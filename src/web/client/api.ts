import type { Problem } from "../contract";

const KEY = "tapster.session";

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly status: number) {
    super(problem.reason);
  }
}

const store = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, v);
    } catch {
      return;
    }
  },
};

let token = store.get();
let onSignedOut: () => void = () => {};

export const hasSession = () => token !== null;
export const whenSignedOut = (f: () => void) => {
  onSignedOut = f;
};

export async function claim(code: string): Promise<void> {
  const res = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: Problem };
  if (!res.ok || !body.token) throw new ApiError(body.error ?? { reason: "the link did not work", fix: "Press Enter in the terminal that runs tapster setup for a fresh link." }, res.status);
  token = body.token;
  store.set(token);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token ?? ""}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError({ reason: "tapster setup is not answering", fix: "Check that tapster setup still runs in your terminal. If it stopped, start it again with bunx @doguyilmaz/tapster setup." }, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (res.status === 401) {
    token = null;
    store.set(null);
    onSignedOut();
  }
  if (!res.ok || data === null) throw new ApiError(data?.error ?? { reason: `tapster setup answered ${res.status}`, fix: "Reload the page and try again." }, res.status);
  return data;
}

export const get = <T>(path: string) => send<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {});
