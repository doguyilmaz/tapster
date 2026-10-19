import { expect, test } from "bun:test";
import { writeBplist } from "../src/bplist";
import { dsStore } from "../src/dsstore";
import { parsePlist } from "../src/plist";

const layout = { window: [200, 120, 780, 500] as [number, number, number, number], icon_size: 110, app: [150, 170] as [number, number], applications: [430, 170] as [number, number] };

test("binary plists round-trip through tapster's reader", () => {
  const value = { WindowBounds: "{{200, 120}, {580, 380}}", ShowSidebar: false, iconSize: 110, gridSpacing: 100.5, viewOptionsVersion: 1, negative: -3, nested: { a: true } };
  const bytes = writeBplist(value);
  expect(bytes.subarray(0, 8).toString("latin1")).toBe("bplist00");
  expect(parsePlist(bytes)).toEqual(value);
});

function readStore(b: Buffer) {
  const at = (o: number) => o + 4;
  expect(b.readUInt32BE(0)).toBe(1);
  expect(b.subarray(4, 8).toString("latin1")).toBe("Bud1");
  const root = b.readUInt32BE(8);
  const count = b.readUInt32BE(at(root));
  const offsets = Array.from({ length: count }, (_, i) => b.readUInt32BE(at(root) + 8 + i * 4));
  const block = (n: number) => at(offsets[n]! & ~0x1f);
  let p = at(root) + 8 + Math.ceil(count / 256) * 256 * 4;
  const toc = b.readUInt32BE(p);
  p += 4;
  const nameLength = b[p]!;
  const tocName = b.subarray(p + 1, p + 1 + nameLength).toString("latin1");
  const dsdb = b.readUInt32BE(p + 1 + nameLength);
  const leaf = b.readUInt32BE(block(dsdb));
  let q = block(leaf);
  expect(b.readUInt32BE(q)).toBe(0);
  const records = b.readUInt32BE(q + 4);
  q += 8;
  const out: { name: string; code: string; value: unknown }[] = [];
  for (let i = 0; i < records; i++) {
    const n = b.readUInt32BE(q);
    const name = Buffer.from(b.subarray(q + 4, q + 4 + n * 2)).swap16().toString("utf16le");
    q += 4 + n * 2;
    const code = b.subarray(q, q + 4).toString("latin1");
    const type = b.subarray(q + 4, q + 8).toString("latin1");
    q += 8;
    if (type === "long") {
      out.push({ name, code, value: b.readUInt32BE(q) });
      q += 4;
    } else {
      const len = b.readUInt32BE(q);
      const data = b.subarray(q + 4, q + 4 + len);
      q += 4 + len;
      out.push({ name, code, value: code === "Iloc" ? [data.readUInt32BE(0), data.readUInt32BE(4)] : parsePlist(data) });
    }
  }
  return { toc, tocName, out };
}

test("the store holds the window, the icon size and both positions", () => {
  const bytes = dsStore(layout, "HafifPix.app");
  expect(bytes.length).toBe(16388);
  const { toc, tocName, out } = readStore(bytes);
  expect([toc, tocName]).toEqual([1, "DSDB"]);
  expect(out.map((r) => `${r.name} ${r.code}`)).toEqual([". bwsp", ". icvp", ". vSrn", "Applications Iloc", "HafifPix.app Iloc"]);
  expect((out[0]!.value as { WindowBounds: string }).WindowBounds).toBe("{{200, 400}, {580, 380}}");
  expect((out[1]!.value as { iconSize: number }).iconSize).toBe(110);
  expect(out[3]!.value).toEqual([430, 170]);
  expect(out[4]!.value).toEqual([150, 170]);
});

test("records are sorted by name without case, and the output is stable", () => {
  const { out } = readStore(dsStore(layout, "Aardvark.app"));
  expect(out.map((r) => r.name)).toEqual([".", ".", ".", "Aardvark.app", "Applications"]);
  expect(dsStore(layout, "HafifPix.app").equals(dsStore(layout, "HafifPix.app"))).toBe(true);
});
