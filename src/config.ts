import { parse } from "yaml";
import { z } from "zod";
import { TapsterError } from "./errors";

export const PLATFORMS = ["darwin-universal", "darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64", "windows-amd64", "windows-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
] as const;

const relPath = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((p) => !p.split("/").includes(".."), "must stay inside the archive");
const label = z.string().regex(/^[A-Za-z0-9.-]+$/);

const pkg = z
  .object({
    name: z.string().regex(NAME),
    repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    kind: z.enum(["go", "bun"]).default("go"),
    workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/).default("release.yml"),
    binaries: z.array(relPath).min(1),
    assets: z.partialRecord(z.enum(PLATFORMS), z.string().regex(/^[A-Za-z0-9._{}-]+$/)),
    description: z.string().min(1).max(200).optional(),
    homepage: z.url().optional(),
    license: z.string().regex(/^[A-Za-z0-9.+-]+$/).optional(),
    completions: z.object({ bash: relPath.optional(), zsh: relPath.optional(), fish: relPath.optional() }).strict().optional(),
    scoop: z.boolean().default(false),
    attestation: z.enum(["auto", "off"]).default("auto"),
    entitlements: z.array(z.enum(ENTITLEMENTS)).default([]),
    cask: z
      .object({
        uninstall: z.object({ launchctl: z.array(label).optional(), quit: z.array(label).optional() }).strict().optional(),
        zap: z.object({ trash: z.array(z.string().regex(/^~\/[A-Za-z0-9 ._\/-]+$/)) }).strict().optional(),
        caveats: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const hub = z
  .object({
    version: z.literal(1),
    tap: z.string().regex(/^[A-Za-z0-9-]+\/[a-z0-9-]+$/),
    packages: z.array(pkg),
  })
  .strict();

export type PackageConfig = z.infer<typeof pkg>;
export type HubConfig = z.infer<typeof hub>;
export type Semver = { major: number; minor: number; patch: number; pre: string | null };

export function parseConfig(text: string, hubOwner: string): HubConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    throw new TapsterError("tapster.yml is not valid YAML", "Fix the YAML syntax; tapster doctor shows the line.");
  }
  const result = hub.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new TapsterError(`tapster.yml is invalid: ${issues}`, "Fix the listed fields.");
  }
  const names = new Set<string>();
  for (const p of result.data.packages) {
    if (names.has(p.name)) throw new TapsterError(`package ${p.name} is listed twice`, "Keep one entry per package.");
    names.add(p.name);
    if (p.repo.split("/")[0]!.toLowerCase() !== hubOwner.toLowerCase()) {
      throw new TapsterError(`${p.name}: ${p.repo} is not owned by ${hubOwner}`, "tapster publishes only repositories of the hub's owner.");
    }
    const entries = Object.entries(p.assets);
    if (entries.length === 0) throw new TapsterError(`${p.name}: assets is empty`, "Map at least one platform to an asset name.");
    for (const [platform, name] of entries) {
      if (name.replaceAll("{version}", "").includes("{") || name.replaceAll("{version}", "").includes("}")) {
        throw new TapsterError(`${p.name}: ${name} uses a placeholder other than {version}`, "Only {version} is replaced in asset names.");
      }
      if (platform.startsWith("darwin") && !name.endsWith(".tar.gz")) {
        throw new TapsterError(`${p.name}: the ${platform} asset must be a .tar.gz`, "Pack macOS builds as tar.gz; tapster reads them itself.");
      }
    }
  }
  return result.data;
}

export function parseTag(tag: string): Semver | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const x = a.pre.split(".");
  const y = b.pre.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const versionOf = (tag: string) => tag.slice(1);

export function assetName(p: PackageConfig, platform: Platform, version: string): string | undefined {
  return p.assets[platform]?.replaceAll("{version}", version);
}
