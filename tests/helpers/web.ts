import { join } from "node:path";
import { GitHub } from "../../src/github";
import { appCallback } from "../../src/web/api/hub";
import { type Deps, type Mode, handler, newSession } from "../../src/web/server";
import { routes } from "../../src/web/start";
import type { FakeHub } from "./fakehub";

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;

export function webApp(fake: FakeHub, home: string, o: Partial<Deps> = {}, mode: Mode = "once") {
  const deps: Deps = {
    github: async () => new GitHub("t", fake.fetch, async () => {}, "user"),
    fetch: fake.fetch as typeof fetch,
    home,
    cwd: join(home, "Developer", "ebb"),
    pin: "0123456789abcdef0123456789abcdef01234567",
    log: () => {},
    open: () => {},
    notary: async () => false,
    keychain: async () => null,
    gpg: async () => null,
    store: () => null,
    platform: "darwin",
    where: { exec: "/opt/homebrew/Caskroom/tapster/1.0.0/tapster", script: "", sha: "a" },
    run: async (argv) => {
      throw new Error(`no command may run in this test: ${argv[0]}`);
    },
    exit: () => {},
    ...o,
  };
  const s = newSession(deps, 8277, mode);
  const handle = handler(s, routes(s, () => {}), (c) => appCallback(c));
  let token: Promise<string> | null = null;
  const pair = async () => {
    const code = s.link().split("#c=")[1]!;
    const res = await handle(new Request("http://127.0.0.1:8277/api/claim", { method: "POST", headers: { host: "127.0.0.1:8277" }, body: JSON.stringify({ code }) }));
    return ((await res.json()) as { token: string }).token;
  };
  const call: Call = async (method, path, body) => {
    token ??= pair();
    const headers: Record<string, string> = { host: "127.0.0.1:8277", authorization: `Bearer ${await token}` };
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await handle(new Request(`http://127.0.0.1:8277${path}`, { method, headers, body: payload }));
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { s, handle, call };
}
