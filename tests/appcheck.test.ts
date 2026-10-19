import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appFacts, checkArchiveRoot } from "../src/appcheck";
import { type AppPackage, parseConfig } from "../src/config";
import { TapsterError } from "../src/errors";

const KEY = `${"A".repeat(43)}=`;
const NEXT = `${"B".repeat(43)}=`;
const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: hafifpix
    repo: o/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.o.HafifPix
    assets: { darwin-arm64: "HafifPix-{version}.app.tar.gz" }
    dmg: { name: "HafifPix-{version}.dmg" }
    sparkle: { key: shared, public_key: "${KEY}", next_key: newer, next_public_key: "${NEXT}" }
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
const pkg = cfg.packages[0] as AppPackage;
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

const entry = (k: string, v: unknown) =>
  `<key>${k}</key>${v === true ? "<true/>" : v === false ? "<false/>" : typeof v === "number" ? `<integer>${v}</integer>` : typeof v === "object" ? `<real>${(v as { real: number }).real}</real>` : `<string>${v}</string>`}`;
const plist = (d: Record<string, unknown>) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(d).map(([k, v]) => entry(k, v)).join("")}</dict></plist>`;

const good: Record<string, unknown> = {
  CFBundleIdentifier: "com.o.HafifPix",
  CFBundleExecutable: "HafifPix",
  CFBundleName: "HafifPix",
  CFBundleShortVersionString: "1.3.1",
  CFBundleVersion: "1.3.1",
  LSMinimumSystemVersion: "15.0",
  SUFeedURL: "https://github.com/o/hafifpix/releases/latest/download/appcast.xml",
  SUPublicEDKey: KEY,
  SURequireSignedFeed: true,
  SUVerifyUpdateBeforeExtraction: true,
};

function app(info: Record<string, unknown>, extra: Record<string, string | Buffer> = {}, sparkle = "2.9.4", links: Record<string, string> = {}): string {
  const root = join(mkdtempSync(join(tmpdir(), "check-")), "HafifPix.app");
  const files: Record<string, string | Buffer> = {
    "Contents/Info.plist": plist(info),
    "Contents/MacOS/HafifPix": MACHO,
    "Contents/Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist": plist({ CFBundleIdentifier: "org.sparkle-project.Sparkle", CFBundleExecutable: "Sparkle", CFBundleShortVersionString: sparkle }),
    "Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle": MACHO,
    ...extra,
  };
  for (const [p, d] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), d);
  }
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    symlinkSync(target, join(root, p));
  }
  return root;
}

const agree = async () => undefined;

test("a well-formed app gives its facts", async () => {
  const facts = await appFacts(app(good), pkg, cfg.packages, "v1.3.1", agree);
  expect(facts).toEqual({ version: "1.3.1", build: "1.3.1", minimumSystemVersion: "15.0", macos: "sequoia", publicKey: KEY });
  expect((await appFacts(app({ ...good, SUPublicEDKey: NEXT }), pkg, cfg.packages, "v1.3.1", agree)).publicKey).toBe(NEXT);
  expect((await appFacts(app({ ...good, SUSignedFeedFailureExpirationInterval: 2_000_000 }), pkg, cfg.packages, "v1.3.1", agree)).version).toBe("1.3.1");
});

test.each([
  ["a short version that differs from the tag", { ...good, CFBundleShortVersionString: "1.3.0" }, {}, /version/],
  ["a build number that differs from the tag", { ...good, CFBundleVersion: "131" }, {}, /CFBundleVersion/],
  ["another bundle id", { ...good, CFBundleIdentifier: "com.o.Other" }, {}, /bundle/],
  ["a feed for another repository", { ...good, SUFeedURL: "https://github.com/x/y/releases/latest/download/appcast.xml" }, {}, /SUFeedURL/],
  ["an unpinned public key", { ...good, SUPublicEDKey: `${"C".repeat(43)}=` }, {}, /SUPublicEDKey/],
  ["signed feeds not required", { ...good, SURequireSignedFeed: false }, {}, /SURequireSignedFeed/],
  ["verification before extraction off", { ...good, SUVerifyUpdateBeforeExtraction: undefined }, {}, /SUVerifyUpdateBeforeExtraction/],
  ["a short safe-mode interval", { ...good, SUSignedFeedFailureExpirationInterval: 60 }, {}, /SUSignedFeedFailureExpirationInterval/],
  ["a DSA key", { ...good, SUPublicDSAKey: "x" }, {}, /SUPublicDSAKey/],
  ["an update security policy", { ...good, NSUpdateSecurityPolicy: "x" }, {}, /NSUpdateSecurityPolicy/],
  ["a localized feed override", good, { "Contents/Resources/en.lproj/InfoPlist.strings": '"SUFeedURL" = "https://evil";' }, /InfoPlist.strings/],
  ["a localized override in UTF-16", good, { "Contents/Resources/tr.lproj/InfoPlist.strings": Buffer.from('"SUPublicEDKey" = "x";', "utf16le") }, /InfoPlist.strings/],
  ["a localized override in UTF-16 big endian", good, { "Contents/Resources/tr.lproj/InfoPlist.strings": Buffer.from('\uFEFF"SUFeedURL" = "x";', "utf16le").swap16() }, /InfoPlist.strings/],
  ["a localized override in UTF-32", good, { "Contents/Resources/de.lproj/InfoPlist.strings": Buffer.concat([..."SUFeedURL"].map((c) => Buffer.from([c.charCodeAt(0), 0, 0, 0])) ) }, /InfoPlist.strings/],
  ["a localized override behind an escape", good, { "Contents/Resources/en.lproj/InfoPlist.strings": '"SU\\U0046eedURL" = "https://evil";' }, /InfoPlist.strings/],
  ["a localization table", good, { "Contents/Resources/InfoPlist.loctable": plist({ en: "SUFeedURL" }) }, /InfoPlist.loctable/],
  ["a lowercase lproj folder", good, { "Contents/Resources/EN.LPROJ/infoplist.strings": '"SUFeedURL" = "x";' }, /infoplist.strings/],
  ["a nested Info.plist in lowercase", good, { "Contents/Resources/X.bundle/Contents/info.plist": plist({ CFBundleIdentifier: "com.o.Battistics.X" }) }, /X.bundle/],
  ["a nested app named like this app", good, { "Contents/Resources/HafifPix.app/Contents/Info.plist": plist({ CFBundleIdentifier: "com.o.HafifPix.Inner" }) }, /HafifPix.app/],
  ["a resource bundle with a foreign id", good, { "Contents/Resources/X.bundle/Contents/Info.plist": plist({ CFBundleIdentifier: "com.o.Battistics.X" }) }, /X.bundle/],
  ["a nested app named like another app", good, { "Contents/Resources/Battistics.app/Contents/Info.plist": plist({ CFBundleIdentifier: "com.o.HafifPix.B" }) }, /Battistics.app/],
  ["a nested bundle using another app's name", good, { "Contents/Resources/Q.bundle/Contents/Info.plist": plist({ CFBundleIdentifier: "com.o.HafifPix.Q", CFBundleName: "Battistics" }) }, /Battistics/],
])("refuses %s", async (_, info, extra, reason) => {
  const clean = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
  await expect(appFacts(app(clean, extra as Record<string, string | Buffer>), pkg, cfg.packages, "v1.3.1", agree)).rejects.toThrow(reason);
});

test("a flat resource bundle without an identifier passes", async () => {
  const extra = { "Contents/Resources/HafifPix_Core.bundle/Info.plist": plist({ CFBundleDevelopmentRegion: "en" }), "Contents/Frameworks/Sparkle.framework/Versions/.DS_Store": "x" };
  expect((await appFacts(app(good, extra), pkg, cfg.packages, "v1.3.1", agree)).version).toBe("1.3.1");
});

test("a macOS minimum without a Homebrew symbol is refused", async () => {
  expect((await appFacts(app({ ...good, LSMinimumSystemVersion: "26.0" }), pkg, cfg.packages, "v1.3.1", agree)).macos).toBe("tahoe");
  await expect(appFacts(app({ ...good, LSMinimumSystemVersion: "10.15" }), pkg, cfg.packages, "v1.3.1", agree)).rejects.toThrow(/LSMinimumSystemVersion/);
});

test("symlinks cannot hide an Info.plist or borrow an app name", async () => {
  const hidden = { "Contents/Resources/data.bin": plist({ CFBundleIdentifier: "com.o.Battistics.X" }) };
  await expect(appFacts(app(good, hidden, "2.9.4", { "Contents/Resources/X.bundle/Contents/Info.plist": "../../data.bin" }), pkg, cfg.packages, "v1.3.1", agree)).rejects.toThrow(/Info.plist/);
  await expect(appFacts(app(good, {}, "2.9.4", { "Contents/Resources/Battistics.app": "." }), pkg, cfg.packages, "v1.3.1", agree)).rejects.toThrow(/Battistics.app/);
});

test("an app without a hub-managed Sparkle cannot keep its own feed", async () => {
  const bat = cfg.packages[1] as AppPackage;
  const info = { ...good, CFBundleIdentifier: "com.o.Battistics", SUFeedURL: "https://example.com/appcast.xml" };
  await expect(appFacts(app(info), bat, cfg.packages, "v1.3.1", agree)).rejects.toThrow(/sparkle/);
  const plain = Object.fromEntries(Object.entries(good).filter(([k]) => !k.startsWith("SU")));
  expect((await appFacts(app({ ...plain, CFBundleIdentifier: "com.o.Battistics" }), bat, cfg.packages, "v1.3.1", agree)).publicKey).toBeNull();
});

test("plutil's number formatting is not a disagreement", async () => {
  const info = { ...good, SUSignedFeedFailureExpirationInterval: { real: 2000000 } };
  const read = async (key: string) => (key === "SUSignedFeedFailureExpirationInterval" ? "2000000.000000" : key === "SURequireSignedFeed" ? "true" : undefined);
  expect((await appFacts(app(info), pkg, cfg.packages, "v1.3.1", read)).version).toBe("1.3.1");
});

test("Sparkle older than 2.9 is refused", async () => {
  await expect(appFacts(app(good, {}, "2.8.1"), pkg, cfg.packages, "v1.3.1", agree)).rejects.toThrow(/Sparkle/);
});

test("plutil must read the same values", async () => {
  await expect(appFacts(app(good), pkg, cfg.packages, "v1.3.1", async (key) => (key === "SUFeedURL" ? "https://elsewhere" : undefined))).rejects.toThrow(/plutil/);
});

test("the archive holds exactly the configured app at its top", () => {
  const e = (name: string) => ({ name, type: "file" as const, mode: 0o644, data: Buffer.alloc(0) });
  expect(() => checkArchiveRoot([e("HafifPix.app/Contents/Info.plist")], pkg)).not.toThrow();
  expect(() => checkArchiveRoot([e("HafifPix.app/x"), e("Other.app/y")], pkg)).toThrow(TapsterError);
  expect(() => checkArchiveRoot([e("README.md"), e("HafifPix.app/x")], pkg)).toThrow(TapsterError);
});
