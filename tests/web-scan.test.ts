import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloneFacts, cloneFacts, defaultRoots, insideHome, oneClonePerRepo, originRepo, projectKind, readSmall, scanClones } from "../src/web/scan";

const base = mkdtempSync(join(tmpdir(), "scan-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function clone(dir: string, url: string, files: Record<string, string> = {}) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
}

test("origin URLs of every GitHub form name the repository; others name nothing", () => {
  const cfg = (url: string) => `[remote "upstream"]\n\turl = https://github.com/other/x\n[remote "origin"]\n\turl = ${url}\n`;
  expect(originRepo(cfg("git@github.com:me/tool.git"))).toBe("me/tool");
  expect(originRepo(cfg("https://github.com/me/tool"))).toBe("me/tool");
  expect(originRepo(cfg("https://github.com/me/tool.git"))).toBe("me/tool");
  expect(originRepo(cfg("ssh://git@github.com/me/my.tool.git"))).toBe("me/my.tool");
  expect(originRepo(cfg("https://gitlab.com/me/tool.git"))).toBeNull();
  expect(originRepo(cfg("https://github.com.evil.example/me/tool"))).toBeNull();
  expect(originRepo('[remote "upstream"]\n\turl = https://github.com/me/tool\n')).toBeNull();
});

test("the kind comes from which build files exist", () => {
  const dir = join(base, "kinds");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "go.mod"), "");
  expect(projectKind(dir, ["go.mod"])).toEqual({ kind: null, why: "a Go project without GoReleaser" });
  writeFileSync(join(dir, ".goreleaser.yaml"), "");
  expect(projectKind(dir, ["go.mod", ".goreleaser.yaml"]).kind).toBe("go");
  expect(projectKind(dir, ["MyApp.xcodeproj"]).kind).toBe("app");
  expect(projectKind(dir, ["README.md"]).why).toBe("no build that tapster knows");
  const js = join(base, "kinds-js");
  mkdirSync(js, { recursive: true });
  writeFileSync(join(js, "package.json"), '{"name":"site"}');
  writeFileSync(join(js, "bun.lock"), "{}");
  expect(projectKind(js, ["package.json", "bun.lock"]).why).toBe("a Bun project without a command (no bin in package.json)");
  writeFileSync(join(js, "package.json"), '{"name":"tool","bin":{"tool":"cli.ts"}}');
  expect(projectKind(js, ["package.json", "bun.lock"]).kind).toBe("bun");
});

test("the scan finds clones three levels down, skips noise and follows a symlinked root once", () => {
  const home = join(base, "home");
  clone(join(home, "Developer", "a"), "git@github.com:me/a.git", { "go.mod": "", ".goreleaser.yml": "" });
  clone(join(home, "Developer", "group", "b"), "https://github.com/me/b");
  clone(join(home, "Developer", "node_modules", "c"), "https://github.com/me/c");
  clone(join(home, "Developer", "x", "y", "z", "deep"), "https://github.com/me/deep");
  clone(join(home, "Developer", "theirs"), "https://github.com/them/theirs");
  clone(join(base, "external", "d"), "https://github.com/me/d");
  symlinkSync(join(base, "external"), join(home, "code"));
  const { found } = scanClones([join(home, "Developer"), join(home, "code"), join(home, "code")]);
  const repos = found.map((f) => f.repo).sort();
  expect(repos).toEqual(["me/a", "me/b", "me/d", "them/theirs"]);
  expect(found.find((f) => f.repo === "me/a")!.kind).toBe("go");
  expect(found.find((f) => f.repo === "me/d")!.path).toBe(join(home, "code", "d"));
  expect(insideHome(join(home, "code", "d"), home)).toBe(true);
});

test("several clones of one repository make one row: the one on the default branch, then the one changed last", () => {
  const facts: Record<string, CloneFacts> = {
    "/h/a": { branch: "feature", defaultBranch: "main", changed: 300 },
    "/h/b": { branch: "main", defaultBranch: "main", changed: 100 },
    "/h/c": { branch: "main", defaultBranch: null, changed: 200 },
    "/h/x": { branch: "old", defaultBranch: null, changed: 10 },
    "/h/y": { branch: "new", defaultBranch: null, changed: 20 },
  };
  const rows = oneClonePerRepo(
    [
      { path: "/h/a", repo: "me/ebb" },
      { path: "/h/b", repo: "me/ebb" },
      { path: "/h/c", repo: "Me/Ebb" },
      { path: "/h/x", repo: "me/lockstep" },
      { path: "/h/y", repo: "me/lockstep" },
      { path: "/h/z", repo: "me/solo" },
    ],
    (dir) => facts[dir]!,
  );
  expect(rows.map((r) => [r.path, r.others])).toEqual([
    ["/h/c", ["/h/b", "/h/a"]],
    ["/h/y", ["/h/x"]],
    ["/h/z", []],
  ]);
});

