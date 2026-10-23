import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { TAPSTER } from "../src/version";
import { join } from "node:path";
import { TapsterError } from "../src/errors";
import { appCallback } from "../src/web/api/hub";
import { CSP } from "../src/web/http";
import { type Deps, PAGE, type Routes, handler, newSession } from "../src/web/server";
import { webScript } from "../src/web/assets";
import { setupOptions } from "../src/web/start";

const logs: string[] = [];
const deps: Deps = {
  github: async () => {
    throw new TapsterError("gh is not signed in", "Run gh auth login.");
  },
  fetch,
  home: "/home/me",
  cwd: "/home/me",
  pin: null,
  log: (l) => logs.push(l),
  open: () => {},
  notary: async () => false,
  keychain: async () => null,
  gpg: async () => null,
  store: () => null,
  platform: "darwin",
  where: { exec: "/opt/homebrew/Caskroom/tapster/1.0.0/tapster", script: "", sha: "a" },
  run: async (argv) => {
    throw new Error(`no command may run in this test: ${argv[0]}`);
  },
  exit: () => {},
};

function app(routes: Routes = {}, mode: "once" | "service" = "once") {
  const s = newSession(deps, 8277, mode);
  const handle = handler(s, routes, (c) => appCallback(c));
  const call = (path: string, init: RequestInit & { host?: string } = {}) =>
    handle(new Request(`http://127.0.0.1:8277${path}`, { ...init, headers: { host: init.host ?? "127.0.0.1:8277", ...(init.headers as Record<string, string>) } }));
  const claim = async (link = s.link()) => {
    const code = link.split("#c=")[1]!;
    return call("/api/claim", { method: "POST", body: JSON.stringify({ code }) });
  };
  return { s, call, claim };
}

const tokenOf = async (res: Response) => ((await res.clone().json()) as { token?: string }).token ?? null;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("a claim answers with a session token in the body and sets no cookie", async () => {
  const { claim } = app();
  const res = await claim();
  expect(res.status).toBe(200);
  expect(await tokenOf(res)).toMatch(/^[0-9a-f]{64}$/);
  expect(res.headers.get("set-cookie")).toBeNull();
  const service = await app({}, "service").claim();
  expect(service.headers.get("set-cookie")).toBeNull();
  expect(((await service.json()) as { service: boolean }).service).toBe(true);
});

test("the API answers only with the session token as a bearer", async () => {
  const { claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) });
  const token = (await tokenOf(await claim()))!;
  expect((await call("/api/ping")).status).toBe(401);
  expect((await call("/api/ping", { headers: bearer("0".repeat(64)) })).status).toBe(401);
  expect((await call("/api/ping", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await call("/api/ping", { headers: { authorization: token } })).status).toBe(401);
  expect((await call("/api/ping", { headers: { cookie: `tapster_8277=${token}` } })).status).toBe(401);
  const ok = await call("/api/ping", { headers: bearer(token) });
  expect(await ok.json()).toEqual({ pong: true });
  expect((await call("/api/missing", { headers: bearer(token) })).status).toBe(404);
});

test("a request from another origin, another port included, is refused even with the token", async () => {
  const { claim, call } = app({ "POST /api/ping": async () => ({ pong: true }) });
  const token = (await tokenOf(await claim()))!;
  const send = (origin: string) => call("/api/ping", { method: "POST", headers: { ...bearer(token), origin } });
  expect((await send("https://evil.example")).status).toBe(403);
  expect((await send("http://127.0.0.1:9999")).status).toBe(403);
  expect((await send("http://127.0.0.1:47331")).status).toBe(403);
  expect((await send("http://localhost:8277")).status).toBe(403);
  expect((await send("null")).status).toBe(403);
  expect((await send("http://127.0.0.1:8277")).status).toBe(200);
  const s = app();
  const code = s.s.link().split("#c=")[1]!;
  expect((await s.call("/api/claim", { method: "POST", headers: { origin: "http://127.0.0.1:5173" }, body: JSON.stringify({ code }) })).status).toBe(403);
});

