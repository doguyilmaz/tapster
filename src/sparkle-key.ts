import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify } from "node:crypto";
import { TapsterError } from "./errors";
import { register } from "./mask";

// Ed25519 over the field 2^255 - 19, used only for Sparkle's older key format, which stores the expanded private key
// (the clamped SHA-512 of the seed) instead of the seed. Node's crypto signs only from a seed.
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
const pow = (base: bigint, exp: bigint) => {
  let r = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
};
const inv = (a: bigint) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));

type Point = [bigint, bigint, bigint, bigint];

function add([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * t1 * t2 * D);
  const d = mod(2n * z1 * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiply(scalar: bigint, point: Point): Point {
  let result: Point = [0n, 1n, 1n, 0n];
  let p = point;
  for (let s = scalar; s > 0n; s >>= 1n) {
    if (s & 1n) result = add(result, p);
    p = add(p, p);
  }
  return result;
}

const BASE: Point = (() => {
  const y = mod(4n * inv(5n));
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = pow(mod(u * inv(v)), (P + 3n) / 8n);
  if (mod(x * x * v - u) !== 0n) x = mod(x * pow(2n, (P - 1n) / 4n));
  if (x & 1n) x = P - x;
  return [x, y, 1n, mod(x * y)];
})();

const littleEndian = (b: Uint8Array) => b.reduceRight((v, byte) => (v << 8n) | BigInt(byte), 0n);

function bytes32(v: bigint): Buffer {
  const out = Buffer.alloc(32);
  let n = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function encode([x, y, z]: Point): Buffer {
  const zi = inv(z);
  const ax = mod(x * zi);
  const ay = mod(y * zi);
  return bytes32(ay | ((ax & 1n) << 255n));
}

const sha512 = (...parts: Uint8Array[]) => createHash("sha512").update(Buffer.concat(parts)).digest();

export function signExpanded(expanded: Buffer, publicKey: Buffer, message: Buffer): Buffer {
  const a = littleEndian(expanded.subarray(0, 32));
  const r = mod(littleEndian(sha512(expanded.subarray(32, 64), message)), L);
  const big = encode(multiply(r, BASE));
  const k = mod(littleEndian(sha512(big, publicKey, message)), L);
  return Buffer.concat([big, bytes32(mod(r + k * a, L))]);
}

export type SparkleKey = { publicKey: string; sign(data: Buffer): Buffer };

const PKCS8_SEED = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

const badKey = (why: string) =>
  new TapsterError(`the Sparkle key ${why}`, "Store the text that generate_keys -x writes, with tapster init --sparkle <label>.");

export function decodeSparkleKey(text: string): SparkleKey {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw badKey("is not base64");
  const raw = Buffer.from(trimmed, "base64");
  register(raw.toString("hex"));
  let publicKey: Buffer;
  let signer: (data: Buffer) => Buffer;
  if (raw.length === 32) {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_SEED, raw]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
    publicKey = spki.subarray(spki.length - 32);
    signer = (data) => nodeSign(null, data, key);
  } else if (raw.length === 96) {
    const expanded = raw.subarray(0, 64);
    register(expanded.toString("base64"));
    publicKey = Buffer.from(raw.subarray(64));
    if (!encode(multiply(littleEndian(expanded.subarray(0, 32)), BASE)).equals(publicKey)) throw badKey("is damaged: its two halves do not match");
    signer = (data) => signExpanded(expanded, publicKey, data);
  } else {
    throw badKey(`decodes to ${raw.length} bytes, not 32 or 96`);
  }
  const verifier = createPublicKey({ key: Buffer.concat([SPKI, publicKey]), format: "der", type: "spki" });
  return {
    publicKey: publicKey.toString("base64"),
    sign(data: Buffer): Buffer {
      const signature = signer(data);
      if (!verify(null, data, verifier, signature)) throw badKey("produced a signature that does not verify");
      return signature;
    },
  };
}
