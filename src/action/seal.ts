import { sealDmg } from "../dmg";
import { failure, info } from "../report";
import { loadManifest, saveManifest } from "../workdir";
import { withApple } from "./apple";
import type { Context } from "./context";
import { appItems } from "./package";

export async function sealMode(ctx: Context): Promise<void> {
  const manifest = await loadManifest();
  const todo = appItems(ctx, manifest.items, "packaged", "sealed");
  if (todo.length > 0) {
    await withApple(async (kc, notary) => {
      for (const { item } of todo) {
        try {
          await sealDmg(kc, item.app!.dmg!, notary);
          item.status = "sealed";
          info(`${item.package} ${item.tag}: the DMG is signed, notarized and stapled`);
        } catch (e) {
          item.status = "failed";
          failure(`${item.package} ${item.tag}`, e);
        }
      }
    });
  }
  await saveManifest(manifest);
}
