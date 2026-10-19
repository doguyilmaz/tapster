import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appKeyFingerprint, appManifest, fillWorkflow, teamIdFromSubject } from "../src/cli/init";
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
