import type { Problem } from "../contract";

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly status: number) {
    super(problem.reason);
  }
}

const KEY = "tapster.session";

// The token lives in this origin's storage, which no other port or site can read. The service keeps it in localStorage
// so the page stays signed in across tabs and restarts. One tapster setup keeps it in sessionStorage so it ends with the tab.
const stores = (): Storage[] => {
  try {
    return [localStorage, sessionStorage];
  } catch {
    return [];
  }
};

const saved = () => {
  for (const s of stores()) {
    try {
      const v = s.getItem(KEY);
      if (v) return v;
    } catch {
      continue;
    }
  }
  return null;
};

function keep(value: string | null, service = false): void {
  for (const s of stores()) {
    try {
      if (value !== null && (s === localStorage) === service) s.setItem(KEY, value);
      else s.removeItem(KEY);
    } catch {
      continue;
    }
  }
}

let token = saved();
let onSignedOut: () => void = () => {};

export const whenSignedOut = (f: () => void) => {
  onSignedOut = f;
};

export async function claim(code: string): Promise<void> {
  const res = await fetch("/api/claim", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await res.json().catch(() => ({}))) as { token?: string; service?: boolean; error?: Problem };
  if (!res.ok || !body.token) throw new ApiError(body.error ?? { reason: "the link did not work", fix: "Run tapster setup in a terminal for a fresh link." }, res.status);
  token = body.token;
  keep(token, body.service === true);
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
    res = await fetch(path, { method, credentials: "omit", headers, body: payload });
  } catch {
    throw new ApiError({ reason: "tapster setup is not answering", fix: "Check that tapster setup still runs. If it stopped, run tapster setup in a terminal again." }, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (res.status === 401) {
    token = null;
    keep(null);
    onSignedOut();
  }
  if (!res.ok || data === null) throw new ApiError(data?.error ?? { reason: `tapster setup answered ${res.status}`, fix: "Reload the page and try again." }, res.status);
  return data;
}

export const get = <T>(path: string) => send<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {});
