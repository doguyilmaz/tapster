import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { TapsterError } from "../errors";
import type { GitHub } from "../github";
import type { NotaryKey } from "../cli/apple";
import type { CloudflareAccount, CloudflareTarget } from "../cli/cloudflare";
import type { Store } from "../cli/keystore";
import type { Runner } from "../cli/runner";
import type { Where } from "../cli/upgrade";
import { scrub } from "../mask";
import { COURIER_URI, LOGO_URI } from "../ui/images";
import { logoPng, webScript } from "./assets";
import { hostAllowed, json, problem, respond } from "./http";
import css from "./client/app.css" with { type: "text" };

export type Deps = {
  github(): Promise<GitHub>;
  fetch: typeof fetch;
  home: string;
  cwd: string;
  pin: string | null;
  log(line: string): void;
  open(url: string): void;
  notary(key: NotaryKey): Promise<boolean>;
  keychain(account: string): Promise<string | null>;
  gpg(): Promise<string | null>;
  store(): Store | null;
  platform: NodeJS.Platform;
  where: Where;
  run: Runner;
  exit(code: number): void;
};

export type Mode = "once" | "service";

// Only a hash of the session token stays in memory, so the service can keep a pairing across a restart without the token itself.
export type Pairing = { hash: string; at: number };

export type Session = {
  deps: Deps;
  port: number;
  mode: Mode;
  pairing: Pairing | null;
  kept(): void;
  codes: Map<string, number>;
  claimed: Set<string>;
  pending: Map<string, { hub: string; owner: string; at: number; kind?: "doorbell" }>;
  apps: Map<string, { id: string; pem: string; slug: string; at: number }>;
  bells: Map<string, { id: string; pem: string; slug: string; at: number }>;
  cloudflare: Map<string, { token: string; accounts: CloudflareAccount[]; target: CloudflareTarget | null; at: number }>;
  sparkle: Map<string, { seed: string; at: number }>;
  dispatched: Map<string, { at: number; known: number[] }>;
  memo: Map<string, unknown>;
  warm: Map<string, { at: number; value: Promise<unknown> }>;
  touched: number;
  login: string | null;
  link(): string;
};

export type Ctx = { s: Session; req: Request; url: URL };
export type Handler = (c: Ctx) => Promise<unknown>;
export type Routes = Record<string, Handler>;

const CODE_TTL = 10 * 60_000;
export const PAIRED_DAYS = 30;
export const IDLE_LOCK = 12 * 3_600_000;
const HELD = 3_600_000;

// An App key GitHub handed over and a Sparkle key read from the keychain stay in memory for an hour at most.
function forgetHeld(s: Session): void {
  for (const held of [s.apps, s.bells, s.sparkle] as Map<string, { at: number }>[]) for (const [k, v] of held) if (Date.now() - v.at > HELD) held.delete(k);
}
const PAGES = new Set(["/", "/setup", "/projects", "/health"]);

const image = (uri: string) => Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
const IMAGES: Record<string, Buffer> = { "/logo.webp": image(LOGO_URI), "/courier.webp": image(COURIER_URI) };

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>tapster setup</title>
<link rel="icon" href="/logo.webp">
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<div id="app"></div>
<noscript><p class="noscript">tapster setup needs JavaScript. The same steps work in a terminal: tapster init and tapster add.</p></noscript>
</body>
</html>
`;

export function newSession(deps: Deps, port: number, mode: Mode = "once"): Session {
  const s: Session = {
    deps,
    port,
    mode,
    pairing: null,
    kept: () => {},
    codes: new Map(),
    claimed: new Set(),
    pending: new Map(),
    apps: new Map(),
    bells: new Map(),
    cloudflare: new Map(),
    sparkle: new Map(),
    dispatched: new Map(),
    memo: new Map(),
    warm: new Map(),
    touched: Date.now(),
    login: null,
    link: () => {
      const code = randomBytes(16).toString("hex");
      s.codes.set(code, Date.now() + CODE_TTL);
      return `http://127.0.0.1:${s.port}/#c=${code}`;
    },
  };
  return s;
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new TapsterError("the request was not JSON", "Reload the page and try again.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TapsterError("the request did not have the expected fields", "Reload the page and try again.");
  return parsed.data;
}

