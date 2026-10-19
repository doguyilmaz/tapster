import { gzipSync } from "node:zlib";

export type Raw = { name: string; type?: string; data?: string | Buffer; linkname?: string; mode?: number; prefix?: string; gnu?: boolean; uid?: number; uname?: string };

function field(h: Buffer, off: number, len: number, value: string) {
  h.write(value, off, Math.min(len, Buffer.byteLength(value)), "utf8");
}

export function rawTarGz(entries: Raw[], trailer = Buffer.alloc(0)): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const h = Buffer.alloc(512);
    field(h, 0, 100, e.name);
    field(h, 100, 8, `${(e.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    field(h, 108, 8, `${(e.uid ?? 0).toString(8).padStart(7, "0")}\0`);
    field(h, 116, 8, "0000000\0");
    field(h, 124, 12, `${data.length.toString(8).padStart(11, "0")}\0`);
    field(h, 136, 12, "00000000000\0");
    h.fill(0x20, 148, 156);
    field(h, 156, 1, e.type ?? "0");
    field(h, 157, 100, e.linkname ?? "");
    if (e.gnu) field(h, 257, 8, "ustar  \0");
    else {
      field(h, 257, 6, "ustar\0");
      field(h, 263, 2, "00");
    }
    if (e.prefix) field(h, 345, 155, e.prefix);
    if (e.uname) field(h, 265, 32, e.uname);
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024), trailer);
  return gzipSync(Buffer.concat(blocks));
}

export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len++;
  return `${len}${body}`;
}

export function rawZip(entries: { name: string; data: Buffer; deflate?: boolean; encrypted?: boolean }[]): Buffer {
  const { crc32, deflateRawSync } = require("node:zlib") as typeof import("node:zlib");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(e.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
