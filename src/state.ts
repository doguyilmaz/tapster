import { z } from "zod";
import { NAME, TAG, compareSemver, parseTag } from "./config";
import { TapsterError } from "./errors";

export const STATE_PATH = ".tapster/state.json";
const KEEP = 20;

const entry = z
  .object({
    tag: z.string().regex(TAG),
    releaseId: z.number().int().positive(),
    checksums: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["publishing", "published"]),
    app: z.object({ macos: z.string().regex(/^[a-z_]+$/), identifiers: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)) }).strict().optional(),
  })
  .strict();
const schema = z.object({ version: z.literal(1), packages: z.record(z.string().regex(NAME), z.array(entry)) }).strict();

export type StateEntry = z.infer<typeof entry>;
export type State = z.infer<typeof schema>;

export const emptyState = (): State => ({ version: 1, packages: {} });

const damaged = () => new TapsterError(".tapster/state.json is damaged", "Restore it from the hub's git history.");

export function parseState(text: string | null): State {
  if (text === null) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw damaged();
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw damaged();
  return r.data;
}

const byNewest = (a: StateEntry, b: StateEntry) => compareSemver(parseTag(b.tag)!, parseTag(a.tag)!);

export function upsert(s: State, pkg: string, e: StateEntry): State {
  const list = (s.packages[pkg] ?? []).filter((x) => x.releaseId !== e.releaseId && x.tag !== e.tag);
  const all = [...list, e].sort(byNewest);
  const kept = new Set(all.filter((x) => x.status === "published").slice(0, KEEP));
  return { ...s, packages: { ...s.packages, [pkg]: all.filter((x) => x.status === "publishing" || kept.has(x)) } };
}

export function latestPublished(s: State, pkg: string): StateEntry | undefined {
  return (s.packages[pkg] ?? []).filter((e) => e.status === "published" && parseTag(e.tag)!.pre === null).sort(byNewest)[0];
}

export function serializeState(s: State): string {
  const packages = Object.fromEntries(Object.keys(s.packages).sort().map((k) => [k, [...s.packages[k]!].sort(byNewest)]));
  return `${JSON.stringify({ version: 1, packages }, null, 2)}\n`;
}

export function recordedChecksums(s: State, pkg: string, releaseId: number): string | undefined {
  return s.packages[pkg]?.find((e) => e.releaseId === releaseId && e.status === "publishing")?.checksums;
}
