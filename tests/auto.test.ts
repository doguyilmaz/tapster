import { expect, test } from "bun:test";
import { autoDecision, releaseFile, releaseSignal, suggestBump } from "../src/release";
import { sinceTag } from "../src/web/api/status";
import type { GitHub } from "../src/github";

const change = (message: string, files = ["src/main.ts"]) => ({ message, files });

test.each([
  ["fix: startup crash", "patch", "v1.4.3"],
  ["perf(core): reduce allocations", "patch", "v1.4.3"],
  ["Improve the command output", "patch", "v1.4.3"],
  ["feat(cli): add export", "minor", "v1.5.0"],
  ["FEAT: add export", "minor", "v1.5.0"],
  ["Add export\n\nRelease: minor", "minor", "v1.5.0"],
  ["Remove the old format\n\nRelease: major", "major", "v2.0.0"],
  ["feat!: remove flag\n\nRelease: patch", null, null],
  ["refactor: simplify\n\nBREAKING CHANGE: flag removed", null, null],
  ["feat!: remove flag\n\nRelease: major", "major", "v2.0.0"],
] as const)("automatic classification: %s", (message, kind, tag) => {
  expect(autoDecision([change(message)], "v1.4.2", ["src/main.ts"])).toMatchObject({ kind, tag, blocked: kind === null });
});

test("before 1.0 breaking changes bump minor and explicit major starts 1.0.0", () => {
  expect(autoDecision([change("fix!: remove old flag")], "v0.4.8", ["src/main.ts"]).tag).toBe("v0.5.0");
  expect(autoDecision([change("Ready\n\nRelease: major")], "v0.4.8", ["src/main.ts"]).tag).toBe("v1.0.0");
  expect(autoDecision([change("feat: first command")], null, ["src/main.ts"]).tag).toBe("v0.1.0");
  expect(autoDecision([change("feat!: first command")], null, ["src/main.ts"]).tag).toBe("v0.1.0");
  expect(autoDecision([change("Ready\n\nRelease: major")], null, ["src/main.ts"]).tag).toBe("v1.0.0");
});

test("all accumulated commits contribute and a smaller trailer cannot hide a breaking change", () => {
  const changes = [change("feat: add export"), change("fix: crash")];
  expect(autoDecision(changes, "v2.3.4", ["src/main.ts"]).tag).toBe("v2.4.0");
  expect(autoDecision([change("fix!: remove flag"), change("Fix\n\nRelease: minor")], "v2.3.4", ["src/main.ts"]).blocked).toBe(true);
  expect(suggestBump(["feat: add export", "Fix\n\nRelease: patch"], "v2.3.4").kind).toBe("minor");
});

test("Release directives must be trailers and invalid values stop automation", () => {
  expect(releaseSignal("Explain Release: major in the guide").explicit).toBeNull();
  expect(releaseSignal("Update\n\nRelease: major\n\nThat was an example.").explicit).toBeNull();
  expect(releaseSignal("Update\n\n```text\nRelease: major\n```").explicit).toBeNull();
  expect(releaseSignal("Update\r\n\r\nRelease: MINOR\r\nSigned-off-by: Test <test@example.com>").explicit).toBe("minor");
  for (const trailer of ["Release: banana", "Release:", "Release: minor\nRelease: banana"]) {
    expect(autoDecision([change(`Update\n\n${trailer}`)], "v1.2.3", ["src/main.ts"]).blocked).toBe(true);
  }
});

test("merge PR titles and BREAKING-CHANGE footers are understood", () => {
  expect(suggestBump(["Merge pull request #123 from octo/feature\n\nfeat(cli): add export"], "v1.2.3").kind).toBe("minor");
  expect(suggestBump(["refactor: simplify\n\nBREAKING-CHANGE: removed config"], "v1.2.3").kind).toBe("major");
  expect(releaseSignal("Mention feat!: syntax without a conventional subject").breaking).toBe(false);
});

test.each(["docs/guide.md", "doc/guide.txt", ".github/workflows/ci.yml", ".github/dependabot.yml", "README.md", "README.tr.md", "CHANGELOG.md", "LICENSE", ".agents/report.md"])("documentation/automation file %s does not trigger a version", (file) => {
  expect(releaseFile(file)).toBe(false);
  expect(autoDecision([change("feat: document a command", [file])], "v1.2.3", [file]).tag).toBeNull();
});

test.each(["src/README.ts", "README.ts", "package.json", "bun.lock", "go.mod", "go.sum", "Makefile", "project.yml", "README.ts/main.ts", "unknown", "assets/icon.png"])("release-relevant file %s produces a patch for an ordinary commit", (file) => {
  expect(releaseFile(file)).toBe(true);
  expect(autoDecision([change("Update", [file])], "v1.2.3", [file]).tag).toBe("v1.2.4");
});

test("documentation features cannot promote an unrelated code fix", () => {
  const changes = [change("feat: describe future API", ["docs/api.md"]), change("fix: crash")];
  expect(autoDecision(changes, "v1.2.3", ["docs/api.md", "src/main.ts"]).tag).toBe("v1.2.4");
});

test("explicit trailers can deliberately release documentation or workflow fixes", () => {
  expect(autoDecision([change("Fix build\n\nRelease: patch", [".github/workflows/release.yml"])], "v1.2.3", [".github/workflows/release.yml"]).tag).toBe("v1.2.4");
});

test("no commits, fully reverted changes, prereleases and unsafe numbers do not release", () => {
  expect(autoDecision([], "v1.2.3", []).tag).toBeNull();
  expect(autoDecision([change("feat: export"), change("Revert export")], "v1.2.3", []).tag).toBeNull();
  for (const highest of ["v1.2.3-rc.1", "v9007199254740992.0.0", "v1.2.9007199254740991"]) {
    expect(autoDecision([change("fix: crash")], highest, ["src/main.ts"]).blocked).toBe(true);
  }
});

test("the manual suggestion paginates the entire range so an early breaking change is not lost", async () => {
  const paths: string[] = [];
  const messages = [...Array.from({ length: 250 }, () => "fix: crash"), "feat!: remove flag"];
  const gh = { json: async (_method: string, path: string) => {
    paths.push(path);
    const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
    return { status: "ahead", total_commits: messages.length, commits: messages.slice((page - 1) * 100, page * 100).map((message) => ({ commit: { message } })) };
  } } as unknown as GitHub;
  expect(suggestBump(await sinceTag(gh, "o/tool", "v1.2.3", "a".repeat(40)), "v1.2.3").kind).toBe("major");
  expect(paths).toHaveLength(3);
});

test("partial or divergent commit lists never supply an incomplete version suggestion", async () => {
  for (const response of [{ status: "diverged", commits: [] }, { total_commits: 1001, commits: [] }, { total_commits: 200, commits: [] }, {}]) {
    const gh = { json: async () => response } as unknown as GitHub;
    await expect(sinceTag(gh, "o/tool", "v1.2.3", "a".repeat(40))).rejects.toThrow();
  }
});
