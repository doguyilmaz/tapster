import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appAsset, dmgName } from "../appcheck";
import { readTarGz, writeTarGz } from "../archive";
import { type ChecksumLine, sha256, writeChecksums } from "../checksums";
import { readTree } from "../extract";
import { type AppPackage, isApp, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { commitToHub, readHubFile } from "../hubcommit";
import { readSecret, requireVar } from "../mask";
import { type Outgoing, assertFinal, assertRecorded, makeLatest, resumeSwap, stageAndSwap, waitDownloadable } from "../publish";
import { failure, info, record, warn } from "../report";
import { STATE_PATH, type State, type StateEntry, parseState, recordedChecksums, serializeState, upsert } from "../state";
import { type InstallationToken, installationToken } from "../token";
import { type DarwinArchive, loadManifest, workdir } from "../workdir";
import type { Context } from "./context";

async function recordState(gh: GitHub, hub: string, pkg: string, entry: StateEntry): Promise<void> {
  await commitToHub(gh, hub, `${pkg} ${entry.tag} ${entry.status}`, async (read) => {
    const before = await read(STATE_PATH);
    const next = serializeState(upsert(parseState(before), pkg, entry));
    return next === before ? [] : [{ path: STATE_PATH, content: next }];
  });
}

export function appOutputs(pkg: AppPackage, tag: string, checksums: ChecksumLine[], dmg: Buffer, feed: Buffer | null): { files: Outgoing[]; remove: string[] } {
  const version = versionOf(tag);
  const files: Outgoing[] = [{ name: dmgName(pkg, version), data: dmg }, ...(feed ? [{ name: pkg.sparkle!.feed, data: feed }] : [])];
  const carried = checksums.filter((l) => Object.hasOwn(pkg.carry, l.name));
  const sums = writeChecksums([...files.map((f) => ({ sha256: sha256(f.data), name: f.name })), ...carried]);
  return { files: [...files, { name: "checksums.txt", data: Buffer.from(sums) }], remove: [appAsset(pkg, version)] };
}

function recordedApp(state: State, pkg: string, releaseId: number): StateEntry["app"] {
  const app = state.packages[pkg]?.find((e) => e.releaseId === releaseId)?.app;
  if (!app) throw new TapsterError("the state has no app facts for this release", "Delete the draft and release again.");
  return app;
}

export async function repackTool(original: Buffer, a: DarwinArchive, mtime: number): Promise<Buffer> {
  const entries = readTarGz(original).filter((e) => a.app === undefined || e.name.split("/")[0] !== a.app);
  for (const e of entries) if (a.binaries.includes(e.name)) e.data = await readFile(join(a.dir, e.name));
  if (a.app) await readTree(join(a.dir, a.app), a.app, entries);
  return writeTarGz(entries, mtime);
}

export const attestLines = (files: Outgoing[]) => writeChecksums(files.map((f) => ({ sha256: sha256(f.data), name: f.name })));

export function attestDecision(signed: boolean, hubPrivate: boolean): { attest: boolean; note: string | null } {
  if (!signed) return { attest: false, note: null };
  if (hubPrivate) return { attest: false, note: "the hub is a private repository, where GitHub offers no attestations; the published files are not attested" };
  return { attest: true, note: null };
}

export async function publishMode(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const hubGh = new GitHub(readSecret("GITHUB_TOKEN"));
  const attested: Outgoing[] = [];
  for (const item of (await loadManifest()).items) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package);
    if (!pkg || item.status !== (isApp(pkg) ? "sparkled" : "signed")) continue;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      let expected: string | undefined;
      let app: StateEntry["app"];
      const signed: Outgoing[] = [];
      if (item.resume) {
        const state = parseState(await readHubFile(hubGh, ctx.hub, STATE_PATH, "main"));
        expected = recordedChecksums(state, pkg.name, item.releaseId);
        if (isApp(pkg)) app = recordedApp(state, pkg.name, item.releaseId);
        await resumeSwap(gh, pkg.repo, release, expected, isApp(pkg) ? [appAsset(pkg, versionOf(item.tag))] : []);
      } else if (isApp(pkg)) {
        const work = item.app!;
        const out = appOutputs(pkg, item.tag, item.checksums, await readFile(work.dmg!), work.feed ? await readFile(work.feed) : null);
        signed.push(...out.files.filter((f) => f.name !== "checksums.txt"));
        expected = sha256(out.files.find((f) => f.name === "checksums.txt")!.data);
        app = { macos: work.facts.macos, identifiers: work.identifiers };
        await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: expected, status: "publishing", app });
        await stageAndSwap(gh, pkg.repo, item.releaseId, out.files, item.before, out.remove);
      } else {
        const dir = join(workdir(), pkg.name, item.tag);
        const mtime = Math.floor(Date.parse(release.created_at) / 1000);
        const lines = item.checksums.map((l) => ({ ...l }));
        const files: Outgoing[] = [];
        for (const a of item.archives) {
          const data = await repackTool(await readFile(join(dir, "assets", a.asset)), a, mtime);
          files.push({ name: a.asset, data });
          signed.push({ name: a.asset, data });
          lines.find((l) => l.name === a.asset)!.sha256 = sha256(data);
        }
        const sums = Buffer.from(writeChecksums(lines));
        files.push({ name: "checksums.txt", data: sums });
        expected = sha256(sums);
        await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: expected, status: "publishing" });
        await stageAndSwap(gh, pkg.repo, item.releaseId, files, item.before);
      }
      await assertFinal(gh, pkg.repo, item.releaseId, expected!);
      await gh.updateRelease(pkg.repo, item.releaseId, item.tag, { draft: false, make_latest: makeLatest(item.tag, await gh.listReleases(pkg.repo)) });
      const published = await gh.getRelease(pkg.repo, item.releaseId);
      if ((await gh.getRepo(pkg.repo)).private) warn(`${pkg.name}: ${pkg.repo} is private, so its files cannot be downloaded by Homebrew users`);
      else await waitDownloadable(published.assets.map((a) => a.browser_download_url));
      const sumsAsset = published.assets.find((a) => a.name === "checksums.txt")!;
      const publishedSums = await gh.downloadAsset(pkg.repo, sumsAsset.id);
      assertRecorded(publishedSums, expected!);
      await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: expected!, status: "published", ...(app ? { app } : {}) });
      attested.push(...signed);
      record({ item: `${pkg.name} ${item.tag}`, result: "published", detail: "" });
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
    }
  }
  const signedAny = attested.length > 0;
  const decision = attestDecision(signedAny, signedAny && (await hubGh.getRepo(ctx.hub)).private);
  if (decision.note) info(`hub: ${decision.note}`);
  core.setOutput("attest", String(decision.attest));
  core.setOutput("attest-checksums", decision.attest ? attestLines(attested).trimEnd() : "");
}
