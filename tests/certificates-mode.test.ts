import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { OpenKeychain } from "../src/action/apple";
import { sealMode } from "../src/action/seal";
import { signMode, toolSteps } from "../src/action/sign";
import { parseConfig } from "../src/config";
import { TapsterError } from "../src/errors";
import { type Keychain, developerIdentity } from "../src/keychain";
import { resetMaskForTests, scrub } from "../src/mask";
import { findings, resetReportForTests, rowsForTests } from "../src/report";
import { type NotaryKey, parseNotary } from "../src/sign";
import { type Fetched, loadManifest, saveManifest, workdir } from "../src/workdir";
import { missingStages } from "./leak/scan";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - { name: hubtool, repo: o/hubtool, binaries: [hubtool], assets: { darwin-arm64: "h_{version}.tar.gz" } }
  - { name: acmetool, repo: o/acmetool, binaries: [acmetool], certificate: acme, assets: { darwin-arm64: "a_{version}.tar.gz" } }
  - { name: betatool, repo: o/betatool, binaries: [betatool], certificate: beta, assets: { darwin-arm64: "b_{version}.tar.gz" } }
  - { name: hubapp, repo: o/hubapp, kind: app, app: H.app, bundle_id: com.o.H, assets: { darwin-arm64: "H-{version}.tar.gz" }, dmg: { name: "H-{version}.dmg" } }
  - { name: acmeapp, repo: o/acmeapp, kind: app, app: A.app, bundle_id: com.o.A, certificate: acme, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" } }
`,
  "o",
);
const ctx = { hub: "o/homebrew-tap", owner: "o", config: cfg, invalid: [], workspace: "/tmp" };
const CREDENTIAL = /^(MACOS_|TAPSTER_TEAM_ID|TAPSTER_CERT_EXPIRES)/;

const tool = (pkg: string): Fetched => ({
  package: pkg,
  tag: "v1.0.0",
  releaseId: 1,
  resume: false,
  before: [],
  checksums: [],
  archives: [{ asset: `${pkg}.tar.gz`, platform: "darwin-arm64", dir: `/nowhere/${pkg}`, binaries: [pkg] }],
  status: "fetched",
});
const facts = { version: "1.0.0", build: "1", minimumSystemVersion: "15.0", macos: "sequoia", publicKey: "" };
const app = (pkg: string): Fetched => ({ ...tool(pkg), archives: [], status: "packaged", app: { dir: `/nowhere/${pkg}.app`, facts, created: "2026-10-19T10:00:00Z", identifiers: [], dmg: `/nowhere/${pkg}.dmg`, feed: null } });

const pem = (body: string) => `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
const HUB = {
  TAPSTER_TEAM_ID: "HUB0000001",
  MACOS_SIGN_P12: "p12-hub-body",
  MACOS_SIGN_PASSWORD: "pw-hub-secret",
  MACOS_NOTARY_KEY: Buffer.from(pem("hub-notary-key")).toString("base64"),
  MACOS_NOTARY_KEY_ID: "kid-hub-1",
  MACOS_NOTARY_ISSUER_ID: "issuer-hub-1",
};
const ACME = {
  TAPSTER_TEAM_ID_ACME: "ACME000001",
  MACOS_SIGN_P12_ACME: "p12-acme-body",
  MACOS_SIGN_PASSWORD_ACME: "pw-acme-secret",
  MACOS_NOTARY_KEY_ACME: pem("acme-notary-key"),
  MACOS_NOTARY_KEY_ID_ACME: "kid-acme-1",
  MACOS_NOTARY_ISSUER_ID_ACME: "issuer-acme-1",
};

type Opened = { p12: string; password: string; team: string };
let opened: Opened[];
let closed: string[];
let signed: { pkg: string; identity: string; team: string; keyId: string; issuer: string; p8: string }[];

const open: OpenKeychain = async (p12, password, team) => {
  opened.push({ p12, password, team });
  return { path: `/kc/${team}`, identity: p12, teamId: team, close: async () => void closed.push(p12) } satisfies Keychain;
};

const record = (pkg: string, kc: Keychain, notary: NotaryKey, team: string) => {
  expect(statSync(notary.p8Path).mode & 0o777).toBe(0o600);
  signed.push({ pkg, identity: kc.identity, team, keyId: notary.keyId, issuer: notary.issuer, p8: readFileSync(notary.p8Path, "utf8") });
};

function fakeTools(): typeof toolSteps {
  let kc: Keychain | null = null;
  let team = "";
  return {
    ...toolSteps,
    signFile: async (k) => {
      kc = k;
    },
    verifySigned: async (_, t) => {
      team = t;
    },
    copy: async () => {},
    zipForNotary: async () => {},
    notarize: async (zip, notary) => {
      record(zip.split("/").at(-3)!, kc!, notary, team);
      return { id: "1", status: "Accepted" };
    },
  };
}

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

beforeEach(() => {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "rt-"));
  for (const k of Object.keys(process.env)) if (CREDENTIAL.test(k)) delete process.env[k];
  opened = [];
  closed = [];
  signed = [];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (CREDENTIAL.test(k)) delete process.env[k];
  resetMaskForTests();
  resetReportForTests();
});

