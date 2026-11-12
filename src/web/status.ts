import { compareSemver, parseTag } from "../semver";
import type { CommitView, ProjectStatus } from "./contract";

export function highestTag(names: string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    const v = parseTag(name);
    if (v && (best === null || compareSemver(v, parseTag(best)!) > 0)) best = name;
  }
  return best;
}

export function nextTag(highest: string | null): string {
  const v = highest ? parseTag(highest) : null;
  if (!v) return "v0.1.0";
  return v.pre === null ? `v${v.major}.${v.minor}.${v.patch + 1}` : `v${v.major}.${v.minor}.${v.patch}`;
}

export function bumps(highest: string | null): { patch: string; minor: string; major: string } {
  const v = highest ? parseTag(highest) : null;
  if (!v) return { patch: "v0.1.0", minor: "v0.1.0", major: "v1.0.0" };
  const at = (major: number, minor: number, patch: number) => `v${major}.${minor}.${patch}`;
  if (v.pre !== null) {
    const same = at(v.major, v.minor, v.patch);
    return { patch: same, minor: v.patch === 0 ? same : at(v.major, v.minor + 1, 0), major: v.minor === 0 && v.patch === 0 ? same : at(v.major + 1, 0, 0) };
  }
  return { patch: at(v.major, v.minor, v.patch + 1), minor: at(v.major, v.minor + 1, 0), major: at(v.major + 1, 0, 0) };
}

export type Follow = { run: "none" | "running" | "ok" | "failed"; draft: "none" | "open" | "note"; published: boolean; hubBusy: boolean };

// Each step waits while it is really in progress; GitHub opens the draft before the run ends and the doorbell starts the hub during it.
export function followSteps(f: Follow): ("done" | "open" | "wait" | "attention")[] {
  const draftOpen = f.draft === "open" || f.published;
  return [
    f.run === "ok" || (f.run === "failed" && draftOpen) ? "done" : f.run === "failed" ? "attention" : "wait",
    f.draft === "note" ? "attention" : draftOpen ? "done" : f.run === "failed" ? "open" : "wait",
    f.published ? "done" : f.draft === "note" ? "open" : f.hubBusy || draftOpen ? "wait" : "open",
  ];
}

export { suggestBump, type Bump } from "../release";

export function tagProblem(tag: string, highest: string | null): string | null {
  const v = parseTag(tag);
  if (!v) return "Use the shape v1.2.3, such as v1.2.3 or v1.2.3-rc.1";
  if (highest && compareSemver(v, parseTag(highest)!) <= 0) return `Pick a version higher than ${highest}, the highest tag on GitHub`;
  return null;
}

const SKIP = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
const SKIP_TRAILER = /^skip-checks:\s*true\s*$/im;

// GitHub runs no push workflow for a commit whose message carries one of these, so a tag on it may start no release.
// skip-checks: true counts only as a trailer, in the last paragraph of a message that has more than one.
export function skipMarker(message: string): string | null {
  const marker = SKIP.exec(message)?.[0];
  if (marker) return marker;
  const paragraphs = message.split(/\r?\n[ \t]*\r?\n/).filter((p) => /\S/.test(p));
  return paragraphs.length > 1 && SKIP_TRAILER.test(paragraphs.at(-1)!) ? "skip-checks: true" : null;
}

const JQ_SKIP = String.raw`(.commit.message | test("(?i)\\[(skip ci|ci skip|no ci|skip actions|actions skip)\\]")) or ([.commit.message | splits("\\r?\\n[ \\t]*\\r?\\n") | select(test("\\S"))] | length > 1 and (last | test("(?im)^skip-checks:\\s*true\\s*$")))`;

// With a branch, the command reads the tip's message first and stops on a skip marker: the error leaves sha empty,
// which GitHub refuses, so no tag is made.
export function tagCommand(repo: string, tag: string, at: { sha: string } | { branch: string }): string | null {
  const head = `gh api --method POST repos/${repo}/git/refs -f ref=refs/tags/${tag} -f sha=`;
  if ("sha" in at) return /^[0-9a-f]{40,64}$/.test(at.sha) ? `${head}${at.sha}` : null;
  if (!/^[A-Za-z0-9._/-]+$/.test(at.branch)) return null;
  const guard = `if ${JQ_SKIP} then error("the latest commit of ${at.branch} carries a skip marker, so a tag on it may not start the release workflow") else .sha end`;
  return `${head}"$(gh api repos/${repo}/commits/${at.branch} --jq '${guard}')"`;
}

