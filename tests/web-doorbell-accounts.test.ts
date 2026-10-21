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

test("a token that reaches several accounts lets the person pick one in setup", async () => {
  expect(reason(await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: WORK }))).toBe("this setup holds no Cloudflare token");
  const pasted = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token });
  expect(pasted.data).toEqual({ accounts: [{ id: cf.accounts[0]!.id, name: "Octo's Account" }, { id: WORK, name: "Work" }] });
  expect(await view()).toMatchObject({ cloudflare: null, accounts: [{ name: "Octo's Account" }, { name: "Work" }] });
  expect(reason(await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: "e".repeat(32) }))).toBe("the token does not reach that Cloudflare account");
  expect((await call("POST", "/api/hub/doorbell/account", { hub: HUB, account: WORK })).data).toEqual({ account: "Work", subdomain: "octo" });
  expect(await view()).toMatchObject({ cloudflare: { account: "Work", subdomain: "octo" }, accounts: null });
  expect(JSON.stringify(await view())).not.toContain(cf.token);
});
