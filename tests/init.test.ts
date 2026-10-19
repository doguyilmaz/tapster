import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appKeyFingerprint, appManifest, fillWorkflow, keyPins, sparkleEnv, sparkleLabels, teamIdFromSubject } from "../src/cli/init";
import { parseConfig } from "../src/config";
import { generateKeyPairSync } from "node:crypto";
import { TapsterError } from "../src/errors";
import pins from "../templates/pins.json";

test("the App asks only for what tapster needs", () => {
  const m = appManifest("o", "o/homebrew-tap", "http://127.0.0.1:5000/callback") as Record<string, unknown>;
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({ contents: "write", attestations: "read", metadata: "read" });
  expect(m.default_events).toEqual([]);
  expect(m.name).toBe("tapster-o-tap");
  expect((appManifest("averyveryverylongowner", "averyveryverylongowner/homebrew-tapster-test", "x") as { name: string }).name.length).toBeLessThanOrEqual(34);
});

test("team id comes from the certificate subject", () => {
  expect(teamIdFromSubject("UID=ABC,CN=Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC),OU=5MYT4VYJFC,O=Dogu Kaan Yilmaz,C=TR")).toBe("5MYT4VYJFC");
  expect(teamIdFromSubject("CN=x")).toBeNull();
});

test("the workflow template is filled with pinned SHAs", () => {
  const out = fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" });
  expect(out).not.toContain("__");
  expect(out).toContain(`doguyilmaz/tapster@${"f".repeat(40)} # v1.0.0`);
  expect(out).toContain(`actions/checkout@${pins["actions/checkout"].sha}`);
});

test("an App key shows the fingerprint GitHub lists for it", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const der = Bun.spawnSync(["/usr/bin/openssl", "rsa", "-pubout", "-outform", "DER"], { stdin: Buffer.from(pem) }).stdout;
  const expected = new Bun.CryptoHasher("sha256").update(der).digest("base64");
  expect(appKeyFingerprint(pem)).toBe(`SHA256:${expected}`);
  expect(() => appKeyFingerprint("not a key")).toThrow(TapsterError);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  expect(() => appKeyFingerprint(publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow(TapsterError);
});

const K1 = `${"A".repeat(43)}=`;
const K2 = `${"B".repeat(43)}=`;
const apps = parseConfig(
  `version: 1
tap: o/tap
packages:
  - { name: a, repo: o/a, kind: app, app: A.app, bundle_id: com.o.A, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" }, sparkle: { key: shared, public_key: "${K1}" } }
  - { name: b, repo: o/b, kind: app, app: B.app, bundle_id: com.o.B, assets: { darwin-arm64: "B-{version}.tar.gz" }, dmg: { name: "B-{version}.dmg" }, sparkle: { key: shared, public_key: "${K1}", next_key: newer, next_public_key: "${K2}" } }
  - { name: c, repo: o/c, binaries: [c], assets: { darwin-arm64: "c-{version}.tar.gz" } }
`,
  "o",
);

test("the sparkle step gets one secret per label", () => {
  expect(sparkleLabels(apps)).toEqual(["shared", "newer"]);
  const env = sparkleEnv(["shared", "recesso"]);
  expect(env).toContain('SPARKLE_KEY_SHARED: "${{ secrets.SPARKLE_KEY_SHARED }}"');
  expect(env).toContain('SPARKLE_KEY_RECESSO: "${{ secrets.SPARKLE_KEY_RECESSO }}"');
  expect(sparkleEnv([])).toBe("{}");
});

test("a stored Sparkle key must match every package that pins it", () => {
  expect(keyPins(apps, "shared", K1)).toEqual(["a", "b"]);
  expect(keyPins(apps, "newer", K2)).toEqual(["b"]);
  expect(() => keyPins(apps, "shared", K2)).toThrow(/a pins/);
  expect(() => keyPins(apps, "other", K1)).toThrow(/no package/);
});

test("rewriting the workflow keeps the Sparkle labels, even with an invalid package in tapster.yml", async () => {
  const { hubLabels } = await import("../src/cli/init");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "labels-"));
  expect(hubLabels(dir, "o")).toEqual([]);
  writeFileSync(
    join(dir, "tapster.yml"),
    `version: 1
tap: o/tap
packages:
  - { name: a, repo: o/a, kind: app, app: A.app, bundle_id: com.o.A, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" }, sparkle: { key: shared, public_key: "${"A".repeat(43)}=" } }
  - { name: broken, repo: o/b, binaries: [b], assets: { darwin-arm64: "b.zip" } }
`,
  );
  expect(hubLabels(dir, "o")).toEqual(["shared"]);
});
