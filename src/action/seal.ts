import { sealDmg } from "../dmg";
import { failure, info } from "../report";
import { loadManifest, saveManifest } from "../workdir";
import { type OpenKeychain, withApple } from "./apple";
import type { Context } from "./context";
import { appItems } from "./package";

export type SealDeps = { open?: OpenKeychain; seal?: typeof sealDmg };

export async function sealMode(ctx: Context, deps: SealDeps = {}): Promise<void> {
  const manifest = await loadManifest();
  const todo = appItems(ctx, manifest.items, "packaged", "sealed");
  const seal = deps.seal ?? sealDmg;
  const failed = ({ item }: (typeof todo)[number], e: unknown) => {
    item.status = "failed";
    failure(`${item.package} ${item.tag}`, e);
  };
  await withApple(
    todo,
    ({ pkg }) => pkg.certificate ?? null,
    failed,
    async ({ kc, notary }, t) => {
      await seal(kc, t.item.app!.dmg!, notary);
      t.item.status = "sealed";
      info(`${t.item.package} ${t.item.tag}: the DMG is signed, notarized and stapled`);
    },
    deps.open,
  );
  await saveManifest(manifest);
}
