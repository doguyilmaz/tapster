import { parse } from "yaml";
import { z } from "zod";
import { TapsterError } from "./errors";
import { descProblems } from "./render";

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

const caskFields = {
  uninstall: z.object({ launchctl: z.array(label).optional(), quit: z.array(label).optional() }).strict().optional(),
  zap: z.object({ trash: z.array(z.string().regex(/^~\/[A-Za-z0-9 ._\/-]+$/)) }).strict().optional(),
  caveats: z.string().min(1).max(2000).optional(),
};
const common = {
  name: z.string().regex(NAME),
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/).default("release.yml"),
  assets: z.partialRecord(z.enum(PLATFORMS), z.string().regex(/^[A-Za-z0-9._{}-]+$/)),
  description: z.string().min(1).max(200).optional(),
  homepage: z.url().optional(),
  license: z.string().regex(/^[A-Za-z0-9.+-]+$/).optional(),
  attestation: z.enum(["auto", "off"]).default("auto"),
};

const cliPkg = z
  .object({
    ...common,
    kind: z.enum(["go", "bun"]),
    binaries: z.array(relPath).min(1),
    completions: z.object({ bash: relPath.optional(), zsh: relPath.optional(), fish: relPath.optional() }).strict().optional(),
    scoop: z.boolean().default(false),
    entitlements: z.array(z.enum(ENTITLEMENTS)).default([]),
    cask: z.object(caskFields).strict().default({}),
    linux: z.boolean().default(false),
  })
  .strict();

export const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const coord = z.number().int().min(0).max(5000);
const entitlementValue = z.union([z.boolean(), z.string().regex(/^[A-Za-z0-9._*{}-]+$/), z.array(z.string().regex(/^[A-Za-z0-9._*{}-]+$/))]);

const appPkg = z
  .object({
    ...common,
    kind: z.literal("app"),
    app: z.string().regex(/^[A-Za-z0-9 ._-]+\.app$/),
    bundle_id: z.string().regex(BUNDLE_ID),
    carry: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), z.string().regex(/^sha256:[0-9a-f]{64}$/)).default({}),
    dmg: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9._{}-]+\.dmg$/),
        volume: z.string().regex(/^[A-Za-z0-9 ._-]{1,27}$/).optional(),
        volume_icon: relPath.optional(),
        layout: z.object({ window: z.tuple([coord, coord, coord, coord]), icon_size: coord, app: z.tuple([coord, coord]), applications: z.tuple([coord, coord]) }).strict().optional(),
      })
      .strict(),
    sparkle: z
      .object({
        key: z.string().regex(/^[a-z0-9]+$/),
        feed: z.string().regex(/^[A-Za-z0-9._-]+\.xml$/).default("appcast.xml"),
        public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
        next_key: z.string().regex(/^[a-z0-9]+$/).optional(),
        next_public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
      })
      .strict()
      .optional(),
    code: z
      .record(relPath, z.object({ identifier: z.string().regex(BUNDLE_ID).optional(), entitlements: z.record(z.string().regex(/^[A-Za-z0-9.-]+$/), entitlementValue).optional() }).strict())
      .default({}),
    cask: z.object({ ...caskFields, binaries: z.array(relPath).optional(), auto_updates: z.boolean().optional() }).strict().default({}),
  })
  .strict();

const pkg = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("kind" in v) ? { ...v, kind: "go" } : v),
  z.discriminatedUnion("kind", [cliPkg, appPkg]),
);