test("a clone's branch, default branch and last change come from its .git files", () => {
  const dir = join(base, "facts");
  clone(dir, "git@github.com:me/facts.git");
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
  mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(dir, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/trunk\n");
  const f = cloneFacts(dir);
  expect([f.branch, f.defaultBranch]).toEqual(["feature/x", "trunk"]);
  expect(f.changed).toBeGreaterThan(0);
  expect(cloneFacts(join(base, "missing"))).toEqual({ branch: null, defaultBranch: null, changed: 0 });
});

test("the scan stops at its limits and says so", () => {
  const many = join(base, "many");
  for (let i = 0; i < 30; i++) mkdirSync(join(many, `d${i}`), { recursive: true });
  expect(scanClones([many], { maxDirs: 10 }).truncated).toBe(true);
  expect(scanClones([many], { deadline: Date.now() - 1 }).truncated).toBe(true);
});

test("only regular small files are read", () => {
  const dir = join(base, "files");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "small"), "ok");
  writeFileSync(join(dir, "big"), "x".repeat(2000));
  symlinkSync("/dev/zero", join(dir, "zero"));
  expect(readSmall(join(dir, "small"))).toBe("ok");
  expect(readSmall(join(dir, "big"), 1000)).toBeNull();
  expect(readSmall(join(dir, "zero"))).toBeNull();
  expect(readSmall(join(dir, "missing"))).toBeNull();
});

test("home checks hold for paths outside and tricks with dot-dot", () => {
  expect(insideHome("/Users/me/Developer/x", "/Users/me")).toBe(true);
  expect(insideHome("/Users/me/../other/x", "/Users/me")).toBe(false);
  expect(insideHome("/Users/meow/x", "/Users/me")).toBe(false);
  expect(defaultRoots("/Users/me", "/Users/me/Developer/tool")).toContain("/Users/me/Developer");
  expect(defaultRoots("/Users/me", "/tmp/elsewhere/tool")).not.toContain("/tmp/elsewhere");
  expect(defaultRoots("/Users/me", "/Users/me/tool")).not.toContain("/Users/me");
});

test("a clone whose build files link to devices cannot hang tapster", async () => {
  const { findApp, prepare, addOptions } = await import("../src/cli/add");
  const dir = join(base, "trap");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  symlinkSync("/dev/zero", join(dir, "project.yml"));
  symlinkSync("/dev/zero", join(dir, "Makefile"));
  expect(findApp(dir)).toBeNull();
  const go = join(base, "trap-go");
  mkdirSync(join(go, ".github", "workflows"), { recursive: true });
  writeFileSync(join(go, "go.mod"), "module x\n");
  symlinkSync("/dev/zero", join(go, ".goreleaser.yaml"));
  await expect(prepare(go, "me/x", "x", addOptions([]))).rejects.toThrow(/not a regular file/);
});

test("tapster add never writes through a link in the clone", async () => {
  const { prepare, addOptions } = await import("../src/cli/add");
  const { writeInside } = await import("../src/cli/paths");
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  const dir = join(base, "linked");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"t","bin":{"t":"cli.ts"}}');
  writeFileSync(join(dir, "bun.lock"), "{}");
  symlinkSync(outside, join(dir, ".github"));
  await expect(prepare(dir, "me/t", "t", addOptions([]))).rejects.toThrow(/through a link/);
  const dangling = join(base, "dangling");
  mkdirSync(join(dangling, ".github", "workflows"), { recursive: true });
  symlinkSync(join(outside, "planted.yml"), join(dangling, ".github", "workflows", "release.yml"));
  await expect(writeInside(dangling, ".github/workflows/release.yml", "x")).rejects.toThrow(/not a regular file/);
  expect(readdirSync(outside)).toEqual([]);
});