const RELEASE_FILES = /^(\.github\/workflows\/|\.goreleaser\.[^/]+$|package\.json$|project\.yml$|Makefile$)/;

// Files of the project root that decide how a release is built: tagging the commit before a change to them releases the
// old setup.
export const changesRelease = (files: string[]) => files.some((f) => RELEASE_FILES.test(f));

// The commit before a marked tip, when tagging it is safe: no marker of its own, no version tag on it (tapster read the
// tags) and a tip that leaves the release setup alone.
export const releasableParent = (head: CommitView) => (head.parent && !head.parent.skip && head.parent.tag === null && head.changesRelease === false ? head.parent : null);

const cleanParent = (head: CommitView) => (releasableParent(head) ? ` Or tag the commit before it, ${head.parent!.sha.slice(0, 7)}, which has no skip marker.` : "");

export function skipNote(branch: string, head: CommitView): string | null {
  if (!head.skip) return null;
  return `The latest commit on ${branch} says ${head.skip}, so GitHub may not start the release workflow for a tag on it. Push a commit without it to ${branch} and click Refresh.${cleanParent(head)}`;
}

export const skipFix = (branch: string, head: CommitView) =>
  `GitHub may not start the release workflow for a tag on that commit. Push a commit without it to ${branch}, then click Release again.${cleanParent(head)}`;

