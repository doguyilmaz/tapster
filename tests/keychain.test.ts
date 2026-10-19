import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeychain, parseIdentities, parseKeychainList } from "../src/keychain";
import { run } from "../src/run";
import { TapsterError } from "../src/errors";

test("parses find-identity output", () => {
  const out = `
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Dogu Yilmaz (83LUCZ63JD)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)"
     2 valid identities found`;
  expect(parseIdentities(out)).toEqual([
    { sha1: "0123456789ABCDEF0123456789ABCDEF01234567", name: "Apple Development: Dogu Yilmaz (83LUCZ63JD)", teamId: "83LUCZ63JD" },
    { sha1: "89ABCDEF0123456789ABCDEF0123456789ABCDEF", name: "Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)", teamId: "5MYT4VYJFC" },
  ]);
});

test("parses the keychain search list", () => {
  expect(parseKeychainList(`    "/Users/me/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n`)).toEqual([
    "/Users/me/Library/Keychains/login.keychain-db",
    "/Library/Keychains/System.keychain",
  ]);
});

test.skipIf(process.platform !== "darwin")("a self-signed identity is rejected and the keychain is gone afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-test-"));
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=Developer ID Application: Test (TEST000001)/OU=TEST000001"]);
  await run("openssl", ["pkcs12", "-export", "-in", join(dir, "c.pem"), "-inkey", join(dir, "k.pem"), "-out", join(dir, "t.p12"), "-passout", "pass:pw-test"]);
  const p12 = Buffer.from(await Bun.file(join(dir, "t.p12")).arrayBuffer()).toString("base64");
  const before = (await run("security", ["list-keychains", "-d", "user"])).stdout;
  await expect(openKeychain(p12, "pw-test", "TEST000001", dir)).rejects.toBeInstanceOf(TapsterError);
  expect((await run("security", ["list-keychains", "-d", "user"])).stdout).toBe(before);
});
