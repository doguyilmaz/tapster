import { compareSemver, parseTag } from "../semver";
import type { ProjectStatus } from "./contract";

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

export function tagProblem(tag: string, highest: string | null): string | null {
  const v = parseTag(tag);
  if (!v) return "Use the shape v1.2.3, such as v1.2.3 or v1.2.3-rc.1";
  if (highest && compareSemver(v, parseTag(highest)!) <= 0) return `Pick a version higher than ${highest}, the highest tag on GitHub`;
  return null;
}

export function tagCommand(repo: string, tag: string, at: { sha: string } | { branch: string }): string | null {
  const head = `gh api --method POST repos/${repo}/git/refs -f ref=refs/tags/${tag} -f sha=`;
  if ("sha" in at) return /^[0-9a-f]{40,64}$/.test(at.sha) ? `${head}${at.sha}` : null;
  return /^[A-Za-z0-9._/-]+$/.test(at.branch) ? `${head}"$(gh api repos/${repo}/commits/${at.branch} --jq .sha)"` : null;
}

export type ProjectStepId = "setup" | "protect" | "entry" | "app" | "release" | "secrets";
export type ProjectStep = { id: ProjectStepId; state: "done" | "open" | "wait" | "attention"; label: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function projectSteps(s: ProjectStatus): ProjectStep[] {
  if (s.unreadable) return [{ id: "setup", state: "attention", label: "GitHub did not show it" }];
  const r = s.release;
  const release: ProjectStep = r.draft?.note
    ? { id: "release", state: "attention", label: `Fix the draft ${r.draft.tag}` }
    : r.draft
      ? { id: "release", state: "wait", label: `The hub publishes ${r.draft.tag} next` }
      : r.latest?.byHub
        ? { id: "release", state: "done", label: `Published ${r.latest.tag}` }
        : r.atHead
          ? { id: "release", state: "done", label: `Nothing new since ${r.atHead}` }
          : { id: "release", state: "open", label: r.autoTag ? "Release from the workflow" : `Release ${r.next}` };
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
  if (s.release.autoTag) return { ok: false, why: "The release workflow tags each release by itself." };
  if (!s.setup.ok) return { ok: false, why: `First the release workflow on ${s.defaultBranch} must be tapster's.` };
  if (!s.release.head) return { ok: false, why: `GitHub did not show the latest commit on ${s.defaultBranch}. Check again in a moment.` };
  if (s.release.atHead) return { ok: false, why: `Nothing new on ${s.defaultBranch} since ${s.release.atHead}.` };
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
