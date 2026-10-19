import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { TarEntry } from "./archive";
import { type AppPackage, type PackageConfig, isApp, versionOf } from "./config";
import { TapsterError } from "./errors";
import { bundleIdAllowed } from "./identity";
import { type PlistValue, parsePlist } from "./plist";
import { run } from "./run";

export type AppFacts = { version: string; build: string; minimumSystemVersion: string; macos: string; publicKey: string | null };

const MACOS: Record<string, string> = {
  "10.13": "high_sierra",
  "10.14": "mojave",
  "10.15": "catalina",
  "11": "big_sur",
  "12": "monterey",
  "13": "ventura",
  "14": "sonoma",
  "15": "sequoia",
  "26": "tahoe",
};
const TWENTY_DAYS = 20 * 24 * 60 * 60;
const SPARKLE_FLOOR = [2, 9, 0];
const CHECKED = [
  "CFBundleIdentifier",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "LSMinimumSystemVersion",
  "SUFeedURL",
  "SUPublicEDKey",
  "SURequireSignedFeed",
  "SUVerifyUpdateBeforeExtraction",
  "SUSignedFeedFailureExpirationInterval",
  "SUPublicDSAKey",
  "SUPublicDSAKeyFile",
  "NSUpdateSecurityPolicy",
];
const FORBIDDEN = ["SUPublicDSAKey", "SUPublicDSAKeyFile", "NSUpdateSecurityPolicy"];

type Dict = { [key: string]: PlistValue };
const refuse = (what: string, fix = "Fix the app's Info.plist and release again.") => new TapsterError(what, fix);

function dict(path: string): Dict {
  const v = parsePlist(readFileSync(path));
  if (typeof v !== "object" || v === null || Array.isArray(v) || Buffer.isBuffer(v) || v instanceof Date) throw refuse(`${path} is not a dictionary`);
  return v;
}

export function checkArchiveRoot(entries: TarEntry[], pkg: AppPackage): void {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]!));
  if (tops.size !== 1 || !tops.has(pkg.app)) {
    throw refuse(`the app archive must hold exactly ${pkg.app} at its top, not ${[...tops].join(", ")}`, "Pack only the app: tar -czf <archive> <App>.app");
  }
}

type Kind = "dir" | "file" | "link";

function walk(dir: string, visit: (path: string, kind: Kind) => void): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    const kind: Kind = e.isSymbolicLink() ? "link" : e.isDirectory() ? "dir" : "file";
    visit(path, kind);
    if (kind === "dir") walk(path, visit);
  }
}

function mentionsChecked(bytes: Buffer): string | undefined {
  const text = Buffer.from(bytes.filter((b) => b !== 0)).toString("latin1");
  if (/\\[Uu][0-9A-Fa-f]|\\[0-7]/.test(text)) return "an escaped key";
  return CHECKED.find((k) => text.includes(k));
}

function versionAtLeast(v: string, floor: number[]): boolean {
  const parts = v.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < floor.length; i++) {
    const p = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (p !== floor[i]) return p > floor[i]!;
  }
  return true;
}

function readsSame(theirs: string | null, ours: PlistValue | undefined): boolean {
  if (ours === undefined || theirs === null) return ours === undefined && theirs === null;
  if (typeof ours === "number") return theirs.trim() !== "" && Number(theirs) === ours;
  if (typeof ours === "boolean" || typeof ours === "string") return theirs === String(ours);
  return false;
}

