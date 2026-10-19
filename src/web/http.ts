import { timingSafeEqual } from "node:crypto";
import { GitHubError, TapsterError } from "../errors";

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'";

const BASE: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export function respond(body: string | Uint8Array | null, status: number, type: string | null, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE, ...(type ? { "content-type": type } : {}), ...extra } });
}

export const json = (data: unknown, status = 200) => respond(JSON.stringify(data), status, "application/json; charset=utf-8");

export type Problem = { reason: string; fix: string };

export function problem(e: unknown): { status: number; body: { error: Problem } } {
  if (e instanceof GitHubError) return { status: 502, body: { error: { reason: e.reason, fix: e.fix } } };
  if (e instanceof TapsterError) return { status: 400, body: { error: { reason: e.reason, fix: e.fix } } };
  return { status: 500, body: { error: { reason: "tapster hit an unexpected error", fix: "The terminal that runs tapster setup shows the details. Try again; if it repeats, open an issue at https://github.com/doguyilmaz/tapster/issues." } } };
}

export function hostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function tokenMatches(header: string | null, token: string): boolean {
  const given = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
