import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingAttestations } from "../attest";
import { parseChecksums } from "../checksums";
import { type AppPackage, type HubConfig, type InvalidPackage, type PackageConfig, isApp, macosCode } from "../config";
import { GitHub, type Release } from "../github";
import { readSecret, requireVar } from "../mask";
import { type Note, type WorkItem, planPackage } from "../plan";
import { noteOutcome, withNote } from "../draftnote";
import { failure, record, warn } from "../report";
import { protectionProblems } from "../rulesets";
import { GitHubError, TapsterError } from "../errors";
import { STATE_PATH, type State, parseState, recordedChecksums } from "../state";
import { type InstallationToken, installationRepos, installationToken } from "../token";
import type { Context } from "./context";
import { renderNeeded } from "./render";

export function linuxNeeded(config: HubConfig, items: WorkItem[], asked: boolean): boolean {
  const linux = new Set(config.packages.filter((p) => !isApp(p) && p.linux).map((p) => p.name));
  return linux.size > 0 && (asked || items.some((i) => linux.has(i.package)));
}

export function feedWarning(latest: Release | null, state: State, pkg: AppPackage): string | null {
  if (!latest || !pkg.sparkle) return null;
  if (state.packages[pkg.name]?.some((e) => e.releaseId === latest.id && e.status === "published")) return null;
  return `${pkg.name}: the latest release ${latest.tag_name} did not come from the hub; installed copies read its ${pkg.sparkle.feed}, so check who published it`;
}


export const needsMacos = (work: WorkItem[], packages: PackageConfig[]) =>
  work.some((i) => !i.resume && packages.some((p) => p.name === i.package && macosCode(p)));

export function appleGate(
  items: WorkItem[],
  packages: PackageConfig[],
  apple: { team: string; expires: string },
  now: number,
): { items: WorkItem[]; failed: { name: string; error: TapsterError }[]; warning: string | null; macos: boolean } {
  const end = apple.expires ? Date.parse(`${apple.expires}T00:00:00Z`) : Number.NaN;
  const out: WorkItem[] = [];
  const failed: { name: string; error: TapsterError }[] = [];
  for (const item of items) {
    const pkg = packages.find((p) => p.name === item.package);
    if (!pkg || item.resume || !macosCode(pkg)) {
      out.push(item);
      continue;
    }
    if (!apple.team) {
      failed.push({ name: pkg.name, error: new TapsterError(`${pkg.name} ships macOS code, but this hub has no Apple credentials`, "Run tapster init --rotate certificate and tapster init --rotate notary in the hub clone.") });
    } else if (end < now) {
      failed.push({ name: pkg.name, error: new TapsterError(`the Developer ID certificate expired on ${apple.expires}`, "Create a new Developer ID Application certificate, then run tapster init --rotate certificate.") });
    } else {
      out.push(item);
    }
  }
  const soon = apple.team && end >= now && end - now < 30 * 86_400_000;
  const warning = soon ? `the Developer ID certificate expires on ${apple.expires}; renew it and run tapster init --rotate certificate` : null;
  return { items: out, failed, warning, macos: needsMacos(out, packages) };
}

export function reportInvalid(invalid: InvalidPackage[], only: string): void {
  for (const i of invalid) if (!only || i.name === only) failure(i.name, new TapsterError(i.reason, i.fix));
}

export async function protectionGate(gh: GitHub, pkg: Pick<PackageConfig, "name" | "repo" | "protection">, branch: string): Promise<void> {
  if (pkg.protection === "off") {
    warn(`${pkg.name}: protection is off, so a stolen App key could tag code in ${pkg.repo} that the hub would sign`);
    return;
  }
  const problems = await protectionProblems(gh, pkg.repo, branch, "app", pkg.protection === "dependabot");
  if (problems.length === 0) return;
  throw new TapsterError(
    `${pkg.repo} is not protected against a stolen App key: ${problems.join("; ")}`,
    `Run tapster add in a clone of ${pkg.repo}. If GitHub cannot enforce rulesets there, make it public, use a paid plan or set protection: off for ${pkg.name} in tapster.yml to accept the risk.`,
  );
}

const BOT_PATHS = /^(\.tapster|Casks|bucket)\//;

