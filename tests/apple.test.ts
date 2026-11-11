import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkP8, inspectP12, labelNotary, labelNotaryRemoved, notaryKey, saveCertificate, saveNotary } from "../src/cli/apple";
import { useGhWrite } from "../src/cli/gh";
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

test("a labeled certificate and notary key are stored under the label's names, the hub's under today's", async () => {
  const writes: string[][] = [];
  useGhWrite(async (args, stdin) => {
    writes.push([args[0]!, args[2]!, args[0] === "secret" ? (stdin ?? "") : args[args.indexOf("--body") + 1]!]);
  });
  try {
    const cert = { team: "ABCDE12345", expires: "2031-01-02", name: "Developer ID Application: Test Person (ABCDE12345)" };
    const key = { p8: new TextEncoder().encode("p8 body"), keyId: "KEY0000001", issuer: "0000000a-0000-4000-8000-00000000000b" };
    await saveCertificate("o/homebrew-tap", new Uint8Array([1, 2, 3]), "pw", cert, "acme");
    await saveNotary("o/homebrew-tap", key, "acme");
    expect(writes).toEqual([
      ["secret", "MACOS_SIGN_P12_ACME", "AQID"],
      ["secret", "MACOS_SIGN_PASSWORD_ACME", "pw"],
      ["variable", "TAPSTER_TEAM_ID_ACME", "ABCDE12345"],
      ["variable", "TAPSTER_CERT_EXPIRES_ACME", "2031-01-02"],
      ["secret", "MACOS_NOTARY_KEY_ACME", Buffer.from("p8 body").toString("base64")],
      ["secret", "MACOS_NOTARY_KEY_ID_ACME", "KEY0000001"],
      ["secret", "MACOS_NOTARY_ISSUER_ID_ACME", "0000000a-0000-4000-8000-00000000000b"],
    ]);
    writes.length = 0;
    await saveCertificate("o/homebrew-tap", new Uint8Array([1, 2, 3]), "pw", cert);
    await saveNotary("o/homebrew-tap", key);
    expect(writes.map((w) => w[1])).toEqual(["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "TAPSTER_TEAM_ID", "TAPSTER_CERT_EXPIRES", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"]);
  } finally {
    useGhWrite(async () => {
      throw new Error("gh is not available in tests");
    });
  }
});

const hubKey = ["MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"];

test("a labeled certificate keeps its own notary key of the same team, else uses the hub's of the same team, else needs one", () => {
  const own = ["MACOS_NOTARY_KEY_ACME", "MACOS_NOTARY_KEY_ID_ACME", "MACOS_NOTARY_ISSUER_ID_ACME"];
  const hubTeam = [{ name: "TAPSTER_TEAM_ID", value: "HUBTEAM001" }];
  expect(labelNotary("acme", "HUBTEAM001", hubTeam, [])).toBe("hub");
  expect(labelNotary("acme", "OTHERTEAM1", hubTeam, [])).toBe("needed");
  expect(labelNotary("acme", "OTHERTEAM1", [], [])).toBe("needed");
  expect(labelNotary("acme", "OTHERTEAM1", [...hubTeam, { name: "TAPSTER_TEAM_ID_ACME", value: "OTHERTEAM1" }], own)).toBe("kept");
  expect(labelNotary("acme", "HUBTEAM001", [...hubTeam, { name: "TAPSTER_TEAM_ID_ACME", value: "HUBTEAM001" }], own)).toBe("kept");
  expect(labelNotary("acme", "THIRDTEAM1", [...hubTeam, { name: "TAPSTER_TEAM_ID_ACME", value: "OTHERTEAM1" }], own)).toBe("needed");
  expect(labelNotary("acme", "HUBTEAM001", [...hubTeam, { name: "TAPSTER_TEAM_ID_ACME", value: "OTHERTEAM1" }], [...own, ...hubKey])).toBe("stale");
  expect(labelNotary("acme", "HUBTEAM001", hubTeam, [...own.slice(0, 1), ...hubKey])).toBe("stale");
  expect(labelNotary("acme", "OTHERTEAM1", [{ name: "TAPSTER_TEAM_ID_ACME", value: "OTHERTEAM1" }], own.slice(0, 2))).toBe("needed");
});

test("a label's notary secrets go when the hub's key takes over or the new team needs a key of its own", () => {
  const own = ["MACOS_NOTARY_KEY_ACME", "MACOS_NOTARY_KEY_ID_ACME", "MACOS_NOTARY_ISSUER_ID_ACME"];
  const secrets = [...hubKey, ...own, "MACOS_SIGN_P12_ACME"];
  expect(labelNotaryRemoved("acme", "stale", secrets)).toEqual(own);
  expect(labelNotaryRemoved("acme", "needed", secrets)).toEqual(own);
  expect(labelNotaryRemoved("acme", "needed", [...own.slice(0, 2), ...hubKey])).toEqual(own.slice(0, 2));
  expect(labelNotaryRemoved("acme", "needed", hubKey)).toEqual([]);
  expect(labelNotaryRemoved("acme", "kept", secrets)).toEqual([]);
  expect(labelNotaryRemoved("acme", "hub", secrets)).toEqual([]);
});

test("a label's key is never removed while the hub has no notary key to take over", () => {
  const own = ["MACOS_NOTARY_KEY_ACME", "MACOS_NOTARY_KEY_ID_ACME", "MACOS_NOTARY_ISSUER_ID_ACME"];
  const hubTeam = [{ name: "TAPSTER_TEAM_ID", value: "HUBTEAM001" }];
  expect(labelNotary("acme", "HUBTEAM001", hubTeam, own)).toBe("kept");
  expect(labelNotary("acme", "HUBTEAM001", [...hubTeam, { name: "TAPSTER_TEAM_ID_ACME", value: "OTHERTEAM1" }], [...own, ...hubKey.slice(0, 2)])).toBe("kept");
  expect(labelNotary("acme", "HUBTEAM001", hubTeam, own.slice(0, 2))).toBe("needed");
});
