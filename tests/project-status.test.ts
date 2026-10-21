import { expect, test } from "bun:test";
import type { HubView, ProjectStatus } from "../src/web/contract";
import { canRelease, highestTag, nextTag, projectNext, projectStop, projectSteps, tagCommand, tagProblem } from "../src/web/status";
import { stops } from "../src/web/steps";

const reach = (reaches: boolean | null): ProjectStatus["app"] => ({
  reaches,
  how: reaches === null ? null : "run",
  at: reaches === null ? null : "2026-10-20T10:00:00Z",
  since: reaches === null ? null : "2026-10-20T09:59:00Z",
  reason: reaches === false ? "the hub's App is not installed on octo/aims" : null,
  run: null,
  running: false,
  installUrl: "https://github.com/apps/x/installations/new",
});

const aims = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
  name: "aims",
  repo: "octo/aims",
  url: "https://github.com/octo/aims",
  kind: "go",
  defaultBranch: "main",
  setup: { ok: true, problems: [] },
  protection: { ok: true, off: false, problems: [] },
  entry: { state: "merged", pr: null, proposal: null, blocked: null },
  app: reach(true),
  release: { latest: null, draft: null, highest: null, next: "v0.1.0", autoTag: false, atHead: null, head: { sha: "a".repeat(40), subject: "Start", date: "2026-10-01T00:00:00Z", url: "https://github.com/octo/aims/commit/a" } },
  secrets: { names: [], published: false },
  unreadable: null,
  ...over,
});

test("the next tag is the next patch after the highest semver tag on GitHub", () => {
  expect(highestTag(["v0.2.0", "v0.2.1", "latest", "v0.1.9", "nightly-3"])).toBe("v0.2.1");
  expect(nextTag(highestTag(["v0.2.0", "v0.2.1"]))).toBe("v0.2.2");
  expect(highestTag(["v0.2.1", "v0.10.0"])).toBe("v0.10.0");
  expect(nextTag("v1.4.0-rc.2")).toBe("v1.4.0");
  expect(nextTag(null)).toBe("v0.1.0");
  expect(highestTag(["release", "1.0.0"])).toBeNull();
});

test("a chosen version must have the tag shape and be higher than every tag", () => {
  expect(tagProblem("v0.2.2", "v0.2.1")).toBeNull();
  expect(tagProblem("v0.3.0-rc.1", "v0.2.1")).toBeNull();
  expect(tagProblem("v1.0.0", null)).toBeNull();
  expect(tagProblem("0.2.2", "v0.2.1")).toContain("v1.2.3");
  expect(tagProblem("v0.2.1", "v0.2.1")).toContain("higher than v0.2.1");
  expect(tagProblem("v0.1.5", "v0.2.1")).toContain("higher than v0.2.1");
  expect(tagProblem("v0.2.1-rc.1", "v0.2.1")).toContain("higher than v0.2.1");
});

test("the tag command tags the commit on GitHub, never the local clone", () => {
  expect(tagCommand("octo/aims", "v0.2.2", { sha: "b".repeat(40) })).toBe(`gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha=${"b".repeat(40)}`);
  expect(tagCommand("octo/aims", "v0.2.2", { branch: "main" })).toStartWith('gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha="$(gh api repos/octo/aims/commits/main --jq ');
  expect(tagCommand("octo/aims", "v0.2.2", { branch: "x;rm -rf /" })).toBeNull();
});

test("each fact is a done step or the next step, in the order of the card", () => {
  const s = aims({
    app: reach(false),
    entry: { state: "proposed", pr: "https://github.com/octo/homebrew-tap/pull/7", proposal: null, blocked: null },
    secrets: { names: ["HOMEBREW_TAP_GITHUB_TOKEN"], published: false },
  });
  expect(projectSteps(s).map((x) => [x.id, x.state])).toEqual([
    ["setup", "done"],
    ["protect", "done"],
    ["entry", "open"],
    ["app", "open"],
    ["release", "open"],
  ]);
  expect(projectNext(s)?.label).toBe("Merge the hub entry");
  expect(projectNext(aims({ app: reach(false) }))?.label).toBe("Install the App");
  expect(projectNext(aims({ release: { ...aims().release, highest: "v0.2.1", next: "v0.2.2" } }))?.label).toBe("Release v0.2.2");
});

test("old release secrets become a step only once the hub has published a release", () => {
  const published = { tag: "v0.2.2", url: "u", byHub: true };
  const done = aims({ release: { ...aims().release, latest: published }, secrets: { names: ["MACOS_SIGN_P12"], published: true } });
  expect(projectSteps(done).map((x) => [x.id, x.state])).toEqual([
    ["setup", "done"],
    ["protect", "done"],
    ["entry", "done"],
    ["app", "done"],
    ["release", "done"],
    ["secrets", "open"],
  ]);
  expect(projectNext(done)?.label).toBe("Delete 1 old secret");
  expect(projectNext({ ...done, secrets: { names: [], published: true } })).toBeNull();
});

