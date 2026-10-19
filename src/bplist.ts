export type BplistValue = string | number | boolean | { $real: number } | { [key: string]: BplistValue };

type Node = { dict: { keys: number[]; values: number[] } } | { scalar: string | number | boolean | { $real: number } };

const isReal = (v: unknown): v is { $real: number } => typeof v === "object" && v !== null && "$real" in v;

function intBytes(n: number): Buffer {
  if (n >= 0 && n < 0x100) return Buffer.from([0x10, n]);
  if (n >= 0 && n < 0x10000) return Buffer.concat([Buffer.from([0x11]), Buffer.from([n >> 8, n & 0xff])]);
  if (n >= 0 && n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = 0x12;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0x13;
  b.writeBigInt64BE(BigInt(n), 1);
  return b;
}

const marker = (high: number, n: number) => (n < 15 ? Buffer.from([(high << 4) | n]) : Buffer.concat([Buffer.from([(high << 4) | 0x0f]), intBytes(n)]));

function sizeFor(n: number): number {
  return n < 0x100 ? 1 : n < 0x10000 ? 2 : n < 0x100000000 ? 4 : 8;
}

function uint(n: number, size: number): Buffer {
  const b = Buffer.alloc(size);
  if (size === 8) b.writeBigUInt64BE(BigInt(n));
  else b.writeUIntBE(n, 0, size);
  return b;
}

export function writeBplist(root: BplistValue): Buffer {
  const nodes: Node[] = [];
  const add = (v: BplistValue): number => {
    const index = nodes.length;
    if (typeof v === "object" && !isReal(v)) {
      const node = { dict: { keys: [] as number[], values: [] as number[] } };
      nodes.push(node);
      const keys = Object.keys(v).sort();
      for (const k of keys) node.dict.keys.push(add(k));
      for (const k of keys) node.dict.values.push(add(v[k]!));
    } else {
      nodes.push({ scalar: v });
    }
    return index;
  };
  add(root);
  const refSize = sizeFor(nodes.length);
  const encoded = nodes.map((node): Buffer => {
    if ("dict" in node) {
      return Buffer.concat([marker(0xd, node.dict.keys.length), ...node.dict.keys.map((r) => uint(r, refSize)), ...node.dict.values.map((r) => uint(r, refSize))]);
    }
    const v = node.scalar;
    if (typeof v === "boolean") return Buffer.from([v ? 0x09 : 0x08]);
    if (isReal(v) || (typeof v === "number" && !Number.isInteger(v))) {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(isReal(v) ? v.$real : v, 1);
      return b;
    }
    if (typeof v === "number") return intBytes(v);
    if (/^[\x00-\x7f]*$/.test(v)) return Buffer.concat([marker(0x5, v.length), Buffer.from(v, "latin1")]);
    const utf16 = Buffer.from(v, "utf16le").swap16();
    return Buffer.concat([marker(0x6, utf16.length / 2), utf16]);
  });
  const offsets: number[] = [];
  let at = 8;
  for (const e of encoded) {
    offsets.push(at);
    at += e.length;
  }
  const offsetSize = sizeFor(at);
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(nodes.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([Buffer.from("bplist00", "latin1"), ...encoded, ...offsets.map((o) => uint(o, offsetSize)), trailer]);
}
