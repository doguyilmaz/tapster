import { basename } from "node:path";
import { parse } from "yaml";
import { BUNDLE_ID } from "./config";
import { parsePlist } from "./plist";

export const literal = (v: unknown) => (typeof v === "string" && !v.includes("$(") ? v : null);
export const feedName = (url: unknown) => (typeof url === "string" ? /\/releases\/latest\/download\/([A-Za-z0-9._-]+\.xml)$/.exec(url)?.[1] ?? null : null);

export type AppFacts = { name: string; bundleId: string | null; feed: string; publicKey: string | null; universal: boolean };
export type Helper = { path: string; identifier: string | null; entitlements: string | null };

type Target = { type?: unknown; info?: { properties?: Record<string, unknown> }; settings?: { base?: Record<string, unknown> }; dependencies?: unknown; entitlements?: { path?: unknown } };
type XcodeGen = { settings?: { base?: Record<string, unknown> }; targets?: Record<string, Target> } | null;

function xcodegen(yml: string): XcodeGen {
  try {
    return parse(yml) as XcodeGen;
  } catch {
    return null;
  }
}

const settingsOf = (project: NonNullable<XcodeGen>, t: Target) => ({ ...(project.settings?.base ?? {}), ...(t.settings?.base ?? {}) });

function appTarget(project: XcodeGen): [string, Target, string] | null {
  for (const [name, t] of Object.entries(project?.targets ?? {})) {
    if (t?.type !== "application") continue;
    const feed = feedName(t.info?.properties?.SUFeedURL);
    if (feed) return [name, t, feed];
  }
  return null;
}

// The XcodeGen application target that reads a Sparkle feed from the project's releases.
export function appFromProjectYml(yml: string): AppFacts | null {
  const project = xcodegen(yml);
  const found = appTarget(project);
  if (!project || !found) return null;
  const [name, t, feed] = found;
  const base = settingsOf(project, t);
  return { name: literal(base.PRODUCT_NAME) ?? name, bundleId: literal(base.PRODUCT_BUNDLE_IDENTIFIER), feed, publicKey: literal(t.info?.properties?.SUPublicEDKey), universal: String(base.ARCHS ?? "").includes("x86_64") };
}

// Command line tools the app target copies into Contents/MacOS, with the identifier the project gives them.
export function helpersOf(yml: string): Helper[] {
  const project = xcodegen(yml);
  const found = appTarget(project);
  if (!project || !found) return [];
  const deps = Array.isArray(found[1].dependencies) ? (found[1].dependencies as Record<string, unknown>[]) : [];
  return deps.flatMap((d) => {
    const copy = (d?.copy ?? {}) as { destination?: unknown; subpath?: unknown };
    const t = typeof d?.target === "string" ? project.targets?.[d.target] : undefined;
    if (!t || t.type !== "tool" || copy.destination !== "executables" || copy.subpath !== undefined) return [];
    const base = settingsOf(project, t);
    const product = literal(base.PRODUCT_NAME) ?? String(d.target);
    if (!/^[A-Za-z0-9._-]+$/.test(product)) return [];
    const id = literal(base.PRODUCT_BUNDLE_IDENTIFIER);
    const file = literal(base.CODE_SIGN_ENTITLEMENTS) ?? literal(t.entitlements?.path);
    return [{ path: `Contents/MacOS/${product}`, identifier: id && BUNDLE_ID.test(id) ? id : null, entitlements: file && /^[A-Za-z0-9 ._\/-]{1,200}$/.test(file) ? file : null }];
  });
}

export function plistDict(data: Buffer): Record<string, unknown> | null {
  try {
    const v = parsePlist(data);
    return v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bundleIdOf(plists: Buffer[], app: string): string | null {
  const base = basename(app, ".app");
  for (const data of plists) {
    const info = plistDict(data) ?? {};
    const id = literal(info.CFBundleIdentifier);
    if ((info.CFBundleExecutable === base || info.CFBundleName === base) && id && BUNDLE_ID.test(id)) return id;
  }
  return null;
}
