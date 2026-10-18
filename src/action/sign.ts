import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openKeychain } from "../keychain";
import { readSecret, register, requireVar } from "../mask";
import { failure, info } from "../report";
import { PRESETS, entitlementsPlist, notarize, signFile, verifySigned, zipForNotary } from "../sign";
import { loadManifest, saveManifest, workdir } from "../workdir";
import type { Context } from "./context";

export async function signMode(ctx: Context): Promise<void> {
  const manifest = await loadManifest();
  for (const i of manifest.items) if (i.status === "fetched" && (i.resume || i.archives.length === 0)) i.status = "signed";
  const todo = manifest.items.filter((i) => i.status === "fetched");
  if (todo.length > 0) {
    const p12 = readSecret("MACOS_SIGN_P12");
    const password = readSecret("MACOS_SIGN_PASSWORD");
    const rawKey = readSecret("MACOS_NOTARY_KEY");
    const keyId = readSecret("MACOS_NOTARY_KEY_ID");
    const issuer = readSecret("MACOS_NOTARY_ISSUER_ID");
    const team = requireVar("TAPSTER_TEAM_ID");
    const p8 = rawKey.includes("BEGIN PRIVATE KEY") ? rawKey : Buffer.from(rawKey, "base64").toString("utf8");
    register(p8);
    const kc = await openKeychain(p12, password, team, workdir());
    const p8Path = join(workdir(), "notary.p8");
    await writeFile(p8Path, p8, { mode: 0o600 });
    try {
      for (const item of todo) {
        try {
          const pkg = ctx.config.packages.find((p) => p.name === item.package)!;
          const keys = [...new Set([...PRESETS[pkg.kind], ...pkg.entitlements])];
          const ent = keys.length ? join(workdir(), `${pkg.name}.entitlements.plist`) : null;
          if (ent) await writeFile(ent, entitlementsPlist(keys));
          for (const a of item.archives) {
            for (const b of a.binaries) {
              await signFile(kc, join(a.dir, b), ent, basename(b));
              await verifySigned(join(a.dir, b), team, basename(b));
            }
          }
          const root = join(workdir(), pkg.name, item.tag, "notary");
          await mkdir(root, { recursive: true, mode: 0o700 });
          for (const a of item.archives) await cp(a.dir, join(root, a.asset), { recursive: true });
          await zipForNotary(root, `${root}.zip`);
          await notarize(`${root}.zip`, { p8Path, keyId, issuer });
          item.status = "signed";
          info(`${item.package} ${item.tag}: signed and notarized`);
        } catch (e) {
          item.status = "failed";
          failure(`${item.package} ${item.tag}`, e);
        }
      }
    } finally {
      await rm(p8Path, { force: true });
      await kc.close();
    }
  }
  await saveManifest(manifest);
}
