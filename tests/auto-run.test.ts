import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { autoWorkflow } from "../src/cli/auto";

const base = mkdtempSync(join(tmpdir(), "tapster-auto-run-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const node = Bun.which("node")!;
const dummy = "tapster-dummy-read-token-NEVER-LOG";
const scripts = parse(autoWorkflow("daily", "main")).jobs;
const code = (mode: "plan" | "tag") => (scripts[mode].steps.find((s: { run?: string }) => s.run).run as string).split("<<'TAPSTER_AUTO'\n")[1]!.replace(/\nTAPSTER_AUTO\s*$/, "");
const env = { PATH: process.env.PATH!, HOME: base, TMPDIR: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

let serial = 0;
function fixture() {
  const root = join(base, `repo-${serial++}`);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  const commit = (message: string, files: Record<string, string> = { "src/main.ts": message }, push = true) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(repo, file, ".."), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message);
    if (push) git("push", "-q", "origin", "HEAD:refs/heads/main");
    return git("rev-parse", "HEAD");
  };
  const version = (tag = "v1.2.3", annotated = false) => {
    git("-c", "tag.gpgsign=false", "tag", ...(annotated ? ["-a", "-m", "Fixture"] : []), tag);
    git("push", "-q", "origin", `refs/tags/${tag}`);
  };
  commit("Start");
  const eventFile = join(root, "event.json");
  const preload = join(root, "fetch.mjs");
  writeFileSync(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
  const run = (mode: "plan" | "tag", options: { releases?: unknown[]; apiStatus?: number; output?: Record<string, string>; extra?: Record<string, string> } = {}) => {
    const outputFile = join(root, "output");
    writeFileSync(outputFile, "");
    writeFileSync(preload, `globalThis.fetch = async (url, options) => { if (!url.startsWith("https://api.github.com/repos/o/tool/releases?") || options.headers.Authorization !== ${JSON.stringify(`Bearer ${dummy}`)}) throw new Error("Unexpected request"); return new Response(${JSON.stringify(JSON.stringify(options.releases ?? []))}, {status: ${options.apiStatus ?? 200}}); };`);
    const result = spawnSync(node, ["--import", preload, "--input-type=module", "-", mode], {
      cwd: repo, input: code(mode), encoding: "utf8", timeout: 20_000,
      env: { ...env, GITHUB_OUTPUT: outputFile, GITHUB_EVENT_PATH: eventFile, GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "o/tool", GH_TOKEN: dummy, ...(options.output ? { RELEASE_TAG: options.output.tag!, RELEASE_SHA: options.output.sha!, RELEASE_REFS: options.output.refs! } : {}), ...options.extra },
    });
    const output = Object.fromEntries(readFileSync(outputFile, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    expect(`${result.stdout}${result.stderr}`).not.toContain(dummy);
    return { ...result, output };
  };
  return { git, commit, version, run, repo, root };
}

test("the exact generated Node script plans and pushes one tag on a local dummy remote", () => {
  const f = fixture();
  f.version("v1.2.3", true);
  const sha = f.commit("feat(cli): add export");
  const plan = f.run("plan");
  expect(plan.status).toBe(0);
  expect(plan.output).toMatchObject({ tag: "v1.3.0", sha });
  expect(f.run("tag", { output: plan.output }).status).toBe(0);
  expect(f.git("ls-remote", "--tags", "origin")).toContain(`refs/tags/v1.3.0`);
  expect(f.git("rev-parse", "v1.3.0")).toBe(sha);
  expect(f.run("tag", { output: plan.output }).stdout).toContain("changed after analysis");
  expect(f.git("rev-parse", "v1.3.0")).toBe(sha);
  expect(f.run("plan").output.tag).toBe("");
});

test("no change and docs-only changes create no tag, while code commits accumulated below them still release", () => {
  const f = fixture();
  f.version();
  expect(f.run("plan").output.tag).toBe("");
  f.commit("feat: document export", { "docs/export.md": "export" });
  expect(f.run("plan").output.tag).toBe("");
  f.commit("fix: crash");
  f.commit("docs: typo", { "README.md": "read me" });
  expect(f.run("plan").output.tag).toBe("v1.2.4");
});

test("first releases, pending drafts and API failures are handled safely", () => {
  const f = fixture();
  expect(f.run("plan").output.tag).toBe("v0.1.0");
  expect(f.run("plan", { releases: [{ tag_name: "v0.1.0", draft: true }] }).output.tag).toBe("");
  const denied = f.run("plan", { apiStatus: 403 });
  expect(denied.status).toBe(1);
  expect(denied.output.tag).toBe("");
  expect(denied.stderr).toContain("HTTP 403");
  const plan = f.run("plan");
  expect(f.run("tag", { output: plan.output, releases: [{ tag_name: "v0.0.1", draft: true }] }).stdout).toContain("appeared after analysis");
  expect(f.git("ls-remote", "--tags", "origin")).toBe("");
});

test.each(["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]", "\n\nskip-checks: true"])("a marked branch tip never gets a tag: %s", (marker) => {
  const f = fixture();
  f.version();
  f.commit(`fix: crash ${marker}`);
  const plan = f.run("plan");
  expect(plan.status).toBe(0);
  expect(plan.output.tag).toBe("");
  expect(plan.stdout).toContain("skips workflows");
});

test("prerelease and divergent highest tags stop automatic version selection", () => {
  const f = fixture();
  f.version("v1.3.0-rc.1");
  f.commit("fix: crash");
  expect(f.run("plan").status).toBe(1);
  f.git("tag", "-d", "v1.3.0-rc.1");
  f.git("checkout", "-q", "--orphan", "other");
  f.git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Other history");
  f.version("v2.0.0");
  f.git("checkout", "-q", "main");
  expect(f.run("plan").status).toBe(1);
});

test("a branch or tag race discards the plan, and a repeat cannot replace the tag", () => {
  const f = fixture();
  f.version();
  const planned = f.commit("fix: crash");
  const plan = f.run("plan");
  f.commit("fix: another crash");
  const stale = f.run("tag", { output: plan.output });
  expect(stale.status).toBe(0);
  expect(stale.stdout).toContain("changed after analysis");
  expect(f.git("ls-remote", "--tags", "origin")).not.toContain("refs/tags/v1.2.4");
  f.git("reset", "--hard", planned);
  f.git("push", "-q", "--force", "origin", "main");
  f.version("v2.0.0");
  expect(f.run("tag", { output: plan.output }).stdout).toContain("changed after analysis");
});

test("tampered output and manual runs from a feature branch cannot push", () => {
  const f = fixture();
  const plan = f.run("plan");
  for (const tag of ["v1.2.3\n::warning::oops", "v1.2", "--force", "v01.2.3"]) {
    expect(f.run("tag", { output: { ...plan.output, tag } }).status).toBe(1);
  }
  expect(f.run("plan", { extra: { GITHUB_REF: "refs/heads/feature" } }).status).toBe(1);
  expect(f.run("tag", { output: plan.output, extra: { GITHUB_REF: "refs/heads/feature" } }).status).toBe(1);
});

test("commit text and Git error output are never echoed into workflow logs", () => {
  const f = fixture();
  f.version();
  f.commit("fix: $(touch SHOULD_NOT_RUN)\n\n::warning::DUMMY_SECRET_FROM_COMMIT");
  const plan = f.run("plan");
  expect(plan.status).toBe(0);
  expect(plan.stdout).not.toContain("DUMMY_SECRET");
  f.git("remote", "set-url", "origin", `https://example.invalid/${dummy}`);
  const failed = f.run("tag", { output: plan.output, extra: { GIT_ALLOW_PROTOCOL: "file" } });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("while reading or updating Git");
  expect(failed.stderr).not.toContain("example.invalid");
});

test("a non-squash merge includes the feature branch's commits and the merge's explicit major decision", () => {
  const f = fixture();
  f.version();
  f.git("checkout", "-q", "-b", "feature");
  f.commit("feat!: remove legacy mode", { "src/main.ts": "new mode" }, false);
  f.git("checkout", "-q", "main");
  f.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge pull request #7 from o/feature\n\nRemove legacy mode\n\nRelease: major", "feature");
  f.git("push", "-q", "origin", "main");
  expect(f.run("plan").output.tag).toBe("v2.0.0");
});
