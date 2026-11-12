import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { signApp, stapleApp, toolBundle, verifyApp } from "../appsign";
import { type CliPackage, isApp } from "../config";
import type { Keychain } from "../keychain";
import { failure, info, warn } from "../report";
import { run } from "../run";
import { type NotaryKey, PRESETS, entitlementsPlist, notarize, signFile, verifySigned, zipForNotary } from "../sign";
import { type Fetched, loadManifest, saveManifest, workdir } from "../workdir";
import { type OpenKeychain, withApple } from "./apple";
import type { Context } from "./context";

export const toolSteps = {
  signFile,
  verifySigned,
  signApp,
  verifyApp,
  copy: async (from: string, to: string) => {
    await run("ditto", [from, to]);
  },
  zipForNotary,
  notarize,
  stapleApp,
};

export async function signTool(kc: Keychain, notary: NotaryKey, team: string, pkg: CliPackage, item: Fetched, steps = toolSteps): Promise<void> {
  const keys = [...new Set([...PRESETS[pkg.kind], ...pkg.entitlements])];
  const ent = keys.length ? join(workdir(), `${pkg.name}.entitlements.plist`) : null;
  if (ent) await writeFile(ent, entitlementsPlist(keys));
  for (const a of item.archives) {
    for (const b of a.binaries) {
      await steps.signFile(kc, join(a.dir, b), ent, basename(b));
      await steps.verifySigned(join(a.dir, b), team, basename(b));
    }
    if (!a.app || !pkg.app) continue;
    const signed = await steps.signApp(kc, join(a.dir, a.app), toolBundle(pkg.app), team);
    await steps.verifyApp(join(a.dir, a.app), signed, team);
    for (const d of signed.dropped) warn(`${item.package} ${item.tag}: the entitlement ${d} of ${a.app} is not in app.entitlements, so it was not signed`);
  }
  const root = join(workdir(), pkg.name, item.tag, "notary");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const a of item.archives) await steps.copy(a.dir, join(root, a.asset));
  await steps.zipForNotary(root, `${root}.zip`);
  await steps.notarize(`${root}.zip`, notary);
  for (const a of item.archives) if (a.app) await steps.stapleApp(join(a.dir, a.app));
}

export const appSteps = { signApp, verifyApp };

export type SignDeps = { open?: OpenKeychain; tools?: typeof toolSteps; apps?: typeof appSteps };

export async function signMode(ctx: Context, deps: SignDeps = {}): Promise<void> {
  const manifest = await loadManifest();
  for (const i of manifest.items) if (i.status === "fetched" && (i.resume || (!i.app && i.archives.length === 0))) i.status = "signed";
  const todo = manifest.items.filter((i) => i.status === "fetched");
  const pkgOf = (item: Fetched) => ctx.config.packages.find((p) => p.name === item.package);
  const apps = deps.apps ?? appSteps;
  const failed = (item: Fetched, e: unknown) => {
    item.status = "failed";
    failure(`${item.package} ${item.tag}`, e);
  };
  await withApple(
    todo,
    (item) => pkgOf(item)?.certificate ?? null,
    failed,
    async ({ kc, notary, team }, item) => {
      const pkg = pkgOf(item)!;
      if (isApp(pkg)) {
        const signed = await apps.signApp(kc, item.app!.dir, pkg, team);
        await apps.verifyApp(item.app!.dir, signed, team);
        item.app!.identifiers = signed.identifiers;
        for (const d of signed.dropped) warn(`${item.package} ${item.tag}: the entitlement ${d} is not in code, so it was not signed`);
        item.status = "signed";
        info(`${item.package} ${item.tag}: signed ${signed.items.length} pieces of code`);
        return;
      }
      await signTool(kc, notary, team, pkg, item, deps.tools);
      item.status = "signed";
      info(`${item.package} ${item.tag}: signed and notarized`);
    },
    deps.open,
  );
  await saveManifest(manifest);
}
