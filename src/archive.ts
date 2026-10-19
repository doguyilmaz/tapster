import { posix } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { TapsterError } from "./errors";

export type TarEntry = { name: string; type: "file" | "dir" | "symlink"; mode: number; data: Buffer; linkname?: string };
export type Limits = { entryBytes: number; totalBytes: number };
export const LIMITS: Limits = { entryBytes: 1 << 30, totalBytes: 2 * (1 << 30) - 1 };

const bad = (what: string) => new TapsterError(`the archive ${what}`, "Rebuild the release; tapster accepts plain files, folders and symlinks that stay inside the archive.");

const cstr = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString("utf8");
};

function octal(h: Buffer, off: number, len: number): number {
  if (h[off]! & 0x80) throw bad("uses a number format tapster does not read");
  const s = cstr(h.subarray(off, off + len)).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw bad("has a damaged header");
  return Number.parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = Number(data.subarray(off, space).toString());
    if (!Number.isInteger(len) || len <= 0) throw bad("has a damaged extended header");
    const record = data.subarray(space + 1, off + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    off += len;
  }
  return out;
}

const PATH_MAX = 1024;
const MAX_ENTRIES = 200_000;
const MAX_HEADER = 64 * 1024;
const PRINTABLE = /^[\x20-\x5b\x5d-\x7e]+$/;

function safeName(raw: string): string {
  if (!PRINTABLE.test(raw)) throw bad("has a name with characters tapster does not accept (printable ASCII only, no backslash)");
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/")) throw bad(`has an absolute or empty path (${trimmed || "empty"})`);
  const norm = posix.normalize(trimmed).replace(/^(\.\/)+/, "");
  if (norm === "." || norm === ".." || norm.startsWith("../") || norm.split("/").includes("..")) throw bad(`has a path that leaves it (${trimmed})`);
  return norm;
}

function checkLink(name: string, target: string) {
  if (target === "" || target.startsWith("/")) throw bad(`has a symlink ${name} pointing outside`);
  if (!PRINTABLE.test(target)) throw bad(`has a symlink ${name} with characters tapster does not accept`);
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved === ".." || resolved.startsWith("../")) throw bad(`has a symlink ${name} pointing outside`);
}

export function readTarGz(gz: Buffer, limits: Limits = LIMITS): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: limits.totalBytes });
  } catch {
    throw bad("is not a valid tar.gz or is larger than allowed");
  }
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw bad("has a damaged header");
    const size = octal(h, 124, 12);
    if (size > limits.entryBytes) throw bad("holds a file larger than allowed");
    const type = String.fromCharCode(h[156]!);
    if ("LKxg".includes(type) && size > MAX_HEADER) throw bad("has an oversized extended header");
    const start = off + 512;
    if (start + size > tar.length) throw bad("is truncated");
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    if (type === "K") {
      longLink = cstr(data);
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") {
      const global = parsePax(data);
      if ("path" in global || "linkpath" in global || "size" in global) throw bad("has a global header that renames or resizes files");
      continue;
    }
    if (pax.size !== undefined && Number(pax.size) !== size) throw bad("has a damaged extended header");
    const posixHeader = h.subarray(257, 263).equals(Buffer.from("ustar\0", "latin1"));
    const prefix = posixHeader ? cstr(h.subarray(345, 500)) : "";
    const base = cstr(h.subarray(0, 100));
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const rawLink = pax.linkpath ?? longLink ?? cstr(h.subarray(157, 257));
    if (Buffer.byteLength(rawName) > PATH_MAX || Buffer.byteLength(rawLink) > PATH_MAX) throw bad("has a name longer than macOS allows");
    if (entries.length >= MAX_ENTRIES) throw bad(`holds more than ${MAX_ENTRIES} entries`);
    pax = {};
    longName = null;
    longLink = null;
    const kind = type === "0" || type === "\0" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : null;
    if (!kind) throw bad(`holds ${rawName}, which is not a file, folder or symlink`);
    if (kind === "dir" && /^(\.\/)*\.\/?$/.test(rawName)) continue;
    const name = safeName(rawName);
    if (seen.has(name.toLowerCase())) throw bad(`lists ${name} twice`);
    seen.add(name.toLowerCase());
    if (kind === "symlink") checkLink(name, rawLink);
    entries.push({ name, type: kind, mode: octal(h, 100, 8) & 0o7777, data: Buffer.from(data), ...(kind === "symlink" ? { linkname: rawLink } : {}) });
  }
  checkSymlinks(entries);
  return entries;
}

function checkSymlinks(entries: TarEntry[]) {
  const links = new Set(entries.filter((e) => e.type === "symlink").map((e) => e.name.toLowerCase()));
  if (links.size === 0) return;
  const names = entries.map((e) => e.name.toLowerCase()).sort();
  for (const link of links) {
    const below = `${link}/`;
    let lo = 0;
    let hi = names.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (names[mid]! < below) lo = mid + 1;
      else hi = mid;
    }
    if (names[lo]?.startsWith(below)) throw bad(`has ${names[lo]}, which passes through a symlink`);
  }
  for (const e of entries) {
    if (e.type !== "symlink") continue;
    const dir = posix.dirname(e.name);
    const stack = dir === "." ? [] : dir.split("/");
    const parts = e.linkname!.split("/").filter((p) => p !== "" && p !== ".");
    for (const [i, p] of parts.entries()) {
      if (p === "..") {
        if (stack.length === 0) throw bad(`has a symlink ${e.name} pointing outside`);
        stack.pop();
        continue;
      }
      stack.push(p);
      if (i < parts.length - 1 && links.has(stack.join("/").toLowerCase())) throw bad(`has a symlink ${e.name} whose target passes through another symlink`);
    }
  }
}

function put(h: Buffer, off: number, len: number, value: string) {
  h.write(value, off, Math.min(len, Buffer.byteLength(value)), "utf8");
}

function header(name: string, mode: number, size: number, mtime: number, type: string, linkname: string): Buffer {
  const h = Buffer.alloc(512);
  put(h, 0, 100, name);
  put(h, 100, 8, `${mode.toString(8).padStart(7, "0")}\0`);
  put(h, 108, 8, "0000000\0");
  put(h, 116, 8, "0000000\0");
  put(h, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  put(h, 136, 12, `${mtime.toString(8).padStart(11, "0")}\0`);
  h.fill(0x20, 148, 156);
  put(h, 156, 1, type);
  put(h, 157, 100, linkname);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len++;
  return `${len}${body}`;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

export function writeTarGz(entries: TarEntry[], mtime: number): Buffer {
  const blocks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const name = e.type === "dir" ? `${e.name}/` : e.name;
    const link = e.linkname ?? "";
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(link) > 100) {
      const body = Buffer.from(paxRecord("path", name) + (link ? paxRecord("linkpath", link) : ""));
      blocks.push(header("PaxHeader", 0o644, body.length, mtime, "x", ""), body, pad(body.length));
    }
    const data = e.type === "file" ? e.data : Buffer.alloc(0);
    const type = e.type === "file" ? "0" : e.type === "dir" ? "5" : "2";
    blocks.push(header(name.slice(0, 100), e.mode & 0o755, data.length, mtime, type, link.slice(0, 100)), data, pad(data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function isMachO(data: Buffer): boolean {
  if (data.length < 8) return false;
  const magic = data.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = data.readUInt32BE(4);
    return count > 0 && count < 32;
  }
  return false;
}
