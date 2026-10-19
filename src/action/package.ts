import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dmgName } from "../appcheck";
import { type AppPackage, isApp, versionOf } from "../config";
import { buildDmg } from "../dmg";
import { failure, info } from "../report";
import { type Fetched, loadManifest, saveManifest, workdir } from "../workdir";
import type { Context } from "./context";

export function appItems(ctx: Context, items: Fetched[], from: Fetched["status"], to: Fetched["status"]): { item: Fetched; pkg: AppPackage }[] {
  const todo: { item: Fetched; pkg: AppPackage }[] = [];
  for (const item of items) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package);
    if (item.status !== from || !pkg || !isApp(pkg)) continue;
    if (item.resume) item.status = to;
    else todo.push({ item, pkg });
  }
  return todo;
}

export async function packageMode(ctx: Context): Promise<void> {
  const manifest = await loadManifest();
  for (const { item, pkg } of appItems(ctx, manifest.items, "signed", "packaged")) {
    try {
      const out = join(workdir(), pkg.name, item.tag, "out");
      await mkdir(out, { recursive: true, mode: 0o700 });
      const dmg = join(out, dmgName(pkg, versionOf(item.tag)));
      await buildDmg(item.app!.dir, dmg, { volume: pkg.dmg.volume, volumeIcon: pkg.dmg.volume_icon ?? null, layout: pkg.dmg.layout ?? null });
      item.app!.dmg = dmg;
      item.status = "packaged";
      info(`${item.package} ${item.tag}: built ${dmgName(pkg, versionOf(item.tag))}`);
    } catch (e) {
      item.status = "failed";
      failure(`${item.package} ${item.tag}`, e);
    }
  }
  await saveManifest(manifest);
}
