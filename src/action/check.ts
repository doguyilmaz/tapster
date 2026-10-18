import * as core from "@actions/core";
import { parseChecksums } from "../checksums";
import { GitHub } from "../github";
import { readSecret, requireVar } from "../mask";
import { type WorkItem, planPackage } from "../plan";
import { failure, record } from "../report";
import { type InstallationToken, installationToken } from "../token";
import type { Context } from "./context";
import { renderNeeded } from "./render";

export async function check(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const only = core.getInput("package");
  const items: WorkItem[] = [];
  for (const pkg of ctx.config.packages) {
    if (only && pkg.name !== only) continue;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const plan = await planPackage(pkg, await gh.listReleases(pkg.repo), async (r) => {
        const asset = r.assets.find((a) => a.name === "checksums.txt");
        return asset ? parseChecksums((await gh.downloadAsset(pkg.repo, asset.id)).toString("utf8")) : null;
      });
      items.push(...plan.items);
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
