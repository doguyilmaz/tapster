import * as core from "@actions/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTarGz, writeTarGz } from "../archive";
import { sha256, writeChecksums } from "../checksums";
import { GitHub } from "../github";
import { commitToHub, readHubFile } from "../hubcommit";
import { readSecret, requireVar } from "../mask";
import { type Outgoing, makeLatest, resumeSwap, stageAndSwap, waitDownloadable } from "../publish";
import { failure, record, warn } from "../report";
import { STATE_PATH, type StateEntry, parseState, recordedChecksums, serializeState, upsert } from "../state";
import { type InstallationToken, installationToken } from "../token";
import { loadManifest, workdir } from "../workdir";
import type { Context } from "./context";

async function recordState(gh: GitHub, hub: string, pkg: string, entry: StateEntry): Promise<void> {
  await commitToHub(gh, hub, `${pkg} ${entry.tag} ${entry.status}`, async (read) => {
    const before = await read(STATE_PATH);
    const next = serializeState(upsert(parseState(before), pkg, entry));
    return next === before ? [] : [{ path: STATE_PATH, content: next }];
  });
}

export async function publishMode(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const hubGh = new GitHub(readSecret("GITHUB_TOKEN"));
  const out = join(workdir(), "out");
  await mkdir(out, { recursive: true, mode: 0o700 });
  let attest = false;
  for (const item of (await loadManifest()).items.filter((i) => i.status === "signed")) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package)!;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      if (item.resume) {
        const state = parseState(await readHubFile(hubGh, ctx.hub, STATE_PATH, "main"));
        await resumeSwap(gh, pkg.repo, release, recordedChecksums(state, pkg.name, item.releaseId));
      } else {
        const dir = join(workdir(), pkg.name, item.tag);
        const mtime = Math.floor(Date.parse(release.created_at) / 1000);
        const lines = item.checksums.map((l) => ({ ...l }));
        const files: Outgoing[] = [];
        for (const a of item.archives) {
          const entries = readTarGz(await readFile(join(dir, "assets", a.asset)));
          for (const e of entries) if (a.binaries.includes(e.name)) e.data = await readFile(join(a.dir, e.name));
          const data = writeTarGz(entries, mtime);
          files.push({ name: a.asset, data });
          lines.find((l) => l.name === a.asset)!.sha256 = sha256(data);
          await writeFile(join(out, a.asset), data);
          attest = true;
        }
        const sums = Buffer.from(writeChecksums(lines));
        files.push({ name: "checksums.txt", data: sums });
        await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: sha256(sums), status: "publishing" });
        await stageAndSwap(gh, pkg.repo, item.releaseId, files, item.before);
      }
      await gh.updateRelease(pkg.repo, item.releaseId, { draft: false, make_latest: makeLatest(item.tag, await gh.listReleases(pkg.repo)) });
      const published = await gh.getRelease(pkg.repo, item.releaseId);
      if ((await gh.getRepo(pkg.repo)).private) warn(`${pkg.name}: ${pkg.repo} is private, so its files cannot be downloaded by Homebrew users`);
      else await waitDownloadable(published.assets.map((a) => a.browser_download_url));
      const sumsAsset = published.assets.find((a) => a.name === "checksums.txt")!;
      const digest = sha256(await gh.downloadAsset(pkg.repo, sumsAsset.id));
      await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: digest, status: "published" });
      record({ item: `${pkg.name} ${item.tag}`, result: "published", detail: "" });
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
    }
  }
  core.setOutput("attest", String(attest));
  core.setOutput("attest-path", `${out}/*`);
}
