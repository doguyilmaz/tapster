import * as core from "@actions/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appFacts, carryCheck, checkArchiveRoot, systemPlist } from "../appcheck";
import { isMachO, readTarGz } from "../archive";
import { verifyAttestation } from "../attest";
import { macCodeIn } from "../maccode";
import { parseChecksums, sha256 } from "../checksums";
import { type AppPackage, type Platform, assetName, isApp, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { writeTree } from "../extract";
import { readSecret, requireVar } from "../mask";
import { failure, warn } from "../report";
import { type InstallationToken, installationToken } from "../token";
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
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      if (!release.draft || release.tag_name !== item.tag) {
        throw new TapsterError("the release is no longer the draft that was checked", "The next run checks again.");
      }
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
          if (!carried(a.name) && (await verifyAttestation(file, pkg, item.tag, repo.private, tok.token)) === "skipped") {
            warn(`${pkg.name} ${item.tag}: ${a.name} has no attestation; ${pkg.repo} is private, so this is allowed`);
          }
        }
        if (isApp(pkg)) {
          const name = assetName(pkg, Object.keys(pkg.assets)[0] as Platform, version)!;
          fetched.app = await unpackApp(ctx, pkg, item.tag, await readFile(join(dir, "assets", name)), dir, release.created_at);
        } else for (const platform of (Object.keys(pkg.assets) as Platform[]).filter((p) => p.startsWith("darwin"))) {
          const name = assetName(pkg, platform, version)!;
          const binDir = join(dir, "bin", name);
          const found: string[] = [];
          for (const e of readTarGz(await readFile(join(dir, "assets", name)))) {
            if (e.type !== "file") continue;
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
          fetched.archives.push({ asset: name, platform, dir: binDir, binaries: found });
        }
      }
      manifest.items.push(fetched);
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
    }
  }
  await saveManifest(manifest);
}
