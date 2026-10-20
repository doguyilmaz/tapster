import { homedir } from "node:os";
import { TapsterError } from "../errors";
import type { GitHub } from "../github";
import { runPath } from "../run";
import { TAPSTER } from "../version";
import { verifyNotary } from "../cli/apple";
import { currentRepo, userGitHub } from "../cli/gh";
import { hubRoutes, appCallback } from "./api/hub";
import { projectRoutes } from "./api/projects";
import type { SessionView } from "./contract";
import { respond } from "./http";
import { type Deps, type Routes, type Session, handler, newSession } from "./server";

export const PORT = 8277;
const IDLE = 2 * 3_600_000;

export type SetupOptions = { open: boolean; port: number | null; pin: string | null };

export function setupOptions(args: string[]): SetupOptions {
  const o: SetupOptions = { open: true, port: null, pin: null };
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
    ...projectRoutes,
    "GET /api/session": async (): Promise<SessionView> => {
      const repo = await currentRepo(s.deps.cwd).catch(() => null);
      const tap = repo !== null && /\/homebrew-/.test(repo);
      return { version: TAPSTER.version, dev: TAPSTER.sha === null && s.deps.pin === null, platform: process.platform, home: s.deps.home, here: { hub: tap ? repo : null, repo: tap ? null : repo, path: s.deps.cwd } };
    },
    "POST /api/quit": async () => {
      setTimeout(quit, 200);
      return { stopping: true };
    },
  };
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  void runPath(opener, "open", [url], { allowFail: true }).catch(() => undefined);
}

export function realDeps(pin: string | null): Deps {
  let cached: { gh: GitHub; at: number } | null = null;
  return {
    async github() {
      if (cached && Date.now() - cached.at < 60_000) return cached.gh;
      const gh = await userGitHub();
      cached = { gh, at: Date.now() };
      return gh;
    },
    fetch,
    home: homedir(),
    cwd: process.cwd(),
    pin,
    log: (line) => console.log(line),
    open: openBrowser,
    notary: verifyNotary,
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

export async function setup(args: string[], deps?: Deps): Promise<void> {
  const o = setupOptions(args);
  if (process.platform === "win32") throw new TapsterError("tapster setup runs on macOS and Linux", "Run it on a Mac or a Linux computer; the hub itself serves Windows users through Scoop.");
  const d = deps ?? realDeps(o.pin);
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
