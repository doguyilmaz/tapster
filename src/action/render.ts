import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ChecksumLine, parseChecksums, sha256 } from "../checksums";
import { type PackageConfig, type Platform, parseTag, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { commitToHub } from "../hubcommit";
import { readSecret } from "../mask";
import { type Download, caskPath, downloadUrl, renderCask, renderScoop, scoopPath } from "../render";
import { failure, record } from "../report";
import { childEnv, run, runPath } from "../run";
import { STATE_PATH, latestPublished, parseState, serializeState, upsert } from "../state";
import type { Context } from "./context";

const readIfExists = (path: string) => readFile(path, "utf8").catch(() => null);

export function buildDownloads(pkg: PackageConfig, tag: string, lines: ChecksumLine[]): Download[] {
  const version = versionOf(tag);
  return (Object.entries(pkg.assets) as [Platform, string][]).map(([platform, template]) => {
    const name = template.replaceAll("{version}", version);
    const line = lines.find((l) => l.name === name);
    if (!line) throw new TapsterError(`${name} is not in the published checksums.txt`, "Check assets in tapster.yml.");
    return { platform, url: downloadUrl(pkg.repo, tag, name), sha256: line.sha256 };
  });
}

export async function headIsStale(ws: string): Promise<boolean> {
  const out = await run("git", ["-C", ws, "log", "-1", "--format=%ct"]).catch(() => ({ stdout: "0" }));
  const last = Number(out.stdout.trim());
  return last > 0 && Date.now() / 1000 - last > 30 * 86400;
}

export async function renderNeeded(ctx: Context): Promise<boolean> {
  if (await headIsStale(ctx.workspace)) return true;
  const state = parseState(await readIfExists(join(ctx.workspace, STATE_PATH)));
  if (Object.values(state.packages).some((list) => list.some((e) => e.status === "publishing"))) return true;
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest) continue;
    const cask = await readIfExists(join(ctx.workspace, caskPath(pkg.name)));
    if (!cask?.includes(`  version "${versionOf(latest.tag)}"\n`)) return true;
  }
  return false;
}

async function audit(ws: string, tap: string, casks: { name: string; online: boolean }[]): Promise<void> {
  if (casks.length === 0) return;
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => existsSync(p));
  if (!brew) throw new TapsterError("Homebrew is not installed on this runner", "Run the render job on macos-15.");
  const env = childEnv({ PATH: `${dirname(brew)}:/usr/bin:/bin`, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" });
  const local = `${tap.split("/")[0]}/tapster-audit`;
  await run("git", ["-C", ws, "add", "-A"]);
  await run("git", ["-C", ws, "-c", "user.name=tapster", "-c", "user.email=tapster@localhost", "commit", "-q", "--allow-empty", "-m", "tapster audit"]);
  await runPath(brew, "brew", ["tap", local, ws], { env });
  try {
    for (const c of casks) {
      await runPath(brew, "brew", ["style", "--cask", `${local}/${c.name}`], { env });
      await runPath(brew, "brew", ["audit", "--cask", ...(c.online ? ["--online"] : []), `${local}/${c.name}`], { env });
    }
  } finally {
    await runPath(brew, "brew", ["untap", local], { env, allowFail: true });
  }
}

export async function renderMode(ctx: Context): Promise<void> {
  const gh = new GitHub(readSecret("GITHUB_TOKEN"));
  const ws = ctx.workspace;
  const stateBefore = await readIfExists(join(ws, STATE_PATH));
  let state = parseState(stateBefore);
  for (const [name, entries] of Object.entries(state.packages)) {
    const pkg = ctx.config.packages.find((p) => p.name === name);
    if (!pkg) continue;
    for (const e of entries.filter((x) => x.status === "publishing")) {
      try {
        const r = await gh.getRelease(pkg.repo, e.releaseId);
        if (r.draft) continue;
        const sums = r.assets.find((a) => a.name === "checksums.txt");
        if (sums && sha256(await gh.downloadAsset(pkg.repo, sums.id)) === e.checksums) state = upsert(state, name, { ...e, status: "published" });
        else record({ item: `${name} ${e.tag}`, result: "skipped", detail: "published, but checksums.txt differs from what tapster recorded; not rendered" });
      } catch (err) {
        failure(`${name} ${e.tag}`, err);
      }
    }
  }
  const changes: { path: string; content: string }[] = [];
  const rendered: string[] = [];
  const online = new Map<string, boolean>();
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest || parseTag(latest.tag) === null) continue;
    try {
      const r = await gh.getRelease(pkg.repo, latest.releaseId);
      const sums = r.assets.find((a) => a.name === "checksums.txt");
      if (!sums) throw new TapsterError(`${latest.tag} has no checksums.txt`, "Check the release.");
      const data = await gh.downloadAsset(pkg.repo, sums.id);
      if (sha256(data) !== latest.checksums) throw new TapsterError(`${latest.tag}: checksums.txt changed after tapster published it`, "tapster renders only what it published; check the release.");
      const repo = await gh.getRepo(pkg.repo);
      online.set(pkg.name, !repo.private);
      const input = {
        pkg,
        version: versionOf(latest.tag),
        downloads: buildDownloads(pkg, latest.tag, parseChecksums(data.toString("utf8"))),
        description: pkg.description ?? repo.description ?? pkg.name,
        homepage: pkg.homepage ?? repo.html_url,
        license: pkg.license ?? null,
      };
      const cask = renderCask(input);
      if ((await readIfExists(join(ws, caskPath(pkg.name)))) !== cask) changes.push({ path: caskPath(pkg.name), content: cask });
      const scoop = renderScoop(input);
      if (scoop && (await readIfExists(join(ws, scoopPath(pkg.name)))) !== scoop) changes.push({ path: scoopPath(pkg.name), content: scoop });
      rendered.push(`${pkg.name} ${latest.tag}`);
    } catch (e) {
      failure(pkg.name, e);
    }
  }
  const stateText = serializeState(state);
  const stateChanged = stateText !== (stateBefore ?? serializeState(parseState(null)));
  const heartbeat = changes.length === 0 && !stateChanged && (await headIsStale(ws));
  if (changes.length === 0 && !stateChanged && !heartbeat) return;
  for (const c of changes) {
    await mkdir(dirname(join(ws, c.path)), { recursive: true });
    await writeFile(join(ws, c.path), c.content);
  }
  const casks = changes.filter((c) => c.path.startsWith("Casks/")).map((c) => basename(c.path, ".rb"));
  await audit(ws, ctx.config.tap, casks.map((name) => ({ name, online: online.get(name) ?? true })));
  const all = [
    ...changes,
    ...(stateChanged ? [{ path: STATE_PATH, content: stateText }] : []),
    ...(heartbeat ? [{ path: ".tapster/heartbeat", content: `${new Date().toISOString().slice(0, 10)}\n` }] : []),
  ];
  const message = changes.length
    ? rendered.filter((r) => changes.some((c) => c.path.includes(`/${r.split(" ")[0]}.`))).join(", ")
    : heartbeat
      ? "Keep the tapster schedule active"
      : "Record published releases";
  await commitToHub(gh, ctx.hub, message, async () => all);
  for (const c of changes) record({ item: c.path, result: "rendered", detail: "" });
}
