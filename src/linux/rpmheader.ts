import { TapsterError } from "../errors";

const bad = (what: string) => new TapsterError(`an rpm ${what}`, "Check the linux-build job.");
const MAGIC = Buffer.from([0x8e, 0xad, 0xe8, 0x01]);

function header(data: Buffer, at: number): { tags: number[]; end: number } {
  if (at + 16 > data.length || !data.subarray(at, at + 4).equals(MAGIC)) throw bad("has a damaged header");
  const count = data.readUInt32BE(at + 8);
  const size = data.readUInt32BE(at + 12);
  if (count > 10_000 || size > 64 << 20) throw bad("has an oversized header");
  const end = at + 16 + count * 16 + size;
  if (end > data.length) throw bad("is truncated");
  const tags: number[] = [];
  for (let i = 0; i < count; i++) tags.push(data.readUInt32BE(at + 16 + i * 16));
  return { tags, end };
}

export function rpmTags(data: Buffer): { signature: number[]; main: number[] } {
  if (data.length < 96 || data.readUInt32BE(0) !== 0xedabeedb) throw bad("has no rpm lead");
  const sig = header(data, 96);
  const main = header(data, sig.end + ((8 - (sig.end % 8)) % 8));
  return { signature: sig.tags, main: main.tags };
}
