import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeSparkleKey, signExpanded } from "../src/sparkle-key";
import { resetMaskForTests, scrub } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(resetMaskForTests);

const vectors = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
];

const expand = (seedHex: string) => {
  const h = createHash("sha512").update(Buffer.from(seedHex, "hex")).digest();
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return h;
};

test("seed keys (Sparkle's current format) sign the RFC 8032 vectors", () => {
  for (const v of vectors) {
    const key = decodeSparkleKey(Buffer.from(v.seed, "hex").toString("base64"));
    expect(key.publicKey).toBe(Buffer.from(v.pub, "hex").toString("base64"));
    expect(key.sign(Buffer.from(v.msg, "hex")).toString("hex")).toBe(v.sig);
  }
});

test("expanded keys (Sparkle's older 96-byte format) sign the same vectors", () => {
  for (const v of vectors) {
    expect(signExpanded(expand(v.seed), Buffer.from(v.pub, "hex"), Buffer.from(v.msg, "hex")).toString("hex")).toBe(v.sig);
    const old = Buffer.concat([expand(v.seed), Buffer.from(v.pub, "hex")]).toString("base64");
    const key = decodeSparkleKey(old);
    expect(key.publicKey).toBe(Buffer.from(v.pub, "hex").toString("base64"));
    expect(key.sign(Buffer.from(v.msg, "hex")).toString("hex")).toBe(v.sig);
  }
});

test("a 96-byte key whose public half does not match is rejected", () => {
  const v = vectors[0]!;
  const wrong = Buffer.concat([expand(v.seed), Buffer.from(vectors[1]!.pub, "hex")]).toString("base64");
  expect(() => decodeSparkleKey(wrong)).toThrow(TapsterError);
});

test.each([["empty", ""], ["not base64", "%%%"], ["wrong length", Buffer.alloc(48).toString("base64")]])("rejects %s", (_, text) => {
  expect(() => decodeSparkleKey(text)).toThrow(TapsterError);
});

test("derived forms of the key are masked", () => {
  const seed = Buffer.from(vectors[0]!.seed, "hex");
  decodeSparkleKey(seed.toString("base64"));
  expect(scrub(`x ${seed.toString("hex")} y`)).toBe("x *** y");
});
