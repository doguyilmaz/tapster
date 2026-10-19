import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signApp } from "../src/appsign";
import { readTarGz } from "../src/archive";
import { type AppPackage, parseConfig } from "../src/config";
import { writeTree } from "../src/extract";
import { buildFakeApp } from "./helpers/fakeapp";

const pkg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: t
    repo: o/t
    kind: app
    app: T.app
    bundle_id: com.t.T
    assets: { darwin-arm64: "T-{version}.app.tar.gz" }
    dmg: { name: "T-{version}.dmg" }
    code:
      Contents/MacOS/Helper: { identifier: com.t.T.Helper }
`,
  "o",
).packages[0] as AppPackage;

const identifier = (path: string) => /^Identifier=(.*)$/m.exec(Bun.spawnSync(["/usr/bin/codesign", "-dv", path]).stderr.toString())?.[1];

test.skipIf(process.platform !== "darwin")("an app built and packed like a project's is signed inside out under hub identifiers", async () => {
  const built = buildFakeApp();
  const gz = join(dirname(built), "T.app.tar.gz");
  Bun.spawnSync(["/usr/bin/tar", "--no-mac-metadata", "--no-xattrs", "-C", dirname(built), "-czf", gz, "T.app"]);
  const out = mkdtempSync(join(tmpdir(), "signed-"));
  await writeTree(readTarGz(Buffer.from(await Bun.file(gz).arrayBuffer())), out);
  const app = join(out, "T.app");
  const result = await signApp({ path: "", identity: "-", teamId: "", close: async () => {} }, app, pkg, "TEAM000001");
  expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", "--deep", app]).exitCode).toBe(0);
  expect(identifier(app)).toBe("com.t.T");
  expect(identifier(join(app, "Contents/MacOS/Helper"))).toBe("com.t.T.Helper");
  expect(identifier(join(app, "Contents/Frameworks/libz.dylib"))).toBe("com.t.T.libz.dylib");
  expect(identifier(join(app, "Contents/Resources/bin/tool"))).toBe("com.t.T.tool");
  expect(identifier(join(app, "Contents/Frameworks/F.framework/Versions/A"))).toBe("com.t.T.F");
  expect(identifier(join(app, "Contents/Frameworks/F.framework/Versions/A/XPCServices/X.xpc"))).toBe("com.t.T.X");
  expect(result.identifiers.at(-1)).toBe("com.t.T");
}, 60_000);

test("a code path that matches nothing, or two items with one identifier, stop the signing", async () => {
  const { checkPlan } = await import("../src/appsign");
  const items = [
    { path: "Contents/MacOS/Helper", kind: "file" as const, bundleId: null },
    { path: ".", kind: "bundle" as const, bundleId: "com.t.T" },
  ];
  expect(() => checkPlan(items, { ...pkg, code: { "Contents/MacOS/Helpr": { identifier: "com.t.T.Helper" } } } as AppPackage)).toThrow(/Contents\/MacOS\/Helpr/);
  const twice = [{ path: "Contents/MacOS/PowerHelper", kind: "file" as const, bundleId: null }, { path: "Contents/Helpers/PowerHelper", kind: "file" as const, bundleId: null }, items[1]!];
  expect(() => checkPlan(twice, { ...pkg, code: {} } as AppPackage)).toThrow(/com.t.T.PowerHelper/);
  expect(checkPlan(items, pkg)).toEqual(["com.t.T.Helper", "com.t.T"]);
});
