// src/auto/main.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

// src/semver.ts
var TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
function parseTag(tag) {
  const m = TAG.exec(tag);
  if (!m)
    return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}
function compareSemver(a, b) {
  for (const k of ["major", "minor", "patch"])
    if (a[k] !== b[k])
      return a[k] - b[k];
  if (a.pre === b.pre)
    return 0;
  if (a.pre === null)
    return 1;
  if (b.pre === null)
    return -1;
  const x = a.pre.split(".");
  const y = b.pre.split(".");
  for (let i = 0;i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined)
      return -1;
    if (q === undefined)
      return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q))
      return Number(p) - Number(q);
    if (pn !== qn)
      return pn ? -1 : 1;
    if (p !== q)
      return p < q ? -1 : 1;
  }
  return 0;
}

// src/release.ts
var rank = { patch: 0, minor: 1, major: 2 };
var count = (n) => `${n} ${n === 1 ? "commit" : "commits"}`;
function releaseSignal(message) {
  const paragraphs = message.trim().split(/\r?\n[ \t]*\r?\n/);
  let subject = paragraphs[0].split(/\r?\n/)[0].trim();
  if (/^Merge pull request #\d+\b/.test(subject))
    subject = paragraphs[1]?.split(/\r?\n/)[0]?.trim() ?? subject;
  const conventional = /^([a-z]+)(?:\([^\r\n()]+\))?(!)?:[ \t]+\S/i.exec(subject);
  const last = paragraphs.length > 1 ? paragraphs.at(-1) : "";
  const trailers = last.split(/\r?\n/).every((line) => /^(?:[a-z][a-z0-9-]*|BREAKING CHANGE):/i.test(line) || /^[ \t]+\S/.test(line)) ? last : "";
  const overrides = [...trailers.matchAll(/^Release:[ \t]*(.*)$/gim)].map((m) => m[1].trim().toLowerCase());
  const explicit = overrides.filter((v) => v === "patch" || v === "minor" || v === "major").sort((a, b) => rank[b] - rank[a])[0] ?? null;
  return {
    breaking: !!conventional?.[2] || paragraphs.slice(1).some((p) => /^BREAKING[ -]CHANGE:[ \t]*\S/m.test(p)),
    feature: conventional?.[1]?.toLowerCase() === "feat",
    fix: conventional?.[1]?.toLowerCase() === "fix",
    explicit,
    invalid: overrides.some((v) => !["patch", "minor", "major"].includes(v))
  };
}
function suggestBump(messages, highest) {
  const signals = messages.map(releaseSignal);
  const breaking = signals.filter((s) => s.breaking).length;
  const feats = signals.filter((s) => s.feature).length;
  const fixes = signals.filter((s) => s.fix).length;
  const explicit = signals.flatMap((s) => s.explicit ? [s.explicit] : []).sort((a, b) => rank[b] - rank[a])[0];
  const v = highest ? parseTag(highest) : null;
  const natural = breaking ? !v || v.major === 0 ? { kind: "minor", reason: `${count(breaking)} marks a breaking change; before 1.0.0 that bumps the minor version` } : { kind: "major", reason: `${count(breaking)} marks a breaking change` } : feats ? { kind: "minor", reason: `${count(feats)} ${feats === 1 ? "adds a feature" : "add features"} (feat:)` } : fixes ? { kind: "patch", reason: `${count(fixes)} ${fixes === 1 ? "fixes" : "fix"} something (fix:)` } : { kind: "patch", reason: `no commit since ${highest ?? "the start"} uses Conventional Commits types, so pick the bump yourself` };
  return explicit && rank[explicit] >= rank[natural.kind] ? { kind: explicit, reason: `a Release: ${explicit} trailer requests this version bump` } : natural;
}
var releaseFile = (file) => !/^(?:docs?\/|\.github\/|\.agents\/|\.claude\/|(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICEN[CS]E)(?:\.(?:[a-z-]+\.)?(?:md|mdx|rst|txt|adoc))?$)/i.test(file);
function autoDecision(changes, highest, netFiles) {
  const stop = (reason, blocked = false) => ({ tag: null, kind: null, reason, blocked });
  if (!changes.length)
    return stop("Nothing new since the highest version tag.");
  const version = highest ? parseTag(highest) : null;
  if (highest && (!version || version.pre !== null || ![version.major, version.minor, version.patch].every(Number.isSafeInteger))) {
    return stop("The highest tag is a prerelease or an unsupported version. Make a stable release manually first.", true);
  }
  const relevant = changes.filter((c) => c.files.some(releaseFile) || releaseSignal(c.message).explicit || releaseSignal(c.message).invalid);
  const signals = relevant.map((c) => releaseSignal(c.message));
  if (signals.some((s) => s.invalid))
    return stop("Invalid Release trailer. Use Release: patch, Release: minor or Release: major.", true);
  if (!netFiles.some(releaseFile) && !signals.some((s) => s.explicit))
    return stop("Only documentation or automation changed, or the changes were fully reverted.");
  const bump = suggestBump(relevant.map((c) => c.message), highest);
  if (bump.kind === "major" && !signals.some((s) => s.explicit === "major")) {
    return stop("Breaking changes need an explicit Release: major trailer or a manual release.", true);
  }
  const v = version ?? { major: 0, minor: 0, patch: 0 };
  const numbers = bump.kind === "major" ? [v.major + 1, 0, 0] : !version ? [0, 1, 0] : bump.kind === "minor" ? [v.major, v.minor + 1, 0] : [v.major, v.minor, v.patch + 1];
  if (!numbers.every(Number.isSafeInteger))
    return stop("The next version exceeds the supported integer range.", true);
  return { tag: `v${numbers.join(".")}`, kind: bump.kind, reason: bump.reason.includes("pick the bump yourself") ? "Unclassified code changes use a patch bump." : bump.reason, blocked: false };
}
// src/web/status.ts
var SKIP = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
var SKIP_TRAILER = /^skip-checks:\s*true\s*$/im;
function skipMarker(message) {
  const marker = SKIP.exec(message)?.[0];
  if (marker)
    return marker;
  const paragraphs = message.split(/\r?\n[ \t]*\r?\n/).filter((p) => /\S/.test(p));
  return paragraphs.length > 1 && SKIP_TRAILER.test(paragraphs.at(-1)) ? "skip-checks: true" : null;
}
var JQ_SKIP = String.raw`(.commit.message | test("(?i)\\[(skip ci|ci skip|no ci|skip actions|actions skip)\\]")) or ([.commit.message | splits("\\r?\\n[ \\t]*\\r?\\n") | select(test("\\S"))] | length > 1 and (last | test("(?im)^skip-checks:\\s*true\\s*$")))`;

// src/auto/main.ts
class AutoReleaseError extends Error {
}
var shaPattern = /^[0-9a-f]{40,64}$/;
var git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
var digest = (refs) => createHash("sha256").update(refs.sort().join(`
`)).digest("hex");
var output = (values) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file)
    throw new AutoReleaseError("GitHub's output file is missing.");
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}
`).join(""));
};
async function pendingDraft() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !token)
    throw new AutoReleaseError("The repository or read token is missing.");
  for (let page = 1;page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!res.ok)
      throw new AutoReleaseError(`Could not check pending drafts (HTTP ${res.status}).`);
    const releases = await res.json();
    if (!Array.isArray(releases))
      throw new AutoReleaseError("GitHub returned an invalid release list.");
    if (releases.some((r) => r.draft && TAG.test(r.tag_name)))
      return true;
    if (releases.length < 100)
      return false;
  }
  throw new AutoReleaseError("The release list is too long to check safely.");
}
function context() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const branch = event.repository?.default_branch;
  if (!branch || process.env.GITHUB_REF !== `refs/heads/${branch}` || !["schedule", "push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? ""))
    throw new AutoReleaseError("Automatic releases run only on the default branch.");
  return branch;
}
async function plan() {
  context();
  output({ tag: "" });
  const sha = git("rev-parse", "HEAD").trim();
  if (!shaPattern.test(sha))
    throw new AutoReleaseError("Git returned an invalid commit.");
  if (skipMarker(git("show", "-s", "--format=%B", sha))) {
    console.log("The default branch tip skips workflows. Push an unmarked commit before releasing.");
    return;
  }
  const refs = git("for-each-ref", "--format=%(objectname)\t%(refname)", "refs/tags").trim().split(`
