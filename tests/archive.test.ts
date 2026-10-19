import { expect, test } from "bun:test";
import { isMachO, readTarGz, writeTarGz } from "../src/archive";
import { TapsterError } from "../src/errors";
import { paxRecord, rawTarGz } from "./helpers/rawtar";

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
  ["symlink chain that leaves", [{ name: "s", type: "2", linkname: "." }, { name: "s/l", type: "2", linkname: "../x" }]],
  ["path through a symlink", [{ name: "sub/", type: "5" }, { name: "s", type: "2", linkname: "sub" }, { name: "s/f", data: "x" }]],
  ["link target through a symlink", [{ name: "s", type: "2", linkname: "." }, { name: "l", type: "2", linkname: "s/.." }]],
  ["PAX size that disagrees", [{ name: "PaxHeader", type: "x", data: paxRecord("size", "100") }, { name: "a", data: "x" }]],
  ["global header with a path", [{ name: "g", type: "g", data: paxRecord("path", "evil") }, { name: "a", data: "x" }]],
  ["duplicate that differs only in case", [{ name: "aims", data: "1" }, { name: "AIMS", data: "2" }]],
  ["path through a symlink spelled in another case", [{ name: "S", type: "2", linkname: "." }, { name: "s/l", type: "2", linkname: "../x" }]],
  ["non-ASCII name", [{ name: "a\u00e9", data: "x" }]],
  ["control character in a name", [{ name: "a\u0001b", data: "x" }]],
  ["backslash in a symlink target", [{ name: "l", type: "2", linkname: "..\\x" }]],
])("rejects %s", (_, entries) => {
  expect(() => readTarGz(rawTarGz(entries))).toThrow(TapsterError);
});

test("a bare ./ root entry is skipped", () => {
  const entries = readTarGz(rawTarGz([{ name: "./", type: "5", mode: 0o755 }, { name: "./konvoy", data: "x", mode: 0o755 }]));
  expect(entries.map((e) => e.name)).toEqual(["konvoy"]);
});

test("the prefix field counts only in POSIX headers", () => {
  expect(readTarGz(rawTarGz([{ name: "aims", prefix: "dir", data: "x" }]))[0]!.name).toBe("dir/aims");
  expect(readTarGz(rawTarGz([{ name: "aims", prefix: "14567012345", gnu: true, data: "x" }]))[0]!.name).toBe("aims");
});

test("an inner symlink chain and a global comment header are fine", () => {
  const entries = readTarGz(
    rawTarGz([
      { name: "g", type: "g", data: paxRecord("comment", "abc") },
      { name: "bin/", type: "5" },
      { name: "bin/aims", data: "x" },
      { name: "a", type: "2", linkname: "bin" },
      { name: "b", type: "2", linkname: "a" },
      { name: "bin/up", type: "2", linkname: "../bin/aims" },
    ]),
  );
  expect(entries.map((e) => e.name)).toEqual(["bin", "bin/aims", "a", "b", "bin/up"]);
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

test("the repack drops setuid, setgid, sticky and group or other write", () => {
  const out = readTarGz(writeTarGz([{ name: "x", type: "file", mode: 0o7777, data: Buffer.from("x") }, { name: "d", type: "dir", mode: 0o1777, data: Buffer.alloc(0) }], 1));
  expect(out.find((e) => e.name === "x")!.mode).toBe(0o755);
  expect(out.find((e) => e.name === "d")!.mode).toBe(0o755);
});

test("framework links that chain through other links are fine", () => {
  const entries = readTarGz(
    rawTarGz([
      { name: "S.framework/Versions/B/S", data: "x" },
      { name: "S.framework/Versions/B/Resources/Info.plist", data: "p" },
      { name: "S.framework/Versions/Current", type: "2", linkname: "B" },
      { name: "S.framework/S", type: "2", linkname: "Versions/Current/S" },
      { name: "S.framework/Resources", type: "2", linkname: "Versions/Current/Resources" },
    ]),
  );
  expect(entries.filter((e) => e.type === "symlink").length).toBe(3);
});

test.each([
  ["a chain that leaves", [{ name: "a", type: "2", linkname: "." }, { name: "b", type: "2", linkname: "a/.." }]],
  ["a loop", [{ name: "a", type: "2", linkname: "b" }, { name: "b", type: "2", linkname: "a" }, { name: "c", type: "2", linkname: "a/x" }]],
])("still rejects %s", (_, entries) => {
  expect(() => readTarGz(rawTarGz(entries))).toThrow(TapsterError);
});

test("names and link targets longer than macOS's PATH_MAX are refused", () => {
  expect(() => readTarGz(rawTarGz([{ name: "PaxHeader", type: "x", data: paxRecord("path", "a/".repeat(600) + "x") }, { name: "x", data: "1" }]))).toThrow(TapsterError);
  expect(() => readTarGz(rawTarGz([{ name: "PaxHeader", type: "x", data: paxRecord("linkpath", "a/".repeat(600)) }, { name: "l", type: "2", linkname: "x" }]))).toThrow(TapsterError);
});

test("archives built to make the symlink checks slow finish quickly", () => {
  const deep = Array.from({ length: 500 }, () => "d").join("/");
  const cases = [
    rawTarGz(Array.from({ length: 4000 }, (_, i) => ({ name: `l${i}`, type: "2", linkname: deep }))),
    rawTarGz([{ name: "link", type: "2", linkname: "x" }, ...Array.from({ length: 20000 }, (_, i) => ({ name: `${deep.slice(0, 900)}/${i}`, data: "" }))]),
  ];
  for (const gz of cases) {
    const started = Date.now();
    try {
      readTarGz(gz);
    } catch (e) {
      expect(e).toBeInstanceOf(TapsterError);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  }
});
