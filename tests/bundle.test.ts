import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findCode } from "../src/bundle";
import { TapsterError } from "../src/errors";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const plist = (exe?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>x</string>${exe ? `<key>CFBundleExecutable</key><string>${exe}</string>` : ""}</dict></plist>`;

function tree(files: Record<string, string | Buffer>, links: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  return join(root, "App.app");
}

const sparkleLike = () =>
  tree(
    {
      "App.app/Contents/Info.plist": plist("App"),
      "App.app/Contents/MacOS/App": MACHO,
      "App.app/Contents/MacOS/Helper": MACHO,
      "App.app/Contents/Frameworks/libz.1.dylib": MACHO,
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle": MACHO,
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist": plist("Sparkle"),
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate": MACHO,
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/Info.plist": plist("Updater"),
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater": MACHO,
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc/Contents/Info.plist": plist("Installer"),
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer": MACHO,
      "App.app/Contents/Resources/bin/hafif": MACHO,
      "App.app/Contents/Resources/bin/script.sh": "#!/bin/sh\n",
      "App.app/Contents/Resources/bin/Core.bundle/Contents/Info.plist": plist(),
      "App.app/Contents/Resources/bin/Core.bundle/Contents/Resources/data.json": "{}",
    },
    {
      "App.app/Contents/Frameworks/Sparkle.framework/Versions/Current": "B",
      "App.app/Contents/Frameworks/Sparkle.framework/Sparkle": "Versions/Current/Sparkle",
      "App.app/Contents/Frameworks/Sparkle.framework/Resources": "Versions/Current/Resources",
      "App.app/Contents/Frameworks/Sparkle.framework/Autoupdate": "Versions/Current/Autoupdate",
    },
  );

test("finds bundles and loose code and signs the deepest first", () => {
  const app = sparkleLike();
  const items = findCode(app).map((i) => `${i.kind} ${i.path}`);
  expect(items).toEqual([
    "bundle Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc",
    "file Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate",
    "bundle Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app",
    "bundle Contents/Frameworks/Sparkle.framework/Versions/B",
    "file Contents/Resources/bin/hafif",
    "file Contents/Frameworks/libz.1.dylib",
    "file Contents/MacOS/Helper",
    "bundle .",
  ]);
});

test("every nested item comes before the bundle that contains it", () => {
  const items = findCode(sparkleLike());
  const contains = (outer: { path: string; kind: string }, inner: { path: string }) =>
    outer.kind === "bundle" && outer.path !== inner.path && (outer.path === "." || inner.path.startsWith(`${outer.path}/`));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) expect(contains(items[i]!, items[j]!)).toBe(false);
  }
});

test("an app without its main executable is rejected", () => {
  const app = tree({ "App.app/Contents/Info.plist": plist("App") });
  expect(() => findCode(app)).toThrow(TapsterError);
});

test("a main executable that is not Mach-O is rejected", () => {
  const app = tree({ "App.app/Contents/Info.plist": plist("App"), "App.app/Contents/MacOS/App": "#!/bin/sh\n" });
  expect(() => findCode(app)).toThrow(TapsterError);
});

test("CFBundleExecutable cannot leave the bundle", () => {
  const app = tree({ "App.app/Contents/Info.plist": plist("../../x"), "App.app/Contents/MacOS/App": MACHO });
  expect(() => findCode(app)).toThrow(TapsterError);
});
