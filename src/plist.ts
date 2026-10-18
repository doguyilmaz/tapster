import { TapsterError } from "./errors";

export type PlistValue = string | number | boolean | Date | Buffer | PlistValue[] | { [key: string]: PlistValue };

const MAX_BYTES = 1 << 20;
const MAX_DEPTH = 32;

const bad = (what: string) => new TapsterError(`an Info.plist ${what}`, "Rebuild the app; tapster reads XML and binary property lists.");

export function parsePlist(data: Buffer): PlistValue {
  if (data.length > MAX_BYTES) throw bad("is larger than 1 MiB");
  if (data.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(data);
  return parseXml(data.toString("utf8"));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    if (v === undefined) throw bad(`uses an unknown entity ${m}`);
    return v;
  });
}

type Token = { kind: "open" | "close" | "empty"; name: string } | { kind: "text"; text: string };

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < xml.length) {
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) throw bad("has an unclosed comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end === -1) throw bad("has an unclosed CDATA section");
      tokens.push({ kind: "text", text: xml.slice(i + 9, end) });
      i = end + 3;
    } else if (xml.startsWith("<?", i) || xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i);
      if (end === -1) throw bad("is not valid XML");
      i = end + 1;
    } else if (xml[i] === "<") {
      const end = xml.indexOf(">", i);
      if (end === -1) throw bad("is not valid XML");
      const body = xml.slice(i + 1, end).trim();
      const m = /^(\/)?([A-Za-z]+)(?:\s[^/]*)?(\/)?$/.exec(body);
      if (!m) throw bad("has a tag tapster does not read");
      tokens.push({ kind: m[1] ? "close" : m[3] ? "empty" : "open", name: m[2]! });
      i = end + 1;
    } else {
      const end = xml.indexOf("<", i);
      const text = xml.slice(i, end === -1 ? xml.length : end);
      tokens.push({ kind: "text", text: decodeText(text) });
      i = end === -1 ? xml.length : end;
    }
  }
  return tokens;
}

function parseXml(xml: string): PlistValue {
  const tokens = tokenize(xml).filter((t) => !(t.kind === "text" && t.text.trim() === ""));
  let pos = 0;
  const next = () => tokens[pos++];
  const peek = () => tokens[pos];
  const textUntil = (name: string): string => {
    let text = "";
    for (;;) {
      const t = next();
      if (!t) throw bad(`has an unclosed <${name}>`);
      if (t.kind === "text") text += t.text;
      else if (t.kind === "close" && t.name === name) return text;
      else throw bad(`has markup inside <${name}>`);
    }
  };
  const value = (depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw bad("is nested too deeply");
    const t = next();
    if (!t || t.kind === "text" || t.kind === "close") throw bad("is missing a value");
    if (t.kind === "empty") {
      if (t.name === "true") return true;
      if (t.name === "false") return false;
      if (t.name === "string") return "";
      if (t.name === "dict") return {};
      if (t.name === "array") return [];
      if (t.name === "data") return Buffer.alloc(0);
      throw bad(`has an unknown <${t.name}/>`);
    }
    switch (t.name) {
      case "string":
        return textUntil("string");
      case "integer": {
        const s = textUntil("integer").trim();
        if (!/^[+-]?\d{1,15}$/.test(s)) throw bad("has an integer tapster does not read");
        return Number(s);
      }
      case "real": {
        const n = Number(textUntil("real").trim());
        if (!Number.isFinite(n)) throw bad("has an invalid real");
        return n;
      }
      case "date": {
        const d = new Date(textUntil("date").trim());
        if (Number.isNaN(d.getTime())) throw bad("has an invalid date");
        return d;
      }
      case "data":
        return Buffer.from(textUntil("data").replace(/\s+/g, ""), "base64");
      case "array": {
        const out: PlistValue[] = [];
        for (;;) {
          const p = peek();
          if (p?.kind === "close" && p.name === "array") {
            pos++;
            return out;
          }
          out.push(value(depth + 1));
        }
      }
      case "dict": {
        const out: { [key: string]: PlistValue } = {};
        for (;;) {
          const p = next();
          if (p?.kind === "close" && p.name === "dict") return out;
          if (p?.kind !== "open" || p.name !== "key") throw bad("has a dict entry without a key");
          const key = textUntil("key");
          if (Object.hasOwn(out, key)) throw bad(`lists the key ${key} twice`);
          Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        }
      }
      default:
        throw bad(`has an unknown <${t.name}>`);
    }
  };
  const first = next();
  if (!first || first.kind !== "open" || first.name !== "plist") throw bad("does not start with <plist>");
  const v = value(1);
  const last = next();
  if (!last || last.kind !== "close" || last.name !== "plist" || pos !== tokens.length) throw bad("has content after its value");
  return v;
}

