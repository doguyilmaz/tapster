import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TapsterError } from "../errors";
import { TAPSTER } from "../version";
import type { Session } from "./server";

export const PORT = 8277;
export const LABEL = "com.doguyilmaz.tapster";
export const LAST_PORT = 8299;

export const serviceFiles = (home: string) => {
  const dir = join(home, ".config", "tapster");
  return { dir, json: join(dir, "service.json"), sock: join(dir, "service.sock"), session: join(dir, "session.json") };
};

export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new TapsterError(`${dir} is not a folder you own`, "Remove it, then try again.");
  chmodSync(dir, 0o700);
}

export function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const portSchema = z.object({ port: z.number().int().min(1024).max(65535) });

export function readPort(home: string): number {
  const path = serviceFiles(home).json;
  if (!existsSync(path)) return PORT;
  const parsed = portSchema.safeParse(readJson(path));
  if (!parsed.success) throw new TapsterError(`${path} does not name a port`, "Run tapster service install again; it writes the file anew.");
  return parsed.data.port;
}

const handoffSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), proof: z.string().regex(/^[0-9a-f]{64}$/), at: z.number(), touched: z.number(), until: z.number() });
const HANDOFF = 10 * 60_000;

// An update hands the pairing to the next process: a hash of the token and the proof key, in a private file that works
// once and for ten minutes. Any other restart needs a new pairing.
export function handOff(s: Session): void {
  if (!s.pairing) return;
  const f = serviceFiles(s.deps.home);
  privateDir(f.dir);
  writePrivate(f.session, JSON.stringify({ ...s.pairing, touched: s.touched, until: Date.now() + HANDOFF }));
}

export function takeHandoff(s: Session): void {
  const f = serviceFiles(s.deps.home);
  if (!existsSync(f.session)) return;
  const saved = handoffSchema.safeParse(readJson(f.session));
  unlinkSync(f.session);
  if (!saved.success || saved.data.until < Date.now()) return;
  s.pairing = { hash: saved.data.hash, proof: saved.data.proof, at: saved.data.at };
  s.touched = saved.data.touched;
}

export type Ask = "pair" | "status" | "stop";

export async function askService(sock: string, what: Ask): Promise<unknown | null> {
  if (!existsSync(sock)) return null;
  try {
    const res = await fetch(`http://tapster/${what}`, { method: what === "stop" ? "POST" : "GET", unix: sock, signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function serveSocket(sock: string, s: Session, stop: () => void): Promise<{ stop(): void }> {
  if (existsSync(sock)) {
    if (!lstatSync(sock).isSocket()) throw new TapsterError(`${sock} is not tapster's socket`, "Remove it, then start the service again.");
    if ((await askService(sock, "status")) !== null) throw new TapsterError("another tapster service already runs", "Open it with tapster setup. To remove it, run tapster service uninstall.");
    unlinkSync(sock);
  }
  const server = Bun.serve({
    unix: sock,
    fetch: (req) => {
      const what = `${req.method} ${new URL(req.url).pathname}`;
      if (what === "GET /pair") return Response.json({ link: s.link() });
      if (what === "GET /status") return Response.json({ version: TAPSTER.version, port: s.port, pid: process.pid });
      if (what === "POST /stop") {
        setTimeout(stop, 50);
        return Response.json({ stopping: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  chmodSync(sock, 0o600);
  return {
    stop: () => {
      server.stop(true);
      if (existsSync(sock)) unlinkSync(sock);
    },
  };
}
