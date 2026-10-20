import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChecksumLine, parseChecksums, sha256 } from "../checksums";
import { dmgName } from "../appcheck";
import { type AppPackage, type CliPackage, type Platform, isApp, parseTag, versionOf } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { GitHub, type Release } from "../github";
import { commitToHub } from "../hubcommit";
import { readSecret } from "../mask";
import { type AppRenderInput, type Download, caskPath, descProblems, downloadUrl, hasCask, renderAppCask, renderCask, renderScoop, scoopPath } from "../render";
import { failure, record } from "../report";
import { run } from "../run";
import { STATE_PATH, type StateEntry, latestPublished, parseState, serializeState, upsert } from "../state";
import type { Context } from "./context";

const readIfExists = (path: string) => readFile(path, "utf8").catch(() => null);

async function readable(gh: GitHub, repo: string, id: number): Promise<Release | null> {
  try {
    return await gh.getRelease(repo, id);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export function buildDownloads(pkg: CliPackage, tag: string, lines: ChecksumLine[]): Download[] {
  const version = versionOf(tag);
  return (Object.entries(pkg.assets) as [Platform, string][]).map(([platform, template]) => {
    const name = template.replaceAll("{version}", version);
    const line = lines.find((l) => l.name === name);
    if (!line) throw new TapsterError(`${name} is not in the published checksums.txt`, "Check assets in tapster.yml.");
    return { platform, url: downloadUrl(pkg.repo, tag, name), sha256: line.sha256 };
  });
}

export function appCaskInput(pkg: AppPackage, entry: StateEntry, lines: ChecksumLine[], text: { description: string; homepage: string }): AppRenderInput {
  if (!entry.app) throw new TapsterError(`${entry.tag} has no app facts in the state`, "Publish the next release with this tapster version.");
  const version = versionOf(entry.tag);
  const line = lines.find((l) => l.name === dmgName(pkg, version));
  if (!line) throw new TapsterError(`${dmgName(pkg, version)} is not in the published checksums.txt`, "Check dmg.name in tapster.yml.");
  return { pkg, version, sha256: line.sha256, macos: entry.app.macos, ...text };
}

export async function headIsStale(ws: string): Promise<boolean> {
  const out = await run("git", ["-C", ws, "log", "-1", "--format=%ct"]).catch(() => ({ stdout: "0" }));
  const last = Number(out.stdout.trim());
  return last > 0 && Date.now() / 1000 - last > 30 * 86400;
}

export async function renderNeeded(ctx: Context, skip: Set<string> = new Set()): Promise<boolean> {
  if (await headIsStale(ctx.workspace)) return true;
  const state = parseState(await readIfExists(join(ctx.workspace, STATE_PATH)));
  if (Object.entries(state.packages).some(([name, list]) => !skip.has(name) && list.some((e) => e.status === "publishing"))) return true;
  for (const pkg of ctx.config.packages) {
    if (skip.has(pkg.name)) continue;
    const latest = latestPublished(state, pkg.name);
    if (!latest) continue;
    if (!hasCask(pkg)) {
      if (isApp(pkg) || !pkg.scoop) continue;
      const scoop = await readIfExists(join(ctx.workspace, scoopPath(pkg.name)));
      if (!scoop?.includes(`"version": ${JSON.stringify(versionOf(latest.tag))}`)) return true;
      continue;
    }
    const cask = await readIfExists(join(ctx.workspace, caskPath(pkg.name)));
    if (!cask?.includes(`  version "${versionOf(latest.tag)}"\n`)) return true;
  }
  return false;
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
        const r = await readable(gh, pkg.repo, e.releaseId);
        if (!r || r.draft) continue;
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
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest || parseTag(latest.tag) === null) continue;
    try {
      const r = await readable(gh, pkg.repo, latest.releaseId);
      if (!r) {
        record({ item: pkg.name, result: "skipped", detail: `the hub cannot read ${pkg.repo}; casks need public projects` });
        continue;
      }
      const sums = r.assets.find((a) => a.name === "checksums.txt");
      if (!sums) throw new TapsterError(`${latest.tag} has no checksums.txt`, "Check the release.");
      const data = await gh.downloadAsset(pkg.repo, sums.id);
      if (sha256(data) !== latest.checksums) throw new TapsterError(`${latest.tag}: checksums.txt changed after tapster published it`, "tapster renders only what it published; check the release.");
      const repo = await gh.getRepo(pkg.repo);
      const text = { description: pkg.description ?? repo.description ?? pkg.name, homepage: pkg.homepage ?? repo.html_url };
      const problems = descProblems(text.description, pkg.name);
      if (problems.length) throw new TapsterError(`Homebrew rejects the description of ${pkg.repo} because ${problems.join(" and ")}`, "Set description in tapster.yml.");
      const lines = parseChecksums(data.toString("utf8"));
      if (isApp(pkg)) {
        const cask = renderAppCask(appCaskInput(pkg, latest, lines, text));
        if ((await readIfExists(join(ws, caskPath(pkg.name)))) !== cask) changes.push({ path: caskPath(pkg.name), content: cask });
        rendered.push(`${pkg.name} ${latest.tag}`);
        continue;
      }
      const input = { pkg, version: versionOf(latest.tag), downloads: buildDownloads(pkg, latest.tag, lines), ...text, license: pkg.license ?? null };
      const cask = renderCask(input);
      if (cask && (await readIfExists(join(ws, caskPath(pkg.name)))) !== cask) changes.push({ path: caskPath(pkg.name), content: cask });
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
