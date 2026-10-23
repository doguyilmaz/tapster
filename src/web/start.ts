import { homedir } from "node:os";
import { TapsterError } from "../errors";
import type { GitHub } from "../github";
import { runPath } from "../run";
import { TAPSTER } from "../version";
import { verifyNotary } from "../cli/apple";
import { localStore, requireStore } from "../cli/keystore";
import { findGpg } from "../cli/linuxkey";
import { currentRepo, userGitHub } from "../cli/gh";
import { readGit } from "../clone";
import { realRunner } from "../cli/runner";
import { here, installKind } from "../cli/upgrade";
import { HUB } from "./api/access";
import { hubRoutes, appCallback, warmStart } from "./api/hub";
import { doorbellRoutes } from "./api/doorbell";
import { linuxRoutes } from "./api/linux";
import { entryRoutes } from "./api/entry";
import { projectRoutes } from "./api/projects";
import { statusRoutes } from "./api/status";
import { updateRoutes } from "./api/update";
import type { SessionView } from "./contract";
import { respond } from "./http";
import { type Deps, type Routes, type Session, handler, newSession } from "./server";
import { PORT, askService, privateDir, readPort, serveSocket, serviceFiles, takeHandoff } from "./service";
import { rememberTeam } from "./api/update";

export { PORT };
const IDLE = 2 * 3_600_000;

export type SetupOptions = { open: boolean; port: number | null; pin: string | null; service: boolean };

export function setupOptions(args: string[]): SetupOptions {
  if (args.includes("--service")) {
    if (args.length > 1) throw new TapsterError("--service takes no other options", "The service reads its port from ~/.config/tapster/service.json.");
    return { open: false, port: null, pin: null, service: true };
  }
  const o: SetupOptions = { open: true, port: null, pin: null, service: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === "--no-open") o.open = false;
    else if (a === "--port" && next && /^\d{2,5}$/.test(next) && Number(next) >= 1024 && Number(next) <= 65535) o.port = Number(args[++i]);
    else if (a === "--tapster" && next && /^[0-9a-f]{40}$/.test(next)) o.pin = args[++i]!;
    else throw new TapsterError(`unknown option ${a}`, "Run tapster setup --help for the options.");
  }
  return o;
}

export function routes(s: Session, quit: () => void): Routes {
  return {
    ...hubRoutes,
    ...doorbellRoutes,
    ...linuxRoutes,
    ...projectRoutes,
    ...statusRoutes,
    ...entryRoutes,
    ...updateRoutes,
    "GET /api/session": async (): Promise<SessionView> => {
      const repo = await currentRepo(s.deps.cwd).catch(() => null);
      const tap = repo !== null && /\/homebrew-/.test(repo);
      return { version: TAPSTER.version, dev: TAPSTER.sha === null && s.deps.pin === null, service: s.mode === "service", platform: s.deps.platform, home: s.deps.home, here: { hub: tap ? repo : null, repo: tap ? null : repo, path: s.deps.cwd } };
    },
    "POST /api/quit": async () => {
      if (s.mode === "service") throw new TapsterError("the tapster service keeps running", "Stop it with tapster service uninstall.");
      setTimeout(quit, 200);
      return { stopping: true };
    },
  };
}

export async function knownHub(cwd: string): Promise<string | null> {
  const [saved, here] = await Promise.all([readGit(cwd, ["config", "--get", "tapster.hub"]).then((r) => r.stdout.trim(), () => ""), currentRepo(cwd).catch(() => "")]);
  return [saved, here].find((x) => HUB.test(x)) ?? null;
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  void runPath(opener, "open", [url], { allowFail: true }).catch(() => undefined);
}

export function realDeps(pin: string | null): Deps {
  let cached: { gh: Promise<GitHub>; at: number } | null = null;
  return {
    github() {
      if (cached && Date.now() - cached.at < 60_000) return cached.gh;
      const gh = userGitHub();
      const mine = { gh, at: Date.now() };
      cached = mine;
      gh.catch(() => {
        if (cached === mine) cached = null;
      });
      return gh;
    },
    fetch,
    home: homedir(),
    cwd: process.cwd(),
    pin,
    log: (line) => console.log(line),
    open: openBrowser,
    notary: verifyNotary,
    keychain: (account) => requireStore("the Sparkle key").read({ service: "https://sparkle-project.org", account, label: "Private key for signing Sparkle updates" }),
    gpg: () => findGpg(),
    store: () => localStore(),
    platform: process.platform,
    where: here(),
    run: realRunner,
    exit: (code) => process.exit(code),
  };
}

function listen(port: number, fetchHandler: (req: Request) => Promise<Response>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: fetchHandler,
    development: false,
    error: () => respond("tapster setup hit an unexpected error. The terminal that runs it may say more.", 500, "text/plain; charset=utf-8"),
    maxRequestBodySize: 1 << 20,
    idleTimeout: 120,
  });
}

