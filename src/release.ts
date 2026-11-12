import { parseTag } from "./semver";

export type BumpKind = "patch" | "minor" | "major";
export type Bump = { kind: BumpKind; reason: string };
export type CommitChange = { message: string; files: string[] };

const rank = { patch: 0, minor: 1, major: 2 };
const count = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

// Only the last paragraph can supply a Release trailer. Quoted instructions in a body are not an override.
export function releaseSignal(message: string): { breaking: boolean; feature: boolean; fix: boolean; explicit: BumpKind | null; invalid: boolean } {
  const paragraphs = message.trim().split(/\r?\n[ \t]*\r?\n/);
  let subject = paragraphs[0]!.split(/\r?\n/)[0]!.trim();
  if (/^Merge pull request #\d+\b/.test(subject)) subject = paragraphs[1]?.split(/\r?\n/)[0]?.trim() ?? subject;
  const conventional = /^([a-z]+)(?:\([^\r\n()]+\))?(!)?:[ \t]+\S/i.exec(subject);
  const last = paragraphs.length > 1 ? paragraphs.at(-1)! : "";
  const trailers = last.split(/\r?\n/).every((line) => /^(?:[a-z][a-z0-9-]*|BREAKING CHANGE):/i.test(line) || /^[ \t]+\S/.test(line)) ? last : "";
  const overrides = [...trailers.matchAll(/^Release:[ \t]*(.*)$/gim)].map((m) => m[1]!.trim().toLowerCase());
  const explicit = overrides.filter((v): v is BumpKind => v === "patch" || v === "minor" || v === "major").sort((a, b) => rank[b] - rank[a])[0] ?? null;
  return {
    breaking: !!conventional?.[2] || paragraphs.slice(1).some((p) => /^BREAKING[ -]CHANGE:[ \t]*\S/m.test(p)),
    feature: conventional?.[1]?.toLowerCase() === "feat",
    fix: conventional?.[1]?.toLowerCase() === "fix",
    explicit,
    invalid: overrides.some((v) => !["patch", "minor", "major"].includes(v)),
  };
}

export function suggestBump(messages: string[], highest: string | null): Bump {
  const signals = messages.map(releaseSignal);
  const breaking = signals.filter((s) => s.breaking).length;
  const feats = signals.filter((s) => s.feature).length;
  const fixes = signals.filter((s) => s.fix).length;
  const explicit = signals.flatMap((s) => s.explicit ? [s.explicit] : []).sort((a, b) => rank[b] - rank[a])[0];
  const v = highest ? parseTag(highest) : null;
  const natural: Bump = breaking
    ? !v || v.major === 0
      ? { kind: "minor", reason: `${count(breaking)} marks a breaking change; before 1.0.0 that bumps the minor version` }
      : { kind: "major", reason: `${count(breaking)} marks a breaking change` }
    : feats ? { kind: "minor", reason: `${count(feats)} ${feats === 1 ? "adds a feature" : "add features"} (feat:)` }
    : fixes ? { kind: "patch", reason: `${count(fixes)} ${fixes === 1 ? "fixes" : "fix"} something (fix:)` }
    : { kind: "patch", reason: `no commit since ${highest ?? "the start"} uses Conventional Commits types, so pick the bump yourself` };
  return explicit && rank[explicit] >= rank[natural.kind] ? { kind: explicit, reason: `a Release: ${explicit} trailer requests this version bump` } : natural;
}

// Ignore only known documentation and automation paths. Unknown files, build files and dependencies count as code.
export const releaseFile = (file: string) => !/^(?:docs?\/|\.github\/|\.agents\/|\.claude\/|(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICEN[CS]E)(?:\.(?:[a-z-]+\.)?(?:md|mdx|rst|txt|adoc))?$)/i.test(file);

export type AutoDecision = { tag: string | null; kind: BumpKind | null; reason: string; blocked: boolean };

export function autoDecision(changes: CommitChange[], highest: string | null, netFiles: string[]): AutoDecision {
  const stop = (reason: string, blocked = false): AutoDecision => ({ tag: null, kind: null, reason, blocked });
  if (!changes.length) return stop("Nothing new since the highest version tag.");
  const version = highest ? parseTag(highest) : null;
  if (highest && (!version || version.pre !== null || ![version.major, version.minor, version.patch].every(Number.isSafeInteger))) {
    return stop("The highest tag is a prerelease or an unsupported version. Make a stable release manually first.", true);
  }
  const relevant = changes.filter((c) => c.files.some(releaseFile) || releaseSignal(c.message).explicit || releaseSignal(c.message).invalid);
  const signals = relevant.map((c) => releaseSignal(c.message));
  if (signals.some((s) => s.invalid)) return stop("Invalid Release trailer. Use Release: patch, Release: minor or Release: major.", true);
  if (!netFiles.some(releaseFile) && !signals.some((s) => s.explicit)) return stop("Only documentation or automation changed, or the changes were fully reverted.");
  const bump = suggestBump(relevant.map((c) => c.message), highest);
  if (bump.kind === "major" && !signals.some((s) => s.explicit === "major")) {
    return stop("Breaking changes need an explicit Release: major trailer or a manual release.", true);
  }
  const v = version ?? { major: 0, minor: 0, patch: 0 };
  const numbers = bump.kind === "major" ? [v.major + 1, 0, 0] : !version ? [0, 1, 0] : bump.kind === "minor" ? [v.major, v.minor + 1, 0] : [v.major, v.minor, v.patch + 1];
  if (!numbers.every(Number.isSafeInteger)) return stop("The next version exceeds the supported integer range.", true);
  return { tag: `v${numbers.join(".")}`, kind: bump.kind, reason: bump.reason.includes("pick the bump yourself") ? "Unclassified code changes use a patch bump." : bump.reason, blocked: false };
}
