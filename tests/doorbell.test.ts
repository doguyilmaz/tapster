import { beforeAll, expect, test } from "bun:test";
import { DoorbellError, type Jwk, type KeySource, jwksSource, verifyOidc } from "../src/doorbell/jwt";
import { dispatch, handle } from "../src/doorbell/worker";

const ORIGIN = "https://tapster-doorbell.o.workers.dev";
const NOW = 1_800_000_000;
const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
let pair: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: Jwk;
let appPem: string;

const rsa = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

beforeAll(async () => {
  pair = (await rsa()) as CryptoKeyPair;
  other = (await rsa()) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" } as Jwk;
  const app = (await rsa()) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", app.privateKey));
  appPem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;
});

const good = () => ({
  iss: "https://token.actions.githubusercontent.com",
  aud: ORIGIN,
  repository: "o/aims",
  repository_owner_id: "42",
  runner_environment: "github-hosted",
  ref: "refs/tags/v1.2.3",
  ref_type: "tag",
  event_name: "push",
  iat: NOW - 10,
  nbf: NOW - 10,
  exp: NOW + 290,
});

async function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "k1" }, key = pair.privateKey): Promise<string> {
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${sig.toString("base64url")}`;
}

const keys: KeySource = async (kid) => (kid === "k1" ? jwk : null);

test("a token from the owner's tagged release passes", async () => {
  const claims = await verifyOidc(await token(good()), ORIGIN, "42", keys, NOW);
  expect(claims.repository).toBe("o/aims");
});

test.each([
  ["another issuer", { iss: "https://evil" }],
  ["another audience", { aud: "https://elsewhere" }],
  ["an audience list", { aud: [ORIGIN] }],
  ["another owner", { repository_owner_id: "43" }],
  ["a numeric owner", { repository_owner_id: 42 }],
  ["a self-hosted runner", { runner_environment: "self-hosted" }],
  ["a branch", { ref: "refs/heads/main", ref_type: "branch" }],
  ["a tag without v", { ref: "refs/tags/1.2.3" }],
  ["a pull request", { event_name: "pull_request_target" }],
  ["an expired token", { exp: NOW - 61 }],
  ["a token from the future", { iat: NOW + 120, nbf: NOW + 120 }],
  ["a token that lives too long", { exp: NOW + 7200 }],
])("refuses %s", async (_, change) => {
  await expect(verifyOidc(await token({ ...good(), ...change }), ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
});

test("refuses other algorithms, other keys, unknown kids and oversized tokens", async () => {
  await expect(verifyOidc(await token(good(), { alg: "none", kid: "k1" }), ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
  await expect(verifyOidc(await token(good(), { alg: "HS256", kid: "k1" }), ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
  await expect(verifyOidc(await token(good(), undefined, other.privateKey), ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
  await expect(verifyOidc(await token(good(), { alg: "RS256", kid: "k9" }), ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
  await expect(verifyOidc(`${"a".repeat(9000)}.b.c`, ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
  await expect(verifyOidc("not a token", ORIGIN, "42", keys, NOW)).rejects.toThrow(DoorbellError);
});

test("the key set is cached for an hour, fetched again for an unknown kid at most every 5 minutes and never cached when a fetch fails", async () => {
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => {
    calls++;
    if (fail) return new Response("down", { status: 503 });
    return Response.json({ keys: [jwk] });
  };
  let clock = NOW;
  const source = jwksSource(fetchImpl as unknown as typeof fetch, () => clock);
  expect(await source("k1")).toEqual(jwk);
  expect(await source("k1")).toEqual(jwk);
  expect(await source("k9")).toBeNull();
  expect(calls).toBe(1);
  clock += 61;
  expect(await source("k9")).toBeNull();
  expect(calls).toBe(1);
  clock += 240;
  expect(await source("k9")).toBeNull();
  expect(calls).toBe(2);
  expect(await source("k9")).toBeNull();
  expect(calls).toBe(2);
  clock += 3601;
  expect(await source("k1")).toEqual(jwk);
  expect(calls).toBe(3);
  fail = true;
  const fresh = jwksSource(fetchImpl as unknown as typeof fetch, () => clock);
  await expect(fresh("k1")).rejects.toThrow(DoorbellError);
  fail = false;
  clock += 31;
  expect(await fresh("k1")).toEqual(jwk);
});

type Call = { method: string; url: string; body: unknown; auth: string | null };
function fakeGitHub(dispatchStatus = 204): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
    if (u.endsWith("/app/installations/77/access_tokens")) return Response.json({ token: "ghs_installationtoken" }, { status: 201 });
    if (u.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus });
    if (u.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response("no", { status: 404 });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const env = () => ({ APP_ID: "1001", INSTALLATION_ID: "77", HUB: "o/homebrew-tap", HUB_ID: "555", OWNER_ID: "42", APP_KEY: appPem });

test("the dispatch asks for an Actions-only token on the hub and always revokes it", async () => {
  const gh = fakeGitHub();
  await dispatch(env(), gh.fetchImpl, NOW);
  expect(gh.calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`)).toEqual([
    "POST /app/installations/77/access_tokens",
    "POST /repos/o/homebrew-tap/actions/workflows/tapster.yml/dispatches",
    "DELETE /installation/token",
  ]);
  expect(gh.calls[0]!.body).toEqual({ repository_ids: [555], permissions: { actions: "write" } });
  expect(gh.calls[1]!.body).toEqual({ ref: "main" });
  expect(gh.calls[1]!.auth).toBe("Bearer ghs_installationtoken");
  const failing = fakeGitHub(422);
  await expect(dispatch(env(), failing.fetchImpl, NOW)).rejects.toThrow(DoorbellError);
  expect(failing.calls.at(-1)!.method).toBe("DELETE");
});

