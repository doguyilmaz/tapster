import { expect, test } from "bun:test";
import { isMachO, readTarGz, writeTarGz } from "../src/archive";
import { TapsterError } from "../src/errors";
import { rawTarGz } from "./helpers/rawtar";

test("reads files, folders and inner symlinks", () => {
  const entries = readTarGz(
    rawTarGz([
      { name: "./bin/", type: "5", mode: 0o755 },
      { name: "./bin/aims", data: "binary", mode: 0o755 },
      { name: "./bin/link", type: "2", linkname: "aims" },
    ]),
  );
  expect(entries.map((e) => [e.name, e.type])).toEqual([
    ["bin", "dir"],
    ["bin/aims", "file"],
    ["bin/link", "symlink"],
  ]);
  expect(entries[1]!.mode).toBe(0o755);
});

test.each([
  ["absolute path", [{ name: "/etc/passwd", data: "x" }]],
  ["dot-dot", [{ name: "a/../../x", data: "x" }]],
  ["escaping symlink", [{ name: "a/l", type: "2", linkname: "../../etc" }]],
  ["absolute symlink", [{ name: "l", type: "2", linkname: "/etc/passwd" }]],
  ["hardlink", [{ name: "h", type: "1", linkname: "a" }]],
  ["fifo", [{ name: "f", type: "6" }]],
  ["device", [{ name: "d", type: "3" }]],
  ["duplicate", [{ name: "a", data: "1" }, { name: "./a", data: "2" }]],
])("rejects %s", (_, entries) => {
  expect(() => readTarGz(rawTarGz(entries))).toThrow(TapsterError);
});

test("enforces size limits", () => {
  expect(() => readTarGz(rawTarGz([{ name: "a", data: "x".repeat(2000) }]), { entryBytes: 1000, totalBytes: 1 << 20 })).toThrow(TapsterError);
  expect(() => readTarGz(rawTarGz([{ name: "a", data: "x".repeat(4000) }]), { entryBytes: 1 << 20, totalBytes: 2048 })).toThrow(TapsterError);
});

test("writing is deterministic and round-trips, including long names", () => {
  const long = `${"d".repeat(120)}/aims`;
  const entries = [
    { name: "b", type: "file" as const, mode: 0o755, data: Buffer.from("two") },
    { name: long, type: "file" as const, mode: 0o644, data: Buffer.from("one") },
    { name: "l", type: "symlink" as const, mode: 0o777, data: Buffer.alloc(0), linkname: "b" },
  ];
  const a = writeTarGz(entries, 1_700_000_000);
  const b = writeTarGz([...entries].reverse(), 1_700_000_000);
  expect(a.equals(b)).toBe(true);
  const back = readTarGz(a);
  expect(back.map((e) => e.name)).toEqual(["b", long, "l"]);
  expect(back[1]!.data.toString()).toBe("one");
  expect(back[2]!.linkname).toBe("b");
});

test("Mach-O detection", () => {
  const be = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(n, 0);
    b.writeUInt32BE(2, 4);
    return b;
  };
  expect(isMachO(be(0xcffaedfe))).toBe(true);
  expect(isMachO(be(0xfeedfacf))).toBe(true);
  expect(isMachO(be(0xcafebabe))).toBe(true);
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
  expect(isMachO(javaClass)).toBe(false);
  expect(isMachO(Buffer.from("#!/bin/sh\n"))).toBe(false);
});
