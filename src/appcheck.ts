import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { TarEntry } from "./archive";
import type { ChecksumLine } from "./checksums";
import { type AppPackage, type PackageConfig, type Platform, assetName, isApp, versionOf } from "./config";
import { TapsterError } from "./errors";
import { bundleIdAllowed } from "./identity";
import { type PlistValue, parsePlist } from "./plist";
import { run } from "./run";

export type AppFacts = { version: string; build: string; minimumSystemVersion: string; macos: string; publicKey: string | null };

const MACOS: Record<string, string> = {
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

export function checkArchiveRoot(entries: TarEntry[], pkg: AppPackage): void {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]!));
  if (tops.size !== 1 || !tops.has(pkg.app)) {
    throw refuse(`the app archive must hold exactly ${pkg.app} at its top, not ${[...tops].join(", ")}`, "Pack only the app: tar -czf <archive> <App>.app");
  }
}

export const appAsset = (pkg: AppPackage, version: string) => assetName(pkg, appPlatform(pkg), version)!;
export const appPlatform = (pkg: AppPackage) => Object.keys(pkg.assets)[0] as Platform;
export const dmgName = (pkg: AppPackage, version: string) => pkg.dmg.name.replaceAll("{version}", version);

export function carryCheck(assets: { name: string }[], checksums: ChecksumLine[], pkg: AppPackage, version: string): void {
  const outputs = new Set([appAsset(pkg, version), dmgName(pkg, version), "checksums.txt", ...(pkg.sparkle ? [pkg.sparkle.feed] : [])]);
  const fix = "Attach only the app archive, checksums.txt and the files listed in carry.";
  for (const name of Object.keys(pkg.carry)) {
    if (outputs.has(name)) throw new TapsterError(`the carried file ${name} has the name of a file tapster writes`, "Rename it or remove it from carry.");
    if (!assets.some((a) => a.name === name)) throw new TapsterError(`the carried file ${name} is not attached`, fix);
    const line = checksums.find((l) => l.name === name);
    if (!line || `sha256:${line.sha256}` !== pkg.carry[name]) throw new TapsterError(`the carried file ${name} differs from the digest pinned in tapster.yml`, "Attach the pinned file unchanged.");
  }
  for (const a of assets) {
    if (a.name !== "checksums.txt" && a.name !== appAsset(pkg, version) && !Object.hasOwn(pkg.carry, a.name)) throw new TapsterError(`the draft holds ${a.name}, which is neither the app archive nor a carried file`, fix);
  }
}

type Kind = "dir" | "file" | "link";

function walk(dir: string, out: { path: string; kind: Kind }[] = []): { path: string; kind: Kind }[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    const kind: Kind = e.isSymbolicLink() ? "link" : e.isDirectory() ? "dir" : "file";
    out.push({ path, kind });
    if (kind === "dir") walk(path, out);
  }
  return out;
}

function versionAtLeast(v: string, floor: number[]): boolean {
  const parts = v.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < floor.length; i++) {
    const p = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (p !== floor[i]) return p > floor[i]!;
  }
  return true;
}

const isDict = (v: PlistValue | undefined): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);

export type ReadPlist = (path: string) => Promise<Dict>;

const MAX_PLIST = 1 << 20;
const MAX_PLISTS = 400;

export const systemPlist: ReadPlist = async (path) => {
  if (statSync(path).size > MAX_PLIST) throw refuse(`${basename(path)} is larger than 1 MiB`);
  const r = await run("plutil", ["-convert", "xml1", "-o", "-", path], { allowFail: true, maxOutput: MAX_PLIST, timeoutMs: 10_000 });
  if (r.code !== 0) throw refuse(`macOS cannot read ${basename(path)} as a property list`);
  const v = parsePlist(Buffer.from(r.stdout, "utf8"));
  if (!isDict(v)) throw refuse(`${basename(path)} is not a dictionary`);
  return v;
};

const sparkleKey = (k: string) => k.startsWith("SU") || CHECKED.includes(k);

function localizedKey(d: Dict): string | undefined {
  for (const [k, v] of Object.entries(d)) {
    if (sparkleKey(k)) return k;
    if (isDict(v)) for (const inner of Object.keys(v)) if (sparkleKey(inner)) return inner;
  }
  return undefined;
}

