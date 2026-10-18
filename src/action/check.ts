import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingAttestations } from "../attest";
import { parseChecksums } from "../checksums";
import { GitHub } from "../github";
import { readSecret, requireVar } from "../mask";
import { type WorkItem, planPackage } from "../plan";
import { failure, record } from "../report";
import { TapsterError } from "../errors";
import { STATE_PATH, parseState, recordedChecksums } from "../state";
import { type InstallationToken, installationExists, installationToken } from "../token";
import type { Context } from "./context";
import { renderNeeded } from "./render";

export async function check(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const only = core.getInput("package");
  const items: WorkItem[] = [];
  const state = parseState(await readFile(join(ctx.workspace, STATE_PATH), "utf8").catch(() => null));
  if (await installationExists(appId, pem, ctx.hub)) {
    failure(ctx.hub, new TapsterError("the App is installed on the hub", "Remove the hub from the App's repositories; the App only needs the projects."));
  }
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
      const repo = pkg.attestation === "auto" ? await gh.getRepo(pkg.repo) : null;
      for (const item of plan.items) {
        const release = repo && !repo.private && !item.resume ? await gh.getRelease(pkg.repo, item.releaseId) : null;
        const missing = release ? await missingAttestations(pkg.repo, release.assets, tok.token) : [];
        if (missing.length) record({ item: pkg.name, result: "waiting", detail: `${item.tag}: no attestation yet for ${missing.join(", ")}` });
        else items.push(item);
      }
      for (const note of plan.notes) record({ item: pkg.name, result: "waiting", detail: note });
    } catch (e) {
      failure(pkg.name, e);
    } finally {
      await tok?.revoke();
    }
  }
  core.setOutput("work", JSON.stringify(items));
  core.setOutput("render", String(items.length > 0 || (await renderNeeded(ctx))));
}
