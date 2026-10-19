export class DoorbellError extends Error {
  constructor(
    readonly status: 401 | 502,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export type Claims = Record<string, unknown>;
export type Jwk = { kty?: string; n?: string; e?: string; kid?: string };
export type KeySource = (kid: string) => Promise<Jwk | null>;

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = `${ISSUER}/.well-known/jwks`;
const SKEW = 60;
const MAX_TOKEN = 8192;
const KEYS_TTL = 3600;
const REFETCH_GAP = 300;

const refuse = (reason: string) => new DoorbellError(401, reason);

function decode(part: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function json(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder().decode(decode(part)));
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw refuse("malformed token");
}

export function jwksSource(fetchImpl: typeof fetch, clock: () => number): KeySource {
  let keys = new Map<string, Jwk>();
  let fetchedAt = -Infinity;
  const refresh = async () => {
    fetchedAt = clock();
    const res = await fetchImpl(JWKS, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) throw new DoorbellError(502, "GitHub's key set is unreachable");
    const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
    const list = Array.isArray(body?.keys) ? (body.keys as Jwk[]) : [];
    const next = new Map(list.filter((k) => typeof k.kid === "string" && k.kty === "RSA").map((k) => [k.kid!, k]));
    if (next.size === 0) throw new DoorbellError(502, "GitHub's key set is empty");
    keys = next;
  };
  return async (kid) => {
    const now = clock();
    if (now - fetchedAt > KEYS_TTL || (!keys.has(kid) && now - fetchedAt > REFETCH_GAP)) {
      try {
        await refresh();
      } catch (e) {
        fetchedAt = -Infinity;
        throw e;
      }
    }
    return keys.get(kid) ?? null;
  };
}

export async function verifyOidc(token: string, origin: string, ownerId: string, keys: KeySource, now: number): Promise<Claims> {
  if (token.length > MAX_TOKEN) throw refuse("token too large");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw refuse("malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = json(h);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw refuse("unexpected algorithm");
  const jwk = await keys(header.kid);
  if (!jwk) throw refuse("unknown key");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw new DoorbellError(502, "GitHub's key could not be read");
  }
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw refuse("bad signature");
  const c = json(p);
  const num = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : Number.NaN);
  if (c.iss !== ISSUER) throw refuse("wrong issuer");
  if (typeof c.aud !== "string" || c.aud !== origin) throw refuse("wrong audience");
  if (typeof c.repository_owner_id !== "string" || c.repository_owner_id !== ownerId) throw refuse("wrong owner");
  if (c.runner_environment !== "github-hosted") throw refuse("not a GitHub-hosted runner");
  if (c.ref_type !== "tag" || typeof c.ref !== "string" || !c.ref.startsWith("refs/tags/v")) throw refuse("not a version tag");
  if (c.event_name !== "push" && c.event_name !== "workflow_dispatch") throw refuse("unexpected event");
  const [exp, nbf, iat] = [num("exp"), num("nbf"), num("iat")];
  if (!(exp >= now - SKEW) || !(nbf <= now + SKEW) || !(iat <= now + SKEW) || !(exp - iat <= 3600)) throw refuse("token time is off");
  return c;
}
