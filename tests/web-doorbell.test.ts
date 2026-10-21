import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_PAGE } from "../src/cli/cloudflare";
import { useGhWrite } from "../src/cli/gh";
import type { AddView, AppStart, BellInstallView, DoorbellDone, HubView } from "../src/web/contract";
import { sampleHome } from "../scripts/demo";
import { FakeCloudflare, both } from "./helpers/fakecloudflare";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const fake = new FakeHub("octo");
const cf = new FakeCloudflare();
const bellPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const seen: string[] = [];
let home = "";
let call: Call;
let handle: ReturnType<typeof webApp>["handle"];
let s: ReturnType<typeof webApp>["s"];

beforeAll(async () => {
  fake.repo("homebrew-tap", {
    files: new Map([
      ["tapster.yml", "version: 1\ntap: octo/tap\npackages:\n  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz } }\n  - { name: aims, repo: octo/aims, binaries: [aims], assets: { linux-amd64: aims.tgz } }\n"],
      [".github/workflows/tapster.yml", 'on:\n  schedule:\n    - cron: "7-59/15 * * * *"\n'],
    ]),
  });
  home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  const app = webApp(fake, home, { fetch: both(fake.fetch, cf), log: (line) => seen.push(line) });
  ({ handle, s } = app);
  call = async (method, path, body) => {
    const res = await app.call(method, path, body);
    seen.push(JSON.stringify(res.data));
    return res;
  };
  await call("POST", "/api/hub/protect", { hub: HUB });
  fake.get(HUB)!.env!.vars.set("TAPSTER_APP_SLUG", "tapster-octo-tap");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const view = async () => ((await call("GET", `/api/hub?hub=${HUB}`)).data as unknown as HubView).extras.doorbell;
const problem = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string; fix: string }).reason;

test("the doorbell starts off and holds nothing", async () => {
  expect(await view()).toEqual({ on: false, origin: null, app: null, key: false, cloudflare: null, tokenPage: TOKEN_PAGE });
});

test("a wrong token, a token without the permission and an account without workers.dev are refused plainly", async () => {
  const notToken = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: "my password!" });
  expect(problem(notToken)).toBe("that is not a Cloudflare API token");
  const wrong = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: "cf_wrongwrongwrongwrongwrong0123456789" });
  expect(wrong.status).toBe(400);
  expect(problem(wrong)).toBe("Cloudflare did not accept that token");
  cf.scope = "none";
  expect(problem(await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token }))).toBe("Cloudflare shows the token no account");
  cf.scope = "edit";
  cf.subdomain = null;
  const none = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token });
  expect(problem(none)).toBe("the Cloudflare account Octo's Account has no workers.dev subdomain yet");
  expect((none.data.error as { fix: string }).fix).toContain(`https://dash.cloudflare.com/${cf.accounts[0]!.id}/workers/onboarding`);
  cf.subdomain = "octo";
  expect((await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token, extra: 1 })).status).toBe(400);
  expect((await view()).cloudflare).toBeNull();
});

test("a working token is held for this setup only and never shown back", async () => {
  const ok = await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: ` ${cf.token}\n` });
  expect(ok.data).toEqual({ account: "Octo's Account", subdomain: "octo" });
  expect((await view()).cloudflare).toEqual({ account: "Octo's Account", subdomain: "octo" });
  expect(s.cloudflare.get(HUB)!.token).toBe(cf.token);
});

test("the doorbell App comes from the same manifest flow and its key stays in the session", async () => {
  const start = (await call("POST", "/api/hub/doorbell/app", { hub: HUB })).data as unknown as AppStart;
  expect(start.name).toBe("tapster-doorbell-octo-tap");
  expect(JSON.parse(start.manifest).default_permissions).toEqual({ actions: "write", metadata: "read" });
  expect(start.permissions).toHaveLength(2);
  const state = new URL(start.action).searchParams.get("state")!;
  fake.manifestApp = { id: 888, slug: "tapster-doorbell-octo-tap", pem: bellPem };
  fake.bell = { id: 888, slug: "tapster-doorbell-octo-tap", pem: bellPem, installation: null };
  const res = await handle(new Request(`http://127.0.0.1:8277/app/callback?code=abc&state=${state}`, { headers: { host: "127.0.0.1:8277" } }));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/setup?doorbell=created&hub=octo%2Fhomebrew-tap");
  const env = fake.get(HUB)!.env!;
  expect(env.vars.get("TAPSTER_DOORBELL_APP_ID")).toBe("888");
  expect(env.vars.get("TAPSTER_DOORBELL_APP_SLUG")).toBe("tapster-doorbell-octo-tap");
  expect([...env.secrets].some((x) => x.includes("DOORBELL"))).toBe(false);
  expect(await view()).toMatchObject({ app: { id: "888", slug: "tapster-doorbell-octo-tap" }, key: true });
  expect((await call("POST", "/api/hub/doorbell/app", { hub: HUB })).status).toBe(400);
});

