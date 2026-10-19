import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isMachO } from "./archive";
import { TapsterError } from "./errors";
import { type PlistValue, parsePlist } from "./plist";

export type CodeItem = { path: string; kind: "bundle" | "file"; bundleId: string | null };

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

type Dict = { [key: string]: PlistValue };
type Bundle = { dir: string; executable: string | null; info: Dict };

function asDict(v: PlistValue, where: string): Dict {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Buffer.isBuffer(v) || v instanceof Date) throw bad(`has an Info.plist that is not a dictionary: ${where}`);
  return v;
}

function readBundle(dir: string, framework: boolean): Bundle | null {
  const infoPath = framework ? join(dir, "Resources", "Info.plist") : join(dir, "Contents", "Info.plist");
  if (!isRealFile(infoPath)) return null;
  const info = asDict(parsePlist(readFileSync(infoPath)), infoPath);
  const exe = info.CFBundleExecutable;
  if (exe === undefined) return { dir, executable: null, info };
  if (typeof exe !== "string" || !NAME.test(exe) || exe === "." || exe === "..") throw bad(`names an executable tapster does not accept in ${infoPath}`);
  return { dir, executable: framework ? join(dir, exe) : join(dir, "Contents", "MacOS", exe), info };
}

export function findCode(appDir: string): CodeItem[] {
  const bundles: Bundle[] = [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.name === "embedded.provisionprofile") throw bad("holds a provisioning profile, which tapster does not sign with");
      if (entry.isDirectory()) {
        const versions = join(path, "Versions");
        if (entry.name.endsWith(".framework") && isRealDir(versions)) {
          for (const v of readdirSync(versions, { withFileTypes: true })) {
            const b = v.isDirectory() ? readBundle(join(versions, v.name), true) : null;
            if (b) bundles.push(b);
          }
        } else {
          const b = readBundle(path, entry.name.endsWith(".framework"));
          if (b) bundles.push(b);
        }
        walk(path);
      } else if (entry.isFile() && isMachO(head(path))) {
        files.push(path);
      }
    }
  };
  const main = readBundle(appDir, false);
  if (!main?.executable) throw bad("has no CFBundleExecutable in Contents/Info.plist");
  walk(appDir);
  const executables = new Set<string>();
  for (const b of [main, ...bundles]) {
    if (!b.executable) continue;
    if (!isRealFile(b.executable)) throw bad(`is missing ${relative(appDir, b.executable)}`);
    if (!isMachO(head(b.executable))) throw bad(`has a main executable that is not Mach-O: ${relative(appDir, b.executable)}`);
    executables.add(b.executable);
  }
  for (const b of bundles) {
    if ("SUFeedURL" in b.info || "SUPublicEDKey" in b.info) throw bad(`has a nested bundle with its own Sparkle feed or key: ${relative(appDir, b.dir)}`);
  }
  const rel = (p: string) => relative(appDir, p).split(sep).join("/") || ".";
  const idOf = (b: Bundle) => (typeof b.info.CFBundleIdentifier === "string" ? b.info.CFBundleIdentifier : null);
  const items: CodeItem[] = [
    ...bundles.filter((b) => b.executable).map((b) => ({ path: rel(b.dir), kind: "bundle" as const, bundleId: idOf(b) })),
    ...files.filter((f) => !executables.has(f)).map((f) => ({ path: rel(f), kind: "file" as const, bundleId: null })),
  ];
  const depth = (p: string) => (p === "." ? 0 : p.split("/").length);
  items.sort((a, b) => depth(b.path) - depth(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [...items, { path: ".", kind: "bundle", bundleId: idOf(main) }];
}
