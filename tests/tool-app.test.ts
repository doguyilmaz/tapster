import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackTool } from "../src/action/fetch";
import { repackTool } from "../src/action/publish";
import { checkToolApp } from "../src/appcheck";
import { type TarEntry, readTarGz, writeTarGz } from "../src/archive";
import { signApp, stapleApp, toolBundle } from "../src/appsign";
import { signTool, toolSteps } from "../src/action/sign";
import { type CliPackage, parseConfig } from "../src/config";
import { writeTree } from "../src/extract";
import { parsePlist } from "../src/plist";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: ebb
    repo: o/ebb
    binaries: [ebb]
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    app: { name: ebb.app, bundle_id: com.o.ebb, binaries: [Contents/MacOS/ebb] }
  - name: battistics
    repo: o/battistics
    kind: app
    app: Battistics.app
    bundle_id: com.o.Battistics
    assets: { darwin-arm64: "Battistics-{version}.app.tar.gz" }
    dmg: { name: "Battistics-{version}.dmg" }
`,
  "o",
);
const ebb = cfg.packages[0] as CliPackage;
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const ARCHIVE = "ebb_1.2.0_darwin_universal.tar.gz";
const agree = async (path: string) => parsePlist(readFileSync(path)) as Record<string, never>;

const plist = (d: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>`;
const info = { CFBundleIdentifier: "com.o.ebb", CFBundleExecutable: "ebb", CFBundleName: "ebb", CFBundleShortVersionString: "1.2.0" };

const file = (name: string, data: string | Buffer, mode = 0o644): TarEntry => ({ name, type: "file", mode, data: Buffer.from(data) });
const link = (name: string, linkname: string): TarEntry => ({ name, type: "symlink", mode: 0o755, data: Buffer.alloc(0), linkname });
const tree = (over: Record<string, string | Buffer> = {}, extra: TarEntry[] = []) => {
  const files: Record<string, string | Buffer> = {
    ebb: MACHO,
    "README.md": "# ebb\n",
    "ebb.app/Contents/Info.plist": plist(info),
    "ebb.app/Contents/MacOS/ebb": MACHO,
    "ebb.app/Contents/Resources/AppIcon.icns": "icns",
    ...over,
  };
  return writeTarGz([...Object.entries(files).map(([n, d]) => file(n, d, n.endsWith("ebb") ? 0o755 : 0o644)), ...extra], 0);
};
const unpack = (gz: Buffer, pkg = ebb) => unpackTool(pkg, cfg.packages, ARCHIVE, gz, mkdtempSync(join(tmpdir(), "tool-")), agree);

test("an archive with the tool and its app unpacks both, the app checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-"));
  const out = await unpackTool(ebb, cfg.packages, ARCHIVE, tree(), dir, agree);
  expect(out).toEqual({ binaries: ["ebb"], app: "ebb.app" });
  expect(existsSync(join(dir, "ebb"))).toBe(true);
  expect(existsSync(join(dir, "ebb.app/Contents/MacOS/ebb"))).toBe(true);
  expect(existsSync(join(dir, "README.md"))).toBe(false);
  const other = await unpack(tree({ "ebb.app/Contents/Info.plist": plist({ ...info, CFBundleShortVersionString: "0.0.1" }) }));
  expect(other.app).toBe("ebb.app");
});

test.each([
  ["a missing app", writeTarGz([file("ebb", MACHO, 0o755)], 0), /does not contain ebb.app/],
  ["an unlisted Mach-O beside the app", tree({ "helper": MACHO }), /helper, a Mach-O file not listed/],
  ["the app folder in a second spelling", tree({ "EBB.app/Contents/Resources/en.lproj/InfoPlist.strings": "x" }), /EBB.app/],
  ["a symlink out of the app", tree({}, [link("ebb.app/Contents/Resources/tool", "../../../ebb")]), /leaves ebb.app/],
  ["a symlink to the app's own folder", tree({}, [link("ebb.app/Contents/Resources/up", "../..")]), /leaves ebb.app/],
  ["a symlink that leaves the app through another one", tree({}, [link("ebb.app/Contents/Resources/deep/l", "../../../Contents"), link("ebb.app/Contents/Resources/deep/x", "l/../../ebb")]), /x that leaves ebb.app/],
  ["another bundle id", tree({ "ebb.app/Contents/Info.plist": plist({ ...info, CFBundleIdentifier: "com.o.Battistics" }) }), /com.o.Battistics, not com.o.ebb/],
  ["an update feed of its own", tree({ "ebb.app/Contents/Info.plist": plist({ ...info, SUFeedURL: "https://x.y/appcast.xml" }) }), /SUFeedURL/],
  ["a nested bundle outside the bundle id", tree({ "ebb.app/Contents/Helpers/H.app/Contents/Info.plist": plist({ CFBundleIdentifier: "com.o.Battistics.H" }) }), /com.o.Battistics.H/],
  ["something named like another app of the hub", tree({ "ebb.app/Contents/Resources/Battistics.app/x": "x" }), /Battistics.app/],
  ["a linked command that is not Mach-O", tree({ "ebb.app/Contents/MacOS/ebb": "#!/bin/sh\n" }), /app.binaries/],
])("refuses %s", async (_, gz, reason) => {
  await expect(unpack(gz)).rejects.toThrow(reason);
});

test("the app checks read the configured identity, not the archive's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-"));
  await writeTree(readTarGz(tree()), dir);
  await expect(checkToolApp(join(dir, "ebb.app"), { ...ebb.app!, bundle_id: "com.o.other" }, cfg.packages, agree)).rejects.toThrow(/not com.o.other/);
  await expect(checkToolApp(join(dir, "ebb.app"), { ...ebb.app!, binaries: ["Contents/MacOS/missing"] }, cfg.packages, agree)).rejects.toThrow(/Contents\/MacOS\/missing/);
});

