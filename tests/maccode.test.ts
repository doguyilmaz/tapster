import { expect, test } from "bun:test";
import { macCodeIn } from "../src/maccode";
import { rawTarGz, rawZip } from "./helpers/rawtar";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const PE = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");

test("Linux and Windows assets pass", () => {
  expect(macCodeIn("x_linux_amd64.tar.gz", rawTarGz([{ name: "x", data: ELF }]))).toBeNull();
  expect(macCodeIn("x_windows_amd64.zip", rawZip([{ name: "x.exe", data: PE, deflate: true }]))).toBeNull();
  expect(macCodeIn("notes.txt", Buffer.from("hello"))).toBeNull();
});

test("macOS code outside the signed archives is caught", () => {
  expect(macCodeIn("x_darwin_arm64", MACHO)).toContain("Mach-O");
  expect(macCodeIn("x_darwin_amd64.tar.gz", rawTarGz([{ name: "x", data: MACHO }]))).toContain("Mach-O");
  expect(macCodeIn("x_all.zip", rawZip([{ name: "README", data: Buffer.from("x") }, { name: "bin/x", data: MACHO, deflate: true }]))).toContain("Mach-O");
  expect(macCodeIn("x_all.zip", rawZip([{ name: "x", data: MACHO }]))).toContain("Mach-O");
  expect(macCodeIn("X-1.0.dmg", Buffer.from("koly"))).toContain("installer");
  expect(macCodeIn("X-1.0.pkg", Buffer.from("xar!"))).toContain("installer");
});

test("archives tapster cannot inspect are refused", () => {
  expect(macCodeIn("x.zip", rawZip([{ name: "x", data: PE, encrypted: true }]))).not.toBeNull();
  expect(macCodeIn("x.zip", Buffer.from("PK\x03\x04broken", "latin1"))).not.toBeNull();
  expect(macCodeIn("x.tar.gz", Buffer.from("not gzip"))).not.toBeNull();
});
