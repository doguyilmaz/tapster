import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapsterError } from "../src/errors";
import { type Deps, handler, newSession } from "../src/web/server";
import { askService, keepPairing, privateDir, readPort, serveSocket, serviceFiles } from "../src/web/service";
import { routes, setup, setupOptions } from "../src/web/start";
import { appCallback } from "../src/web/api/hub";

const homes: string[] = [];
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), "svc-"));
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const logs: string[] = [];
const opened: string[] = [];
const deps = (home: string): Deps => ({
  github: async () => {
    throw new TapsterError("gh is not signed in", "Run gh auth login.");
  },
  fetch,
  home,
  cwd: home,
  pin: null,
  log: (l) => logs.push(l),
  open: (u) => opened.push(u),
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
});

const mode = (p: string) => statSync(p).mode & 0o777;

test("the state folder is private to its owner, also when it existed before", () => {
  const home = newHome();
  const { dir } = serviceFiles(home);
  privateDir(dir);
  expect(mode(dir)).toBe(0o700);
  chmodSync(dir, 0o755);
  privateDir(dir);
  expect(mode(dir)).toBe(0o700);
});

test("the service's port comes from service.json, 8277 without it", () => {
  const home = newHome();
  expect(readPort(home)).toBe(8277);
  const f = serviceFiles(home);
  privateDir(f.dir);
  writeFileSync(f.json, JSON.stringify({ port: 8281 }));
  expect(readPort(home)).toBe(8281);
  writeFileSync(f.json, JSON.stringify({ port: 80 }));
  expect(() => readPort(home)).toThrow(TapsterError);
});

test("the socket answers pair, status and stop, only to its owner", async () => {
  const home = newHome();
  const f = serviceFiles(home);
  privateDir(f.dir);
  const s = newSession(deps(home), 8290, "service");
  let stopped = 0;
  const sock = await serveSocket(f.sock, s, () => stopped++);
  try {
    expect(mode(f.sock)).toBe(0o600);
    const pair = (await askService(f.sock, "pair")) as { link: string };
    const code = /^http:\/\/127\.0\.0\.1:8290\/#c=([0-9a-f]{32})$/.exec(pair.link)![1]!;
    expect(s.codes.has(code)).toBe(true);
    expect(await askService(f.sock, "status")).toEqual({ version: expect.any(String), port: 8290, pid: process.pid });
    expect(await askService(f.sock, "stop")).toEqual({ stopping: true });
    await Bun.sleep(100);
    expect(stopped).toBe(1);
  } finally {
    sock.stop();
  }
  expect(await askService(f.sock, "status")).toBeNull();
});

test("a socket left behind is replaced; a live one refuses a second service", async () => {
  const home = newHome();
  const f = serviceFiles(home);
  privateDir(f.dir);
  const s = newSession(deps(home), 8291, "service");
  const first = await serveSocket(f.sock, s, () => {});
  await expect(serveSocket(f.sock, s, () => {})).rejects.toThrow(TapsterError);
  first.stop();
  writeFileSync(f.sock, "");
  await expect(serveSocket(f.sock, s, () => {})).rejects.toThrow(TapsterError);
  rmSync(f.sock);
  const again = await serveSocket(f.sock, s, () => {});
  expect((await askService(f.sock, "status")) as unknown).toMatchObject({ port: 8291 });
  again.stop();
});

test("no service answers when the socket is missing", async () => {
  expect(await askService(join(newHome(), "nothing.sock"), "pair")).toBeNull();
});