test("a tool's app is signed as its bundle id, with its own entitlements on its main executable only", () => {
  expect(toolBundle(ebb.app!)).toEqual({ bundle_id: "com.o.ebb", code: {} });
  expect(toolBundle({ ...ebb.app!, entitlements: ["com.apple.security.cs.allow-jit"] })).toEqual({
    bundle_id: "com.o.ebb",
    code: { ".": { entitlements: { "com.apple.security.cs.allow-jit": true } } },
  });
});

test("a tool's binaries and app are signed, verified, notarized together and the app stapled, in that order", async () => {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "rt-"));
  const calls: string[] = [];
  const log = (step: string) => async (...args: unknown[]) => {
    calls.push(`${step} ${args.filter((a) => typeof a === "string" && a.includes("/")).join(" ")}`);
    return { items: ["."], identifiers: ["com.o.ebb"], dropped: [] } as never;
  };
  const steps = Object.fromEntries(Object.keys(toolSteps).map((k) => [k, log(k)])) as unknown as typeof toolSteps;
  const kc = { path: "", identity: "-", teamId: "TEAM000001", close: async () => {} };
  const item = { package: "ebb", tag: "v1.2.0", releaseId: 1, resume: false, before: [], checksums: [], status: "fetched" as const, archives: [{ asset: ARCHIVE, platform: "darwin-universal" as const, dir: "/w/a", binaries: ["ebb"], app: "ebb.app" }] };
  await signTool(kc, { p8Path: "/k.p8", keyId: "K", issuer: "I" }, "TEAM000001", ebb, item, steps);
  const root = join(process.env.RUNNER_TEMP, "tapster/ebb/v1.2.0/notary");
  expect(calls).toEqual([
    "signFile /w/a/ebb",
    "verifySigned /w/a/ebb",
    "signApp /w/a/ebb.app",
    "verifyApp /w/a/ebb.app",
    `copy /w/a ${root}/${ARCHIVE}`,
    `zipForNotary ${root} ${root}.zip`,
    `notarize ${root}.zip`,
    "stapleApp /w/a/ebb.app",
  ]);
});

test("a stapled app that Gatekeeper does not report as notarized is refused", async () => {
  const exec = (spctl: { code: number; stderr: string }) => async (cmd: string) => ({ ...(cmd === "spctl" ? spctl : { code: 0, stderr: "" }), stdout: "", bytes: Buffer.alloc(0) });
  await expect(stapleApp("/w/a/ebb.app", exec({ code: 0, stderr: "/w/a/ebb.app: accepted\nsource=Notarized Developer ID\n" }))).resolves.toBeUndefined();
  await expect(stapleApp("/w/a/ebb.app", exec({ code: 0, stderr: "/w/a/ebb.app: accepted\nsource=Developer ID\n" }))).rejects.toThrow(/not accepted by Gatekeeper/);
  await expect(stapleApp("/w/a/ebb.app", exec({ code: 3, stderr: "source=Notarized Developer ID\n" }))).rejects.toThrow(/not accepted by Gatekeeper/);
});

const sh = (args: string[]) => {
  const r = Bun.spawnSync(args, { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString() + r.stderr.toString();
};

test.skipIf(process.platform !== "darwin")("the signed app goes back into the archive and still verifies after unpacking", async () => {
  const work = mkdtempSync(join(tmpdir(), "tool-build-"));
  writeFileSync(join(work, "m.c"), "int main(void){return 0;}\n");
  sh(["/usr/bin/clang", "-o", join(work, "ebb"), join(work, "m.c")]);
  const bin = readFileSync(join(work, "ebb"));
  const original = tree({ ebb: bin, "ebb.app/Contents/MacOS/ebb": bin });
  const dir = mkdtempSync(join(tmpdir(), "tool-"));
  const unpacked = await unpackTool(ebb, cfg.packages, ARCHIVE, original, dir, agree);
  const app = join(dir, "ebb.app");
  const signed = await signApp({ path: "", identity: "-", teamId: "", close: async () => {} }, app, toolBundle({ ...ebb.app!, entitlements: ["com.apple.security.cs.allow-jit"] }), "TEAM000001");
  expect(signed.identifiers).toEqual(["com.o.ebb"]);
  expect(sh(["/usr/bin/codesign", "-dv", app])).toContain("Identifier=com.o.ebb");
  expect(sh(["/usr/bin/codesign", "-d", "--entitlements", "-", "--xml", app])).toContain("com.apple.security.cs.allow-jit");
  const repacked = await repackTool(original, { asset: ARCHIVE, platform: "darwin-universal", dir, ...unpacked }, 0);
  const entries = readTarGz(repacked);
  const before = new Map(readTarGz(original).map((e) => [e.name, e.data]));
  expect(entries.find((e) => e.name === "README.md")!.data.equals(before.get("README.md")!)).toBe(true);
  expect(entries.some((e) => e.name === "ebb.app/Contents/_CodeSignature/CodeResources")).toBe(true);
  expect(entries.find((e) => e.name === "ebb.app/Contents/MacOS/ebb")!.data.equals(bin)).toBe(false);
  const again = mkdtempSync(join(tmpdir(), "tool-again-"));
  await writeTree(entries, again);
  sh(["/usr/bin/codesign", "--verify", "--strict", "--deep", join(again, "ebb.app")]);
}, 60_000);