const fresh = (s: Session) => (s.mode === "service" ? "Run tapster setup in a terminal for a fresh link." : "Press Enter in the terminal that runs tapster setup for a fresh link.");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function bearer(header: string | null): string | null {
  return /^Bearer ([0-9a-f]{64})$/.exec(header ?? "")?.[1] ?? null;
}

function endPairing(s: Session): void {
  s.pairing = null;
  s.kept();
}

function signedIn(s: Session, req: Request): boolean {
  const p = s.pairing;
  const given = bearer(req.headers.get("authorization"));
  if (!p || !given) return false;
  if (!timingSafeEqual(Buffer.from(hash(given)), Buffer.from(p.hash))) return false;
  if (s.mode === "service" && (Date.now() - s.touched > IDLE_LOCK || Date.now() - p.at > PAIRED_DAYS * 86_400_000)) {
    endPairing(s);
    return false;
  }
  return true;
}

function claim(s: Session, code: unknown): Response {
  if (typeof code !== "string" || !/^[0-9a-f]{32}$/.test(code)) return json({ error: { reason: "this link is not a tapster setup link", fix: fresh(s) } }, 400);
  if (s.claimed.has(code)) {
    s.codes.clear();
    endPairing(s);
    s.deps.log("tapster setup: the same link was opened twice, so tapster ended every session for safety.");
    if (s.mode === "service") s.deps.log("Run tapster setup in a terminal for a fresh link.");
    else s.deps.log(`Open this fresh link in your browser: ${s.link()}`);
    return json({ error: { reason: "this link was already used", fix: s.mode === "service" ? "tapster ended every session for safety. Run tapster setup in a terminal for a fresh link." : "tapster ended every session for safety. Open the fresh link the terminal printed." } }, 409);
  }
  const expires = s.codes.get(code);
  if (expires === undefined || expires < Date.now()) return json({ error: { reason: "this link has expired", fix: fresh(s) } }, 410);
  s.codes.delete(code);
  s.claimed.add(code);
  const value = randomBytes(32).toString("hex");
  s.pairing = { hash: hash(value), at: Date.now() };
  s.touched = Date.now();
  s.kept();
  return json({ token: value, service: s.mode === "service" });
}

// The bearer token lives in this origin's storage only. An Authorization header needs a CORS preflight that this server never grants. Origin, when the browser sends one, must be this page.
function fromPage(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === `http://${req.headers.get("host")}`;
}

export function handler(s: Session, routes: Routes, callback: (c: Ctx) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!hostAllowed(req.headers.get("host"), s.port)) return respond("Misdirected request", 421, "text/plain; charset=utf-8");
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "GET" && PAGES.has(path)) return respond(PAGE, 200, "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/app.css") return respond(css, 200, "text/css; charset=utf-8");
    if (req.method === "GET" && path === "/app.js") return respond(await webScript(), 200, "text/javascript; charset=utf-8");
    if (req.method === "GET" && IMAGES[path]) return respond(new Uint8Array(IMAGES[path]), 200, "image/webp");
    if (req.method === "GET" && path === "/logo.png") return respond(await logoPng(), 200, "image/png", { "content-disposition": 'attachment; filename="tapster-logo.png"' });
    if (req.method === "GET" && path === "/app/callback") return callback({ s, req, url });
    if (!path.startsWith("/api/")) return respond("Not found", 404, "text/plain; charset=utf-8");
    forgetHeld(s);
    if (!fromPage(req)) return json({ error: { reason: "this request did not come from the tapster setup page", fix: "Open tapster setup from your terminal." } }, 403);
    if (req.method === "POST" && path === "/api/claim") {
      const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
      return claim(s, body?.code);
    }
    if (!signedIn(s, req)) return json({ error: { reason: "this page is not signed in to tapster setup", fix: fresh(s) } }, 401);
    // The page asks for the latest release by itself every six hours; that alone does not keep an idle session open.
    if (path !== "/api/tapster") {
      const before = s.touched;
      s.touched = Date.now();
      if (s.touched - before > 600_000) s.kept();
    }
    if (req.method !== "GET") s.warm.clear();
    const route = routes[`${req.method} ${path}`];
    if (!route) return json({ error: { reason: "unknown request", fix: "Reload the page." } }, 404);
    try {
      return json((await route({ s, req, url })) ?? {});
    } catch (e) {
      const p = problem(e);
      if (p.status === 500) s.deps.log(`tapster setup: ${req.method} ${path} failed: ${scrub(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error")}`);
      return json(p.body, p.status);
    }
  };
}
