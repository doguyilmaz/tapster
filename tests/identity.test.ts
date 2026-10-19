import { expect, test } from "bun:test";
import { identifierFor } from "../src/identity";
import { parseConfig, isApp, type AppPackage } from "../src/config";
import { TapsterError } from "../src/errors";

const pkg = parseConfig(`version: 1
tap: o/tap
packages:
  - name: b
    repo: o/b
    kind: app
    app: B.app
    bundle_id: com.o.B
    assets: { darwin-arm64: "B-{version}.app.tar.gz" }
    dmg: { name: "B-{version}.dmg" }
    code:
      Contents/MacOS/Helper: { identifier: com.o.B.PowerHelper }
`, "o").packages[0] as AppPackage;

test("the app, nested bundles and loose code get hub identifiers", () => {
  expect(identifierFor({ path: ".", kind: "bundle", bundleId: "com.o.B" }, pkg)).toBe("com.o.B");
  expect(identifierFor({ path: "Contents/PlugIns/X.appex", kind: "bundle", bundleId: "com.o.B.X" }, pkg)).toBe("com.o.B.X");
  expect(identifierFor({ path: "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc", kind: "bundle", bundleId: "org.sparkle-project.InstallerLauncher" }, pkg)).toBe("org.sparkle-project.InstallerLauncher");
  expect(identifierFor({ path: "Contents/MacOS/Helper", kind: "file", bundleId: null }, pkg)).toBe("com.o.B.PowerHelper");
  expect(identifierFor({ path: "Contents/Resources/bin/hafif", kind: "file", bundleId: null }, pkg)).toBe("com.o.B.hafif");
});

test.each([
  ["another app's id on a nested bundle", { path: "Contents/PlugIns/X.appex", kind: "bundle" as const, bundleId: "com.o.Other" }],
  ["Sparkle's prefix outside Sparkle", { path: "Contents/PlugIns/X.appex", kind: "bundle" as const, bundleId: "org.sparkle-project.X" }],
  ["an app whose id is not bundle_id", { path: ".", kind: "bundle" as const, bundleId: "com.o.Other" }],
])("refuses %s", (_, item) => {
  expect(() => identifierFor(item, pkg)).toThrow(TapsterError);
});
