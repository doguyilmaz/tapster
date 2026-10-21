import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAims } from "../scripts/demo";
import { releaseHint } from "../src/cli/add";
import { GitHub } from "../src/github";
import type { ProjectStatus, StatusView } from "../src/web/contract";
import { FakeHub } from "./helpers/fakehub";
import { webApp } from "./helpers/web";
import { canRelease, changesRelease, projectSteps, releasableParent, skipMarker, skipNote, tagCommand } from "../src/web/status";

test.each([
  ["Merge pull request #3 [skip ci]", "[skip ci]"],
  ["Bump deps [ci skip]", "[ci skip]"],
  ["[no ci] docs", "[no ci]"],
  ["Tidy\n\nMore words [skip actions]", "[skip actions]"],
  ["Tidy [actions skip]", "[actions skip]"],
  ["Tidy [Skip CI]", "[Skip CI]"],
  ["Tidy\n\n\nskip-checks: true", "skip-checks: true"],
  ["Tidy\n\n\nSigned-off-by: O <o@x.yz>\nskip-checks:true", "skip-checks: true"],
])("GitHub skips workflows for %j, so tapster names %s", (message, marker) => {
  expect(skipMarker(message)).toBe(marker);
});

test.each(["Release v1.2.0", "skip ci without brackets", "Mention skip-checks: true in a sentence", "[skip-ci]", "skip-checks: false", "skip-checks: true", "Tidy\n\nskip-checks: true\n\nMore words after it"])("%j carries no skip marker", (message) => {
  expect(skipMarker(message)).toBeNull();
});

const head = { sha: "a".repeat(40), subject: "Merge pull request #3 [skip ci]", date: "2026-10-01T00:00:00Z", url: "https://github.com/octo/aims/commit/a" };
const s = (over: Partial<ProjectStatus["release"]> = {}): ProjectStatus => ({
  name: "aims",
  repo: "octo/aims",
  url: "https://github.com/octo/aims",
  kind: "go",
  defaultBranch: "main",
  setup: { ok: true, problems: [], triggers: [] },
  protection: { ok: true, off: false, problems: [] },
  entry: { state: "merged", pr: null, proposal: null, blocked: null },
  app: { reaches: true, how: "run", at: null, since: null, reason: null, run: null, running: false, installUrl: "" },
  release: { latest: null, draft: null, highest: "v0.2.1", next: "v0.2.2", autoTag: false, atHead: null, suggest: null, head, ...over },
  secrets: { names: [], published: false },
  unreadable: null,
});

test("a tip with a skip marker is not released: the card says why and names the commit before it when that one is clean", () => {
  const clean = { sha: "b".repeat(40), subject: "Fix the parser", url: "https://github.com/octo/aims/commit/b", skip: null, tag: null };
  const marked = s({ head: { ...head, skip: "[skip ci]", parent: clean, changesRelease: false } });
  expect(canRelease(marked)).toEqual({
    ok: false,
    why: "The latest commit on main says [skip ci], so GitHub may not start the release workflow for a tag on it. Push a commit without it to main and click Refresh. Or tag the commit before it, bbbbbbb, which has no skip marker.",
  });
  expect(projectSteps(marked).find((x) => x.id === "release")).toEqual({ id: "release", state: "open", label: "Push a commit without [skip ci]" });
  const both = s({ head: { ...head, skip: "[skip ci]", parent: { ...clean, skip: "[ci skip]" }, changesRelease: false } });
  expect(canRelease(both).why).toBe("The latest commit on main says [skip ci], so GitHub may not start the release workflow for a tag on it. Push a commit without it to main and click Refresh.");
  expect(canRelease(s())).toEqual({ ok: true, why: null });
});

test("the printed tag command reads the tip's message first and stops on a skip marker", () => {
  const cmd = tagCommand("octo/aims", "v0.2.2", { branch: "main" })!;
  expect(cmd).toStartWith(`gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha="$(gh api repos/octo/aims/commits/main --jq 'if `);
  expect(cmd).toEndWith(` then error("the latest commit of main carries a skip marker, so a tag on it may not start the release workflow") else .sha end')"`);
});

