import { expect, test } from "bun:test";
import { type CliPackage, parseConfig, parseHub } from "../src/config";

const ebb = `version: 1
tap: o/tap
packages:
  - name: ebb
    repo: o/ebb
    binaries: [ebb]
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    app:
      name: ebb.app
      bundle_id: com.o.ebb
      binaries: [Contents/MacOS/ebb]
    cask:
      uninstall: { launchctl: [com.o.ebb] }
      postflight: { binary: ebb, args: [daemon, restore] }
`;

test("a tool may carry an app and a post-install command", () => {
  const p = parseConfig(ebb, "o").packages[0] as CliPackage;
  expect(p.kind).toBe("go");
  expect(p.app).toEqual({ name: "ebb.app", bundle_id: "com.o.ebb", binaries: ["Contents/MacOS/ebb"], entitlements: [] });
  expect(p.cask.postflight).toEqual({ binary: "ebb", args: ["daemon", "restore"] });
  const bare = parseConfig(ebb.replace("      binaries: [Contents/MacOS/ebb]\n", "").replace("args: [daemon, restore] }", "}"), "o").packages[0] as CliPackage;
  expect(bare.app!.binaries).toEqual([]);
  expect(bare.cask.postflight).toEqual({ binary: "ebb", args: [] });
});

test("the app gets its own entitlements, not the tool's", () => {
  const jit = parseConfig(ebb.replace("    app:\n", "    entitlements: [com.apple.security.cs.disable-library-validation]\n    app:\n").replace("binaries: [Contents/MacOS/ebb]", "binaries: [Contents/MacOS/ebb]\n      entitlements: [com.apple.security.cs.allow-jit]"), "o").packages[0] as CliPackage;
  expect(jit.entitlements).toEqual(["com.apple.security.cs.disable-library-validation"]);
  expect(jit.app!.entitlements).toEqual(["com.apple.security.cs.allow-jit"]);
  expect(() => parseConfig(ebb.replace("binaries: [Contents/MacOS/ebb]", "binaries: [Contents/MacOS/ebb]\n      entitlements: [com.apple.security.get-task-allow]"), "o")).toThrow();
});

test.each([
  ["an app without a macOS archive", ebb.replace('darwin-universal: "ebb_{version}_darwin_universal.tar.gz"', 'windows-amd64: "ebb_{version}_windows_amd64.zip"'), /macOS archive/],
  ["an app with a Linux archive", ebb.replace('_darwin_universal.tar.gz"', '_darwin_universal.tar.gz"\n      linux-amd64: "ebb_{version}_linux_amd64.tar.gz"'), /Linux/],
  ["a binary inside the app", ebb.replace("binaries: [ebb]", "binaries: [ebb, ebb.app/Contents/MacOS/ebb]"), /inside ebb.app/],
  ["a binary named like the app", ebb.replace("binaries: [ebb]", "binaries: [ebb.app]"), /inside ebb.app/],
  ["an app name that is not an .app", ebb.replace("name: ebb.app", "name: ebb"), /app.name/],
  ["an app in a subfolder", ebb.replace("name: ebb.app", "name: dist/ebb.app"), /app.name/],
  ["a bad bundle id", ebb.replace("bundle_id: com.o.ebb", "bundle_id: ebb"), /bundle_id/],
  ["a hook for a command the cask does not link", ebb.replace("binary: ebb,", "binary: sh,"), /sh, which the cask does not link/],
  ["a hook argument with a space", ebb.replace("args: [daemon, restore]", 'args: ["daemon restore"]'), /args/],
  ["a hook argument with a quote", ebb.replace("args: [daemon, restore]", "args: ['a\"b']"), /args/],
  ["a hook argument that interpolates", ebb.replace("args: [daemon, restore]", 'args: ["#{system}"]'), /args/],
  ["a hook written as Ruby", ebb.replace("postflight: { binary: ebb, args: [daemon, restore] }", "postflight: 'system \"rm\"'"), /postflight/],
  ["a hook with sudo", ebb.replace("args: [daemon, restore] }", "args: [daemon], sudo: true }"), /postflight/],
  ["hook arguments longer than a cask line", ebb.replace("args: [daemon, restore]", `args: [${Array(4).fill("x".repeat(20)).join(", ")}]`), /one line/],
  ["eleven hook arguments", ebb.replace("args: [daemon, restore]", `args: [${Array(11).fill("a").join(", ")}]`), /args/],
])("refuses %s", (_, text, reason) => {
  expect(() => parseConfig(text, "o")).toThrow(reason);
});

const mac = (id: string, cmd: string) => `  - name: other
    repo: o/other
    kind: app
    app: Other.app
    bundle_id: ${id}
    assets: { darwin-arm64: "Other-{version}.app.tar.gz" }
    dmg: { name: "Other-{version}.dmg" }
    cask: { binaries: [Contents/MacOS/${cmd}] }
`;
const reasons = (text: string) => parseHub(text, "o").invalid.map((i) => i.reason).join("; ");

test("a tool's app shares no identity and no command name with other packages", () => {
  expect(reasons(ebb + mac("com.o.Other", "other"))).toBe("");
  expect(reasons(ebb + mac("com.o.ebb.Other", "other"))).toMatch(/overlapping bundle ids/);
  expect(reasons(ebb + mac("com.o.Other", "ebb"))).toMatch(/both ship a binary named ebb/);
  const second = ebb.replace(/^version: 1\ntap: o\/tap\npackages:\n/, "").replaceAll("ebb", "ebc").replace("com.o.ebc", "com.o.ebb");
  expect(reasons(ebb + second)).toMatch(/overlapping bundle ids/);
});

test("an app's hook runs one of the commands its cask links", () => {
  const app = (cmd: string) => `version: 1
tap: o/tap
packages:
${mac("com.o.Other", "other").replace("cask: { binaries: [Contents/MacOS/other] }", `cask: { binaries: [Contents/MacOS/other], postflight: { binary: ${cmd}, args: [--setup] } }`)}`;
  expect(reasons(app("other"))).toBe("");
  expect(reasons(app("Other"))).toMatch(/Other, which the cask does not link/);
});