export async function appFacts(appDir: string, pkg: AppPackage, all: PackageConfig[], tag: string, readPlist: ReadPlist): Promise<AppFacts> {
  const rel = (p: string) => relative(appDir, p).split(sep).join("/");
  let reads = 0;
  const read = async (path: string): Promise<Dict> => {
    if (++reads > MAX_PLISTS) throw refuse(`the app holds more than ${MAX_PLISTS} property lists`, "Rebuild the app; tapster reads at most that many.");
    try {
      const v = await readPlist(path);
      if (!isDict(v)) throw refuse(`${rel(path)} is not a dictionary`);
      return v;
    } catch (e) {
      if (e instanceof TapsterError && e.reason.includes(rel(path))) throw e;
      throw refuse(`tapster cannot read ${rel(path)}`, "Write it as an XML or binary property list in UTF-8.");
    }
  };
  const infoPath = join(appDir, "Contents", "Info.plist");
  const info = await read(infoPath);
  const version = versionOf(tag);
  const str = (k: string) => (typeof info[k] === "string" ? (info[k] as string) : null);
  if (str("CFBundleIdentifier") !== pkg.bundle_id) throw refuse(`the app's bundle id is ${str("CFBundleIdentifier") ?? "missing"}, not ${pkg.bundle_id}`);
  if (str("CFBundleShortVersionString") !== version) throw refuse(`the app's version is ${str("CFBundleShortVersionString") ?? "missing"}, but the tag says ${version}`);
  if (str("CFBundleVersion") !== version) throw refuse(`the app's CFBundleVersion is ${str("CFBundleVersion") ?? "missing"}, but the tag says ${version}`, "Stamp CFBundleVersion with the tag version, as today.");
  const minimum = str("LSMinimumSystemVersion") ?? "";
  const macos = MACOS[minimum.split(".")[0] ?? ""];
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
      const sv = (await read(join(sparkleVersions, v, "Resources", "Info.plist"))).CFBundleShortVersionString;
      if (typeof sv !== "string" || !versionAtLeast(sv, SPARKLE_FLOOR)) throw refuse(`the embedded Sparkle is ${String(sv)}, older than 2.9.0, which ignores SURequireSignedFeed`, "Update Sparkle in the project.");
    }
  }
  const appNames = new Set(all.filter(isApp).map((p) => p.app.replace(/\.app$/i, "").toLowerCase()));
  const lower = (p: string) => basename(p).toLowerCase();
  for (const { path, kind } of walk(appDir)) {
    const name = lower(path);
    if (kind !== "file" && appNames.has(name.replace(/\.app$/, ""))) throw refuse(`the app contains ${rel(path)}, named like an app the hub publishes`);
    if (/\.m?pkg$/.test(name)) throw refuse(`the app contains the installer package ${rel(path)}, which Sparkle could install instead of the app`);
    if (/^info-.*\.plist$/.test(name)) throw refuse(`the app contains ${rel(path)}, which macOS would read instead of the Info.plist tapster checks`);
    if (kind === "link" && (name === "info.plist" || name.startsWith("infoplist."))) throw refuse(`${rel(path)} is a symlink, which hides the Info.plist tapster checks`);
    if (kind !== "file") continue;
    if (name.startsWith("infoplist.")) {
      const hit = localizedKey(await read(path));
      if (hit) throw refuse(`${rel(path)} localizes ${hit}, which tapster checks`, "Remove that key from the localized Info.plist.");
      continue;
    }
    if (name !== "info.plist" || path === infoPath) continue;
    const parent = dirname(path);
    const owner = lower(parent) === "contents" ? dirname(parent) : lower(parent) === "resources" && lower(dirname(dirname(parent))) === "versions" ? dirname(parent) : parent;
    const ownerRel = rel(owner);
    const nested = await read(path);
    const id = nested.CFBundleIdentifier;
    if (id !== undefined && (typeof id !== "string" || !bundleIdAllowed(ownerRel, id, pkg))) throw refuse(`${ownerRel} claims the identifier ${String(id)}, outside ${pkg.bundle_id}`);
    for (const k of ["SUFeedURL", "SUPublicEDKey", ...FORBIDDEN]) if (k in nested) throw refuse(`${ownerRel} carries its own ${k}`);
    for (const k of ["CFBundleName", "CFBundleDisplayName"]) {
      const v = nested[k];
      if (typeof v === "string" && appNames.has(v.toLowerCase())) throw refuse(`${ownerRel} is named ${v}, like an app the hub publishes`);
    }
  }
  return { version, build: version, minimumSystemVersion: minimum, macos, publicKey };
}
