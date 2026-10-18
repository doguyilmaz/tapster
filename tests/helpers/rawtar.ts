import { gzipSync } from "node:zlib";

export type Raw = { name: string; type?: string; data?: string; linkname?: string; mode?: number; prefix?: string; gnu?: boolean };

function field(h: Buffer, off: number, len: number, value: string) {
  h.write(value, off, Math.min(len, Buffer.byteLength(value)), "utf8");
}

export function rawTarGz(entries: Raw[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const h = Buffer.alloc(512);
    field(h, 0, 100, e.name);
    field(h, 100, 8, `${(e.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    field(h, 108, 8, "0000000\0");
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
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len++;
  return `${len}${body}`;
}
