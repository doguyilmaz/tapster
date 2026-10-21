import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHub } from "../src/config";
import { TOKEN_PAGE } from "../src/cli/cloudflare";
import { type DoorbellIO, rotateDoorbell, setupDoorbell } from "../src/cli/doorbell";
import { useGhWrite } from "../src/cli/gh";
import { GitHub } from "../src/github";
import { FakeCloudflare, both } from "./helpers/fakecloudflare";
import { FakeHub } from "./helpers/fakehub";

const HUB = "octo/homebrew-tap";
const fake = new FakeHub("octo");
const cf = new FakeCloudflare();
const bellPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const dir = mkdtempSync(join(tmpdir(), "tapster-bell-"));
const pemPath = join(dir, "bell.pem");
const fetchBoth = both(fake.fetch, cf);
const gh = new GitHub("t", fetchBoth, async () => {}, "user");
const config = parseHub("version: 1\ntap: octo/tap\npackages:\n  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz } }\n  - { name: gone, repo: octo/gone, binaries: [gone], assets: { linux-amd64: gone.tgz } }\n", "octo").config;

function io(answers: string[], env: Record<string, string | undefined>) {
  const lines: string[] = [];
  const opened: string[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  const value: DoorbellIO = {
    fetch: fetchBoth,
    ask: async (question, hidden = false) => {
      asked.push({ question, hidden });
      return answers.shift() ?? "";
    },
    log: (line) => lines.push(line),
    open: (url) => opened.push(url),
    env,
  };
  return { value, lines, opened, asked };
}

beforeAll(() => {
  writeFileSync(pemPath, bellPem);
  const hub = fake.repo("homebrew-tap");
  hub.env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_DOORBELL_APP_ID", "888"], ["TAPSTER_DOORBELL_APP_SLUG", "tapster-doorbell-octo-tap"]]), secrets: new Set() };
  fake.repo("ebb");
  fake.bell = { id: 888, slug: "tapster-doorbell-octo-tap", pem: bellPem, installation: { id: 55, repos: [HUB] } };
  useGhWrite(fake.ghWrite);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

test("tapster init --doorbell continues with the App's new .pem and deploys through Cloudflare's API", async () => {
  const run = io([pemPath], { CLOUDFLARE_API_TOKEN: cf.token });
  await setupDoorbell(gh, HUB, config, 20, run.value);
  const origin = "https://tapster-doorbell.octo.workers.dev";
  const w = cf.scripts.get("tapster-doorbell")!;
  expect(w.crons).toEqual(["*/20 * * * *"]);
  expect(w.secrets.get("APP_KEY")).toBe(createPrivateKey(bellPem).export({ type: "pkcs8", format: "pem" }).toString());
  expect((w.metadata.bindings as { name: string; text: string }[]).find((b) => b.name === "INSTALLATION_ID")!.text).toBe("55");
  const env = fake.get(HUB)!.env!;
  expect(env.vars.get("TAPSTER_DOORBELL")).toBe(origin);
  expect(env.vars.get("TAPSTER_DOORBELL_EVERY")).toBe("20");
  expect(fake.get("octo/ebb")!.repoVars.get("TAPSTER_DOORBELL")).toBe(origin);
  expect(run.lines).toContain(`Could not give octo/gone the doorbell's address. Run: gh variable set TAPSTER_DOORBELL --repo octo/gone --body ${origin}`);
  expect(run.lines.at(-1)).toBe(`The doorbell answers at ${origin}. Projects ring it after opening a draft.`);
  expect(run.opened).toEqual(["https://github.com/settings/apps/tapster-doorbell-octo-tap"]);
  expect(run.lines.join("\n")).not.toContain(cf.token);
});

test("tapster init --doorbell stops once the hub has a doorbell", async () => {
  await expect(setupDoorbell(gh, HUB, config, 10, io([], { CLOUDFLARE_API_TOKEN: cf.token }).value)).rejects.toThrow("the hub already has a doorbell");
});

test("tapster init --rotate doorbell asks for the token with a hidden prompt and redeploys with the new key", async () => {
  const fresh = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  writeFileSync(pemPath, fresh);
  fake.bell!.pem = fresh;
  const run = io([pemPath, cf.token], {});
  await rotateDoorbell(gh, HUB, 10, run.value);
  expect(run.asked.map((a) => a.hidden)).toEqual([false, true]);
  expect(run.opened).toContain(TOKEN_PAGE);
  const w = cf.scripts.get("tapster-doorbell")!;
  expect(w.secrets.get("APP_KEY")).toBe(createPrivateKey(fresh).export({ type: "pkcs8", format: "pem" }).toString());
  expect(w.crons).toEqual(["*/10 * * * *"]);
  expect(run.lines.join("\n")).not.toContain(cf.token);
});

test("a .pem of another App is refused before anything reaches Cloudflare", async () => {
  writeFileSync(pemPath, fake.pem);
  const before = cf.calls.length;
  await expect(rotateDoorbell(gh, HUB, 10, io([pemPath], { CLOUDFLARE_API_TOKEN: cf.token }).value)).rejects.toThrow("that key does not belong to the doorbell App");
  expect(cf.calls.length).toBe(before);
});

test("a wrong token stops the CLI with the same words as setup", async () => {
  writeFileSync(pemPath, fake.bell!.pem);
  await expect(rotateDoorbell(gh, HUB, 10, io([pemPath], { CLOUDFLARE_API_TOKEN: "cf_wrongwrongwrongwrongwrong0123456789" }).value)).rejects.toThrow("Cloudflare did not accept that token");
});
