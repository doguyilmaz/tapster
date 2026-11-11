import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { FLOW, fillWorkflow } from "../src/cli/hubfiles";
import { type StoreIO, storeCertificateFor } from "../src/cli/init";
import { GitHub } from "../src/github";
import { run } from "../src/run";
import { TAPSTER } from "../src/version";
import pins from "../templates/pins.json";
import { FakeHub } from "./helpers/fakehub";

const scratch = mkdtempSync(join(tmpdir(), "init-certificate-"));
const HUB = "octo/homebrew-tap";
const TEAM = "ABCDE12345";
const template = readFileSync("templates/hub/tapster.yml", "utf8");
const fill = (certificates: string[]) => fillWorkflow(template, pins, { sha: "a".repeat(40), tag: "v1.0.0" }, { certificates });
const CONFIG = `version: 1
tap: octo/tap
packages:
  - { name: a, repo: octo/a, binaries: [a], certificate: acme, assets: { darwin-arm64: "a.tar.gz" } }
  - { name: b, repo: octo/b, binaries: [b], certificate: acme, assets: { darwin-arm64: "b.tar.gz" } }
  - { name: c, repo: octo/c, binaries: [c], assets: { darwin-arm64: "c.tar.gz" } }
`;
const HUB_NOTARY = ["MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"];
const ACME_NOTARY = ["MACOS_NOTARY_KEY_ACME", "MACOS_NOTARY_KEY_ID_ACME", "MACOS_NOTARY_ISSUER_ID_ACME"];
let p12 = "";
let p8 = "";
let logs: string[] = [];
let n = 0;

beforeAll(async () => {
  const key = join(scratch, "k.pem");
  const cert = join(scratch, "c.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "90", "-subj", `/CN=Developer ID Application: Test Person (${TEAM})/OU=${TEAM}`]);
  p12 = join(scratch, "cert.p12");
  await run("openssl", ["pkcs12", "-export", "-in", cert, "-inkey", key, "-out", p12, "-passout", "pass:pw"]);
  p8 = join(scratch, "AuthKey_KEY0000001.p8");
  writeFileSync(p8, "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n");
});

afterEach(() => {
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A hub clone with tapster.yml and a workflow, and the hub on a fake GitHub with the given environment.
function hub(vars: Record<string, string>, secrets: string[], flow: string | null = fill([])) {
  const dir = join(scratch, `hub${n++}`);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, "tapster.yml"), CONFIG);
  if (flow !== null) writeFileSync(join(dir, FLOW), flow);
  const fake = new FakeHub("octo");
  const env = { policies: ["main"], custom: true, vars: new Map(Object.entries(vars)), secrets: new Set(secrets) };
  fake.repo("homebrew-tap", { env });
  useGhWrite(fake.ghWrite);
  return { dir, env, gh: new GitHub("t", fake.fetch, async () => {}, "user"), fake };
}

// Answers the prompts in order and records each question.
function answers(...given: string[]): StoreIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      const next = given.shift();
      if (next === undefined) throw new Error(`unexpected question: ${question}`);
      return next;
    },
    verify: async () => true,
  };
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  logs = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
  try {
    return await work();
  } finally {
    log.mockRestore();
  }
}

test("a certificate of the hub's team is stored under its label, notarized with the hub's key and passed to the sign steps", async () => {
  const h = hub({ TAPSTER_TEAM_ID: TEAM }, HUB_NOTARY);
  const io = answers(p12, "pw");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect(io.asked).toEqual([".p12 file (drag it here): ", ".p12 password: "]);
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(h.env.vars.get("TAPSTER_TEAM_ID_ACME")).toBe(TEAM);
  expect(h.env.vars.get("TAPSTER_CERT_EXPIRES_ACME")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(readFileSync(join(h.dir, FLOW), "utf8")).toBe(fill(["acme"]));
  expect(logs).toContain("The certificate acme signs a, b.");
  expect(logs).toContain(`Certificate acme stored for team ${TEAM}. It expires on ${h.env.vars.get("TAPSTER_CERT_EXPIRES_ACME")}; the hub warns 30 days before.`);
  expect(logs).toContain(`The hub's notarization key notarizes it too, since both belong to team ${TEAM}.`);
  expect(logs).toContain(`updated the sign steps in ${FLOW}`);
  expect(logs).toContain("Review and commit the workflow change, then push.");
});

test("a certificate of another team asks for that team's notary key", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001" }, HUB_NOTARY);
  const io = answers(p12, "pw", p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect(io.asked.slice(2)).toEqual([".p8 file (drag it here): ", "Key ID: ", "Issuer ID: "]);
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, ...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`The certificate acme belongs to team ${TEAM}, not to the hub's team HUBTEAM001. Apple notarizes it only with an App Store Connect key of team ${TEAM}.`);
  expect(logs).toContain(`Notarization key for the certificate acme stored. You may delete ${p8} once you keep a backup.`);
});

