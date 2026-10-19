import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingAttestations } from "../attest";
import { parseChecksums } from "../checksums";
import { type AppPackage, type HubConfig, type InvalidPackage, type PackageConfig, isApp } from "../config";
import { GitHub, type Release } from "../github";
import { readSecret, requireVar } from "../mask";
import { type WorkItem, planPackage } from "../plan";
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

export function reportInvalid(invalid: InvalidPackage[], only: string): void {
  for (const i of invalid) if (!only || i.name === only) failure(i.name, new TapsterError(i.reason, i.fix));
}

export async function protectionGate(gh: GitHub, pkg: Pick<PackageConfig, "name" | "repo" | "protection">, branch: string): Promise<void> {
  if (pkg.protection === "off") {
    warn(`${pkg.name}: protection is off, so a stolen App key could tag code in ${pkg.repo} that the hub would sign`);
    return;
  }
  const problems = await protectionProblems(gh, pkg.repo, branch, "app");
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
  const cmp = await gh.json<{ status: string; files?: { filename: string }[] }>("GET", `/repos/${hub}/compare/${last.after}...main`);
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
      const plan = await planPackage(pkg, await gh.listReleases(pkg.repo), {
        checksumsOf: async (r) => {
          const asset = r.assets.find((a) => a.name === "checksums.txt");
          return asset ? parseChecksums((await gh.downloadAsset(pkg.repo, asset.id)).toString("utf8")) : null;
        },
        recorded: (releaseId) => recordedChecksums(state, pkg.name, releaseId),
        owner: ctx.owner,
        tagExists: (tag) => tagExists(gh, pkg.repo, tag),
      });
      if (repo.private) privateRepos.add(pkg.name);
      for (const item of plan.items) {
        const release = pkg.attestation === "auto" && !repo.private && !item.resume ? await gh.getRelease(pkg.repo, item.releaseId) : null;
        const attested = release?.assets.filter((a) => !(isApp(pkg) && Object.hasOwn(pkg.carry, a.name))) ?? [];
        const missing = release ? await missingAttestations(pkg.repo, attested, tok.token) : [];
        if (missing.length) record({ item: pkg.name, result: "waiting", detail: `${item.tag}: no attestation yet for ${missing.join(", ")}` });
        else items.push(item);
      }
      for (const note of plan.notes) record({ item: pkg.name, result: "waiting", detail: note });
      const feed = isApp(pkg) ? feedWarning(await latestRelease(gh, pkg.repo), state, pkg) : null;
      if (feed) warn(feed);
    } catch (e) {
      failure(pkg.name, e);
    } finally {
      await tok?.revoke();
    }
  }
  if (items.length > 50) record({ item: "hub", result: "waiting", detail: `${items.length - 50} more drafts wait for the next run` });
  core.setOutput("work", JSON.stringify(items.slice(0, 50)));
  core.setOutput("render", String(items.length > 0 || (await renderNeeded(ctx, privateRepos))));
  core.setOutput("linux", String(linuxNeeded(ctx.config, items.slice(0, 50), core.getInput("linux") === "true")));
}
