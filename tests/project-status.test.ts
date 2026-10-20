import { expect, test } from "bun:test";
import type { ProjectStatus } from "../src/web/contract";
import { canRelease, highestTag, nextTag, projectNext, projectStop, projectSteps, tagCommand, tagProblem } from "../src/web/status";

const aims = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
  name: "aims",
  repo: "octo/aims",
  url: "https://github.com/octo/aims",
  kind: "go",
  defaultBranch: "main",
  setup: { ok: true, problems: [] },
  protection: { ok: true, off: false, problems: [] },
  entry: { state: "merged", pr: null },
  app: { reaches: true, installUrl: "https://github.com/apps/x/installations/new" },
  release: { latest: null, draft: null, highest: null, next: "v0.1.0", autoTag: false, head: { sha: "a".repeat(40), subject: "Start", date: "2026-10-01T00:00:00Z", url: "https://github.com/octo/aims/commit/a" } },
  secrets: { names: [], published: false },
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
  expect(tagCommand("octo/aims", "v0.2.2", { branch: "main" })).toBe('gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha="$(gh api repos/octo/aims/commits/main --jq .sha)"');
  expect(tagCommand("octo/aims", "v0.2.2", { branch: "x;rm -rf /" })).toBeNull();
});

test("each fact is a done step or the next step, in the order of the card", () => {
  const s = aims({
    app: { reaches: false, installUrl: "u" },
    entry: { state: "proposed", pr: "https://github.com/octo/homebrew-tap/pull/7" },
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
  expect(projectNext(aims({ app: { reaches: false, installUrl: "u" } }))?.label).toBe("Install the App");
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

test("the App's reach that GitHub does not show blocks nothing", () => {
  const unknown = aims({ app: { reaches: null, installUrl: "u" } });
  expect(projectSteps(unknown).find((x) => x.id === "app")!.state).toBe("done");
  expect(canRelease(unknown)).toEqual({ ok: true, why: null });
});

test("the release button waits for the workflow and the App and never replaces a tagging workflow", () => {
  expect(canRelease(aims())).toEqual({ ok: true, why: null });
  expect(canRelease(aims({ setup: { ok: false, problems: ["x"] } }))).toEqual({ ok: false, why: "First the release workflow on main must be tapster's." });
  expect(canRelease(aims({ app: { reaches: false, installUrl: "u" } }))).toEqual({ ok: false, why: "First install the App on aims." });
  expect(canRelease(aims({ release: { ...aims().release, autoTag: true } }))).toEqual({ ok: false, why: "The release workflow tags each release by itself." });
  expect(canRelease(aims({ release: { ...aims().release, head: null } })).ok).toBe(false);
});

test("the route's project stop sums up the projects the same way", () => {
  expect(projectStop(null, 2)).toEqual({ done: true, status: "2 in the hub" });
  expect(projectStop(null, 0)).toEqual({ done: false, status: "None yet" });
  expect(projectStop([aims()], 1)).toEqual({ done: true, status: "1 in the hub" });
  expect(projectStop([aims({ entry: { state: "proposed", pr: "p" } })], 0)).toEqual({ done: false, status: "aims: Merge the hub entry" });
  const other = aims({ name: "ebb", repo: "octo/ebb", app: { reaches: false, installUrl: "u" } });
  expect(projectStop([aims({ entry: { state: "proposed", pr: "p" } }), other], 1)).toEqual({ done: false, status: "2 projects need you" });
});
