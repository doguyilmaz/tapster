import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkP8, inspectP12, notaryKey } from "../src/cli/apple";
import { TapsterError } from "../src/errors";
import { run } from "../src/run";

const dir = mkdtempSync(join(tmpdir(), "apple-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function p12(cn: string, password: string, withKey = true): Promise<Uint8Array> {
  const subj = `/CN=${cn}/OU=ABCDE12345`;
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "30", "-subj", subj]);
  const key = withKey ? ["-inkey", join(dir, "k.pem")] : ["-nokeys"];
  await run("openssl", ["pkcs12", "-export", "-in", join(dir, "c.pem"), ...key, "-out", join(dir, "t.p12"), "-passout", `pass:${password}`]);
  return new Uint8Array(readFileSync(join(dir, "t.p12")));
}

test("a .p12 is read from memory with its password and names the team, expiry and certificate", async () => {
  const cert = await inspectP12(await p12("Developer ID Application: Test Person (ABCDE12345)", "s3cret pw"), "s3cret pw");
  expect(cert.team).toBe("ABCDE12345");
  expect(cert.name).toBe("Developer ID Application: Test Person (ABCDE12345)");
  expect(cert.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("a wrong password, a missing key or another certificate type is refused with a fix", async () => {
  const good = await p12("Developer ID Application: Test Person (ABCDE12345)", "right");
  await expect(inspectP12(good, "wrong")).rejects.toThrow(/could not be opened with that password/);
  await expect(inspectP12(await p12("Developer ID Application: Test Person (ABCDE12345)", "pw", false), "pw")).rejects.toThrow(/not its private key/);
  await expect(inspectP12(await p12("Apple Development: Test Person (ABCDE12345)", "pw"), "pw")).rejects.toThrow(/not a Developer ID Application/);
  await expect(inspectP12(new Uint8Array(0), "pw")).rejects.toBeInstanceOf(TapsterError);
  await expect(inspectP12(new Uint8Array(70 * 1024), "pw")).rejects.toThrow(/not a .p12/);
});

test("the notary key needs a .p8, a 10-character Key ID and an Issuer ID", () => {
  const p8 = new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n");
  expect(notaryKey(p8, " ABCDE12345 ", "0000000A-0000-4000-8000-00000000000B")).toEqual({ p8, keyId: "ABCDE12345", issuer: "0000000a-0000-4000-8000-00000000000b" });
  expect(() => checkP8(new TextEncoder().encode("hello"))).toThrow(/not an App Store Connect key/);
  expect(() => notaryKey(p8, "abc", "0000000a-0000-4000-8000-00000000000b")).toThrow(/is not a Key ID/);
  expect(() => notaryKey(p8, "ABCDE12345", "nope")).toThrow(/not an Issuer ID/);
});
