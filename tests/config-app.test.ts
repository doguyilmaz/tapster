import { expect, test } from "bun:test";
import { isApp, parseConfig } from "../src/config";
import { TapsterError } from "../src/errors";

const app = `version: 1
tap: o/tap
packages:
  - name: hafifpix
    repo: o/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.o.HafifPix
    assets:
      darwin-arm64: "HafifPix-{version}.app.tar.gz"
    dmg: { name: "HafifPix-{version}.dmg", volume: HafifPix }
    sparkle: { key: shared, public_key: "${"A".repeat(43)}=" }
    code:
      Contents/MacOS/Helper:
        identifier: com.o.HafifPix.Helper
        entitlements: { com.apple.application-identifier: "{team}.com.o.HafifPix.Helper" }
    cask: { binaries: [Contents/Resources/bin/hafif] }
`;

test("an app package parses with defaults", () => {
  const p = parseConfig(app, "o").packages[0]!;
  expect(isApp(p)).toBe(true);
  if (!isApp(p)) return;
  expect(p.sparkle!.feed).toBe("appcast.xml");
  expect(p.dmg.volume).toBe("HafifPix");
  expect(p.carry).toEqual({});
});

test.each([
  ["a Linux asset", app.replace('darwin-arm64: "HafifPix-{version}.app.tar.gz"', 'darwin-arm64: "HafifPix-{version}.app.tar.gz"\n      linux-amd64: "x.tar.gz"')],
  ["two darwin assets", app.replace('darwin-arm64: "HafifPix-{version}.app.tar.gz"', 'darwin-arm64: "a.tar.gz"\n      darwin-amd64: "b.tar.gz"')],
  ["binaries on an app", app.replace("    kind: app\n", "    kind: app\n    binaries: [x]\n")],
  ["a bad bundle id", app.replace("bundle_id: com.o.HafifPix", "bundle_id: HafifPix")],
  ["a dmg not ending in .dmg", app.replace('name: "HafifPix-{version}.dmg"', 'name: "HafifPix-{version}.zip"')],
  ["a short public key", app.replace(`"${"A".repeat(43)}="`, '"AAAA"')],
  ["a carry digest that is not sha256", app.replace("    kind: app\n", "    kind: app\n    carry: { appcast.xml: md5 }\n")],
  ["a code path that leaves the app", app.replace("Contents/MacOS/Helper:", "../Helper:")],
])("refuses %s", (_, text) => {
  expect(() => parseConfig(text, "o")).toThrow(TapsterError);
});

test("identities cannot overlap across packages", () => {
  const second = (id: string) => `${app}  - name: other
    repo: o/other
    kind: app
    app: Other.app
    bundle_id: ${id}
    assets:
      darwin-arm64: "Other-{version}.app.tar.gz"
    dmg: { name: "Other-{version}.dmg" }
`;
  expect(() => parseConfig(second("com.o.HafifPix"), "o")).toThrow(TapsterError);
  expect(() => parseConfig(second("com.o.HafifPix.Sub"), "o")).toThrow(TapsterError);
  expect(() => parseConfig(second("com.o.HafifPixel"), "o")).not.toThrow();
  const cli = `${app}  - name: tool
    repo: o/tool
    binaries: [com.o.HafifPix.Helper]
    assets:
      linux-amd64: "t.tar.gz"
`;
  expect(() => parseConfig(cli, "o")).toThrow(TapsterError);
});

test("a code identifier stays under the app's bundle id", () => {
  expect(() => parseConfig(app.replace("identifier: com.o.HafifPix.Helper", "identifier: com.o.Other.Helper"), "o")).toThrow(TapsterError);
});

test("the volume name defaults to the app name", () => {
  const p = parseConfig(app.replace(", volume: HafifPix", ""), "o").packages[0]!;
  if (!isApp(p)) throw new Error("not an app");
  expect(p.dmg.volume).toBe("HafifPix");
});

test("the app itself can take entitlements under code '.'", () => {
  const p = parseConfig(app.replace("    code:\n", '    code:\n      ".": { entitlements: { com.apple.security.network.client: true } }\n'), "o").packages[0]!;
  if (!isApp(p)) throw new Error("not an app");
  expect(p.code["."]!.entitlements).toEqual({ "com.apple.security.network.client": true });
});

test("bundle ids overlap without regard to case, and app commands are named once", () => {
  const second = `${app}  - name: other
    repo: o/other
    kind: app
    app: Other.app
    bundle_id: COM.O.HAFIFPIX.sub
    assets:
      darwin-arm64: "Other-{version}.app.tar.gz"
    dmg: { name: "Other-{version}.dmg" }
`;
  expect(() => parseConfig(second, "o")).toThrow(/overlapping bundle ids/);
  const cli = `${app}  - name: tool
    repo: o/tool
    binaries: [hafif]
    assets:
      linux-amd64: "t.tar.gz"
`;
  expect(() => parseConfig(cli, "o")).toThrow(/both ship a binary named hafif/);
});

test("a rotation names the next key and its public half together", () => {
  const rot = app.replace(`sparkle: { key: shared, public_key: "${"A".repeat(43)}=" }`, `sparkle: { key: shared, public_key: "${"A".repeat(43)}=", next_key: newer, next_public_key: "${"B".repeat(43)}=" }`);
  const p = parseConfig(rot, "o").packages[0]!;
  if (!isApp(p)) throw new Error("not an app");
  expect(p.sparkle!.next_key).toBe("newer");
  expect(() => parseConfig(rot.replace(", next_key: newer", ""), "o")).toThrow(/next_key and next_public_key/);
});

test("a DMG name with a placeholder other than {version} is refused before anything is published", async () => {
  const { parseHub } = await import("../src/config");
  const { invalid } = parseHub(app.replace('name: "HafifPix-{version}.dmg"', 'name: "HafifPix-{tag}.dmg"'), "o");
  expect(invalid[0]?.reason).toBe("hafifpix: HafifPix-{tag}.dmg uses a placeholder other than {version}");
});
