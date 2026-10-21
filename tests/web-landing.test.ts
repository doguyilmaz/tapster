import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { GitHub } from "../src/github";
import type { AppStart, HubView } from "../src/web/contract";
import { FakeCloudflare, both } from "./helpers/fakecloudflare";
import { FakeHub } from "./helpers/fakehub";
import { webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const LAG = 40;
const fake = new FakeHub("octo");
const cf = new FakeCloudflare();
const home = mkdtempSync(join(tmpdir(), "tapster-landing-"));
const starts: number[] = [];
let writing = 0;
let most = 0;
const slow = async (input: string | URL | Request, init?: RequestInit) => {
  starts.push(performance.now());
  await Bun.sleep(LAG);
  return fake.fetch(input, init);
};
const app = webApp(fake, home, { github: async () => new GitHub("t", slow as typeof fetch, async () => {}, "user"), fetch: both(slow, cf) });

beforeAll(async () => {
  fake.repo("homebrew-tap", {
    files: new Map([
      ["tapster.yml", "version: 1\ntap: octo/tap\npackages:\n  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz } }\n  - { name: aims, repo: octo/aims, binaries: [aims], assets: { linux-amd64: aims.tgz } }\n"],
      [".github/workflows/tapster.yml", "on: {}\n"],
      [".github/workflows/tests.yml", "jobs: {}\n"],
      [".github/workflows/lint.yml", "jobs: {}\n"],
    ]),
  });
  fake.repo("ebb");
  fake.repo("aims");
  useGhWrite(async (args, stdin) => {
    most = Math.max(most, ++writing);
    await Bun.sleep(LAG);
    writing--;
    return fake.ghWrite(args, stdin);
  });
  await app.call("POST", "/api/hub/protect", { hub: HUB });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

// Requests that start together form one round; the next round starts only after an answer, LAG later.
const rounds = async (f: () => Promise<unknown>) => {
  starts.length = 0;
  await f();
  return starts.filter((t, i) => i === 0 || t - starts[i - 1]! > LAG * 0.75).length;
};

const back = async (state: string) => (await app.handle(new Request(`http://127.0.0.1:8277/app/callback?code=abc&state=${state}`, { headers: { host: "127.0.0.1:8277" } }))).headers.get("location");

test("the page reads the hub in three rounds of requests", async () => {
  expect(await rounds(() => app.call("GET", `/api/hub?hub=${HUB}`))).toBeLessThanOrEqual(3);
});

test("the hub App's install page preselects the hub's projects and never the hub", async () => {
  fake.get(HUB)!.env!.vars.set("TAPSTER_APP_SLUG", "tapster-octo-tap");
  const h = (await app.call("GET", `/api/hub?hub=${HUB}`)).data as unknown as HubView;
  const url = new URL(h.app.install!);
  expect(url.pathname).toBe("/apps/tapster-octo-tap/installations/new/permissions");
  expect(url.searchParams.get("suggested_target_id")).toBe("42");
  expect(url.searchParams.getAll("repository_ids[]")).toEqual([String(fake.get("octo/ebb")!.id), String(fake.get("octo/aims")!.id)]);
  expect(url.searchParams.getAll("repository_ids[]")).not.toContain(String(fake.get(HUB)!.id));
  const before = fake.calls.length;
  await app.call("GET", `/api/hub?hub=${HUB}`);
  expect(fake.calls.slice(before).filter((c) => /^GET \/repos\/octo\/(ebb|aims)$/.test(c))).toEqual([]);
  fake.get(HUB)!.env!.vars.delete("TAPSTER_APP_SLUG");
});

test("back from GitHub, the doorbell App's ID and slug go to the hub at once", async () => {
  cf.accounts.push({ id: "f".repeat(32), name: "Work" });
  await app.call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token });
  await app.call("POST", "/api/hub/doorbell/account", { hub: HUB, account: "f".repeat(32) });
  const start = (await app.call("POST", "/api/hub/doorbell/app", { hub: HUB })).data as unknown as AppStart;
  fake.manifestApp = { id: 888, slug: "tapster-doorbell-octo-tap", pem: fake.pem };
  most = 0;
  const callback = await rounds(async () => expect(await back(new URL(start.action).searchParams.get("state")!)).toBe("/setup?doorbell=created&hub=octo%2Fhomebrew-tap"));
  expect(callback).toBe(1);
  expect(most).toBe(2);
});

test("back from GitHub, the hub App's key goes to the hub while the environment check runs next to the manifest", async () => {
  fake.manifestApp = null;
  const start = (await app.call("POST", "/api/hub/app", { hub: HUB })).data as unknown as AppStart;
  most = 0;
  const callback = await rounds(async () => expect(await back(new URL(start.action).searchParams.get("state")!)).toBe("/setup?app=created&hub=octo%2Fhomebrew-tap"));
  expect(callback).toBeLessThanOrEqual(2);
  expect(most).toBe(3);
});