const hub = z
  .object({
    version: z.literal(1),
    tap: z.string().regex(/^[A-Za-z0-9-]+\/[a-z0-9-]+$/),
    linux: z
      .object({
        maintainer: z.string().regex(/^[A-Za-z0-9 .'-]+ <[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>$/),
        url: z.url({ protocol: /^https$/ }).regex(/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)*$/).optional(),
      })
      .strict()
      .optional(),
    packages: z.array(pkg),
  })
  .strict();

export type CliPackage = z.infer<typeof cliPkg>;
export type AppPackage = z.infer<typeof appPkg> & { dmg: { volume: string } };
export type PackageConfig = CliPackage | AppPackage;
export const isApp = (p: PackageConfig): p is AppPackage => p.kind === "app";
export type HubConfig = Omit<z.infer<typeof hub>, "packages"> & { packages: PackageConfig[] };
export type Semver = { major: number; minor: number; patch: number; pre: string | null };

export type InvalidPackage = { name: string; reason: string; fix: string };

const issueText = (issues: z.core.$ZodIssue[]) => issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

function checkPackage(p: PackageConfig, top: Omit<HubConfig, "packages">, hubOwner: string): void {
  if (isApp(p)) checkApp(p);
  if (p.repo.split("/")[0]!.toLowerCase() !== hubOwner.toLowerCase()) {
    throw new TapsterError(`${p.name}: ${p.repo} is not owned by ${hubOwner}`, "tapster publishes only repositories of the hub's owner.");
  }
  const problems = p.description === undefined ? [] : descProblems(p.description, p.name);
  if (problems.length) throw new TapsterError(`${p.name}: Homebrew rejects the description because ${problems.join(" and ")}`, "Rewrite description in tapster.yml.");
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
  if (isApp(p) || !p.linux) return;
  if (!Object.keys(p.assets).some((k) => k.startsWith("linux-"))) throw new TapsterError(`${p.name}: linux needs a Linux asset`, "Map linux-amd64 or linux-arm64, or remove linux: true.");
  if (!top.linux) throw new TapsterError(`${p.name} ships Linux packages, but tapster.yml names no linux.maintainer`, 'Add linux: { maintainer: "Name <address>" } at the top of tapster.yml.');
}

function conflicts(pkgs: [number, PackageConfig][]): Map<number, TapsterError> {
  const found = new Map<number, TapsterError>();
  const mark = (i: number, e: TapsterError) => found.has(i) || found.set(i, e);
  for (const [i, p] of pkgs) {
    const twins = pkgs.filter(([j, q]) => j !== i && q.name === p.name);
    if (twins.length) mark(i, new TapsterError(`package ${p.name} is listed twice`, "Keep one entry per package."));
  }
  const binaries = pkgs.flatMap(([i, p]) => (isApp(p) ? (p.cask.binaries ?? []) : p.binaries).map((b) => ({ i, p, id: b.split("/").pop()! })));
  for (const a of binaries) {
    for (const b of binaries) {
      if (a.i === b.i || a.id !== b.id || a.p.name === b.p.name) continue;
      mark(a.i, new TapsterError(`${a.p.name} and ${b.p.name} both ship a binary named ${a.id}`, "Signed tools are identified by name, so each name may belong to one package."));
    }
  }
  const overlaps = (x: string, y: string) => {
    const a = x.toLowerCase();
    const b = y.toLowerCase();
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
  };
  const apps = pkgs.filter((e): e is [number, AppPackage] => isApp(e[1]));
  for (const [i, a] of apps) {
    for (const [j, b] of apps) {
      if (i !== j && overlaps(a.bundle_id, b.bundle_id)) mark(i, new TapsterError(`${a.name} and ${b.name} have overlapping bundle ids`, "Each app needs its own bundle id, not one inside another."));
    }
    for (const bin of binaries) {
      const id = bin.id.toLowerCase();
      if (id !== a.bundle_id.toLowerCase() && !id.startsWith(`${a.bundle_id.toLowerCase()}.`)) continue;
      const e = new TapsterError(`the binary ${bin.id} would carry ${a.name}'s identity`, "Rename the binary.");
      mark(i, e);
      mark(bin.i, e);
    }
  }
  return found;
}

export function parseHub(text: string, hubOwner: string): { config: HubConfig; invalid: InvalidPackage[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    throw new TapsterError("tapster.yml is not valid YAML", "Fix the YAML syntax; tapster doctor shows the line.");
  }
  const top = hub.extend({ packages: z.array(z.unknown()) }).safeParse(raw);
  if (!top.success) throw new TapsterError(`tapster.yml is invalid: ${issueText(top.error.issues)}`, "Fix the listed fields.");
  const { packages, ...rest } = top.data;
  const failed = new Map<number, InvalidPackage>();
  const nameAt = (v: unknown, i: number) => {
    const n = v && typeof v === "object" && "name" in v ? (v as { name: unknown }).name : undefined;
    return typeof n === "string" && NAME.test(n) ? n : `packages[${i}]`;
  };
  const ok: [number, PackageConfig][] = [];
  for (const [i, v] of packages.entries()) {
    const r = pkg.safeParse(v);
    if (!r.success) {
      failed.set(i, { name: nameAt(v, i), reason: `${nameAt(v, i)} is invalid: ${issueText(r.error.issues)}`, fix: "Fix the listed fields in tapster.yml." });
      continue;
    }
    const p = r.data as PackageConfig;
    try {
      checkPackage(p, rest, hubOwner);
      ok.push([i, p]);
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      failed.set(i, { name: p.name, reason: e.reason, fix: e.fix });
    }
  }
  for (const [i, e] of conflicts(ok)) failed.set(i, { name: ok.find(([j]) => j === i)![1].name, reason: e.reason, fix: e.fix });
  return {
    config: { ...rest, packages: ok.filter(([i]) => !failed.has(i)).map(([, p]) => p) },
    invalid: [...failed.entries()].sort(([a], [b]) => a - b).map(([, v]) => v),
  };
}

export function parseConfig(text: string, hubOwner: string): HubConfig {
  const { config, invalid } = parseHub(text, hubOwner);
  if (invalid.length) throw new TapsterError(invalid.map((i) => i.reason).join("; "), invalid[0]!.fix);
  return config;
}

function checkApp(p: AppPackage): void {
  const darwin = Object.keys(p.assets).filter((k) => k.startsWith("darwin"));
  if (darwin.length !== 1 || Object.keys(p.assets).length !== 1) {
    throw new TapsterError(`${p.name}: an app needs exactly one darwin asset and nothing else`, "Map one of darwin-arm64, darwin-amd64 or darwin-universal to the app archive.");
  }
  p.dmg.volume ??= p.app.replace(/\.app$/, "").slice(0, 27);
  if (p.sparkle && (p.sparkle.next_key === undefined) !== (p.sparkle.next_public_key === undefined)) {
    throw new TapsterError(`${p.name}: a rotation needs both sparkle.next_key and next_public_key`, "Set both, or neither.");
  }
  for (const [path, c] of Object.entries(p.code)) {
    if (c.identifier && !c.identifier.startsWith(`${p.bundle_id}.`)) {
      throw new TapsterError(`${p.name}: the identifier for ${path} is outside ${p.bundle_id}`, `Use an identifier that starts with ${p.bundle_id}.`);
    }
  }
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

export function linuxUrl(config: HubConfig, hub: string): string {
  const [owner, repo] = hub.split("/") as [string, string];
  return config.linux?.url ?? `https://${owner.toLowerCase()}.github.io/${repo}`;
}

export function assetName(p: PackageConfig, platform: Platform, version: string): string | undefined {
  return p.assets[platform]?.replaceAll("{version}", version);
}
