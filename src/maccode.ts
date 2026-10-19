import { inflateRawSync } from "node:zlib";
import { LIMITS, isMachO, readTarGz } from "./archive";
import { TapsterError } from "./errors";

function zipHeads(zip: Buffer): { name: string; data: Buffer }[] {
  const fail = (what: string): never => {
    throw new TapsterError(`zip ${what}`, "");
  };
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("has no central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) fail("uses ZIP64");
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) fail("has a damaged central directory");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (flags & 1) fail("is encrypted");
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) fail("has a damaged entry");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + size > zip.length) fail("is truncated");
    const body = zip.subarray(start, start + size);
    if (method === 0) out.push({ name, data: body });
    else if (method === 8) out.push({ name, data: inflateRawSync(body, { maxOutputLength: LIMITS.entryBytes }) });
    else fail(`uses compression method ${method}`);
  }
  return out;
}

export function macCodeIn(name: string, data: Buffer): string | null {
  if (/\.(dmg|pkg|mpkg)$/i.test(name)) return `${name} is a macOS installer, which tapster does not sign`;
  if (isMachO(data)) return `${name} is a Mach-O binary that tapster does not sign`;
  try {
    if (/\.(tar\.gz|tgz)$/i.test(name)) {
      const hit = readTarGz(data).find((e) => e.type === "file" && isMachO(e.data));
      return hit ? `${name} holds the Mach-O file ${hit.name}, which tapster does not sign` : null;
    }
    if (/\.zip$/i.test(name)) {
      const hit = zipHeads(data).find((e) => isMachO(e.data));
      return hit ? `${name} holds the Mach-O file ${hit.name}, which tapster does not sign` : null;
    }
  } catch {
    return `${name} could not be inspected for macOS code`;
  }
  return null;
}
