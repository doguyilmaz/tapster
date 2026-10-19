import type { ChecksumLine } from "./checksums";
import { type PackageConfig, type Platform, assetName, isApp, parseTag, versionOf } from "./config";
import { TapsterError } from "./errors";
import type { Account, Release } from "./github";

export const STAGING = "tapster-staging--";

export type DraftStatus = { kind: "ready" } | { kind: "resume" } | { kind: "waiting"; reason: string } | { kind: "invalid"; reason: string };
export type WorkItem = { package: string; tag: string; releaseId: number; resume: boolean };

export function draftStatus(r: Release, pkg: PackageConfig, checksums: ChecksumLine[] | null, recorded?: string): DraftStatus {
  const tag = parseTag(r.tag_name);
  if (!tag) return { kind: "invalid", reason: `tag ${r.tag_name} is not like v1.2.3` };
  if (isApp(pkg) && tag.pre !== null) return { kind: "invalid", reason: "prereleases of apps are not published, because the feed would never serve them" };
  if (r.assets.some((a) => a.name.startsWith(STAGING))) return { kind: "resume" };
  if (recorded && r.assets.some((a) => a.name === "checksums.txt" && a.digest === `sha256:${recorded}`)) return { kind: "resume" };
  if (r.assets.some((a) => a.state !== "uploaded")) return { kind: "waiting", reason: "assets are still uploading" };
  if (!r.assets.some((a) => a.name === "checksums.txt")) return { kind: "waiting", reason: "checksums.txt is not attached yet" };
  const version = versionOf(r.tag_name);
  for (const platform of Object.keys(pkg.assets) as Platform[]) {
    const name = assetName(pkg, platform, version)!;
    if (!r.assets.some((a) => a.name === name)) return { kind: "waiting", reason: `${name} is not attached yet` };
  }
  if (!checksums) return { kind: "waiting", reason: "checksums.txt could not be read yet" };
  for (const a of r.assets) {
    if (a.name === "checksums.txt") continue;
    const line = checksums.find((l) => l.name === a.name);
    if (!line) return { kind: "invalid", reason: `${a.name} is attached but not listed in checksums.txt` };
    if (a.digest && a.digest !== `sha256:${line.sha256}`) return { kind: "invalid", reason: `${a.name} does not match checksums.txt` };
  }
  for (const l of checksums) {
    if (!r.assets.some((a) => a.name === l.name)) return { kind: "waiting", reason: `${l.name} is listed but not attached yet` };
  }
  return { kind: "ready" };
}

const CI = "github-actions[bot]";

export function draftOrigin(r: Release, owner: string): string | null {
  const trusted = (a: Account | null | undefined) => a?.login === CI || a?.login.toLowerCase() === owner.toLowerCase();
  const rule = `tapster takes drafts only from ${CI} or ${owner}`;
  if (!trusted(r.author)) return `the draft was created by ${r.author?.login ?? "an unknown account"}; ${rule}`;
  const foreign = r.assets.find((a) => !trusted(a.uploader));
  return foreign ? `${foreign.name} was uploaded by ${foreign.uploader?.login ?? "an unknown account"}; ${rule}` : null;
}

export type PlanOptions = {
  checksumsOf: (r: Release) => Promise<ChecksumLine[] | null>;
  recorded?: (releaseId: number) => string | undefined;
  owner: string;
  tagExists: (tag: string) => Promise<boolean>;
};

export type Note = { tag: string; releaseId: number; kind: "waiting" | "invalid"; reason: string; since: string | null };

export async function planPackage(pkg: PackageConfig, releases: Release[], opts: PlanOptions): Promise<{ items: WorkItem[]; notes: Note[] }> {
  const { checksumsOf, recorded = () => undefined } = opts;
  const items: WorkItem[] = [];
  const notes: Note[] = [];
  const note = (r: Release, kind: Note["kind"], reason: string) => notes.push({ tag: r.tag_name, releaseId: r.id, kind, reason, since: r.created_at || null });
  const drafts = releases.filter((r) => r.draft);
  const byTag = new Map<string, Release[]>();
  for (const r of drafts) byTag.set(r.tag_name, [...(byTag.get(r.tag_name) ?? []), r]);
  const published = new Set(releases.filter((r) => !r.draft).map((r) => r.tag_name));
  for (const [tag, list] of byTag) {
    if (published.has(tag)) {
      for (const r of list) note(r, "invalid", "a release for this tag is already published; delete the draft");
      continue;
    }
    if (list.length > 1) {
      for (const r of list) note(r, "invalid", "two drafts exist for this tag; delete one");
      continue;
    }
    const r = list[0]!;
    const ready = r.assets.some((a) => a.name === "checksums.txt") && r.assets.every((a) => a.state === "uploaded");
    let checksums: ChecksumLine[] | null = null;
    try {
      checksums = ready ? await checksumsOf(r) : null;
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      note(r, "invalid", e.reason);
      continue;
    }
    const status = draftStatus(r, pkg, checksums, recorded(r.id));
    if (status.kind === "waiting" || status.kind === "invalid") {
      note(r, status.kind, status.reason);
      continue;
    }
    if (status.kind === "ready") {
      const foreign = draftOrigin(r, opts.owner);
      if (foreign) {
        note(r, "invalid", foreign);
        continue;
      }
      if (!(await opts.tagExists(tag))) {
        note(r, "waiting", "the tag is not pushed yet; tapster publishes only tags that exist");
        continue;
      }
    }
    items.push({ package: pkg.name, tag, releaseId: r.id, resume: status.kind === "resume" });
  }
  return { items, notes };
}
