import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ChecksumLine, parseChecksums, sha256 } from "../checksums";
import { type CliPackage, type Platform, isApp, parseTag, versionOf } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { GitHub, type Release } from "../github";
import { commitToHub } from "../hubcommit";
import { readSecret } from "../mask";
import { type Download, caskPath, descProblems, downloadUrl, renderCask, renderScoop, scoopPath } from "../render";
import { failure, record } from "../report";
import { childEnv, excerpt, run, runPath } from "../run";
import { STATE_PATH, latestPublished, parseState, serializeState, upsert } from "../state";
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
    const cask = await readIfExists(join(ctx.workspace, caskPath(pkg.name)));
    if (!cask?.includes(`  version "${versionOf(latest.tag)}"\n`)) return true;
  }
  return false;
}

export async function auditEach(names: string[], check: (name: string) => Promise<void>): Promise<Map<string, unknown>> {
  const failed = new Map<string, unknown>();
  for (const name of names) {
    try {
      await check(name);
    } catch (e) {
      failed.set(name, e);
    }
  }
  return failed;
}

async function brewCheck(brew: string, env: Record<string, string>, args: string[]): Promise<void> {
  const res = await runPath(brew, "brew", args, { env, allowFail: true });
  if (res.code !== 0) throw new TapsterError(`brew ${args[0]} found problems`, excerpt(`${res.stdout}\n${res.stderr}`, 8) || "No output.");
}

const AUDIT_TARGETS: Record<string, string[]> = {
  "darwin-arm64": ["--arch", "arm"],
  "darwin-amd64": ["--arch", "intel"],
  "darwin-universal": [],
  "linux-arm64": ["--os", "linux", "--arch", "arm"],
  "linux-amd64": ["--os", "linux", "--arch", "intel"],
};

export function auditArgs(local: string, name: string, online: boolean, platforms: string[]): string[][] {
  const base = ["audit", "--cask", ...(online ? ["--online"] : [])];
  return platforms.filter((p) => p in AUDIT_TARGETS).map((p) => [...base, ...AUDIT_TARGETS[p]!, `${local}/${name}`]);
}

async function audit(ws: string, tap: string, casks: { name: string; online: boolean; platforms: string[] }[]): Promise<Map<string, unknown>> {
  if (casks.length === 0) return new Map();
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => existsSync(p));
  if (!brew) throw new TapsterError("Homebrew is not installed on this runner", "Run the render job on macos-15.");
  const env = childEnv({ PATH: `${dirname(brew)}:/usr/bin:/bin`, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" });
  const local = `${tap.split("/")[0]}/tapster-audit`;
  await run("git", ["-C", ws, "add", "-A"]);
  await run("git", ["-C", ws, "-c", "user.name=tapster", "-c", "user.email=tapster@localhost", "commit", "-q", "--allow-empty", "-m", "tapster audit"]);
  await runPath(brew, "brew", ["tap", local, ws], { env });
  try {
    const byName = new Map(casks.map((c) => [c.name, c]));
    return await auditEach(
      casks.map((c) => c.name),
      async (name) => {
        const c = byName.get(name)!;
        await brewCheck(brew, env, ["style", "--cask", `${local}/${name}`]);
        for (const args of auditArgs(local, name, c.online, c.platforms)) await brewCheck(brew, env, args);
      },
    );
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
  const online = new Map<string, boolean>();
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest || parseTag(latest.tag) === null) continue;
    if (isApp(pkg)) continue;
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
      online.set(pkg.name, !repo.private);
      const input = {
        pkg,
        version: versionOf(latest.tag),
        downloads: buildDownloads(pkg, latest.tag, parseChecksums(data.toString("utf8"))),
        description: pkg.description ?? repo.description ?? pkg.name,
        homepage: pkg.homepage ?? repo.html_url,
        license: pkg.license ?? null,
      };
      const problems = descProblems(input.description, pkg.name);
      if (problems.length) throw new TapsterError(`Homebrew rejects the description of ${pkg.repo} because ${problems.join(" and ")}`, "Set description in tapster.yml.");
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
  const failed = await audit(
    ws,
    ctx.config.tap,
    casks.map((name) => ({ name, online: online.get(name) ?? true, platforms: Object.keys(ctx.config.packages.find((p) => p.name === name)?.assets ?? {}) })),
  );
  for (const [name, err] of failed) failure(name, err);
  const kept = changes.filter((c) => !failed.has(basename(c.path).replace(/\.(rb|json)$/, "")));
  changes.length = 0;
  changes.push(...kept);
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