test("a hub without a certificate of its own asks for the label's notary key", async () => {
  const h = hub({}, []);
  const io = answers(p12, "pw", p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect([...h.env.secrets].sort()).toEqual([...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`The certificate acme belongs to team ${TEAM}. Apple notarizes it only with an App Store Connect key of team ${TEAM}.`);
});

test("a renewed certificate of the same team keeps the label's notary key", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001", TAPSTER_TEAM_ID_ACME: TEAM }, ACME_NOTARY, fill(["acme"]));
  const io = answers(p12, "pw");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect(io.asked).toHaveLength(2);
  expect(logs).toContain(`The notarization key stored for acme belongs to team ${TEAM} too, so it stays.`);
  expect(logs).toContain(`${FLOW} already passes the certificate acme.`);
  expect(logs).not.toContain("Review and commit the workflow change, then push.");
});

test("a certificate moved to the hub's team drops the label's key, which would win over the hub's", async () => {
  const h = hub({ TAPSTER_TEAM_ID: TEAM, TAPSTER_TEAM_ID_ACME: "OLDTEAM001" }, [...HUB_NOTARY, ...ACME_NOTARY]);
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, answers(p12, "pw")));
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain("Removed the notarization key stored for acme: it would win over the hub's key and may belong to another team.");
  expect(logs).toContain(`The hub's notarization key notarizes it too, since both belong to team ${TEAM}.`);
});

test("a certificate moved to a third team drops the old team's key before it asks for the new one, so stopping there leaves no key to notarize with", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001", TAPSTER_TEAM_ID_ACME: "OLDTEAM001" }, [...HUB_NOTARY, ...ACME_NOTARY]);
  const io = answers(p12, "pw");
  await expect(quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io))).rejects.toThrow("unexpected question: .p8 file (drag it here): ");
  expect(h.env.vars.get("TAPSTER_TEAM_ID_ACME")).toBe(TEAM);
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`Removed the notarization key stored for acme: it may belong to another team than the new certificate's team ${TEAM}.`);
});

test("a delete that fails stores nothing, so a second run still sees the old team and removes its key", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001", TAPSTER_TEAM_ID_ACME: "OLDTEAM001" }, [...HUB_NOTARY, ...ACME_NOTARY]);
  useGhWrite(async (args, stdin) => {
    if (args[0] === "secret" && args[1] === "delete") throw new Error("gh could not delete");
    return h.fake.ghWrite(args, stdin);
  });
  await expect(quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, answers(p12, "pw")))).rejects.toThrow("gh could not delete");
  expect(h.env.vars.get("TAPSTER_TEAM_ID_ACME")).toBe("OLDTEAM001");
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, ...ACME_NOTARY].sort());
  useGhWrite(h.fake.ghWrite);
  await expect(quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, answers(p12, "pw")))).rejects.toThrow("unexpected question: .p8 file (drag it here): ");
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
});

