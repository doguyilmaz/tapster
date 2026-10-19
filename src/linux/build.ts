import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readTarGz } from "../archive";
import { parseChecksums, sha256 } from "../checksums";
import { type CliPackage, type HubConfig, isApp, linuxUrl, versionOf } from "../config";
import { TapsterError } from "../errors";
import { type State, latestPublished } from "../state";

export type LinuxPlatform = "linux-amd64" | "linux-arm64";
export type LinuxTarget = { pkg: CliPackage; tag: string; version: string; checksums: string; assets: { platform: LinuxPlatform; name: string }[] };
export type Packager = "deb" | "rpm";
export type PackageFile = { src: string; dst: string; mode: number };

export const ARCH: Record<LinuxPlatform, { nfpm: string; deb: string; rpm: string }> = {
  "linux-amd64": { nfpm: "amd64", deb: "amd64", rpm: "x86_64" },
  "linux-arm64": { nfpm: "arm64", deb: "arm64", rpm: "aarch64" },
};
const PLATFORMS = Object.keys(ARCH) as LinuxPlatform[];
const MAX_DOWNLOAD = 1 << 30;

export function linuxTargets(config: HubConfig, state: State): LinuxTarget[] {
  const out: LinuxTarget[] = [];
  for (const pkg of config.packages) {
    if (isApp(pkg) || !pkg.linux) continue;
    const latest = latestPublished(state, pkg.name);
    if (!latest) continue;
    const version = versionOf(latest.tag);
    const assets = PLATFORMS.filter((p) => pkg.assets[p]).map((platform) => ({ platform, name: pkg.assets[platform]!.replaceAll("{version}", version) }));
    out.push({ pkg, tag: latest.tag, version, checksums: latest.checksums, assets });
  }
  return out;
}

export const manifestJson = (targets: LinuxTarget[]) =>
  `${JSON.stringify({ packages: Object.fromEntries(targets.map((t) => [t.pkg.name, t.version]).sort(([a], [b]) => (a! < b! ? -1 : 1))) })}\n`;

export function packageFiles(pkg: CliPackage, packager: Packager, dir: string): PackageFile[] {
  const files: PackageFile[] = pkg.binaries.map((b) => ({ src: join(dir, b), dst: `/usr/bin/${basename(b)}`, mode: 0o755 }));
  const c = pkg.completions;
  if (c?.bash) files.push({ src: join(dir, c.bash), dst: `/usr/share/bash-completion/completions/${pkg.name}`, mode: 0o644 });
  if (c?.zsh) files.push({ src: join(dir, c.zsh), dst: `/usr/share/zsh/${packager === "deb" ? "vendor-completions" : "site-functions"}/_${pkg.name}`, mode: 0o644 });
  if (c?.fish) files.push({ src: join(dir, c.fish), dst: `/usr/share/fish/vendor_completions.d/${pkg.name}.fish`, mode: 0o644 });
  return files;
}

export type NfpmInput = { name: string; version: string; arch: string; maintainer: string; description: string; homepage: string; license: string | null; files: PackageFile[] };

export function nfpmConfig(i: NfpmInput): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    `name: ${q(i.name)}`,
    `arch: ${q(i.arch)}`,
    'platform: "linux"',
    `version: ${q(i.version)}`,
    'release: "1"',
    `maintainer: ${q(i.maintainer)}`,
    `description: ${q(i.description)}`,
    `homepage: ${q(i.homepage)}`,
    ...(i.license ? [`license: ${q(i.license)}`] : []),
    "contents:",
    ...i.files.flatMap((f) => [`  - src: ${q(f.src)}`, `    dst: ${q(f.dst)}`, `    file_info: { mode: 0${f.mode.toString(8)} }`]),
    "",
  ].join("\n");
}

export type BuildOptions = {
  fetch: typeof fetch;
  out: string;
  packager: (config: string, kind: Packager, dir: string) => Promise<void>;
};

async function download(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  const res = await fetchImpl(url).catch(() => null);
  if (!res?.ok) throw new TapsterError(`${basename(url)} could not be downloaded (${res?.status ?? "network error"})`, "The next run tries again.");
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new TapsterError(`${basename(url)} is larger than tapster packages`, "Keep Linux archives under 1 GiB.");
  return Buffer.from(await res.arrayBuffer());
}

async function buildOne(t: LinuxTarget, config: HubConfig, o: BuildOptions, stage: string): Promise<void> {
  const base = `https://github.com/${t.pkg.repo}/releases/download/${t.tag}`;
  const sums = await download(o.fetch, `${base}/checksums.txt`);
  if (sha256(sums) !== t.checksums) throw new TapsterError(`${t.tag}: checksums.txt differs from the one tapster published`, "Check who edited the release.");
  const lines = parseChecksums(sums.toString("utf8"));
  for (const asset of t.assets) {
    const data = await download(o.fetch, `${base}/${asset.name}`);
    const line = lines.find((l) => l.name === asset.name);
    if (!line || sha256(data) !== line.sha256) throw new TapsterError(`${asset.name} does not match checksums.txt`, "Check who edited the release.");
    const entries = readTarGz(data);
    const dir = join(stage, t.pkg.name, asset.platform);
    for (const kind of ["deb", "rpm"] as const) {
      const files = packageFiles(t.pkg, kind, dir);
      for (const f of files) {
        const rel = f.src.slice(dir.length + 1);
        const e = entries.find((x) => x.type === "file" && x.name === rel);
        if (!e) throw new TapsterError(`${asset.name}: ${rel} is missing`, "Check binaries and completions in tapster.yml.");
        await mkdir(dirname(f.src), { recursive: true, mode: 0o700 });
        await writeFile(f.src, e.data, { mode: f.mode });
      }
      const nfpm = nfpmConfig({
        name: t.pkg.name,
        version: t.version,
        arch: ARCH[asset.platform].nfpm,
        maintainer: config.linux!.maintainer,
        description: t.pkg.description ?? t.pkg.name,
        homepage: t.pkg.homepage ?? `https://github.com/${t.pkg.repo}`,
        license: t.pkg.license ?? null,
        files,
      });
      const configPath = join(dir, `nfpm-${kind}.yaml`);
      await writeFile(configPath, nfpm);
      const target = kind === "deb" ? join(o.out, "apt", "pool", "main") : join(o.out, "rpm", ARCH[asset.platform].rpm);
      await mkdir(target, { recursive: true });
      await o.packager(configPath, kind, target);
    }
  }
}

export async function buildLinux(config: HubConfig, state: State, hub: string, o: BuildOptions): Promise<{ changed: boolean; failed: string[] }> {
  const targets = linuxTargets(config, state);
  const stage = join(o.out, ".stage");
  const failed: string[] = [];
  try {
    for (const t of targets) {
      try {
        await buildOne(t, config, o, stage);
      } catch (e) {
        failed.push(`${t.pkg.name} ${t.tag}: ${e instanceof TapsterError ? e.reason : "unexpected error"}`);
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  if (failed.length) return { changed: false, failed };
  const manifest = manifestJson(targets);
  await writeFile(join(o.out, "tapster-linux.json"), manifest);
  const live = await o.fetch(`${linuxUrl(config, hub)}/tapster-linux.json`).catch(() => null);
  const current = live?.ok ? await live.text() : null;
  return { changed: current !== manifest, failed };
}
