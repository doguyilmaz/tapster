import { expect, test } from "bun:test";
import { TapsterError } from "../src/errors";
import { rpmTags } from "../src/linux/rpmheader";

function header(tags: number[], store: number): Buffer {
  const h = Buffer.alloc(16 + tags.length * 16 + store);
  Buffer.from([0x8e, 0xad, 0xe8, 0x01]).copy(h, 0);
  h.writeUInt32BE(tags.length, 8);
  h.writeUInt32BE(store, 12);
  tags.forEach((t, i) => h.writeUInt32BE(t, 16 + i * 16));
  return h;
}

test("the signature and main header tags are read", () => {
  const lead = Buffer.alloc(96);
  lead.writeUInt32BE(0xedabeedb, 0);
  const sig = header([62, 1000], 5);
  const pad = Buffer.alloc((8 - ((96 + sig.length) % 8)) % 8);
  const rpm = Buffer.concat([lead, sig, pad, header([63, 1000, 1001], 3), Buffer.from("payload")]);
  expect(rpmTags(rpm)).toEqual({ signature: [62, 1000], main: [63, 1000, 1001] });
  expect(() => rpmTags(rpm.subarray(0, 120))).toThrow(TapsterError);
  expect(() => rpmTags(Buffer.alloc(200))).toThrow(TapsterError);
});