test("a key stored before its certificate is asked for again once the certificate's team is known", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001" }, ACME_NOTARY);
  const io = answers(p12, "pw", p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect(io.asked.slice(2)).toEqual([".p8 file (drag it here): ", "Key ID: ", "Issuer ID: "]);
  expect([...h.env.secrets].sort()).toEqual([...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`Removed the notarization key stored for acme: it may belong to another team than the new certificate's team ${TEAM}.`);
});

test("the new team's key replaces the old one when the owner stores it", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001", TAPSTER_TEAM_ID_ACME: "OLDTEAM001" }, [...HUB_NOTARY, ...ACME_NOTARY]);
  const io = answers(p12, "pw", p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect([...h.env.secrets].sort()).toEqual([...HUB_NOTARY, ...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`Notarization key for the certificate acme stored. You may delete ${p8} once you keep a backup.`);
});

test("the label's key stays when the hub has no notarization key to take over", async () => {
  const h = hub({ TAPSTER_TEAM_ID: TEAM }, ACME_NOTARY);
  const io = answers(p12, "pw");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect(io.asked).toHaveLength(2);
  expect([...h.env.secrets].sort()).toEqual([...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`The notarization key stored for acme stays, since the hub has no notarization key of its own. Apple accepts it only if it belongs to team ${TEAM}.`);
  expect(logs.some((l) => l.startsWith("Removed"))).toBe(false);
});

test("a part of the label's key with no hub key to take over asks for the whole key", async () => {
  const h = hub({ TAPSTER_TEAM_ID: TEAM }, ACME_NOTARY.slice(0, 1));
  const io = answers(p12, "pw", p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, io));
  expect([...h.env.secrets].sort()).toEqual([...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect(logs).toContain(`The certificate acme belongs to team ${TEAM}. Apple notarizes it only with an App Store Connect key of team ${TEAM}.`);
});

test("a hub workflow of an older tapster gets a note that its pin has to move too", async () => {
  const build = { ...TAPSTER };
  Object.assign(TAPSTER, { version: "1.2.0", sha: "b".repeat(40) });
  try {
    const h = hub({ TAPSTER_TEAM_ID: TEAM }, HUB_NOTARY);
    await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", false, answers(p12, "pw")));
    expect(logs).toContain("The hub workflow runs tapster v1.0.0, older than this tapster v1.2.0. An older tapster may refuse entries with certificate:, so run tapster init --workflow too.");
    Object.assign(TAPSTER, { version: "1.0.0", sha: "a".repeat(40) });
    const current = hub({ TAPSTER_TEAM_ID: TEAM }, HUB_NOTARY);
    await quietly(() => storeCertificateFor(current.gh, current.dir, HUB, "acme", false, answers(p12, "pw")));
    expect(logs.some((l) => l.includes("older than this tapster"))).toBe(false);
  } finally {
    Object.assign(TAPSTER, build);
  }
});

test("--notary stores only the label's notary key", async () => {
  const h = hub({ TAPSTER_TEAM_ID: "HUBTEAM001", TAPSTER_TEAM_ID_ACME: TEAM }, ["MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"]);
  const io = answers(p8, "KEY0000001", "0000000a-0000-4000-8000-00000000000b");
  await quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "acme", true, io));
  expect(io.asked).toEqual([".p8 file (drag it here): ", "Key ID: ", "Issuer ID: "]);
  expect([...h.env.secrets].sort()).toEqual([...ACME_NOTARY, "MACOS_SIGN_P12_ACME", "MACOS_SIGN_PASSWORD_ACME"].sort());
  expect([...h.env.vars.keys()].sort()).toEqual(["TAPSTER_TEAM_ID", "TAPSTER_TEAM_ID_ACME"]);
  expect(logs).toContain(`Apple notarizes it only with an App Store Connect key of team ${TEAM}, the team of the certificate acme.`);
  expect(readFileSync(join(h.dir, FLOW), "utf8")).toBe(fill(["acme"]));
});

test("a label no package names or a missing workflow is refused before any question", async () => {
  const h = hub({}, []);
  const io = answers();
  await expect(quietly(() => storeCertificateFor(h.gh, h.dir, HUB, "beta", false, io))).rejects.toThrow("no package in tapster.yml signs with the certificate beta");
  const bare = hub({}, [], null);
  await expect(quietly(() => storeCertificateFor(bare.gh, bare.dir, HUB, "acme", true, io))).rejects.toThrow(`${FLOW} is missing`);
  expect(io.asked).toEqual([]);
  expect(h.env.secrets.size + bare.env.secrets.size).toBe(0);
});
