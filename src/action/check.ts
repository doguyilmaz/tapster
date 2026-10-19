import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingAttestations } from "../attest";
import { parseChecksums } from "../checksums";
import { type AppPackage, type HubConfig, type InvalidPackage, isApp } from "../config";
import { GitHub, type Release } from "../github";
import { readSecret, requireVar } from "../mask";
import { type WorkItem, planPackage } from "../plan";
import { failure, record, warn } from "../report";
import { GitHubError, TapsterError } from "../errors";
import { STATE_PATH, type State, parseState, recordedChecksums } from "../state";
import { type InstallationToken, installationExists, installationToken } from "../token";
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
  if (await installationExists(appId, pem, ctx.hub)) {
    failure(ctx.hub, new TapsterError("the App is installed on the hub", "Remove the hub from the App's repositories; the App only needs the projects."));
  }
  reportInvalid(ctx.invalid, only);
  for (const pkg of ctx.config.packages) {
    if (only && pkg.name !== only) continue;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const plan = await planPackage(
        pkg,
        await gh.listReleases(pkg.repo),
        async (r) => {
          const asset = r.assets.find((a) => a.name === "checksums.txt");
          return asset ? parseChecksums((await gh.downloadAsset(pkg.repo, asset.id)).toString("utf8")) : null;
        },
        (releaseId) => recordedChecksums(state, pkg.name, releaseId),
      );
      const repo = await gh.getRepo(pkg.repo);
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