test("a second claim rotates the token: the first one stops working", async () => {
  const { claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) });
  const first = (await tokenOf(await claim()))!;
  const second = (await tokenOf(await claim()))!;
  expect(second).not.toBe(first);
  expect((await call("/api/ping", { headers: bearer(first) })).status).toBe(401);
  expect((await call("/api/ping", { headers: bearer(second) })).status).toBe(200);
});

test("the service locks after 12 hours without a request; the one-shot session does not", async () => {
  for (const mode of ["service", "once"] as const) {
    const { s, claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) }, mode);
    const token = (await tokenOf(await claim()))!;
    s.touched = Date.now() - 11 * 3_600_000;
    expect((await call("/api/ping", { headers: bearer(token) })).status).toBe(200);
    s.touched = Date.now() - 12 * 3_600_000 - 60_000;
    expect((await call("/api/ping", { headers: bearer(token) })).status).toBe(mode === "service" ? 401 : 200);
    if (mode === "service") expect((await call("/api/ping", { headers: bearer(token) })).status).toBe(401);
  }
});

test("the page's own release check does not keep an idle session open", async () => {
  const { s, claim, call } = app({ "GET /api/tapster": async () => ({}) }, "service");
  const token = (await tokenOf(await claim()))!;
  s.touched = Date.now() - 11 * 3_600_000;
  await call("/api/tapster", { headers: bearer(token) });
  expect(Date.now() - s.touched).toBeGreaterThan(10 * 3_600_000);
});

test("the service's pairing ends after 30 days", async () => {
  const { s, claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) }, "service");
  const token = (await tokenOf(await claim()))!;
  s.pairing!.at = Date.now() - 31 * 86_400_000;
  expect((await call("/api/ping", { headers: bearer(token) })).status).toBe(401);
});

test("a launch link works once; a second use ends every session and prints a fresh link", async () => {
  const { s, claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) });
  const link = s.link();
  const first = await claim(link);
  expect(first.status).toBe(200);
  const token = (await tokenOf(first))!;
  logs.length = 0;
  const again = await claim(link);
  expect(again.status).toBe(409);
  expect(await tokenOf(again)).toBeNull();
  expect((await call("/api/ping", { headers: bearer(token) })).status).toBe(401);
  expect(logs.join("\n")).toContain("http://127.0.0.1:8277/#c=");
  const fresh = await claim(logs.join("\n").match(/http:\/\/127\.0\.0\.1:8277\/#c=[0-9a-f]+/)![0]);
  expect(fresh.status).toBe(200);
});

test("the service never writes a pairing link to its log", async () => {
  const { s, claim } = app({}, "service");
  const link = s.link();
  await claim(link);
  logs.length = 0;
  expect((await claim(link)).status).toBe(409);
  expect(logs.join("\n")).not.toContain("#c=");
  expect(logs.join("\n")).toContain("Run tapster setup");
});

test("keys held in memory are forgotten after an hour", async () => {
  const { s, claim, call } = app({ "GET /api/ping": async () => ({ pong: true }) }, "service");
  const token = (await tokenOf(await claim()))!;
  const old = Date.now() - 3_600_001;
  s.apps.set("me/homebrew-old", { id: "1", pem: "pem", slug: "a", at: old });
  s.apps.set("me/homebrew-new", { id: "2", pem: "pem", slug: "b", at: Date.now() });
  s.bells.set("me/homebrew-old", { id: "3", pem: "pem", slug: "c", at: old });
  s.sparkle.set("me/homebrew-old x", { seed: "seed", at: old });
  await call("/api/ping", { headers: bearer(token) });
  expect([...s.apps.keys()]).toEqual(["me/homebrew-new"]);
  expect(s.bells.size).toBe(0);
  expect(s.sparkle.size).toBe(0);
});