test("a pairing survives a restart as a hash in a private file, never the cookie", async () => {
  const home = newHome();
  const first = newSession(deps(home), 8292, "service");
  keepPairing(first);
  const handle = handler(first, routes(first, () => {}), (c) => appCallback(c));
  const code = first.link().split("#c=")[1]!;
  const claimed = await handle(new Request("http://127.0.0.1:8292/api/claim", { method: "POST", headers: { host: "127.0.0.1:8292", "x-tapster": "1" }, body: JSON.stringify({ code }) }));
  const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
  const file = serviceFiles(home).session;
  expect(mode(file)).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain(cookie.split("=")[1]!);
  const second = newSession(deps(home), 8292, "service");
  keepPairing(second);
  const again = handler(second, routes(second, () => {}), (c) => appCallback(c));
  const res = await again(new Request("http://127.0.0.1:8292/api/session", { headers: { host: "127.0.0.1:8292", "x-tapster": "1", cookie } }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { service: boolean }).service).toBe(true);
});

test("setup --service opens no browser, prints no link, pairs over the socket and stops when asked", async () => {
  const home = newHome();
  const f = serviceFiles(home);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(f.json, JSON.stringify({ port: 18377 }));
  logs.length = 0;
  opened.length = 0;
  const done = setup(["--service"], deps(home));
  let pair: { link: string } | null = null;
  for (let i = 0; i < 50 && !pair; i++) {
    pair = (await askService(f.sock, "pair")) as { link: string } | null;
    if (!pair) await Bun.sleep(50);
  }
  expect(pair!.link).toStartWith("http://127.0.0.1:18377/#c=");
  const code = pair!.link.split("#c=")[1]!;
  const claimed = await fetch("http://127.0.0.1:18377/api/claim", { method: "POST", headers: { "x-tapster": "1", "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
  const view = (await (await fetch("http://127.0.0.1:18377/api/session", { headers: { "x-tapster": "1", cookie } })).json()) as { service: boolean };
  expect(view.service).toBe(true);
  expect(mode(f.dir)).toBe(0o700);
  await askService(f.sock, "stop");
  await done;
  expect(opened).toEqual([]);
  expect(logs.join("\n")).not.toContain("#c=");
  expect(existsSync(f.sock)).toBe(false);
});

test("tapster setup opens the running service's page instead of starting its own", async () => {
  const home = newHome();
  const f = serviceFiles(home);
  privateDir(f.dir);
  const s = newSession(deps(home), 8294, "service");
  const sock = await serveSocket(f.sock, s, () => {});
  opened.length = 0;
  logs.length = 0;
  try {
    await setup([], deps(home));
  } finally {
    sock.stop();
  }
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:8294\/#c=[0-9a-f]{32}$/);
  expect(s.codes.size).toBe(1);
  expect(logs.join("\n")).toContain("runs as a service");
});

async function oneShot(where: Deps["where"]): Promise<string> {
  const home = newHome();
  logs.length = 0;
  const done = setup(["--no-open", "--port", "18378"], { ...deps(home), where });
  while (!logs.some((l) => l.includes("#c="))) await Bun.sleep(20);
  const code = /#c=([0-9a-f]{32})/.exec(logs.join("\n"))![1]!;
  const claimed = await fetch("http://127.0.0.1:18378/api/claim", { method: "POST", headers: { "x-tapster": "1" }, body: JSON.stringify({ code }) });
  const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
  await fetch("http://127.0.0.1:18378/api/quit", { method: "POST", headers: { "x-tapster": "1", cookie } });
  await done;
  return logs.join("\n");
}

test("the one-shot setup suggests the service once, only to a stable install", async () => {
  const brew = await oneShot({ exec: "/opt/homebrew/Caskroom/tapster/1.0.0/tapster", script: "", sha: "a" });
  expect(brew.split("tapster service install").length).toBe(2);
  const bunx = await oneShot({ exec: "/b/bun", script: "/T/bunx-501-@doguyilmaz/tapster@latest/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" });
  expect(bunx).not.toContain("tapster service install");
});

test("setup options: --service stands alone", () => {
  expect(setupOptions(["--service"])).toEqual({ open: false, port: null, pin: null, service: true });
  expect(() => setupOptions(["--service", "--port", "9000"])).toThrow(TapsterError);
});
