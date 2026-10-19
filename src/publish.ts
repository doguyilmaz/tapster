import { parseChecksums, sha256 } from "./checksums";
import { compareSemver, parseTag } from "./config";
import { TapsterError } from "./errors";
import type { Asset, FetchLike, GitHub, Release } from "./github";
import { STAGING } from "./plan";

export type Outgoing = { name: string; data: Buffer };

const key = (x: Asset) => `${x.id}:${x.name}:${x.digest ?? ""}`;

export function sameAssets(before: Asset[], now: Asset[]): boolean {
  const a = before.map(key).sort();
  const b = now.map(key).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const checksumsLast = (names: string[]) => [...names.filter((n) => n !== "checksums.txt"), ...names.filter((n) => n === "checksums.txt")];

async function swap(gh: GitHub, repo: string, originals: Asset[], staged: Map<string, Asset>, remove: string[]): Promise<void> {
  const replace = async (name: string) => {
    const old = originals.find((x) => x.name === name);
    if (old) await gh.deleteAsset(repo, old.id);
    await gh.renameAsset(repo, staged.get(name)!.id, name);
  };
  for (const name of [...staged.keys()].filter((n) => n !== "checksums.txt")) await replace(name);
  for (const name of remove) {
    const old = originals.find((x) => x.name === name);
    if (old) await gh.deleteAsset(repo, old.id);
  }
  if (staged.has("checksums.txt")) await replace("checksums.txt");
}

export async function stageAndSwap(gh: GitHub, repo: string, releaseId: number, files: Outgoing[], before: Asset[], remove: string[] = []): Promise<void> {
  const current = await gh.getRelease(repo, releaseId);
  if (!current.draft) throw new TapsterError("the release was published while tapster worked on it", "Nothing was changed; check who published it.");
  if (!sameAssets(before, current.assets)) {
    throw new TapsterError("the draft changed while tapster worked on it", "The project is still uploading or edited the draft; the next run starts over.");
  }
  const staged = new Map<string, Asset>();
  for (const name of checksumsLast(files.map((f) => f.name))) {
    staged.set(name, await gh.uploadAsset(current, STAGING + name, files.find((f) => f.name === name)!.data));
  }
  await swap(gh, repo, current.assets, staged, remove);
}

export async function resumeSwap(gh: GitHub, repo: string, release: Release, recorded: string | undefined, removable: string[] = []): Promise<void> {
  const stagedAssets = release.assets.filter((x) => x.name.startsWith(STAGING));
  const discard = async (reason: string) => {
    for (const x of stagedAssets) await gh.deleteAsset(repo, x.id);
    throw new TapsterError(reason, "tapster removed the staging files; the next run signs the draft again.");
  };
  const stagedSums = stagedAssets.find((x) => x.name === `${STAGING}checksums.txt`);
  if (!recorded) return discard("the draft holds staging files that tapster has no record of uploading");
  if (stagedAssets.length === 0) return confirmSwapped(gh, repo, release, recorded);
  if (!stagedSums || stagedAssets.some((x) => x.state !== "uploaded")) return discard("an earlier run stopped while uploading the signed files");
  const sums = await gh.downloadAsset(repo, stagedSums.id);
  if (sha256(sums) !== recorded) return discard("the staged checksums.txt is not the one tapster recorded");
  const staged = new Map(stagedAssets.map((x) => [x.name.slice(STAGING.length), x] as const));
  const originals = release.assets.filter((x) => !x.name.startsWith(STAGING));
  const lines = parseChecksums(sums.toString("utf8"));
  const listed = new Set(lines.map((l) => l.name));
  const finalAsset = (name: string) => (staged.has(name) ? staged.get(name) : originals.find((x) => x.name === name));
  const unlistedStaged = [...staged.keys()].some((n) => n !== "checksums.txt" && !listed.has(n));
  if (unlistedStaged || !lines.every((l) => finalAsset(l.name)?.digest === `sha256:${l.sha256}`)) {
    return discard("the staged files do not match the checksums tapster recorded");
  }
  const unlisted = originals.map((x) => x.name).filter((n) => n !== "checksums.txt" && !listed.has(n) && !staged.has(n));
  const unexpected = unlisted.filter((n) => !removable.includes(n));
  if (unexpected.length) {
    throw new TapsterError(`the draft holds ${unexpected.join(", ")}, which tapster did not expect`, "Delete the draft and release again.");
  }
  await swap(gh, repo, originals, staged, unlisted);
}

async function confirmSwapped(gh: GitHub, repo: string, release: Release, recorded: string): Promise<void> {
  const changed = new TapsterError("the draft no longer matches what tapster recorded before publishing it", "Check who edited the draft; delete it and release again.");
  const sumsAsset = release.assets.find((x) => x.name === "checksums.txt");
  if (!sumsAsset) throw changed;
  const sums = await gh.downloadAsset(repo, sumsAsset.id);
  if (sha256(sums) !== recorded) throw changed;
  const lines = parseChecksums(sums.toString("utf8"));
  const others = release.assets.filter((x) => x.name !== "checksums.txt");
  if (lines.length !== others.length || !lines.every((l) => others.some((x) => x.name === l.name && x.digest === `sha256:${l.sha256}`))) throw changed;
}

export async function assertFinal(gh: GitHub, repo: string, releaseId: number, recorded: string): Promise<void> {
  const release = await gh.getRelease(repo, releaseId);
  if (!release.draft) throw new TapsterError("the release was published while tapster worked on it", "Check who published it; tapster did not update the cask.");
  await confirmSwapped(gh, repo, release, recorded);
}

export function assertRecorded(published: Buffer, recorded: string): void {
  if (sha256(published) !== recorded) {
    throw new TapsterError("the published checksums.txt is not the one tapster recorded", "Check who edited the release; tapster did not update the cask.");
  }
}

export function makeLatest(tag: string, releases: Release[]): "true" | "false" {
  const t = parseTag(tag);
  if (!t || t.pre) return "false";
  const higher = releases.some((r) => {
    if (r.draft || r.tag_name === tag) return false;
    const o = parseTag(r.tag_name);
    return o !== null && o.pre === null && compareSemver(o, t) > 0;
  });
  return higher ? "false" : "true";
}

export async function waitDownloadable(
  urls: string[],
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  deadlineMs = 300_000,
): Promise<void> {
  const start = Date.now();
  let pending = [...urls];
  for (;;) {
    const next: string[] = [];
    for (const url of pending) {
      const res = await fetchImpl(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
      if (!res || res.status !== 200) next.push(url);
    }
    pending = next;
    if (pending.length === 0) return;
    if (Date.now() - start > deadlineMs) {
      throw new TapsterError(`${pending.length} published file(s) did not download yet`, "GitHub was slow; the next run renders the cask once they download.");
    }
    await sleep(10_000);
  }
}