export async function appFacts(
  appDir: string,
  pkg: AppPackage,
  all: PackageConfig[],
  tag: string,
  plutil: (key: string) => Promise<string | null | undefined>,
): Promise<AppFacts> {
  const infoPath = join(appDir, "Contents", "Info.plist");
  const info = dict(infoPath);
  const version = versionOf(tag);
  const str = (k: string) => (typeof info[k] === "string" ? (info[k] as string) : null);
  if (str("CFBundleIdentifier") !== pkg.bundle_id) throw refuse(`the app's bundle id is ${str("CFBundleIdentifier") ?? "missing"}, not ${pkg.bundle_id}`);
  if (str("CFBundleShortVersionString") !== version) throw refuse(`the app's version is ${str("CFBundleShortVersionString") ?? "missing"}, but the tag says ${version}`);
  if (str("CFBundleVersion") !== version) throw refuse(`the app's CFBundleVersion is ${str("CFBundleVersion") ?? "missing"}, but the tag says ${version}`, "Stamp CFBundleVersion with the tag version, as today.");
  const minimum = str("LSMinimumSystemVersion") ?? "";
  const parts = minimum.split(".");
  const macos = MACOS[parts[0] === "10" ? parts.slice(0, 2).join(".") : (parts[0] ?? "")];
  if (!/^\d+(\.\d+){0,2}$/.test(minimum) || !macos) throw refuse(`LSMinimumSystemVersion ${minimum || "is missing"} is not a macOS version tapster knows`);
  for (const k of FORBIDDEN) if (k in info) throw refuse(`the app sets ${k}, which would bypass the hub's update signature`);
  let publicKey: string | null = null;
  if (!pkg.sparkle && ("SUFeedURL" in info || "SUPublicEDKey" in info)) {
    throw refuse("the app has its own Sparkle feed or key, but tapster.yml has no sparkle section for it", "Add a sparkle section to the package so the hub signs its updates.");
  }
  if (pkg.sparkle) {
    const feed = `https://github.com/${pkg.repo}/releases/latest/download/${pkg.sparkle.feed}`;
    if (str("SUFeedURL") !== feed) throw refuse(`SUFeedURL is ${str("SUFeedURL") ?? "missing"}, not ${feed}`);
    publicKey = str("SUPublicEDKey");
    if (publicKey !== pkg.sparkle.public_key && (publicKey === null || publicKey !== pkg.sparkle.next_public_key)) {
      throw refuse(`SUPublicEDKey ${publicKey ?? "is missing"} is not the key pinned in tapster.yml`, "Installed copies would reject the update; check sparkle.public_key.");
    }
    if (info.SURequireSignedFeed !== true) throw refuse("SURequireSignedFeed must be true so installed copies accept only the hub's feed");
    if (info.SUVerifyUpdateBeforeExtraction !== true) throw refuse("SUVerifyUpdateBeforeExtraction must be true; Sparkle refuses to start with SURequireSignedFeed alone");
    const interval = info.SUSignedFeedFailureExpirationInterval;
    if (interval !== undefined && (typeof interval !== "number" || interval < TWENTY_DAYS)) {
      throw refuse("SUSignedFeedFailureExpirationInterval is shorter than 20 days, which lets an unsigned feed in early");
    }
    const sparkleVersions = join(appDir, "Contents/Frameworks/Sparkle.framework/Versions");
    const versions = existsSync(sparkleVersions) ? readdirSync(sparkleVersions, { withFileTypes: true }).filter((v) => v.isDirectory()).map((v) => v.name) : [];
    if (versions.length === 0) throw refuse("the app has no Sparkle.framework in Contents/Frameworks");
    for (const v of versions) {
      const sv = dict(join(sparkleVersions, v, "Resources", "Info.plist")).CFBundleShortVersionString;
      if (typeof sv !== "string" || !versionAtLeast(sv, SPARKLE_FLOOR)) throw refuse(`the embedded Sparkle is ${String(sv)}, older than 2.9.0, which ignores SURequireSignedFeed`, "Update Sparkle in the project.");
    }
  }
  for (const k of CHECKED) {
    const theirs = await plutil(k);
    if (theirs === undefined) continue;
    if (!readsSame(theirs, info[k])) throw refuse(`plutil and tapster read ${k} differently`, "Rebuild the app with a plain Info.plist.");
  }
  const resources = join(appDir, "Contents", "Resources");
  const localized = (p: string) => {
    const rel = relative(resources, dirname(p));
    return rel === "" || (!rel.includes(sep) && rel.toLowerCase().endsWith(".lproj"));
  };
  const appNames = new Set(all.filter(isApp).map((p) => p.app.replace(/\.app$/i, "").toLowerCase()));
  const lower = (p: string) => basename(p).toLowerCase();
  walk(appDir, (path, kind) => {
    const rel = relative(appDir, path).split(sep).join("/");
    const name = lower(path);
    if (kind !== "file" && name.endsWith(".app") && appNames.has(name.slice(0, -4))) throw refuse(`the app contains ${rel}, named like an app the hub publishes`);
    if (kind === "dir") return;
    if (kind === "link") {
      if (name === "info.plist" || name.startsWith("infoplist.")) throw refuse(`${rel} is a symlink, which hides the Info.plist tapster checks`);
      return;
    }
    if (name.startsWith("infoplist.") && localized(path)) {
      const hit = mentionsChecked(readFileSync(path));
      if (hit) throw refuse(`${rel} localizes ${hit}, which tapster checks`, "Remove that key from the localized Info.plist.");
    }
    if (name !== "info.plist" || rel.toLowerCase() === "contents/info.plist") return;
    const parent = dirname(path);
    const owner = lower(parent) === "contents" ? dirname(parent) : lower(parent) === "resources" && lower(dirname(dirname(parent))) === "versions" ? dirname(parent) : parent;
    const ownerRel = relative(appDir, owner).split(sep).join("/");
    const nested = dict(path);
    const id = nested.CFBundleIdentifier;
    if (id !== undefined && (typeof id !== "string" || !bundleIdAllowed(ownerRel, id, pkg))) throw refuse(`${ownerRel} claims the identifier ${String(id)}, outside ${pkg.bundle_id}`);
    for (const k of ["SUFeedURL", "SUPublicEDKey", ...FORBIDDEN]) if (k in nested) throw refuse(`${ownerRel} carries its own ${k}`);
    const bundleName = nested.CFBundleName;
    if (typeof bundleName === "string" && appNames.has(bundleName.toLowerCase())) throw refuse(`${ownerRel} is named ${bundleName}, like an app the hub publishes`);
  });
  return { version, build: version, minimumSystemVersion: minimum, macos, publicKey };
}

export function plutilReader(infoPath: string): (key: string) => Promise<string | null> {
  return async (key) => {
    const r = await run("plutil", ["-extract", key, "raw", "-o", "-", infoPath], { allowFail: true });
    if (r.code !== 0) return null;
    return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
  };
}