const STABLE = new Set(["brew", "bun", "npm"]);

async function openService(d: Deps, open: boolean): Promise<boolean> {
  const answer = (await askService(serviceFiles(d.home).sock, "pair")) as { link?: unknown } | null;
  const link = typeof answer?.link === "string" && /^http:\/\/127\.0\.0\.1:\d{4,5}\/#c=[0-9a-f]{32}$/.test(answer.link) ? answer.link : null;
  if (!link) return false;
  d.log(`tapster setup runs as a service on this computer at ${new URL(link).origin}.`);
  d.log(open ? "It opens in your browser now. If it does not, open this link (it works once):" : "Open this link in your browser (it works once):");
  d.log(`\n  ${link}\n`);
  if (open) d.open(link);
  return true;
}

// The service prints no link and opens no browser: tapster setup asks it for a link over the socket that only this user can reach.
async function service(d: Deps): Promise<void> {
  const files = serviceFiles(d.home);
  privateDir(files.dir);
  const port = readPort(d.home);
  let handle: (req: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  let server: ReturnType<typeof listen>;
  try {
    server = listen(port, (req) => handle(req));
  } catch {
    throw new TapsterError(`port ${port} is held by another program`, "The service does not start and no page gets your session. Close that program. Or run tapster service install again to pick a free port.");
  }
  const s = newSession(d, port, "service");
  takeHandoff(s);
  void rememberTeam(s);
  warmStart(s, knownHub(d.cwd));
  let done: () => void = () => {};
  const closed = new Promise<void>((resolve) => (done = resolve));
  let sock: { stop(): void } | null = null;
  const leave = () => sock?.stop();
  const end = () => {
    leave();
    d.exit(0);
  };
  const stop = () => {
    process.off("exit", leave).off("SIGTERM", end).off("SIGINT", end);
    leave();
    server.stop();
    done();
  };
  handle = handler(s, routes(s, stop), (c) => appCallback(c));
  try {
    sock = await serveSocket(files.sock, s, stop);
  } catch (e) {
    server.stop();
    throw e;
  }
  process.once("exit", leave).once("SIGTERM", end).once("SIGINT", end);
  d.log(`tapster setup runs as a service on this computer at http://127.0.0.1:${port}. Run tapster setup to open it.`);
  await closed;
  d.log("tapster setup stopped.");
}

export async function setup(args: string[], deps?: Deps): Promise<void> {
  const o = setupOptions(args);
  if (process.platform === "win32") throw new TapsterError("tapster setup runs on macOS and Linux", "Run it on a Mac or a Linux computer; the hub itself serves Windows users through Scoop.");
  const d = deps ?? realDeps(o.pin);
  if (o.service) return service(d);
  if (o.port === null && o.pin === null && (await openService(d, o.open))) return;
  let handle: (req: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  let server: ReturnType<typeof listen>;
  try {
    server = listen(o.port ?? PORT, (req) => handle(req));
  } catch {
    if (o.port !== null) throw new TapsterError(`port ${o.port} is in use`, "Pick another one with --port or close the program that uses it.");
    server = listen(0, (req) => handle(req));
    d.log(`Port ${PORT} is in use (another tapster setup may be open), so this one uses ${server.port}. Password managers save entries per address, so they may not offer the ones saved on ${PORT}.`);
  }
  let done: () => void = () => {};
  const closed = new Promise<void>((resolve) => (done = resolve));
  const s = newSession(d, server.port!);
  warmStart(s, knownHub(d.cwd));
  const stop = () => {
    clearInterval(idle);
    process.stdin.pause();
    server.stop();
    done();
  };
  handle = handler(s, routes(s, stop), (c) => appCallback(c));
  const idle = setInterval(() => {
    if (Date.now() - s.touched > IDLE) {
      d.log("tapster setup stopped after two hours without use. Run it again to continue; everything you did is on GitHub.");
      stop();
    }
  }, 60_000);
  const show = () => {
    const link = s.link();
    d.log(`\n  ${link}\n`);
    if (o.open) d.open(link);
  };
  d.log(`tapster setup runs on this computer at http://127.0.0.1:${server.port}. Your keys go from here to your own GitHub account only.`);
  d.log(o.open ? "It opens in your browser now. If it does not, open this link (it works once):" : "Open this link in your browser (it works once):");
  show();
  d.log("Press Enter for a fresh link, for example after closing the tab. Ctrl+C stops tapster setup.");
  if (STABLE.has(installKind(d.where))) d.log("To keep tapster setup running on this computer, run tapster service install.");
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (chunk.includes("\n")) show();
    });
    process.stdin.resume();
  }
  await closed;
  d.log("tapster setup stopped.");
}