test("the Release button and tapster add's printed command read the tip first and refuse a commit with a skip marker", async () => {
  const fake = new FakeHub("octo");
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set<string>() };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  listAims(fake);
  const aims = fake.repo("aims", { tags: new Map([["v0.2.1", "2".repeat(40)]]), commit: { message: "Merge pull request #4 from octo/docs\n\n[skip ci]", date: "2026-10-19T16:20:00Z", parent: { sha: "c".repeat(40), message: "Fix the parser" } } });
  const home = mkdtempSync(join(tmpdir(), "skipci-"));
  const { call } = webApp(fake, home);
  const status = ((await call("GET", "/api/projects/status?hub=octo/homebrew-tap&repo=octo/aims")).data as unknown as StatusView).projects[0]!;
  expect(status.release.head).toMatchObject({ sha: aims.head, skip: "[skip ci]", parent: { sha: "c".repeat(40), subject: "Fix the parser", skip: null } });
  const refused = await call("POST", "/api/projects/release", { hub: "octo/homebrew-tap", repo: "octo/aims", tag: "v0.2.2", sha: aims.head });
  expect(refused.data.error).toEqual({
    reason: "the latest commit on main says [skip ci]",
    fix: "GitHub may not start the release workflow for a tag on that commit. Push a commit without it to main, then click Release again. Or tag the commit before it, ccccccc, which has no skip marker.",
  });
  expect(aims.tags.has("v0.2.2")).toBe(false);
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  const hint = await releaseHint(gh, "octo/aims");
  expect(hint).toStartWith("The latest commit of main says [skip ci], so GitHub may not start the release workflow for a tag on it. Push a commit without it, then release v0.2.2 by tagging that one:\n  gh api --method POST repos/octo/aims/git/refs");
  expect(hint).toEndWith(`Or tag the commit before it, which has no skip marker:\n  gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha=${"c".repeat(40)}`);
  aims.tags.set("v0.2.1", "c".repeat(40));
  const tagged = ((await call("GET", "/api/projects/status?hub=octo/homebrew-tap&repo=octo/aims")).data as unknown as StatusView).projects[0]!;
  expect(tagged.release.head?.parent).toMatchObject({ sha: "c".repeat(40), tag: "v0.2.1" });
  expect(skipNote("main", tagged.release.head!)).toBe("The latest commit on main says [skip ci], so GitHub may not start the release workflow for a tag on it. Push a commit without it to main and click Refresh.");
  expect((await call("POST", "/api/projects/release", { hub: "octo/homebrew-tap", repo: "octo/aims", tag: "v0.2.2", sha: aims.head })).data.error).toMatchObject({ fix: "GitHub may not start the release workflow for a tag on that commit. Push a commit without it to main, then click Release again." });
  expect(await releaseHint(gh, "octo/aims")).not.toContain("Or tag the commit before it");
  aims.commit = { message: "Fix the parser", date: "2026-10-19T16:20:00Z" };
  expect((await call("POST", "/api/projects/release", { hub: "octo/homebrew-tap", repo: "octo/aims", tag: "v0.2.2", sha: aims.head })).data).toEqual({ tag: "v0.2.2", sha: aims.head });
  rmSync(home, { recursive: true, force: true });
});

const MARKED = ["x [skip ci]", "x [ci skip]", "x [NO CI]", "x [skip actions]", "x [actions skip]", "Tidy\n\nskip-checks: true", "Tidy\n\n\nSigned-off-by: O <o@x.yz>\nskip-checks:true\n", "Tidy\r\n\r\nskip-checks: true\r\n"];
const CLEAN = ["Release v1.2.0", "skip-checks: true", "Tidy\n\nskip-checks: true\n\nMore words after it", "Mention skip-checks: true in a sentence\n\nok", "[skip-ci] no"];
const jq = Bun.which("jq");

test.skipIf(!jq)("jq runs the printed guard and stops exactly where skipMarker does", () => {
  const guard = /--jq '(.*)'\)"$/.exec(tagCommand("o/t", "v1.0.0", { branch: "main" })!)![1]!;
  for (const message of [...MARKED, ...CLEAN]) {
    const r = Bun.spawnSync([jq!, guard], { stdin: Buffer.from(JSON.stringify({ sha: "abc", commit: { message } })), stderr: "pipe" });
    expect([message, r.exitCode !== 0]).toEqual([message, skipMarker(message) !== null]);
  }
});

test.each([".github/workflows/release.yml", ".github/workflows/ci.yaml", ".goreleaser.yaml", ".goreleaser.yml", "package.json", "project.yml", "Makefile"])("a tip that changes %s changes the release setup", (f) => {
  expect(changesRelease(["README.md", f])).toBe(true);
});

test.each(["README.md", "src/main.go", "docs/package.json", "Makefile.md", ".github/dependabot.yml"])("a tip that changes only %s leaves the release setup", (f) => {
  expect(changesRelease([f])).toBe(false);
});

test("the commit before a marked tip is offered only when the tip leaves the release setup, the commit has no version tag and the tags were read", async () => {
  const fake = new FakeHub("octo");
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set<string>() };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  listAims(fake);
  const parent = { sha: "c".repeat(40), message: "Fix the parser" };
  const aims = fake.repo("aims", { tags: new Map([["v0.2.1", "2".repeat(40)]]), commit: { message: "Docs [skip ci]", date: "2026-10-19T16:20:00Z", parent, files: [".github/workflows/release.yml", "README.md"] } });
  const home = mkdtempSync(join(tmpdir(), "skipci-"));
  const { call } = webApp(fake, home);
  const head = async () => ((await call("GET", "/api/projects/status?hub=octo/homebrew-tap&repo=octo/aims")).data as unknown as StatusView).projects[0]!.release.head!;
  const offered = async () => [releasableParent(await head())?.sha ?? null, (await releaseHint(new GitHub("t", fake.fetch, async () => {}, "user"), "octo/aims")).includes("Or tag the commit before it")];
  expect(await head()).toMatchObject({ skip: "[skip ci]", changesRelease: true });
  expect(await offered()).toEqual([null, false]);
  const refused = await call("POST", "/api/projects/release", { hub: "octo/homebrew-tap", repo: "octo/aims", tag: "v0.2.2", sha: aims.head });
  expect((refused.data.error as { fix: string }).fix).not.toContain("Or tag");
  aims.commit = { ...aims.commit, files: ["README.md"] };
  expect(await offered()).toEqual(["c".repeat(40), true]);
  aims.commit = { ...aims.commit, message: "Merge pull request #5 from octo/docs\n\n[skip ci]", merge: "d".repeat(40), files: ["docs/a.md"] };
  expect(await offered()).toEqual(["c".repeat(40), true]);
  aims.commit = { ...aims.commit, files: ["docs/a.md", "package.json"] };
  expect(await offered()).toEqual([null, false]);
  aims.commit = { ...aims.commit, files: ["docs/a.md"] };
  const real = fake.fetch;
  fake.fetch = async (input, init) => (String(input).includes("/matching-refs/") ? new Response("{}", { status: 403 }) : real(input, init));
  const blind = await offered();
  fake.fetch = real;
  expect(blind).toEqual([null, false]);
  rmSync(home, { recursive: true, force: true });
});