export type ProjectStepId = "setup" | "protect" | "entry" | "app" | "release" | "secrets";
export type ProjectStep = { id: ProjectStepId; state: "done" | "open" | "wait" | "attention"; label: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function releaseMode(s: ProjectStatus): { label: string; detail: string } | null {
  if (s.unreadable) return null;
  if (s.release.auto === "daily") return { label: "Auto · daily", detail: "Checks the default branch daily at 03:23 UTC; no per-release approval unless the environment requires one." };
  if (s.release.auto === "push") return { label: "Auto · push", detail: "Checks each push to the default branch and picks the next version." };
  if (s.release.auto !== "off" && s.release.autoTag) return { label: "Workflow tags", detail: "The project's own workflow chooses versions and pushes tags." };
  return { label: "Manual", detail: "You choose when to create the next release tag." };
}

export function projectUpdates(s: ProjectStatus): { id: string; label: string; detail: string; tone: "next" | "warn" }[] {
  if (s.unreadable) return [];
  const updates: ReturnType<typeof projectUpdates> = [];
  const changes = s.release.changes;
  if (changes && changes.commits > 0) updates.push({ id: "commits", label: "New commits", detail: `${plural(changes.commits, "commit")} on ${s.defaultBranch} since ${changes.since}. Documentation-only changes may not trigger an automatic release.`, tone: "next" });
  const config = s.config;
  if (config?.pending?.blocked || config?.manual.length) updates.push({ id: "config", label: "Review config", detail: config.pending?.blocked ?? config.manual.join(" "), tone: "warn" });
  else if (config?.pending) updates.push({ id: "config", label: "Config PR", detail: "Hub entry changes are waiting in a pull request. Open the project to review and merge them.", tone: "next" });
  else if (config?.update) updates.push({ id: "config", label: "Config update", detail: "The package now ships something its hub entry does not describe. Open the project to review the changes.", tone: "next" });
  return updates;
}

export function projectSteps(s: ProjectStatus): ProjectStep[] {
  if (s.unreadable) return [{ id: "setup", state: "attention", label: "GitHub did not show it" }];
  const r = s.release;
  const tagged = r.highest && (!r.latest || compareSemver(parseTag(r.highest)!, parseTag(r.latest.tag)!) > 0) && (r.atHead === r.highest || r.changes?.since === r.highest);
  const next = r.suggest ? bumps(r.highest)[r.suggest.kind] : r.next;
  const automatic = r.auto === "daily" || r.auto === "push";
  const releaseLabel = automatic ? "Automatic releases enabled" : r.autoTag ? "Release from the workflow" : `Release ${next}`;
  const release: ProjectStep = (() => {
    const step = (state: ProjectStep["state"], label: string): ProjectStep => ({ id: "release", state, label });
    if (r.draft?.note) return step("attention", `Fix the draft ${r.draft.tag}`);
    if (r.draft) return step("wait", `The hub publishes ${r.draft.tag} next`);
    if (r.head?.skip && (!r.atHead || tagged)) return step("open", `Push a commit without ${r.head.skip}`);
    if (tagged) return step("wait", `Tagged ${r.highest}; awaiting draft`);
    if (r.changes && r.changes.commits > 0) return step("open", automatic ? `New commits on ${s.defaultBranch}` : releaseLabel);
    if (r.latest?.byHub) return step("done", `Published ${r.latest.tag}`);
    if (r.atHead) return step("done", `Nothing new since ${r.atHead}`);
    return step("open", releaseLabel);
  })();
  const steps: ProjectStep[] = [
    { id: "setup", state: s.setup.ok ? "done" : "open", label: "Set up the release workflow" },
    { id: "protect", state: s.protection.ok || s.protection.off ? "done" : "open", label: "Protect the repository" },
    { id: "entry", state: s.entry.state === "merged" ? "done" : "open", label: s.entry.state === "proposed" ? "Merge the hub entry" : "Propose the hub entry" },
    s.app.reaches === true
      ? { id: "app", state: "done", label: "Install the App" }
      : s.app.running
        ? { id: "app", state: "wait", label: "The hub checks its App" }
        : { id: "app", state: "open", label: s.app.reaches === false ? "Install the App" : "Let the hub check its App" },
    release,
  ];
  if (s.secrets.names.length && s.secrets.published) steps.push({ id: "secrets", state: "open", label: `Delete ${plural(s.secrets.names.length, "old secret")}` });
  return steps;
}

export const projectNext = (s: ProjectStatus): ProjectStep | null => projectSteps(s).find((x) => x.state !== "done") ?? null;

const SETUP: ProjectStepId[] = ["setup", "protect", "entry", "app"];
const ready = (s: ProjectStatus) => projectSteps(s).every((x) => !SETUP.includes(x.id) || x.state === "done");

export function canRelease(s: ProjectStatus): { ok: boolean; why: string | null } {
  if (s.unreadable) return { ok: false, why: s.unreadable };
  if (s.release.autoTag) return { ok: false, why: s.release.auto === "daily" ? "Automatic releases check the default branch daily at 03:23 UTC. Run tapster auto on GitHub to check sooner." : s.release.auto === "push" ? "Automatic releases check each push to the default branch. Run tapster auto on GitHub to check again." : "The release workflow tags each release by itself." };
  if (!s.setup.ok) return { ok: false, why: `First the release workflow on ${s.defaultBranch} must be tapster's.` };
  if (!s.release.head) return { ok: false, why: `GitHub did not show the latest commit on ${s.defaultBranch}. Check again in a moment.` };
  if (s.release.atHead) return { ok: false, why: `Nothing new on ${s.defaultBranch} since ${s.release.atHead}.` };
  const skip = skipNote(s.defaultBranch, s.release.head);
  if (skip) return { ok: false, why: skip };
  return { ok: true, why: null };
}

export function projectStop(list: ProjectStatus[] | null, packages: number): { done: boolean; status: string } {
  if (list === null) return { done: packages > 0, status: packages ? `${packages} in the hub` : "None yet" };
  const open = list.filter((s) => !ready(s));
  if (open.length === 1) return { done: false, status: `${open[0]!.name}: ${projectNext(open[0]!)!.label}` };
  if (open.length > 1) return { done: false, status: `${open.length} projects need you` };
  const merged = list.filter((s) => s.entry.state === "merged").length;
  return { done: merged > 0, status: merged ? `${merged} in the hub` : "None yet" };
}
