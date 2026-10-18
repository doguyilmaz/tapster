import { expect, test } from "bun:test";
import { parseChecksums, sha256, writeChecksums } from "../src/checksums";
import { TapsterError } from "../src/errors";

const h = "a".repeat(64);
const g = "b".repeat(64);

test("parses GoReleaser output", () => {
  expect(parseChecksums(`${h}  aims_1.0.0_darwin_arm64.tar.gz\n${g}  aims_1.0.0_linux_amd64.tar.gz\n`)).toEqual([
    { sha256: h, name: "aims_1.0.0_darwin_arm64.tar.gz" },
    { sha256: g, name: "aims_1.0.0_linux_amd64.tar.gz" },
  ]);
});

test("review focus 1: CRLF, trailing spaces and binary markers parse", () => {
  expect(parseChecksums(`${h.toUpperCase()} *a.zip  \r\n\r\n${g}  b.tar.gz\r\n`)).toEqual([
    { sha256: h, name: "a.zip" },
    { sha256: g, name: "b.tar.gz" },
  ]);
});

test.each([
  ["duplicate", `${h}  a.zip\n${g}  a.zip\n`],
  ["short hash", `abc  a.zip\n`],
  ["path", `${h}  dir/a.zip\n`],
  ["empty", "\n\n"],
])("rejects %s", (_, text) => {
  expect(() => parseChecksums(text)).toThrow(TapsterError);
});

test("writes sorted lines", () => {
  expect(writeChecksums([{ sha256: g, name: "b" }, { sha256: h, name: "a" }])).toBe(`${h}  a\n${g}  b\n`);
});

test("sha256", () => {
  expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
