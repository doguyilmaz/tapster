import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, runPath } from "../src/run";
import { changedFiles, syncClone } from "../src/web/sync";

const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
let root = "";
let origin = "";
let clone = "";

const at = (dir: string) => (args: string[], timeoutMs?: number) => runPath(TOOLS.git, "git", ["-C", dir, ...args], { env: ENV, allowFail: true, timeoutMs });
const git = async (dir: string, ...args: string[]) => {
  const r = await at(dir)(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (dir: string, file: string, text: string, message = `edit ${file}`) => {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", file);
  await git(dir, "commit", "-q", "-m", message);
};
const sync = (stash = false) => syncClone(at(clone), clone, "main", stash);
const branch = () => git(clone, "branch", "--show-current");
const upstreamAdds = async (file: string, text: string) => {
  const other = join(root, "other");
  await git(root, "clone", "-q", origin, other);
  await commit(other, file, text);
  await git(other, "push", "-q", "origin", "main");
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tapster-sync-"));
  origin = join(root, "origin.git");
  clone = join(root, "clone");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, clone);
  await commit(clone, "README.md", "one\n");
  await git(clone, "push", "-q", "-u", "origin", "main");
  await git(clone, "switch", "-q", "-c", "feat/x");
  await commit(clone, "feature.txt", "mine\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a clean feature branch moves to main and picks up GitHub's new commits", async () => {
  await upstreamAdds("news.txt", "new\n");
  const r = await sync();
  expect(r).toEqual({ state: "synced", branch: "main", from: "feat/x", stashed: false, fetched: true, pulled: 1, diverged: null });
  expect(await branch()).toBe("main");
  expect(readFileSync(join(clone, "news.txt"), "utf8")).toBe("new\n");
  expect(await git(clone, "log", "-1", "--format=%s", "feat/x")).toBe("edit feature.txt");
});

test("uncommitted changes stop it before anything happens, until the user agrees to stash", async () => {
  writeFileSync(join(clone, "feature.txt"), "half done\n");
  const asked = await sync();
  expect(asked).toEqual({ state: "changes", files: ["feature.txt"] });
  expect(await branch()).toBe("feat/x");
  expect(readFileSync(join(clone, "feature.txt"), "utf8")).toBe("half done\n");

  const r = await sync(true);
  expect(r).toMatchObject({ state: "synced", branch: "main", stashed: true });
  expect(await git(clone, "stash", "list")).toContain("tapster: put aside before switching from feat/x to main");
  await git(clone, "switch", "-q", "feat/x");
  await git(clone, "stash", "pop", "-q");
  expect(readFileSync(join(clone, "feature.txt"), "utf8")).toBe("half done\n");
});

test("a main that went both ways is left as it is", async () => {
  await git(clone, "switch", "-q", "main");
  await commit(clone, "local.txt", "local\n");
  const local = await git(clone, "rev-parse", "main");
  await git(clone, "switch", "-q", "feat/x");
  await upstreamAdds("news.txt", "new\n");
  const r = await sync();
  expect(r).toMatchObject({ state: "synced", branch: "main", pulled: 0, diverged: { ahead: 1, behind: 1 } });
  expect(await git(clone, "rev-parse", "main")).toBe(local);
});

test("an untracked file in the way stops the switch and puts stashed changes back", async () => {
  await upstreamAdds("news.txt", "theirs\n");
  await git(clone, "fetch", "-q");
  await git(clone, "branch", "-q", "-f", "main", "origin/main");
  writeFileSync(join(clone, "news.txt"), "my notes\n");
  writeFileSync(join(clone, "feature.txt"), "half done\n");
  const err = await sync(true).catch((e) => e);
  expect(err.reason).toBe("some files here are not in git and main has files with the same names");
  expect(err.fix).toContain("news.txt");
  expect(err.fix).toContain("Your changes are back where they were.");
  expect(await branch()).toBe("feat/x");
  expect(readFileSync(join(clone, "feature.txt"), "utf8")).toBe("half done\n");
  expect(readFileSync(join(clone, "news.txt"), "utf8")).toBe("my notes\n");
  expect(await git(clone, "stash", "list")).toBe("");
});

test("an unfinished merge is refused untouched", async () => {
  writeFileSync(join(clone, ".git", "MERGE_HEAD"), `${await git(clone, "rev-parse", "HEAD")}\n`);
  const err = await sync().catch((e) => e);
  expect(err.reason).toBe("A merge is not finished in this clone");
  expect(await branch()).toBe("feat/x");
});

test("a commit no branch holds is never left behind", async () => {
  await git(clone, "switch", "-q", "--detach");
  await commit(clone, "lost.txt", "x\n");
  const err = await sync().catch((e) => e);
  expect(err.reason).toBe("this clone is on a commit that no branch holds");
  expect(await git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
});

test("without GitHub it still switches to the local main and says so", async () => {
  await git(clone, "remote", "set-url", "origin", join(root, "missing.git"));
  const r = await sync();
  expect(r).toMatchObject({ state: "synced", branch: "main", fetched: false });
  expect(await branch()).toBe("main");
});

test("without GitHub or a local main it changes nothing", async () => {
  await git(clone, "branch", "-q", "-D", "main");
  await git(clone, "update-ref", "-d", "refs/remotes/origin/main");
  await git(clone, "remote", "set-url", "origin", join(root, "missing.git"));
  const err = await sync().catch((e) => e);
  expect(err.reason).toBe("this clone has no copy of main and GitHub did not answer");
  expect(await branch()).toBe("feat/x");
});

test("a clone without a local main gets one that follows GitHub's", async () => {
  await git(clone, "branch", "-q", "-D", "main");
  const r = await sync();
  expect(r).toMatchObject({ state: "synced", branch: "main", fetched: true });
  expect(await git(clone, "rev-parse", "--abbrev-ref", "main@{u}")).toBe("origin/main");
});

test("git's porcelain list reads renames once", () => {
  expect(changedFiles(" M a.txt\0R  new.txt\0old.txt\0A  b.txt\0")).toEqual(["a.txt", "new.txt", "b.txt"]);
});
