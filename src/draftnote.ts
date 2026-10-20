const OPEN = "<!-- tapster -->";
const CLOSE = "<!-- /tapster -->";
const BLOCK = /<!-- tapster -->[\s\S]*?<!-- \/tapster -->\n*/g;

export const noteText = (reason: string) => `> **tapster will not publish this draft:** ${reason}`;

export function noteIn(body: string | null | undefined): string | null {
  const block = new RegExp(`${OPEN}\\s*([\\s\\S]*?)${CLOSE}`).exec(body ?? "")?.[1];
  return block ? block.replace(/^>\s*/, "").replace(/\*\*/g, "").trim() : null;
}

export function withNote(body: string | null | undefined, reason: string | null): string {
  const rest = (body ?? "").replace(BLOCK, "");
  if (reason === null) return rest;
  const safe = reason.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;").replace(/[\r\n]+/g, " ");
  return `${OPEN}\n${noteText(safe)}\n${CLOSE}\n\n${rest}`;
}

// A release's created_at is the date of its tag or commit, which can be days old; the last upload says when the draft was worked on.
export function waitingSince(release: { created_at: string; assets: { created_at?: string }[] }): string | null {
  const times = release.assets.map((a) => a.created_at).filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : release.created_at || null;
}

export function judge(note: { kind: "waiting" | "invalid"; since: string | null }, now: number): "waiting" | "failed" {
  if (note.kind === "invalid") return "failed";
  const since = note.since ? Date.parse(note.since) : Number.NaN;
  return now - since > 3_600_000 ? "failed" : "waiting";
}

export function noteOutcome(
  note: { kind: "waiting" | "invalid"; reason: string; since: string | null },
  body: string | null | undefined,
  now: number,
): { result: "waiting" | "failed" | "known"; body: string | null; reason: string } {
  const failed = judge(note, now) === "failed";
  const reason = failed && note.kind === "waiting" ? `${note.reason} for more than an hour` : note.reason;
  const next = withNote(body, failed ? reason : null);
  const changed = next !== (body ?? "");
  if (!failed) return { result: "waiting", body: changed ? next : null, reason };
  return changed ? { result: "failed", body: next, reason } : { result: "known", body: null, reason };
}
