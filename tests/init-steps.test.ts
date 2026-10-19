import { expect, test } from "bun:test";
import { appleGate } from "../src/action/check";
import { macosCode } from "../src/config";
import { cleanPath } from "../src/cli/paths";
import { checkCertificate, checkP12, notaryArgs, notaryCheckError } from "../src/cli/apple";
import { doneSteps, initSteps, privateHubError } from "../src/cli/init";
import { parseConfig } from "../src/config";
import { GitHubError, TapsterError } from "../src/errors";

test("paths dropped from Finder or typed with ~ resolve", () => {
  expect(cleanPath("'/Users/me/My Keys/cert.p12' ", "/Users/me")).toBe("/Users/me/My Keys/cert.p12");
  expect(cleanPath('"/Users/me/cert.p12"', "/Users/me")).toBe("/Users/me/cert.p12");
  expect(cleanPath("/Users/me/My\\ Keys/cert.p12", "/Users/me")).toBe("/Users/me/My Keys/cert.p12");
  expect(cleanPath("~/Downloads/AuthKey_ABC.p8", "/Users/me")).toBe("/Users/me/Downloads/AuthKey_ABC.p8");
  expect(() => cleanPath("   ", "/Users/me")).toThrow(TapsterError);
});

const now = Date.parse("2026-10-19T00:00:00Z");
const subject = "UID=ABCDE12345,CN=Developer ID Application: Dogu Yilmaz (ABCDE12345),OU=ABCDE12345,O=Dogu Yilmaz,C=TR";

test("only a valid Developer ID Application certificate is stored, with its expiry", () => {
  expect(checkCertificate(subject, "Oct 19 00:00:00 2031 GMT", now)).toEqual({ team: "ABCDE12345", expires: "2031-10-19", name: "Developer ID Application: Dogu Yilmaz (ABCDE12345)" });
  expect(() => checkCertificate(subject.replace("Developer ID Application", "Apple Development"), "Oct 19 00:00:00 2031 GMT", now)).toThrow(/Developer ID Application/);
  expect(() => checkCertificate(subject.replace("Developer ID Application", "Developer ID Installer"), "Oct 19 00:00:00 2031 GMT", now)).toThrow(/Developer ID Application/);
  expect(() => checkCertificate(subject, "Oct 18 00:00:00 2026 GMT", now)).toThrow(/expired/);
});