test("a draft the hub refused needs attention and one it has not reached yet waits", () => {
  const refused = aims({ release: { ...aims().release, draft: { tag: "v0.2.2", url: "u", note: "the tag does not exist" } } });
  expect(projectNext(refused)).toMatchObject({ id: "release", state: "attention", label: "Fix the draft v0.2.2" });
  const waiting = aims({ release: { ...aims().release, draft: { tag: "v0.2.2", url: "u", note: null } } });
  expect(projectNext(waiting)).toMatchObject({ id: "release", state: "wait", label: "The hub publishes v0.2.2 next" });
});

test("a project GitHub does not show needs attention and offers no release", () => {
  const gone = aims({ unreadable: "GitHub GET /repos/octo/aims returned 404. Check the name." });
  expect(projectSteps(gone)).toEqual([{ id: "setup", state: "attention", label: "GitHub did not show it" }]);
  expect(canRelease(gone)).toEqual({ ok: false, why: "GitHub GET /repos/octo/aims returned 404. Check the name." });
  expect(projectStop([gone], 1)).toEqual({ done: false, status: "aims: GitHub did not show it" });
});

test("a default branch whose tip already carries a version tag has nothing to release", () => {
  const done = aims({ release: { ...aims().release, highest: "v0.2.2", next: "v0.2.3", atHead: "v0.2.2" } });
  expect(canRelease(done)).toEqual({ ok: false, why: "Nothing new on main since v0.2.2." });
  expect(projectSteps(done).find((x) => x.id === "release")).toEqual({ id: "release", state: "done", label: "Nothing new since v0.2.2" });
});

test("an App reach the hub has not checked yet is a step but blocks no release", () => {
  const unknown = aims({ app: reach(null) });
  expect(projectSteps(unknown).find((x) => x.id === "app")).toEqual({ id: "app", state: "open", label: "Let the hub check its App" });
  expect(canRelease(unknown)).toEqual({ ok: true, why: null });
  expect(projectSteps(aims({ app: { ...reach(null), running: true } })).find((x) => x.id === "app")).toEqual({ id: "app", state: "wait", label: "The hub checks its App" });
});

test("the release button waits for tapster's workflow but not for the App and never replaces a tagging workflow", () => {
  expect(canRelease(aims())).toEqual({ ok: true, why: null });
  expect(canRelease(aims({ setup: { ok: false, problems: ["x"] } }))).toEqual({ ok: false, why: "First the release workflow on main must be tapster's." });
  expect(canRelease(aims({ app: reach(false) }))).toEqual({ ok: true, why: null });
  expect(canRelease(aims({ release: { ...aims().release, autoTag: true } }))).toEqual({ ok: false, why: "The release workflow tags each release by itself." });
  expect(canRelease(aims({ release: { ...aims().release, head: null } })).ok).toBe(false);
});

test("the setup route's project stop reads the project statuses", () => {
  const h: HubView = {
    name: "octo/homebrew-tap",
    url: "u",
    private: false,
    empty: false,
    protect: { done: true, environment: true, checks: [], others: [] },
    app: { id: "1", slug: "s", key: true, held: false, install: null },
    apple: { needed: null, certificate: null, certificateStored: false, notary: false },
    files: { config: true, state: true, readme: true, workflow: "current", pinned: null, every: null },
    packages: [{ name: "aims", repo: "octo/aims", kind: "go" }],
    invalid: [],
    issue: null,
    extras: { doorbell: { on: false, origin: null, app: null, install: null, key: false, cloudflare: null, accounts: null, tokenPage: "" }, linux: { wanted: false, stored: false, gpg: false, keystore: null, maintainer: null, tools: [], left: [] }, sparkle: [] },
  };
  const project = (list: ProjectStatus[] | null) => stops(h, "no", Date.now(), list).find((s) => s.id === "project")!;
  expect(project(null)).toMatchObject({ state: "done", status: ["1 in the hub"] });
  expect(project([aims({ app: reach(false) })])).toMatchObject({ state: "now", status: ["aims: Install the App"] });
});

test("the route's project stop sums up the projects the same way", () => {
  expect(projectStop(null, 2)).toEqual({ done: true, status: "2 in the hub" });
  expect(projectStop(null, 0)).toEqual({ done: false, status: "None yet" });
  expect(projectStop([aims()], 1)).toEqual({ done: true, status: "1 in the hub" });
  expect(projectStop([aims({ entry: { state: "proposed", pr: "p", proposal: null, blocked: null } })], 0)).toEqual({ done: false, status: "aims: Merge the hub entry" });
  const other = aims({ name: "ebb", repo: "octo/ebb", app: reach(false) });
  expect(projectStop([aims({ entry: { state: "proposed", pr: "p", proposal: null, blocked: null } }), other], 1)).toEqual({ done: false, status: "2 projects need you" });
});
