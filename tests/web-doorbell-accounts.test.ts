import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import type { HubView } from "../src/web/contract";
import { FakeCloudflare, both } from "./helpers/fakecloudflare";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const fake = new FakeHub("octo");
const cf = new FakeCloudflare();
const WORK = "f".repeat(32);
const home = mkdtempSync(join(tmpdir(), "tapster-accounts-"));
let call: Call;
const OCTO = { id: "0123456789abcdef0123456789abcdef", name: "Octo's Account" };

beforeAll(() => {
  cf.accounts.push({ id: WORK, name: "Work" });
  fake.repo("homebrew-tap", { env: { policies: ["main"], custom: true, vars: new Map(), secrets: new Set() } });
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home, { fetch: both(fake.fetch, cf) }));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const view = async () => ((await call("GET", `/api/hub?hub=${HUB}`)).data as unknown as HubView).extras.doorbell;
const reason = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string }).reason;

test("a token that reaches several accounts never picks one by itself, not even after a reload", async () => {
  expect(reason(await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: WORK }))).toBe("this setup holds no Cloudflare token");
  const pasted = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token });
  expect(pasted.data).toEqual({ cloudflare: null, accounts: [OCTO, { id: WORK, name: "Work" }] });
  for (let i = 0; i < 2; i++) expect(await view()).toMatchObject({ cloudflare: null, accounts: [OCTO, { id: WORK, name: "Work" }] });
  expect(cf.calls.filter((c) => c.includes("/workers/"))).toEqual([]);
});

test("a failed pick keeps the accounts to pick from and says why", async () => {
  expect(reason(await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: "e".repeat(32) }))).toBe("the token does not reach that Cloudflare account");
  cf.subdomain = null;
  expect(reason(await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: WORK }))).toBe("the Cloudflare account Work has no workers.dev subdomain yet");
  cf.subdomain = "octo";
  expect(await view()).toMatchObject({ cloudflare: null, accounts: [OCTO, { id: WORK, name: "Work" }] });
});

test("the picked account comes back in the answer, so the page shows it without reading the hub again", async () => {
  const before = fake.calls.length;
  expect((await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: WORK })).data).toEqual({ cloudflare: { account: "Work", subdomain: "octo" }, accounts: null });
  expect(fake.calls.slice(before)).toEqual([]);
  expect(await view()).toMatchObject({ cloudflare: { account: "Work", subdomain: "octo" }, accounts: null });
  expect(JSON.stringify(await view())).not.toContain(cf.token);
});