test("init does only the steps that are not done yet", () => {
  const none = { vars: [], secrets: [] };
  expect(initSteps(none, true)).toEqual(["app", "certificate", "notary", "files"]);
  expect(initSteps(none, false)).toEqual(["app", "files"]);
  const app = { vars: ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG"], secrets: ["TAPSTER_APP_PRIVATE_KEY"] };
  expect(initSteps(app, true)).toEqual(["certificate", "notary", "files"]);
  expect(initSteps({ vars: ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG"], secrets: [] }, false)).toEqual(["app-key", "files"]);
  const all = { vars: [...app.vars, "TAPSTER_TEAM_ID"], secrets: [...app.secrets, "MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"] };
  expect(initSteps(all, true)).toEqual(["files"]);
  expect(initSteps({ vars: ["TAPSTER_APP_ID"], secrets: ["TAPSTER_APP_PRIVATE_KEY"] }, true)).toContain("app");
});

test("the notary key is checked by file, never on the command line", () => {
  const args = notaryArgs("/tmp/k.p8", "KEYID12345", "00000000-0000-0000-0000-000000000000");
  expect(args).toEqual(["notarytool", "history", "--key", "/tmp/k.p8", "--key-id", "KEYID12345", "--issuer", "00000000-0000-0000-0000-000000000000", "--output-format", "json"]);
});

test("a private hub without environments gets the plan explained", () => {
  const e = privateHubError(new GitHubError("GitHub PUT /repos/o/hub/environments/tapster returned 422", "", 422), true);
  expect(e.reason).toContain("environments");
  expect(e.fix).toContain("GitHub Pro");
  const other = new GitHubError("x", "y", 500);
  expect(privateHubError(other, true)).toBe(other);
  expect(privateHubError(new GitHubError("x", "y", 422), false).reason).toBe("x");
});

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - { name: mac, repo: o/mac, binaries: [mac], assets: { darwin-arm64: "m_{version}.tar.gz" } }
  - { name: lin, repo: o/lin, binaries: [lin], assets: { linux-amd64: "l_{version}.tar.gz" } }
  - { name: app, repo: o/app, kind: app, app: A.app, bundle_id: com.o.A, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" } }
`,
  "o",
);
const item = (p: string) => ({ package: p, tag: "v1.0.0", releaseId: 1, resume: false });

test("only packages with macOS code need macOS and Apple credentials", () => {
  expect(cfg.packages.map(macosCode)).toEqual([true, false, true]);
});

test("macOS work waits for Apple credentials and a certificate that has not expired", () => {
  const all = [item("mac"), item("lin"), item("app")];
  const none = appleGate(all, cfg.packages, { team: "", expires: "" }, now);
  expect(none.items.map((i) => i.package)).toEqual(["lin"]);
  expect(none.failed.map((f) => f.name)).toEqual(["mac", "app"]);
  expect(none.failed[0]!.error.fix).toContain("tapster init --rotate certificate");
  expect(none.macos).toBe(false);
  const ok = appleGate(all, cfg.packages, { team: "ABCDE12345", expires: "2031-10-19" }, now);
  expect(ok.items).toHaveLength(3);
  expect(ok.macos).toBe(true);
  expect(ok.warning).toBeNull();
  const soon = appleGate(all, cfg.packages, { team: "ABCDE12345", expires: "2026-11-01" }, now);
  expect(soon.warning).toContain("2026-11-01");
  const expired = appleGate(all, cfg.packages, { team: "ABCDE12345", expires: "2026-10-01" }, now);
  expect(expired.failed.map((f) => f.name)).toEqual(["mac", "app"]);
  expect(expired.failed[0]!.error.reason).toContain("expired");
  expect(appleGate([item("lin")], cfg.packages, { team: "", expires: "" }, now).macos).toBe(false);
});

test("init repairs a weakened hub ruleset and extra branch rules instead of leaving them", async () => {
  const { protectHub, HUB_RULESET } = await import("../src/cli/init");
  const writes: string[] = [];
  const gh = {
    json: async (method: string, path: string) => {
      if (method !== "GET") {
        writes.push(`${method} ${path}`);
        return {};
      }
      if (path.endsWith("/deployment-branch-policies")) return { branch_policies: [{ id: 1, name: "main" }, { id: 2, name: "dev" }] };
      if (path.endsWith("/rulesets")) return [{ id: 9, name: "tapster main" }];
      throw new Error(path);
    },
  } as never;
  await protectHub(gh, "o/hub", false);
  expect(writes).toContain("DELETE /repos/o/hub/environments/tapster/deployment-branch-policies/2");
  expect(writes).not.toContain("POST /repos/o/hub/environments/tapster/deployment-branch-policies");
  expect(writes).toContain("PUT /repos/o/hub/rulesets/9");
  expect(HUB_RULESET.rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward"]);
  expect(HUB_RULESET.bypass_actors).toEqual([]);
});

test("init names as done only the parts that are complete", () => {
  expect(doneSteps(["app-key", "files"], false)).toEqual([]);
  expect(doneSteps(["certificate", "notary", "files"], true)).toEqual(["app"]);
  expect(doneSteps(["files"], true)).toEqual(["app", "certificate", "notary"]);
  expect(doneSteps(["files"], false)).toEqual(["app"]);
});

test("a failed notary check at setup speaks about the key, not about a draft", () => {
  const denied = notaryCheckError("Error: HTTP status code: 401. Unauthenticated.");
  expect(denied.reason).toBe("Apple rejected the notary key (HTTP 401)");
  expect(denied.fix).toContain("Key ID");
  const other = notaryCheckError("\nxcrun: error: unable to find utility \"notarytool\"\n");
  expect(other.reason).toContain('notarytool could not check the key: xcrun: error: unable to find utility "notarytool"');
  expect(`${denied.fix} ${other.fix}`).not.toContain("draft");
  expect(notaryCheckError("Error: HTTP status code: 403. A required agreement is missing.").reason).toBe("Apple refused the notary key (HTTP 403)");
  expect(notaryCheckError("Error: The Internet connection appears to be offline.").fix).toContain("connection");
});

test("a .p12 must open with the password and hold the private key", () => {
  const info = (text: string, code = 0) => ({ code, stdout: text });
  const certs = { code: 0, stdout: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n" };
  const good = info("MAC verified OK\nCertificate bag\nShrouded Keybag: pbeWithSHA1And3-KeyTripleDES-CBC, Iteration 2048\n");
  expect(() => checkP12(good, certs)).not.toThrow();
  expect(() => checkP12(info("MAC Iteration 2048\nMac verify error: invalid password?\n", 1), { code: 1, stdout: "" })).toThrow("the .p12 could not be opened with that password");
  expect(() => checkP12(info("MAC verified OK\nCertificate bag\n"), { code: 0, stdout: "" })).toThrow("the .p12 holds the certificate but not its private key");
  expect(() => checkP12(info("MAC verified OK\nShrouded Keybag: x\n"), { code: 0, stdout: "" })).toThrow("the .p12 holds no certificate");
  expect(() => checkP12(info("Error outputting keys and certificates\nunsupported: Algorithm (RC2-40-CBC : 0)\n", 1), { code: 1, stdout: "" })).toThrow("this system's openssl cannot read the .p12");
  expect(() => checkP12(good, { code: 1, stdout: "" })).toThrow("the .p12 could not be read");
});

test("a backup is confirmed by yes in any case", async () => {
  const { confirmed } = await import("../src/cli/init");
  expect(confirmed(" Yes ")).toBe(true);
  expect(confirmed("YES")).toBe(true);
  expect(confirmed("y")).toBe(false);
  expect(confirmed("")).toBe(false);
});
