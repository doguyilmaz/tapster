// Bundled into each generated workflow. It reads Git objects and never imports or executes project code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { autoDecision } from "../release";
import { TAG, compareSemver, parseTag } from "../semver";
import { skipMarker } from "../web/status";

class AutoReleaseError extends Error {}

const shaPattern = /^[0-9a-f]{40,64}$/;
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
const digest = (refs: string[]) => createHash("sha256").update(refs.sort().join("\n")).digest("hex");
const output = (values: Record<string, string>) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new AutoReleaseError("GitHub's output file is missing.");
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
};

async function pendingDraft(): Promise<boolean> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !token) throw new AutoReleaseError("The repository or read token is missing.");
  // GitHub.com is the only supported host; never send the token to an event-supplied URL.
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!res.ok) throw new AutoReleaseError(`Could not check pending drafts (HTTP ${res.status}).`);
    const releases = await res.json() as { draft: boolean; tag_name: string }[];
    if (!Array.isArray(releases)) throw new AutoReleaseError("GitHub returned an invalid release list.");
    if (releases.some((r) => r.draft && TAG.test(r.tag_name))) return true;
    if (releases.length < 100) return false;
  }
  throw new AutoReleaseError("The release list is too long to check safely.");
}

function context(): string {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as { repository?: { default_branch?: string } };
  const branch = event.repository?.default_branch;
  if (!branch || process.env.GITHUB_REF !== `refs/heads/${branch}` || !["schedule", "push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")) throw new AutoReleaseError("Automatic releases run only on the default branch.");
  return branch;
}

async function plan() {
  context();
  output({ tag: "" });
  const sha = git("rev-parse", "HEAD").trim();
  if (!shaPattern.test(sha)) throw new AutoReleaseError("Git returned an invalid commit.");
  if (skipMarker(git("show", "-s", "--format=%B", sha))) {
    console.log("The default branch tip skips workflows. Push an unmarked commit before releasing.");
    return;
  }
  const refs = git("for-each-ref", "--format=%(objectname)\t%(refname)", "refs/tags").trim().split("\n").filter(Boolean);
  const tags = refs.map((r) => r.split("\t")[1]!.slice("refs/tags/".length)).filter((t) => TAG.test(t));
  if (tags.some((t) => !Object.values(parseTag(t)!).filter((n) => typeof n === "number").every(Number.isSafeInteger))) throw new AutoReleaseError("A version tag exceeds the supported integer range.");
  const highest = tags.sort((a, b) => compareSemver(parseTag(b)!, parseTag(a)!))[0] ?? null;
  if (highest && parseTag(highest)!.pre !== null) throw new AutoReleaseError("The highest tag is a prerelease. Make a stable release manually first.");
  if (highest) {
    try { git("merge-base", "--is-ancestor", `refs/tags/${highest}`, sha); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1) throw new AutoReleaseError("The highest tag is not an ancestor of the default branch. Make a stable manual release first.");
      throw error;
    }
  }
  const range = highest ? [`refs/tags/${highest}..${sha}`] : [sha];
  const ids = git("rev-list", "--max-count=1001", ...range).trim().split("\n").filter(Boolean);
  if (ids.length > 1000) throw new AutoReleaseError("More than 1000 commits need analysis. Make a manual release first.");
  const changes = ids.map((id) => ({ message: git("show", "-s", "--format=%B", id), files: git("diff-tree", "--root", "--no-commit-id", "--name-only", "--no-ext-diff", "--no-textconv", "-r", "--first-parent", "-m", "-z", id).split("\0").filter(Boolean) }));
  const netFiles = highest ? git("diff", "--name-only", "--no-ext-diff", "--no-textconv", "-z", `refs/tags/${highest}`, sha).split("\0").filter(Boolean) : git("ls-tree", "-r", "--name-only", "-z", sha).split("\0").filter(Boolean);
  const decision = autoDecision(changes, highest, netFiles);
  console.log(decision.reason);
  if (decision.blocked) throw new AutoReleaseError("Automatic release needs a manual version decision.");
  if (!decision.tag) return;
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
  if (!tag || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || !sha || !shaPattern.test(sha) || !refs || !/^[0-9a-f]{64}$/.test(refs)) throw new AutoReleaseError("Invalid automatic release plan.");
  const remote = git("ls-remote", "--refs", "origin").trim().split("\n").filter(Boolean);
  const tip = remote.find((r) => r.split("\t")[1] === `refs/heads/${branch}`)?.split("\t")[0];
  if (tip !== sha || digest(remote.filter((r) => r.split("\t")[1]?.startsWith("refs/tags/"))) !== refs) {
    console.log("The default branch or tags changed after analysis. The next run will analyze them again.");
    return;
  }
  if (git("rev-parse", "HEAD").trim() !== sha || skipMarker(git("show", "-s", "--format=%B", sha))) throw new AutoReleaseError("The checked-out commit does not match the release plan.");
  if (await pendingDraft()) {
    console.log("A draft release appeared after analysis. No new tag was created.");
    return;
  }
  git("tag", "--no-sign", tag, sha);
  // No force and no branch refspec: a racing tag creation fails instead of replacing anything.
  git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
  console.log(`Pushed ${tag}; the project's release workflow builds it next.`);
}

try {
  if (process.argv[2] === "plan") await plan();
  else if (process.argv[2] === "tag") await tag();
  else throw new AutoReleaseError("Choose plan or tag.");
} catch (error) {
  // Child-process errors can include credentials or repository-controlled text. Never print their output or stack.
  console.error(error instanceof AutoReleaseError ? error.message : "Automatic release failed while reading or updating Git. Check the repository and re-run.");
  process.exitCode = 1;
}