function parseBinary(data: Buffer): PlistValue {
  if (data.length < 8 + 32) throw bad("is truncated");
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6]!;
  const refSize = trailer[7]!;
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableAt = Number(trailer.readBigUInt64BE(24));
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw bad("has a damaged trailer");
  if (count < 1 || top >= count || tableAt < 8 || tableAt + count * offsetSize > data.length - 32) throw bad("has a damaged offset table");
  const uint = (at: number, size: number): number => {
    if (at + size > data.length - 32) throw bad("is truncated");
    const v = size === 8 ? data.readBigUInt64BE(at) : BigInt(data.readUIntBE(at, size));
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bad("has a number tapster does not read");
    return Number(v);
  };
  const offset = (ref: number): number => {
    if (ref >= count) throw bad("has a reference outside its objects");
    const at = uint(tableAt + ref * offsetSize, offsetSize);
    if (at < 8 || at >= tableAt) throw bad("has an object outside its body");
    return at;
  };
  const visiting = new Set<number>();
  const object = (ref: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw bad("is nested too deeply");
    if (visiting.has(ref)) throw bad("refers to itself");
    visiting.add(ref);
    try {
      const at = offset(ref);
      const marker = data[at]!;
      const high = marker >> 4;
      const low = marker & 0x0f;
      const length = (): [number, number] => {
        if (low !== 0x0f) return [low, at + 1];
        const m = data[at + 1]!;
        if (m >> 4 !== 0x1) throw bad("has a damaged length");
        const size = 1 << (m & 0x0f);
        return [uint(at + 2, size), at + 2 + size];
      };
      switch (high) {
        case 0x0:
          if (marker === 0x08) return false;
          if (marker === 0x09) return true;
          throw bad("has an object tapster does not read");
        case 0x1: {
          const size = 1 << low;
          if (size === 8) {
            if (at + 9 > data.length - 32) throw bad("is truncated");
            const v = data.readBigInt64BE(at + 1);
            if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw bad("has a number tapster does not read");
            return Number(v);
          }
          if (size > 8) throw bad("has a number tapster does not read");
          return uint(at + 1, size);
        }
        case 0x2: {
          if (low === 2) return data.readFloatBE(at + 1);
          if (low === 3) return data.readDoubleBE(at + 1);
          throw bad("has a real tapster does not read");
        }
        case 0x3:
          if (marker !== 0x33) throw bad("has a damaged date");
          return new Date((978307200 + data.readDoubleBE(at + 1)) * 1000);
        case 0x4: {
          const [n, start] = length();
          if (start + n > tableAt) throw bad("is truncated");
          return Buffer.from(data.subarray(start, start + n));
        }
        case 0x5: {
          const [n, start] = length();
          if (start + n > tableAt) throw bad("is truncated");
          return data.subarray(start, start + n).toString("latin1");
        }
        case 0x6: {
          const [n, start] = length();
          if (start + n * 2 > tableAt) throw bad("is truncated");
          const swapped = Buffer.from(data.subarray(start, start + n * 2));
          swapped.swap16();
          return swapped.toString("utf16le");
        }
        case 0xa: {
          const [n, start] = length();
          if (start + n * refSize > tableAt) throw bad("is truncated");
          return Array.from({ length: n }, (_, i) => object(uint(start + i * refSize, refSize), depth + 1));
        }
        case 0xd: {
          const [n, start] = length();
          if (start + 2 * n * refSize > tableAt) throw bad("is truncated");
          const out: { [key: string]: PlistValue } = {};
          for (let i = 0; i < n; i++) {
            const key = object(uint(start + i * refSize, refSize), depth + 1);
            if (typeof key !== "string") throw bad("has a dict key that is not a string");
            if (Object.hasOwn(out, key)) throw bad(`lists the key ${key} twice`);
            Object.defineProperty(out, key, { value: object(uint(start + (n + i) * refSize, refSize), depth + 1), enumerable: true, writable: true, configurable: true });
          }
          return out;
        }
        default:
          throw bad("has an object tapster does not read");
      }
    } finally {
      visiting.delete(ref);
    }
  };
  return object(top, 1);
}
