import * as core from "@actions/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ReadPlist, appFacts, carryCheck, checkArchiveRoot, checkToolApp, systemPlist } from "../appcheck";
import { isMachO, readTarGz, resolveSymlinks } from "../archive";
import { verifyAttestation } from "../attest";
import { macCodeIn } from "../maccode";
import { parseChecksums, sha256 } from "../checksums";
import { type AppPackage, type CliPackage, type PackageConfig, type Platform, assetName, isApp, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub, type Release } from "../github";
import { type WorkItem, draftOrigin } from "../plan";
import { writeTree } from "../extract";
import { readSecret, requireVar } from "../mask";
import { failure, warn } from "../report";
import { type InstallationToken, attestationToken, installationToken } from "../token";
import { type Fetched, type Manifest, saveManifest, workdir } from "../workdir";
import { type Context, parseWork } from "./context";

async function unpackApp(ctx: Context, pkg: AppPackage, tag: string, archive: Buffer, dir: string, created: string): Promise<Fetched["app"]> {
  const entries = readTarGz(archive);
  checkArchiveRoot(entries, pkg);
  await writeTree(entries, join(dir, "app"));
  const appDir = join(dir, "app", pkg.app);
  const facts = await appFacts(appDir, pkg, ctx.config.packages, tag, systemPlist);
  return { dir: appDir, facts, created, identifiers: [], dmg: null, feed: null };
}

export async function unpackTool(pkg: CliPackage, all: PackageConfig[], name: string, archive: Buffer, binDir: string, readPlist: ReadPlist = systemPlist): Promise<{ binaries: string[]; app?: string }> {
  const app = pkg.app;
  const entries = readTarGz(archive);
  const inApp = (n: string) => app !== undefined && n.split("/")[0] === app.name;
  if (app) {
    const twin = entries.map((e) => e.name.split("/")[0]!).find((top) => top !== app.name && top.toLowerCase() === app.name.toLowerCase());
    if (twin) throw new TapsterError(`${name} holds both ${app.name} and ${twin}, which macOS treats as one folder`, "Pack the app once, under the name in tapster.yml.");
    for (const [link, target] of resolveSymlinks(entries)) {
      if (inApp(link) && !target.toLowerCase().startsWith(`${app.name.toLowerCase()}/`)) {
        throw new TapsterError(`${name} has a symlink ${link} that leaves ${app.name}`, "Keep the app's symlinks inside the app.");
      }
    }
  }
  const found: string[] = [];
  for (const e of entries) {
    if (e.type !== "file" || inApp(e.name)) continue;
    const listed = pkg.binaries.includes(e.name);
    const macho = isMachO(e.data);
    if (macho && !listed) throw new TapsterError(`${name} holds ${e.name}, a Mach-O file not listed in binaries`, "List every macOS executable in binaries.");
    if (listed && !macho) throw new TapsterError(`${e.name} in ${name} is not a Mach-O binary`, "binaries must name the macOS executables in the archive.");
    if (!listed) continue;
    const out = join(binDir, e.name);
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await writeFile(out, e.data, { mode: 0o755 });
    found.push(e.name);
  }
  const missing = pkg.binaries.filter((b) => !found.includes(b));
  if (missing.length) throw new TapsterError(`${name} does not contain ${missing.join(", ")}`, "Check binaries in tapster.yml.");
  if (!app) return { binaries: found };
  const own = entries.filter((e) => inApp(e.name));
  if (!own.some((e) => e.name.startsWith(`${app.name}/`))) throw new TapsterError(`${name} does not contain ${app.name}`, "Pack the app at the top of the archive or remove app from tapster.yml.");
  await writeTree(own, binDir);
  await checkToolApp(join(binDir, app.name), app, all, readPlist);
  return { binaries: found, app: app.name };
}

export function assertFetchable(release: Release, item: WorkItem, owner: string): void {
  if (!release.draft || release.tag_name !== item.tag) {
    throw new TapsterError("the release is no longer the draft that was checked", "The next run checks again.");
  }
  const foreign = item.resume ? null : draftOrigin(release, owner);
  if (foreign) throw new TapsterError(foreign, "Delete the draft and release again from the project's workflow.");
}

export async function fetchMode(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const manifest: Manifest = { items: [] };
  for (const item of parseWork(core.getInput("work"))) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package);
    if (!pkg) {
      failure(item.package, new TapsterError("the package is not in tapster.yml", "The config changed since the check; the next run checks again."));
      continue;
    }
    let tok: InstallationToken | undefined;
    let attTok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      assertFetchable(release, item, ctx.owner);
      const fetched: Fetched = { ...item, before: release.assets, checksums: [], archives: [], status: "fetched" };
      if (!item.resume) {
        const repo = await gh.getRepo(pkg.repo);
        const dir = join(workdir(), pkg.name, item.tag);
        await mkdir(join(dir, "assets"), { recursive: true, mode: 0o700 });
        const sums = release.assets.find((a) => a.name === "checksums.txt");
        if (!sums) throw new TapsterError("checksums.txt disappeared from the draft", "The next run checks again.");
        fetched.checksums = parseChecksums((await gh.downloadAsset(pkg.repo, sums.id)).toString("utf8"));
        const version = versionOf(item.tag);
        if (isApp(pkg)) carryCheck(release.assets, fetched.checksums, pkg, version);
        const carried = (name: string) => isApp(pkg) && Object.hasOwn(pkg.carry, name);
        const signedHere = new Set((Object.keys(pkg.assets) as Platform[]).filter((p) => p.startsWith("darwin")).map((p) => assetName(pkg, p, version)!));
        for (const a of release.assets) {
          if (a.name === "checksums.txt") continue;
          const data = await gh.downloadAsset(pkg.repo, a.id);
          const line = fetched.checksums.find((l) => l.name === a.name);
          if (!line || sha256(data) !== line.sha256 || (a.digest !== null && a.digest !== `sha256:${line.sha256}`)) {
            throw new TapsterError(`${a.name} does not match checksums.txt`, "Rebuild the release; the files changed after the checksums were written.");
          }
          const unsigned = signedHere.has(a.name) ? null : macCodeIn(a.name, data);
          if (unsigned) throw new TapsterError(unsigned, "Map every macOS archive in tapster.yml so tapster signs it or stop attaching the file.");
          const file = join(dir, "assets", a.name);
          await writeFile(file, data, { mode: 0o600 });
          attTok ??= await attestationToken(appId, pem, pkg.repo);
          if (!carried(a.name) && (await verifyAttestation(file, pkg, item.tag, repo.private, attTok.token)) === "skipped") {
            warn(`${pkg.name} ${item.tag}: ${a.name} has no attestation; ${pkg.repo} is private, so this is allowed`);
          }
        }
        if (isApp(pkg)) {
          const name = assetName(pkg, Object.keys(pkg.assets)[0] as Platform, version)!;
          fetched.app = await unpackApp(ctx, pkg, item.tag, await readFile(join(dir, "assets", name)), dir, release.created_at);
        } else for (const platform of (Object.keys(pkg.assets) as Platform[]).filter((p) => p.startsWith("darwin"))) {
          const name = assetName(pkg, platform, version)!;
          const binDir = join(dir, "bin", name);
          const unpacked = await unpackTool(pkg, ctx.config.packages, name, await readFile(join(dir, "assets", name)), binDir);
          fetched.archives.push({ asset: name, platform, dir: binDir, ...unpacked });
        }
      }
      manifest.items.push(fetched);
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
      await attTok?.revoke();
    }
  }
  await saveManifest(manifest);
}
