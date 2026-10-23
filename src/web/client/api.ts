import type { Problem } from "../contract";

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly status: number) {
    super(problem.reason);
  }
}

const KEY = "tapster.session";

type Held = { token: string; proof: string };

// The token lives in this origin's storage, which no other port or site can read. The service keeps it in localStorage
// so the page stays signed in across tabs and restarts. One tapster setup keeps it in sessionStorage so it ends with the tab.
const stores = (): Storage[] => {
  try {
    return [localStorage, sessionStorage];
  } catch {
    return [];
  }
};

function saved(): Held | null {
  for (const s of stores()) {
    try {
      const v = JSON.parse(s.getItem(KEY) ?? "null") as Partial<Held> | null;
      if (typeof v?.token === "string" && typeof v.proof === "string") return { token: v.token, proof: v.proof };
    } catch {
      continue;
    }
  }
  return null;
}

function keep(value: Held | null, service = false): void {
  for (const s of stores()) {
    try {
      if (value !== null && (s === localStorage) === service) s.setItem(KEY, JSON.stringify(value));
      else s.removeItem(KEY);
    } catch {
      continue;
    }
  }
}

let held = saved();
let onSignedOut: () => void = () => {};

export const whenSignedOut = (f: () => void) => {
  onSignedOut = f;
};

function signOut(): void {
  held = null;
  trusted = null;
  keep(null);
  onSignedOut();
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export type Hello = { state: "ok"; version: string } | { state: "down" } | { state: "foreign" } | { state: "unpaired" };

// Asks the server to sign a fresh nonce with the proof key from the claim. The token never goes with this request, so a
// program that took the port while tapster restarted learns nothing and fails the check.
export async function hello(): Promise<Hello> {
  if (!held) return { state: "unpaired" };
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  let res: Response;
  try {
    res = await fetch(`/api/hello?nonce=${nonce}`, { credentials: "omit", cache: "no-store" });
  } catch {
    return { state: "down" };
  }
  if (res.status === 401) return { state: "unpaired" };
  const body = (await res.json().catch(() => null)) as { version?: unknown; mac?: unknown } | null;
  if (typeof body?.version !== "string" || typeof body.mac !== "string") return { state: "foreign" };
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(held.proof), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`tapster ${nonce} ${body.version}`)));
  return mac === body.mac ? { state: "ok", version: body.version } : { state: "foreign" };
}

export const FOREIGN: Problem = { reason: "another program answers at this address", fix: "tapster sent it nothing. Close that program, then run tapster setup in a terminal. tapster service status shows whether the service runs." };

let trusted: Promise<void> | null = null;

function trust(): Promise<void> {
  trusted ??= hello().then((h) => {
    if (h.state === "ok") return;
    trusted = null;
    if (h.state === "unpaired") {
      signOut();
      throw new ApiError({ reason: "this page is not signed in to tapster setup", fix: "Run tapster setup in a terminal for a fresh link." }, 401);
    }
    if (h.state === "foreign") throw new ApiError(FOREIGN, 0);
    throw new ApiError({ reason: "tapster setup is not answering", fix: "Check that tapster setup still runs. If it stopped, run tapster setup in a terminal again." }, 0);
  });
  return trusted;
}

export async function claim(code: string): Promise<void> {
  const res = await fetch("/api/claim", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await res.json().catch(() => ({}))) as { token?: string; proof?: string; service?: boolean; error?: Problem };
  if (!res.ok || !body.token || !body.proof) throw new ApiError(body.error ?? { reason: "the link did not work", fix: "Run tapster setup in a terminal for a fresh link." }, res.status);
  held = { token: body.token, proof: body.proof };
  trusted = Promise.resolve();
  keep(held, body.service === true);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  await trust();
  const headers: Record<string, string> = { authorization: `Bearer ${held?.token ?? ""}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "omit", headers, body: payload });
  } catch {
    trusted = null;
    throw new ApiError({ reason: "tapster setup is not answering", fix: "Check that tapster setup still runs. If it stopped, run tapster setup in a terminal again." }, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (res.status === 401) signOut();
  if (!res.ok || data === null) throw new ApiError(data?.error ?? { reason: `tapster setup answered ${res.status}`, fix: "Reload the page and try again." }, res.status);
  return data;
}

export const get = <T>(path: string) => send<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {});
