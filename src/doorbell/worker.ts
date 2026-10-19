import { DoorbellError, type KeySource, jwksSource, verifyOidc } from "./jwt";

export type Env = { APP_ID: string; INSTALLATION_ID: string; HUB: string; HUB_ID: string; OWNER_ID: string; INTERVAL?: string; APP_KEY: string };

const API = "https://api.github.com";
const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function appJwt(env: Env, now: number): Promise<string> {
  const der = Uint8Array.from(atob(env.APP_KEY.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.APP_ID }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

async function github(fetchImpl: typeof fetch, method: string, path: string, auth: string, body?: unknown): Promise<Response> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "tapster-doorbell",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) throw new DoorbellError(502, `${method} ${path.split("/").slice(0, 3).join("/")} failed`);
  return res;
}

export async function dispatch(env: Env, fetchImpl: typeof fetch, now: number, opts: { tick?: boolean } = {}): Promise<"dispatched" | "skipped"> {
  const jwt = await appJwt(env, now);
  const minted = await github(fetchImpl, "POST", `/app/installations/${env.INSTALLATION_ID}/access_tokens`, jwt, { repository_ids: [Number(env.HUB_ID)], permissions: { actions: "write" } });
  if (!minted.ok) throw new DoorbellError(502, `GitHub refused a token (${minted.status})`);
  const { token } = (await minted.json()) as { token: string };
  const flow = `/repos/${env.HUB}/actions/workflows/tapster.yml`;
  try {
    const wf = await github(fetchImpl, "GET", flow, token);
    if (!wf.ok) throw new DoorbellError(502, `GitHub did not show the hub workflow (${wf.status})`);
    const { state } = (await wf.json()) as { state: string };
    if (state === "disabled_inactivity") {
      const on = await github(fetchImpl, "PUT", `${flow}/enable`, token);
      if (!on.ok) throw new DoorbellError(502, `GitHub refused to turn the workflow back on (${on.status})`);
    } else if (state !== "active") throw new DoorbellError(409, `the hub workflow is ${state.replace(/_/g, " ")}`);
    if (opts.tick) {
      const runs = await github(fetchImpl, "GET", `${flow}/runs?per_page=1`, token);
      if (!runs.ok) throw new DoorbellError(502, `GitHub did not list the runs (${runs.status})`);
      const last = ((await runs.json()) as { workflow_runs: { created_at: string }[] }).workflow_runs[0];
      const interval = Number(env.INTERVAL ?? "10") * 60;
      if (last && now - Date.parse(last.created_at) / 1000 < interval - 30) return "skipped";
    }
    const res = await github(fetchImpl, "POST", `${flow}/dispatches`, token, { ref: "main" });
    if (!res.ok) throw new DoorbellError(502, `GitHub refused the dispatch (${res.status})`);
    return "dispatched";
  } finally {
    await github(fetchImpl, "DELETE", "/installation/token", token).catch(() => null);
  }
}

const clean = (v: unknown) => String(v).replace(/[^\x20-\x7e]/g, "").slice(0, 200);

export async function handle(request: Request, env: Env, fetchImpl: typeof fetch, now: number, log: (line: string) => void, keys?: KeySource): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let claims: Record<string, unknown>;
  try {
    claims = await verifyOidc(token, new URL(request.url).origin, env.OWNER_ID, keys ?? jwksSource(fetchImpl, () => now), now);
  } catch (e) {
    const status = e instanceof DoorbellError ? e.status : 401;
    log(`refused: ${e instanceof DoorbellError ? e.reason : "unexpected error"} -> ${status}`);
    return new Response(null, { status });
  }
  const who = `${clean(claims.repository)} ${clean(claims.ref)}`;
  try {
    await dispatch(env, fetchImpl, now);
  } catch (e) {
    log(`rang: ${who} -> 502 (${e instanceof DoorbellError ? e.reason : "unexpected error"})`);
    return new Response(null, { status: 502 });
  }
  log(`rang: ${who} -> 202`);
  return new Response(null, { status: 202 });
}

const boundFetch = ((input, init) => fetch(input, init)) as typeof fetch;
let keys: KeySource | null = null;

export async function tick(env: Env, fetchImpl: typeof fetch, now: number, log: (line: string) => void): Promise<void> {
  try {
    log(`tick: ${await dispatch(env, fetchImpl, now, { tick: true })}`);
  } catch (e) {
    log(`tick: failed (${e instanceof DoorbellError ? e.reason : "unexpected error"})`);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    keys ??= jwksSource(boundFetch, () => Math.floor(Date.now() / 1000));
    return handle(request, env, boundFetch, Math.floor(Date.now() / 1000), (line) => console.log(line), keys);
  },
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
    ctx.waitUntil(tick(env, boundFetch, Math.floor(Date.now() / 1000), (line) => console.log(line)));
  },
};