test("the page sees the install and refuses an App that reaches more than the hub", async () => {
  expect((await call("GET", `/api/hub/doorbell/installation?hub=${HUB}`)).data as unknown as BellInstallView).toEqual({ id: null, others: [] });
  expect(problem(await call("POST", "/api/hub/doorbell/deploy", { hub: HUB }))).toBe("the doorbell App is not installed on octo/homebrew-tap");
  fake.bell!.installation = { id: 55, repos: [HUB, "octo/ebb"] };
  expect((await call("GET", `/api/hub/doorbell/installation?hub=${HUB}`)).data).toEqual({ id: 55, others: ["octo/ebb"] });
  const wide = await call("POST", "/api/hub/doorbell/deploy", { hub: HUB });
  expect(problem(wide)).toBe("the doorbell App reaches octo/ebb besides octo/homebrew-tap");
  expect(cf.scripts.size).toBe(0);
  fake.bell!.installation = { id: 55, repos: [HUB] };
  expect((await call("GET", `/api/hub/doorbell/installation?hub=${HUB}`)).data).toEqual({ id: 55, others: [] });
});

test("deploying uploads the Worker, rings every project and forgets the token and the key", async () => {
  const done = (await call("POST", "/api/hub/doorbell/deploy", { hub: HUB })).data as unknown as DoorbellDone;
  expect(done).toEqual({ origin: "https://tapster-doorbell.octo.workers.dev", rung: ["octo/ebb", "octo/aims"], missed: [] });
  const w = cf.scripts.get("tapster-doorbell")!;
  const bound = Object.fromEntries((w.metadata.bindings as { name: string; text: string }[]).map((b) => [b.name, b.text]));
  expect(bound).toEqual({ APP_ID: "888", INSTALLATION_ID: "55", HUB, HUB_ID: String(fake.get(HUB)!.id), OWNER_ID: "42", INTERVAL: "15" });
  expect(w.crons).toEqual(["*/15 * * * *"]);
  expect(w.workersDev).toBe(true);
  expect(w.secrets.get("APP_KEY")).toBe(createPrivateKey(bellPem).export({ type: "pkcs8", format: "pem" }).toString());
  const env = fake.get(HUB)!.env!;
  expect(env.vars.get("TAPSTER_DOORBELL")).toBe(done.origin);
  expect(env.vars.get("TAPSTER_DOORBELL_EVERY")).toBe("15");
  expect(fake.get("octo/ebb")!.repoVars.get("TAPSTER_DOORBELL")).toBe(done.origin);
  expect(fake.get("octo/aims")!.repoVars.get("TAPSTER_DOORBELL")).toBe(done.origin);
  expect(s.cloudflare.size).toBe(0);
  expect(s.bells.size).toBe(0);
  expect(await view()).toEqual({ on: true, origin: done.origin, app: { id: "888", slug: "tapster-doorbell-octo-tap" }, key: false, cloudflare: null, tokenPage: TOKEN_PAGE });
  expect(problem(await call("POST", "/api/hub/doorbell/deploy", { hub: HUB }))).toBe("this setup holds no key of the doorbell App");
});

test("setup's Add gives a new project the doorbell's address", async () => {
  const added = (await call("POST", "/api/projects/add", { hub: HUB, path: join(home, "Developer", "hafifpix"), options: { workflow: "release.yml", autoTag: false, dependabot: false, force: false } })).data as unknown as AddView;
  expect(added.lines).toContain("- the release workflow rings the hub's doorbell, so the hub publishes right after the draft opens");
  expect(fake.get("octo/hafifpix")!.repoVars.get("TAPSTER_DOORBELL")).toBe("https://tapster-doorbell.octo.workers.dev");
});

test("a later setup resumes with a dropped .pem of the doorbell App", async () => {
  const env = fake.get(HUB)!.env!;
  env.vars.delete("TAPSTER_DOORBELL");
  expect(await view()).toMatchObject({ on: false, app: { id: "888" }, key: false });
  const drop = (pem: string) => {
    const form = new FormData();
    form.set("hub", HUB);
    form.set("pem", new File([pem], "tapster-doorbell.private-key.pem"));
    return call("POST", "/api/hub/doorbell/key", form);
  };
  expect(problem(await drop("not a key"))).toBe("that file is not a private key");
  expect(problem(await drop(fake.pem))).toBe("that key does not belong to the doorbell App");
  expect((await drop(bellPem)).data).toEqual({ held: true });
  expect((await view()).key).toBe(true);
  await call("POST", "/api/hub/doorbell/cloudflare", { hub: HUB, token: cf.token });
  const again = (await call("POST", "/api/hub/doorbell/deploy", { hub: HUB })).data as unknown as DoorbellDone;
  expect(again.origin).toBe("https://tapster-doorbell.octo.workers.dev");
  expect(env.vars.get("TAPSTER_DOORBELL")).toBe(again.origin);
});

test("no response or log line carries the token or a private key", () => {
  const all = seen.join("\n");
  expect(all).not.toContain(cf.token);
  expect(all).not.toContain("PRIVATE KEY");
  expect(all).not.toContain(bellPem.split("\n")[1]!);
});