test("the page keeps a strict CSP: no inline script, no eval and nothing from another origin", async () => {
  expect(CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'");
  expect(PAGE).not.toMatch(/<script(?![^>]*\ssrc="\/app\.js")/);
  expect(PAGE).not.toMatch(/\son\w+=/);
  const script = await webScript();
  expect(script).not.toMatch(/\beval\(|new Function\(/);
});

test("the page can check that this server is the one it paired with before it sends its token", async () => {
  const { s, claim, call } = app();
  const nonce = "ab".repeat(16);
  expect((await call(`/api/hello?nonce=${nonce}`)).status).toBe(401);
  const first = (await (await claim()).json()) as { token: string; proof: string };
  expect(first.proof).toMatch(/^[0-9a-f]{64}$/);
  expect(first.proof).not.toBe(first.token);
  const mac = (proof: string) => createHmac("sha256", proof).update(`tapster ${nonce} ${TAPSTER.version}`).digest("hex");
  const hello = await call(`/api/hello?nonce=${nonce}`);
  expect(hello.status).toBe(200);
  expect(await hello.json()).toEqual({ version: expect.any(String), mac: mac(first.proof) });
  expect(JSON.stringify(s.pairing)).not.toContain(first.token);
  expect((await call("/api/hello?nonce=short")).status).toBe(400);
  expect((await call(`/api/hello?nonce=${nonce}`, { headers: { origin: "http://127.0.0.1:5173" } })).status).toBe(403);
  const second = (await (await claim()).json()) as { proof: string };
  expect(((await (await call(`/api/hello?nonce=${nonce}`)).json()) as { mac: string }).mac).toBe(mac(second.proof));
});

test("expired pairing codes are dropped when a new one is made", () => {
  const { s } = app();
  s.codes.set("a".repeat(32), Date.now() - 1);
  s.codes.set("b".repeat(32), Date.now() + 60_000);
  s.link();
  expect(s.codes.has("a".repeat(32))).toBe(false);
  expect(s.codes.has("b".repeat(32))).toBe(true);
  expect(s.codes.size).toBe(2);
});

test("expired or made-up codes are refused", async () => {
  const { s, claim } = app();
  const link = s.link();
  s.codes.set(link.split("#c=")[1]!, Date.now() - 1);
  expect((await claim(link)).status).toBe(410);
  expect((await claim(`x#c=${"a".repeat(32)}`)).status).toBe(410);
  expect((await claim("x#c=../../etc")).status).toBe(400);
});

test("errors reach the page as a reason and a fix; unexpected ones stay in the terminal", async () => {
  const { claim, call } = app({
    "GET /api/known": async () => {
      throw new TapsterError("the hub has no App yet", "Create it in Setup.");
    },
    "GET /api/boom": async () => {
      throw new Error("internal detail");
    },
  });
  const auth = { headers: bearer((await tokenOf(await claim()))!) };
  const known = await call("/api/known", auth);
  expect(known.status).toBe(400);
  expect(await known.json()).toEqual({ error: { reason: "the hub has no App yet", fix: "Create it in Setup." } });
  logs.length = 0;
  const boom = await call("/api/boom", auth);
  expect(boom.status).toBe(500);
  expect(JSON.stringify(await boom.json())).not.toContain("internal detail");
  expect(logs.join("\n")).toContain("internal detail");
});

test("the GitHub App callback needs the state the app created and uses it once", async () => {
  const { s, call } = app();
  const unknown = await call("/app/callback?code=abc&state=nope");
  expect(unknown.status).toBe(303);
  expect(unknown.headers.get("location")).toBe("/setup?app=unknown");
  s.pending.set("s1", { hub: "me/homebrew-tap", owner: "me", at: Date.now() });
  const bad = await call("/app/callback?code=a%20b&state=s1");
  expect(bad.headers.get("location")).toBe("/setup?app=unknown");
});

test("setup options", () => {
  expect(setupOptions([])).toEqual({ open: true, port: null, pin: null, service: false });
  expect(setupOptions(["--no-open", "--port", "9000", "--tapster", "a".repeat(40)])).toEqual({ open: false, port: 9000, pin: "a".repeat(40), service: false });
  expect(() => setupOptions(["--port", "80"])).toThrow(TapsterError);
  expect(() => setupOptions(["--tapster", "main"])).toThrow(TapsterError);
});