const statuses = async () => (await loadManifest()).items.map((i) => [i.package, i.status]);

test("a package that names a certificate signs with it and never needs the hub's certificate", async () => {
  setEnv(ACME);
  await saveManifest({ items: [tool("acmetool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(await statuses()).toEqual([["acmetool", "signed"]]);
  expect(opened).toEqual([{ p12: "p12-acme-body", password: "pw-acme-secret", team: "ACME000001" }]);
  expect(signed).toEqual([{ pkg: "acmetool", identity: "p12-acme-body", team: "ACME000001", keyId: "kid-acme-1", issuer: "issuer-acme-1", p8: pem("acme-notary-key") }]);
  expect(closed).toEqual(["p12-acme-body"]);
  expect(existsSync(join(workdir(), "notary-acme.p8"))).toBe(false);
  expect(findings()).toEqual([]);
});

test("a certificate of the hub's team without a notary key of its own notarizes with the hub's key", async () => {
  setEnv({ ...HUB, ...ACME, TAPSTER_TEAM_ID_ACME: "HUB0000001", MACOS_NOTARY_KEY_ACME: "", MACOS_NOTARY_KEY_ID_ACME: "", MACOS_NOTARY_ISSUER_ID_ACME: "" });
  await saveManifest({ items: [tool("hubtool"), tool("acmetool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(await statuses()).toEqual([
    ["hubtool", "signed"],
    ["acmetool", "signed"],
  ]);
  expect(opened.map((o) => o.p12)).toEqual(["p12-hub-body", "p12-acme-body"]);
  expect(signed.map((s) => [s.pkg, s.identity, s.team, s.keyId, s.issuer, s.p8])).toEqual([
    ["hubtool", "p12-hub-body", "HUB0000001", "kid-hub-1", "issuer-hub-1", pem("hub-notary-key")],
    ["acmetool", "p12-acme-body", "HUB0000001", "kid-hub-1", "issuer-hub-1", pem("hub-notary-key")],
  ]);
  expect(closed).toEqual(["p12-hub-body", "p12-acme-body"]);
  expect(existsSync(join(workdir(), "notary.p8"))).toBe(false);
});

test("a certificate of another team without its notary key fails only its own items", async () => {
  setEnv({ ...HUB, TAPSTER_TEAM_ID_BETA: "BETA000001", MACOS_SIGN_P12_BETA: "p12-beta-body", MACOS_SIGN_PASSWORD_BETA: "pw-beta-secret" });
  await saveManifest({ items: [tool("betatool"), tool("hubtool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(await statuses()).toEqual([
    ["betatool", "failed"],
    ["hubtool", "signed"],
  ]);
  expect(findings()).toEqual([
    {
      item: "betatool v1.0.0",
      reason: "certificate beta: the certificate belongs to team BETA000001 and the hub has no notary key for that team",
      fix: "Store that team's App Store Connect key with tapster init --certificate beta --notary or in tapster setup (Optional extras).",
    },
  ]);
  expect(opened.map((o) => o.team)).toEqual(["HUB0000001"]);
  expect(signed.map((s) => s.pkg)).toEqual(["hubtool"]);
});

test("a notary key of a certificate needs all three of its secrets", async () => {
  setEnv({ TAPSTER_TEAM_ID_ACME: "ACME000001", MACOS_SIGN_P12_ACME: "p12-acme-body", MACOS_SIGN_PASSWORD_ACME: "pw-acme-secret", MACOS_NOTARY_KEY_ACME: pem("acme-notary-key") });
  await saveManifest({ items: [tool("acmetool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(await statuses()).toEqual([["acmetool", "failed"]]);
  expect(findings()).toEqual([
    {
      item: "acmetool v1.0.0",
      reason: "certificate acme: MACOS_NOTARY_KEY_ID_ACME is not set",
      fix: "Store that team's App Store Connect key with tapster init --certificate acme --notary or in tapster setup (Optional extras).",
    },
  ]);
  expect(opened).toEqual([]);
});

test("a certificate that is not stored names the command that stores it, not the hub's setup", async () => {
  setEnv({ ...HUB, TAPSTER_TEAM_ID_ACME: "ACME000001", MACOS_SIGN_P12_ACME: "p12-acme-body" });
  await saveManifest({ items: [tool("acmetool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(findings()).toEqual([
    {
      item: "acmetool v1.0.0",
      reason: "certificate acme: MACOS_SIGN_PASSWORD_ACME is not set",
      fix: "Store it with tapster init --certificate acme in a clone of the hub or in tapster setup (Optional extras).",
    },
  ]);
  expect(opened).toEqual([]);
});

test("a certificate the keychain refuses fails only its items, with the label in the reason and its own command in the fix", async () => {
  setEnv({ ...HUB, ...ACME });
  const refusing: OpenKeychain = async (p12, password, team, root) => {
    if (p12 === ACME.MACOS_SIGN_P12_ACME) developerIdentity([{ sha1: "A".repeat(40), name: "Developer ID Application: Other (OTHER00001)", teamId: "OTHER00001" }], team);
    return open(p12, password, team, root);
  };
  await saveManifest({ items: [tool("acmetool"), tool("hubtool")] });
  await signMode(ctx, { open: refusing, tools: fakeTools() });
  expect(await statuses()).toEqual([
    ["acmetool", "failed"],
    ["hubtool", "signed"],
  ]);
  expect(findings()).toEqual([
    {
      item: "acmetool v1.0.0",
      reason: "certificate acme: the certificate belongs to team OTHER00001, not ACME000001",
      fix: "Use the team's certificate. To change teams, run tapster init --certificate acme.",
    },
  ]);
});

test("a failure while signing names the certificate, and a rejected key names the command of the key that was used", async () => {
  setEnv({ ...HUB, ...ACME, TAPSTER_TEAM_ID_BETA: HUB.TAPSTER_TEAM_ID, MACOS_SIGN_P12_BETA: "p12-beta-body", MACOS_SIGN_PASSWORD_BETA: "pw-beta-secret" });
  await saveManifest({ items: [tool("hubtool"), tool("acmetool"), tool("betatool")] });
  const tools = { ...fakeTools(), notarize: async () => parseNotary("", "Error: HTTP status code: 401. Unauthenticated.\n") };
  await signMode(ctx, { open, tools });
  expect(await statuses()).toEqual([
    ["hubtool", "failed"],
    ["acmetool", "failed"],
    ["betatool", "failed"],
  ]);
  const again = (command: string) => `Store the App Store Connect key, its Key ID and the Issuer ID again with ${command}. The draft is untouched.`;
  expect(findings()).toEqual([
    { item: "hubtool v1.0.0", reason: "Apple rejected the notary key (HTTP 401)", fix: again("tapster init --rotate notary") },
    { item: "acmetool v1.0.0", reason: "certificate acme: Apple rejected the notary key (HTTP 401)", fix: again("tapster init --certificate acme --notary") },
    { item: "betatool v1.0.0", reason: "certificate beta: Apple rejected the notary key (HTTP 401)", fix: again("tapster init --rotate notary") },
  ]);
  expect(closed).toEqual(["p12-hub-body", "p12-acme-body", "p12-beta-body"]);
});

test("every certificate secret is masked and leaves the environment, with work to sign and with none", async () => {
  const given = { ...HUB, ...ACME, MACOS_SIGN_P12_OTHER: "p12-other-body", MACOS_NOTARY_KEY_BETA: "" };
  const gone = () => {
    for (const [name, value] of Object.entries(given)) {
      if (name.startsWith("TAPSTER_")) continue;
      expect(process.env[name], name).toBeUndefined();
      if (value) expect(scrub(`x ${value} y`), name).toBe("x *** y");
    }
  };
  // Nothing to sign or to seal: no tool runs. The secrets are still masked and out of the environment.
  for (const mode of [signMode, sealMode]) {
    setEnv(given);
    await saveManifest({ items: [] });
    await mode(ctx, { open });
    gone();
    expect(scrub(Buffer.from("p12-acme-body").toString("base64"))).toBe("***");
    expect(scrub("acme-notary-key")).toBe("***");
    resetMaskForTests();
  }
  setEnv(given);
  await saveManifest({ items: [tool("acmetool")] });
  await signMode(ctx, { open, tools: fakeTools() });
  expect(await statuses()).toEqual([["acmetool", "signed"]]);
  gone();
  expect(scrub("acme-notary-key")).toBe("***");
  expect(process.env.TAPSTER_TEAM_ID_ACME).toBe("ACME000001");
});

test("apps are signed with the certificate their entry names", async () => {
  setEnv({ ...HUB, ...ACME });
  await saveManifest({ items: [{ ...app("hubapp"), status: "fetched" }, { ...app("acmeapp"), status: "fetched" }] });
  const apps: [string, string, string][] = [];
  await signMode(ctx, {
    open,
    apps: {
      signApp: async (kc, dir, _, team) => {
        apps.push([dir, kc.identity, team]);
        return { items: ["."], identifiers: ["com.o.x"], dropped: [] };
      },
      verifyApp: async () => {},
    },
  });
  expect(await statuses()).toEqual([
    ["hubapp", "signed"],
    ["acmeapp", "signed"],
  ]);
  expect(apps).toEqual([
    ["/nowhere/hubapp.app", "p12-hub-body", "HUB0000001"],
    ["/nowhere/acmeapp.app", "p12-acme-body", "ACME000001"],
  ]);
});

test("seal groups the DMGs by certificate the same way", async () => {
  setEnv({ ...HUB, ...ACME });
  await saveManifest({ items: [app("acmeapp"), app("hubapp"), tool("hubtool")] });
  const sealed: string[][] = [];
  await sealMode(ctx, {
    open,
    seal: async (kc, dmg, notary) => {
      expect(readFileSync(notary.p8Path, "utf8")).toBe(kc.identity === ACME.MACOS_SIGN_P12_ACME ? pem("acme-notary-key") : pem("hub-notary-key"));
      sealed.push([dmg, kc.identity, notary.keyId]);
    },
  });
  expect(await statuses()).toEqual([
    ["acmeapp", "sealed"],
    ["hubapp", "sealed"],
    ["hubtool", "fetched"],
  ]);
  expect(sealed).toEqual([
    ["/nowhere/acmeapp.dmg", "p12-acme-body", "kid-acme-1"],
    ["/nowhere/hubapp.dmg", "p12-hub-body", "kid-hub-1"],
  ]);
  expect(closed).toEqual(["p12-acme-body", "p12-hub-body"]);
});

// Runs the signing stage the way the leak workflow's step does, for the package of one of its configs. Returns what
// the step logs for it. Empty secrets are what GitHub hands a step whose repository secret is missing.
async function leakLog(file: string, pkg: string, label: string | null, secrets: "set" | "empty", open: OpenKeychain, tools: typeof toolSteps): Promise<string> {
  const suffix = label === null ? "" : `_${label.toUpperCase()}`;
  const given = secrets === "set";
  resetReportForTests();
  for (const k of Object.keys(process.env)) if (CREDENTIAL.test(k)) delete process.env[k];
  setEnv({
    [`TAPSTER_TEAM_ID${suffix}`]: "CANARY0001",
    [`MACOS_SIGN_P12${suffix}`]: given ? "p12" : "",
    [`MACOS_SIGN_PASSWORD${suffix}`]: given ? "pw" : "",
    [`MACOS_NOTARY_KEY${suffix}`]: given ? pem("k") : "",
    [`MACOS_NOTARY_KEY_ID${suffix}`]: given ? "kid" : "",
    [`MACOS_NOTARY_ISSUER_ID${suffix}`]: given ? "iss" : "",
  });
  // The workflow's fake work item: a binary named fixture, as in the configs.
  await saveManifest({ items: [{ ...tool(pkg), tag: "v0.0.1", archives: [{ asset: "a", platform: "darwin-arm64", dir: `/nowhere/${pkg}`, binaries: ["fixture"] }] }] });
  await signMode({ ...ctx, config: parseConfig(readFileSync(file, "utf8"), "doguyilmaz") }, { open, tools });
  return rowsForTests().map((r) => `${r.item}: ${r.result} (${r.detail})`).join("\n");
}

test("the leak test's sign steps log the markers its scan waits for", async () => {
  const leak = parse(readFileSync(".github/workflows/leak.yml", "utf8")) as { jobs: { scan: { steps: { env?: { EXPECT_STAGES?: string } }[] } } };
  const stages = JSON.parse(leak.jobs.scan.steps.at(-1)!.env!.EXPECT_STAGES!) as Record<string, string[]>;
  const markers = (job: string, pkg: string) => stages[job]!.filter((m) => m.startsWith(`${pkg} v0.0.1`));
  const signSteps = [
    { pkg: "leakcert", file: "tests/leak/hub/certificate.yml", label: "leak" },
    { pkg: "fixture", file: "tests/leak/hub/tapster.yml", label: null },
  ];
  // The plain job's fake .p12 is refused by openssl.
  for (const { pkg, file, label } of signSteps) {
    const plain = await leakLog(file, pkg, label, "set", async () => {
      throw new TapsterError("openssl exited with 1", "No error output.");
    }, fakeTools());
    expect(markers("plain", pkg), pkg).toHaveLength(1);
    expect(missingStages(plain, markers("plain", pkg)), pkg).toEqual([]);
  }
  // The canary certificate opens its keychain and signs, but codesign shows no Developer ID team for it.
  const unsigned = {
    ...fakeTools(),
    verifySigned: async (file: string) => {
      throw new TapsterError(`${basename(file)} is not signed as expected`, "It needs a Developer ID Application signature of the configured team with the hardened runtime.");
    },
  };
  for (const { pkg, file, label } of signSteps) {
    const masked = await leakLog(file, pkg, label, "set", open, unsigned);
    expect(markers("masked", pkg), pkg).toHaveLength(1);
    expect(missingStages(masked, markers("masked", pkg)), pkg).toEqual([]);
    // A step whose repository secrets are gone fails before the keychain: that must not pass for the stage.
    const gone = await leakLog(file, pkg, label, "empty", open, unsigned);
    expect(gone, pkg).toContain("is not set");
    expect(missingStages(gone, markers("masked", pkg)), pkg).toEqual(markers("masked", pkg));
    // A canary that no keychain accepts fails inside openKeychain, which is not the signature check either.
    const refused = await leakLog(file, pkg, label, "set", async () => {
      throw new TapsterError("security exited with 1", "No error output.");
    }, unsigned);
    expect(missingStages(refused, markers("masked", pkg)), pkg).toEqual(markers("masked", pkg));
  }
  expect(missingStages(await leakLog("tests/leak/hub/certificate.yml", "leakcert", "leak", "set", open, unsigned), markers("masked", "fixture"))).toEqual(markers("masked", "fixture"));
});

test("seal fails only the DMGs of a certificate it cannot open", async () => {
  setEnv({ ...ACME });
  await saveManifest({ items: [app("hubapp"), app("acmeapp")] });
  await sealMode(ctx, { open, seal: async () => {} });
  expect(await statuses()).toEqual([
    ["hubapp", "failed"],
    ["acmeapp", "sealed"],
  ]);
  expect(findings().map((f) => [f.item, f.reason])).toEqual([["hubapp v1.0.0", "MACOS_SIGN_P12 is not set"]]);
});