export async function foreignWrites(gh: GitHub, hub: string, owner: string): Promise<string[]> {
  const ref = encodeURIComponent("refs/heads/main");
  const [last] = await gh.json<{ after: string }[]>("GET", `/repos/${hub}/activity?ref=${ref}&actor=${owner}&per_page=1`);
  if (!last) return [`GitHub shows no push by ${owner} to main`];
  const at = last.after.slice(0, 7);
  const head = (await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`)).object.sha;
  const cmp = await gh.json<{ status: string; files?: { filename: string }[] }>("GET", `/repos/${hub}/compare/${last.after}...${head}`);
  if (cmp.status === "identical") return [];
  if (cmp.status !== "ahead") return [`main no longer contains your last push (${at})`];
  const files = cmp.files ?? [];
  if (files.length >= 300) return [`more files changed after your last push (${at}) than GitHub lists`];
  return files.filter((f) => !BOT_PATHS.test(f.filename)).map((f) => `${f.filename} changed after your last push (${at})`);
}

export function installationProblems(repos: string[] | null, hub: string, listed: string[]): { fatal: string | null; extra: string[] } {
  if (repos === null) return { fatal: "the App is not installed on any of your repositories", extra: [] };
  const known = new Set(listed.map((r) => r.toLowerCase()));
  if (repos.some((r) => r.toLowerCase() === hub.toLowerCase())) return { fatal: "the App is installed on the hub", extra: [] };
  return { fatal: null, extra: repos.filter((r) => !known.has(r.toLowerCase())) };
}

async function hubGate(ctx: Context, appId: string, pem: string): Promise<void> {
  const writes = await foreignWrites(new GitHub(readSecret("GITHUB_TOKEN")), ctx.hub, ctx.owner);
  if (writes.length) {
    throw new TapsterError(
      `the hub changed in ways only you may change it: ${writes.join("; ")}`,
      "Review the commits on main since your last push, revert what you did not make and push; a push from you marks main as reviewed. If you did not expect them, rotate the App key with tapster init --rotate app.",
    );
  }
  const listed = [...ctx.config.packages.map((p) => p.repo), ...ctx.invalid.flatMap((i) => (i.repo ? [i.repo] : []))];
  const inst = installationProblems(await installationRepos(appId, pem, ctx.owner), ctx.hub, listed);
  if (inst.fatal) throw new TapsterError(inst.fatal, "The App must be installed on the projects only, never on the hub: https://github.com/settings/installations");
  if (inst.extra.length) warn(`the App can also write to ${inst.extra.join(", ")}, which tapster.yml does not list; remove them at https://github.com/settings/installations`);
}

export async function writeNote(gh: GitHub, repo: string, release: Release, body: string): Promise<void> {
  if (body === (release.body ?? "")) return;
  await gh.json("PATCH", `/repos/${repo}/releases/${release.id}`, { body, tag_name: release.tag_name });
}

async function tagExists(gh: GitHub, repo: string, tag: string): Promise<boolean> {
  try {
    await gh.json("GET", `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

async function latestRelease(gh: GitHub, repo: string): Promise<Release | null> {
  try {
    return await gh.json<Release>("GET", `/repos/${repo}/releases/latest`);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export async function check(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const only = core.getInput("package");
  const items: WorkItem[] = [];
  const privateRepos = new Set<string>();
  const state = parseState(await readFile(join(ctx.workspace, STATE_PATH), "utf8").catch(() => null));
  await hubGate(ctx, appId, pem);
  reportInvalid(ctx.invalid, only);
  for (const pkg of ctx.config.packages) {
    if (only && pkg.name !== only) continue;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const repo = await gh.getRepo(pkg.repo);
      await protectionGate(gh, pkg, repo.default_branch);
      const releases = await gh.listReleases(pkg.repo);
      const plan = await planPackage(pkg, releases, {
        checksumsOf: async (r) => {
          const asset = r.assets.find((a) => a.name === "checksums.txt");
          return asset ? parseChecksums((await gh.downloadAsset(pkg.repo, asset.id)).toString("utf8")) : null;
        },
        recorded: (releaseId) => recordedChecksums(state, pkg.name, releaseId),
        owner: ctx.owner,
        tagExists: (tag) => tagExists(gh, pkg.repo, tag),
      });
      if (repo.private) privateRepos.add(pkg.name);
      const notes: Note[] = [...plan.notes];
      for (const item of plan.items) {
        const release = releases.find((r) => r.id === item.releaseId)!;
        const judged = pkg.attestation === "auto" && !repo.private && !item.resume;
        const attested = judged ? release.assets.filter((a) => !(isApp(pkg) && Object.hasOwn(pkg.carry, a.name))) : [];
        const missing = judged ? await missingAttestations(pkg.repo, attested, tok.token) : [];
        if (missing.length) {
          notes.push({ tag: item.tag, releaseId: item.releaseId, kind: "waiting", reason: `no attestation yet for ${missing.join(", ")}`, since: release.created_at });
          continue;
        }
        items.push(item);
        if (!item.resume) await writeNote(gh, pkg.repo, release, withNote(release.body, null));
      }
      for (const n of notes) {
        const release = releases.find((r) => r.id === n.releaseId);
        const out = noteOutcome(n, release?.body, Date.now());
        if (release && out.body !== null) await writeNote(gh, pkg.repo, release, out.body);
        if (out.result === "failed") failure(pkg.name, new TapsterError(`${n.tag}: ${out.reason}`, "The hub wrote this on the draft too; fix the draft or delete it."));
        else record({ item: pkg.name, result: out.result === "known" ? "skipped" : "waiting", detail: `${n.tag}: ${out.reason}${out.result === "known" ? " (reported on the draft)" : ""}` });
      }
      const feed = isApp(pkg) ? feedWarning(await latestRelease(gh, pkg.repo), state, pkg) : null;
      if (feed) warn(feed);
    } catch (e) {
      failure(pkg.name, e);
    } finally {
      await tok?.revoke();
    }
  }
  const gate = appleGate(items, ctx.config.packages, { team: process.env.TAPSTER_TEAM_ID ?? "", expires: process.env.TAPSTER_CERT_EXPIRES ?? "" }, Date.now());
  for (const f of gate.failed) failure(f.name, f.error);
  if (gate.warning) warn(gate.warning);
  const work = gate.items.slice(0, 50);
  if (gate.items.length > 50) record({ item: "hub", result: "waiting", detail: `${gate.items.length - 50} more drafts wait for the next run` });
  core.setOutput("work", JSON.stringify(work));
  core.setOutput("macos", String(needsMacos(work, ctx.config.packages)));
  core.setOutput("render", String(work.length > 0 || (await renderNeeded(ctx, privateRepos))));
  core.setOutput("linux", String(linuxNeeded(ctx.config, work, core.getInput("linux") === "true")));
}
