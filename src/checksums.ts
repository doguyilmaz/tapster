import { createHash } from "node:crypto";
import { TapsterError } from "./errors";

export type ChecksumLine = { sha256: string; name: string };

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export function parseChecksums(text: string): ChecksumLine[] {
  const out: ChecksumLine[] = [];
  const names = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^([0-9a-fA-F]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new TapsterError(`checksums.txt line ${i + 1} is malformed`, 'Each line must be "<sha256>  <file name>".');
    const name = m[2]!;
    if (names.has(name)) throw new TapsterError(`checksums.txt lists ${name} twice`, "List each file once.");
    names.add(name);
    out.push({ sha256: m[1]!.toLowerCase(), name });
  }
  if (out.length === 0) throw new TapsterError("checksums.txt is empty", "List every release file with its sha256.");
  return out;
}

export function writeChecksums(lines: ChecksumLine[]): string {
  return `${[...lines]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => `${l.sha256}  ${l.name}`)
    .join("\n")}\n`;
}
