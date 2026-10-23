import type { Problem } from "../contract";

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly status: number) {
    super(problem.reason);
  }
}

let onSignedOut: () => void = () => {};

export const whenSignedOut = (f: () => void) => {
  onSignedOut = f;
};

// The session lives in an HttpOnly cookie that this script never sees. The header marks a request as the page's own.
const HEADERS = { "x-tapster": "1" };

export async function claim(code: string): Promise<void> {
  const res = await fetch("/api/claim", { method: "POST", credentials: "same-origin", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await res.json().catch(() => ({}))) as { paired?: boolean; error?: Problem };
  if (!res.ok || !body.paired) throw new ApiError(body.error ?? { reason: "the link did not work", fix: "Run tapster setup in a terminal for a fresh link." }, res.status);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...HEADERS };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers, body: payload });
  } catch {
    throw new ApiError({ reason: "tapster setup is not answering", fix: "Check that tapster setup still runs. If it stopped, run tapster setup in a terminal again." }, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (res.status === 401) onSignedOut();
  if (!res.ok || data === null) throw new ApiError(data?.error ?? { reason: `tapster setup answered ${res.status}`, fix: "Reload the page and try again." }, res.status);
  return data;
}

export const get = <T>(path: string) => send<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {});
