import { expect, test } from "bun:test";
import { join } from "node:path";
import { TapsterError } from "../src/errors";
import { appCallback } from "../src/web/api/hub";
import { CSP } from "../src/web/http";
import { type Deps, type Routes, handler, newSession } from "../src/web/server";
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
};

function app(routes: Routes = {}) {
  const s = newSession(deps, 8277);
  const handle = handler(s, routes, (c) => appCallback(c));
  const call = (path: string, init: RequestInit & { host?: string } = {}) =>
    handle(new Request(`http://127.0.0.1:8277${path}`, { ...init, headers: { host: init.host ?? "127.0.0.1:8277", ...(init.headers as Record<string, string>) } }));
  const claim = async (link = s.link()) => {
    const code = link.split("#c=")[1]!;
    return call("/api/claim", { method: "POST", body: JSON.stringify({ code }) });
  };
  return { s, call, claim };
}

test("only 127.0.0.1 or localhost on this port reach the app", async () => {
  const { call } = app();
  expect((await call("/", { host: "evil.example:8277" })).status).toBe(421);
  expect((await call("/", { host: "127.0.0.1:9999" })).status).toBe(421);
  expect((await call("/", { host: "localhost:8277" })).status).toBe(200);
});

test("pages carry a strict policy and never get cached", async () => {
  const { call } = app();
  const res = await call("/setup");
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(CSP).toContain("default-src 'none'");
  expect(CSP).toContain("frame-ancestors 'none'");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).toContain('<script type="module" src="/app.js"></script>');
  expect((await call("/logo.webp")).headers.get("content-type")).toBe("image/webp");
  expect((await call("/elsewhere")).status).toBe(404);
});

test("the logo for the GitHub App downloads as site/public/logo-512.png, from this host only", async () => {
  const { call } = app();
  const res = await call("/logo.png");
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="tapster-logo.png"');
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(await Bun.file(join(import.meta.dir, "..", "site", "public", "logo-512.png")).bytes());
  expect((await call("/logo.png", { host: "evil.example:8277" })).status).toBe(421);
});

test("the API answers only with the session token", async () => {
  const { s, call } = app({ "GET /api/ping": async () => ({ pong: true }) });
  expect((await call("/api/ping")).status).toBe(401);
  expect((await call("/api/ping", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await call("/api/ping", { headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status).toBe(401);
  const ok = await call("/api/ping", { headers: { authorization: `Bearer ${s.token}` } });
  expect(await ok.json()).toEqual({ pong: true });
  expect((await call("/api/missing", { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(404);
});

test("a launch link works once; a second use ends every session and prints a fresh link", async () => {
  const { s, claim } = app();
  const link = s.link();
  const first = await claim(link);
  expect(first.status).toBe(200);
  const { token } = (await first.json()) as { token: string };
  expect(token).toBe(s.token);
  logs.length = 0;
  const again = await claim(link);
  expect(again.status).toBe(409);
  expect(s.token).not.toBe(token);
  expect(logs.join("\n")).toContain("http://127.0.0.1:8277/#c=");
  const fresh = await claim(logs.join("\n").match(/http:\/\/127\.0\.0\.1:8277\/#c=[0-9a-f]+/)![0]);
  expect(fresh.status).toBe(200);
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
  const { s, call } = app({
    "GET /api/known": async () => {
      throw new TapsterError("the hub has no App yet", "Create it in Setup.");
    },
    "GET /api/boom": async () => {
      throw new Error("internal detail");
    },
  });
  const auth = { headers: { authorization: `Bearer ${s.token}` } };
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
  expect(setupOptions([])).toEqual({ open: true, port: null, pin: null });
  expect(setupOptions(["--no-open", "--port", "9000", "--tapster", "a".repeat(40)])).toEqual({ open: false, port: 9000, pin: "a".repeat(40) });
  expect(() => setupOptions(["--port", "80"])).toThrow(TapsterError);
  expect(() => setupOptions(["--tapster", "main"])).toThrow(TapsterError);
});
