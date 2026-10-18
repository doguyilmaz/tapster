import { existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isMachO } from "./archive";
import { TapsterError } from "./errors";
import { parsePlist } from "./plist";

export type CodeItem = { path: string; kind: "bundle" | "file" };

const BUNDLE = /\.(app|xpc|appex|bundle|plugin|framework)$/;
const NAME = /^[A-Za-z0-9 ._+-]+$/;

const bad = (what: string) => new TapsterError(`the app ${what}`, "Rebuild the app; tapster signs regular bundles and Mach-O files.");

function head(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(8);
    const n = readSync(fd, b, 0, 8, 0);
    return b.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const isRealDir = (p: string) => existsSync(p) && lstatSync(p).isDirectory();
const isRealFile = (p: string) => existsSync(p) && lstatSync(p).isFile();

type Bundle = { dir: string; executable: string | null };

function readBundle(dir: string, framework: boolean): Bundle {
  const info = framework ? join(dir, "Resources", "Info.plist") : join(dir, "Contents", "Info.plist");
  if (!isRealFile(info)) return { dir, executable: null };
  const plist = parsePlist(readFileSync(info));
  const exe = typeof plist === "object" && !Array.isArray(plist) && !Buffer.isBuffer(plist) && !(plist instanceof Date) ? plist.CFBundleExecutable : undefined;
  if (exe === undefined) return { dir, executable: null };
  if (typeof exe !== "string" || !NAME.test(exe) || exe === "." || exe === "..") throw bad(`names an executable tapster does not accept in ${info}`);
  return { dir, executable: framework ? join(dir, exe) : join(dir, "Contents", "MacOS", exe) };
}

export function findCode(appDir: string): CodeItem[] {
  const bundles: Bundle[] = [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) {
          const versions = join(path, "Versions");
          if (isRealDir(versions)) {
            for (const v of readdirSync(versions, { withFileTypes: true })) {
              if (v.isDirectory()) bundles.push(readBundle(join(versions, v.name), true));
            }
          } else {
            bundles.push(readBundle(path, true));
          }
        } else if (BUNDLE.test(entry.name)) {
          bundles.push(readBundle(path, false));
        }
        walk(path);
      } else if (entry.isFile() && isMachO(head(path))) {
        files.push(path);
      }
    }
  };
  const main = readBundle(appDir, false);
  if (!main.executable) throw bad("has no CFBundleExecutable in Contents/Info.plist");
  walk(appDir);
  const executables = new Set<string>();
  for (const b of [main, ...bundles]) {
    if (!b.executable) continue;
    if (!isRealFile(b.executable)) throw bad(`is missing ${relative(appDir, b.executable)}`);
    if (!isMachO(head(b.executable))) throw bad(`has a main executable that is not Mach-O: ${relative(appDir, b.executable)}`);
    executables.add(b.executable);
  }
  const rel = (p: string) => relative(appDir, p).split(sep).join("/") || ".";
  const items: CodeItem[] = [
    ...bundles.filter((b) => b.executable).map((b) => ({ path: rel(b.dir), kind: "bundle" as const })),
    ...files.filter((f) => !executables.has(f)).map((f) => ({ path: rel(f), kind: "file" as const })),
  ];
  const depth = (p: string) => (p === "." ? 0 : p.split("/").length);
  items.sort((a, b) => depth(b.path) - depth(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [...items, { path: ".", kind: "bundle" }];
}
