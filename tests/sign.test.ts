import { expect, test } from "bun:test";
import { codesignArgs, entitlementsPlist, parseNotary, parseSignature, PRESETS } from "../src/sign";
import { TapsterError } from "../src/errors";

test("presets", () => {
  expect(PRESETS.go).toEqual([]);
  expect(PRESETS.bun).toEqual(["com.apple.security.cs.allow-jit"]);
});

test("entitlements plist lists the keys", () => {
  const xml = entitlementsPlist(PRESETS.bun);
  expect(xml).toContain("<key>com.apple.security.cs.allow-jit</key><true/>");
  expect(xml.startsWith("<?xml")).toBe(true);
});

test("parses codesign -dvv output", () => {
  const info = parseSignature(`Executable=/x/ebb
Identifier=ebb
CodeDirectory v=20500 size=96335 flags=0x10000(runtime) hashes=3005+2 location=embedded
Authority=Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=5MYT4VYJFC`);
  expect(info).toEqual({
    authority: ["Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)", "Developer ID Certification Authority", "Apple Root CA"],
    teamId: "5MYT4VYJFC",
    runtime: true,
    identifier: "ebb",
  });
});

test("parses notarytool json", () => {
  expect(parseNotary('{"id":"abc-123","status":"Accepted","message":"Processing complete"}')).toEqual({ id: "abc-123", status: "Accepted" });
});

test("review focus 5: a timeout reads as In Progress", () => {
  expect(parseNotary('{"id":"abc","status":"In Progress"}').status).toBe("In Progress");
});

test("unreadable notarytool output never echoes it", () => {
  let err: unknown;
  try {
    parseNotary("Error: secret-ish output");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TapsterError);
  expect(JSON.stringify(err)).not.toContain("secret-ish");
});

test("the identifier is tapster's choice, never the build's", () => {
  const kc = { path: "/k/t.keychain-db", identity: "A".repeat(40), teamId: "TEAM000001", close: async () => {} };
  expect(codesignArgs(kc, "/w/bin/aims", null, "aims")).toEqual([
    "--force", "--options", "runtime", "--timestamp", "--keychain", "/k/t.keychain-db", "--sign", "A".repeat(40), "--identifier", "aims", "/w/bin/aims",
  ]);
  expect(codesignArgs(kc, "/w/bin/x", "/w/e.plist", "x")).toContain("--entitlements");
});

test("credentials Apple rejects are named as such", () => {
  expect(() => parseNotary("", "Error: HTTP status code: 401. Unauthenticated. Ensure that all authentication arguments are correct.\n")).toThrow("Apple rejected the notary key (HTTP 401)");
  expect(() => parseNotary("", "Error: The operation couldn't be completed. (network down)\n")).toThrow("notarytool failed: Error: The operation couldn't be completed. (network down)");
  expect(() => parseNotary("not json", "")).toThrow("notarytool returned output tapster could not read");
});