test("the handler answers 405, 401, 202 and 502 and never logs a token", async () => {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const jwks = async () => Response.json({ keys: [jwk] });
  const call = async (method: string, auth: string | null, dispatchStatus = 204) => {
    const gh = fakeGitHub(dispatchStatus);
    const both = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("token.actions") ? jwks() : gh.fetchImpl(url, init))) as typeof fetch;
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    return handle(new Request(`${ORIGIN}/`, { method, headers }), env(), both, NOW, log);
  };
  const t = await token(good());
  expect((await call("GET", null)).status).toBe(405);
  const refused = await call("POST", "Bearer nope");
  expect(refused.status).toBe(401);
  expect(await refused.text()).toBe("");
  expect((await call("POST", `Bearer ${t}`)).status).toBe(202);
  expect((await call("POST", `Bearer ${t}`, 500)).status).toBe(502);
  expect(lines.join("\n")).not.toContain(t.split(".")[2]!.slice(0, 20));
  expect(lines.join("\n")).not.toContain("ghs_installationtoken");
  expect(lines.some((l) => l.includes("o/aims refs/tags/v1.2.3"))).toBe(true);
});

test("rings that arrive together share one key set fetch, and a failed fetch is not retried for 30 seconds", async () => {
  let calls = 0;
  let fail = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fetchImpl = (async () => {
    calls++;
    await gate;
    return fail ? new Response("down", { status: 503 }) : Response.json({ keys: [jwk] });
  }) as unknown as typeof fetch;
  let clock = NOW;
  const source = jwksSource(fetchImpl, () => clock);
  const both = Promise.all([source("k1"), source("k1")]);
  release();
  expect(await both).toEqual([jwk, jwk]);
  expect(calls).toBe(1);
  fail = true;
  const broken = jwksSource(fetchImpl, () => clock);
  await expect(broken("k1")).rejects.toThrow(DoorbellError);
  await expect(broken("k1")).rejects.toThrow(DoorbellError);
  expect(calls).toBe(2);
  clock += 31;
  fail = false;
  expect(await broken("k1")).toEqual(jwk);
  expect(calls).toBe(3);
});