`).filter(Boolean);
  const tags = refs.map((r) => r.split("\t")[1].slice("refs/tags/".length)).filter((t) => TAG.test(t));
  if (tags.some((t) => !Object.values(parseTag(t)).filter((n) => typeof n === "number").every(Number.isSafeInteger)))
    throw new AutoReleaseError("A version tag exceeds the supported integer range.");
  const highest = tags.sort((a, b) => compareSemver(parseTag(b), parseTag(a)))[0] ?? null;
  if (highest && parseTag(highest).pre !== null)
    throw new AutoReleaseError("The highest tag is a prerelease. Make a stable release manually first.");
  if (highest) {
    try {
      git("merge-base", "--is-ancestor", `refs/tags/${highest}`, sha);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1)
        throw new AutoReleaseError("The highest tag is not an ancestor of the default branch. Make a stable manual release first.");
      throw error;
    }
  }
  const range = highest ? [`refs/tags/${highest}..${sha}`] : [sha];
  const ids = git("rev-list", "--max-count=1001", ...range).trim().split(`
`).filter(Boolean);
  if (ids.length > 1000)
    throw new AutoReleaseError("More than 1000 commits need analysis. Make a manual release first.");
  const changes = ids.map((id) => ({ message: git("show", "-s", "--format=%B", id), files: git("diff-tree", "--root", "--no-commit-id", "--name-only", "--no-ext-diff", "--no-textconv", "-r", "--first-parent", "-m", "-z", id).split("\x00").filter(Boolean) }));
  const netFiles = highest ? git("diff", "--name-only", "--no-ext-diff", "--no-textconv", "-z", `refs/tags/${highest}`, sha).split("\x00").filter(Boolean) : git("ls-tree", "-r", "--name-only", "-z", sha).split("\x00").filter(Boolean);
  const decision = autoDecision(changes, highest, netFiles);
  console.log(decision.reason);
  if (decision.blocked)
    throw new AutoReleaseError("Automatic release needs a manual version decision.");
  if (!decision.tag)
    return;
  if (await pendingDraft()) {
    console.log("A draft release is waiting for the hub. No new tag was created.");
    return;
  }
  output({ tag: decision.tag, sha, refs: digest(refs) });
  console.log(`Selected ${decision.tag}.`);
}
async function tag() {
  const branch = context();
  const { RELEASE_TAG: tag, RELEASE_SHA: sha, RELEASE_REFS: refs } = process.env;
  if (!tag || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || !sha || !shaPattern.test(sha) || !refs || !/^[0-9a-f]{64}$/.test(refs))
    throw new AutoReleaseError("Invalid automatic release plan.");
  const remote = git("ls-remote", "--refs", "origin").trim().split(`
`).filter(Boolean);
  const tip = remote.find((r) => r.split("\t")[1] === `refs/heads/${branch}`)?.split("\t")[0];
  if (tip !== sha || digest(remote.filter((r) => r.split("\t")[1]?.startsWith("refs/tags/"))) !== refs) {
    console.log("The default branch or tags changed after analysis. The next run will analyze them again.");
    return;
  }
  if (git("rev-parse", "HEAD").trim() !== sha || skipMarker(git("show", "-s", "--format=%B", sha)))
    throw new AutoReleaseError("The checked-out commit does not match the release plan.");
  if (await pendingDraft()) {
    console.log("A draft release appeared after analysis. No new tag was created.");
    return;
  }
  git("tag", "--no-sign", tag, sha);
  git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
  console.log(`Pushed ${tag}; the project's release workflow builds it next.`);
}
try {
  if (process.argv[2] === "plan")
    await plan();
  else if (process.argv[2] === "tag")
    await tag();
  else
    throw new AutoReleaseError("Choose plan or tag.");
} catch (error) {
  console.error(error instanceof AutoReleaseError ? error.message : "Automatic release failed while reading or updating Git. Check the repository and re-run.");
  process.exitCode = 1;
}
