import { expect, test } from "bun:test";
import { Cloudflare, SCRIPT, TOKEN_PAGE, bundleWorker, checkCloudflare, deployWorker } from "../src/cli/cloudflare";
import { FakeCloudflare } from "./helpers/fakecloudflare";

const reason = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error & { reason?: string; fix?: string }) => `${e.reason ?? e.message} | ${e.fix ?? ""}`);

test("the token page asks for Workers Scripts edit and nothing else", () => {
  const url = new URL(TOKEN_PAGE);
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([{ key: "workers_scripts", type: "edit" }]);
  expect(url.searchParams.get("name")).toBe("tapster-doorbell");
  expect(TOKEN_PAGE).toContain("&accountId=*&zoneId=all");
});

test("a working token names its one account and the workers.dev subdomain", async () => {
  const cf = new FakeCloudflare();
  expect(await checkCloudflare(new Cloudflare(cf.token, cf.fetch as typeof fetch))).toEqual({ account: { id: cf.accounts[0]!.id, name: "Octo's Account" }, subdomain: "octo" });
});

test("a wrong token, an inactive one and one without the permission are told apart", async () => {
  const cf = new FakeCloudflare();
  const wrong = await reason(checkCloudflare(new Cloudflare("cf_not-the-token-at-all-0123456789", cf.fetch as typeof fetch)));
  expect(wrong).toStartWith("Cloudflare did not accept that token");
  expect(wrong).not.toContain("cf_not-the-token");
  cf.status = "expired";
  expect(await reason(checkCloudflare(new Cloudflare(cf.token, cf.fetch as typeof fetch)))).toStartWith("that Cloudflare token is expired");
  cf.status = "active";
  cf.scope = "none";
  expect(await reason(checkCloudflare(new Cloudflare(cf.token, cf.fetch as typeof fetch)))).toContain("Cloudflare shows the token no account | Create a new token");
  cf.scope = "read";
  const read = new Cloudflare(cf.token, cf.fetch as typeof fetch);
  const target = await checkCloudflare(read);
  expect(await reason(deployWorker(read, target, { APP_ID: "1" }, "key", "*/10 * * * *"))).toStartWith("the Cloudflare token lacks the Workers Scripts edit permission");
});

test("a token that reaches several accounts asks for one", async () => {
  const cf = new FakeCloudflare();
  cf.accounts.push({ id: "f".repeat(32), name: "Work" });
  expect(await reason(checkCloudflare(new Cloudflare(cf.token, cf.fetch as typeof fetch)))).toStartWith("the token reaches 2 Cloudflare accounts");
});

test("an account without a workers.dev subdomain stops with the dashboard link", async () => {
  const cf = new FakeCloudflare();
  cf.subdomain = null;
  const said = await reason(checkCloudflare(new Cloudflare(cf.token, cf.fetch as typeof fetch)));
  expect(said).toBe(`the Cloudflare account Octo's Account has no workers.dev subdomain yet | Pick one at https://dash.cloudflare.com/${cf.accounts[0]!.id}/workers/onboarding, then try again.`);
  expect(cf.calls.some((c) => c.startsWith("PUT"))).toBe(false);
});

test("the Worker is one ES module bundled from the doorbell source", async () => {
  const js = await bundleWorker();
  expect(js).toContain("export {");
  expect(js).toContain("default");
  expect(js).toContain("token.actions.githubusercontent.com");
  expect(js).not.toMatch(/from\s+["']\.\/jwt/);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as { default: { fetch: unknown; scheduled: unknown } };
  expect(typeof mod.default.fetch).toBe("function");
  expect(typeof mod.default.scheduled).toBe("function");
});

test("a deploy uploads the module with its variables, then the secret, the schedule and the workers.dev route", async () => {
  const cf = new FakeCloudflare();
  const api = new Cloudflare(cf.token, cf.fetch as typeof fetch);
  const target = await checkCloudflare(api);
  const vars = { APP_ID: "888", INSTALLATION_ID: "55", HUB: "octo/homebrew-tap", HUB_ID: "100", OWNER_ID: "42", INTERVAL: "10" };
  const origin = await deployWorker(api, target, vars, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", "*/10 * * * *");
  expect(origin).toBe("https://tapster-doorbell.octo.workers.dev");
  const base = `/accounts/${target.account.id}/workers/scripts/${SCRIPT}`;
  expect(cf.calls.slice(-4)).toEqual([`PUT ${base}`, `PUT ${base}/secrets`, `PUT ${base}/schedules`, `POST ${base}/subdomain`]);
  const s = cf.scripts.get(SCRIPT)!;
  expect(s.metadata).toEqual({
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    bindings: Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    keep_bindings: ["secret_text"],
  });
  expect(s.type).toBe("application/javascript+module");
  expect(s.module).toContain("export {");
  expect(JSON.stringify(s.metadata)).not.toContain("PRIVATE KEY");
  expect(s.secrets.get("APP_KEY")).toContain("BEGIN PRIVATE KEY");
  expect(s.crons).toEqual(["*/10 * * * *"]);
  expect(s.workersDev).toBe(true);
});
