import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type DmgLayout, dsStore } from "./dsstore";
import { TapsterError } from "./errors";
import type { Keychain } from "./keychain";
import { type NotaryKey, notarize } from "./sign";
import { run } from "./run";

const temp = () => mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "dmg-"));

async function hdiutil(args: string[], tries = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await run("hdiutil", args, { allowFail: true });
    if (res.code === 0) return;
    if (attempt >= tries) throw new TapsterError(`hdiutil ${args[0]} failed`, "Re-run the workflow; hdiutil fails now and then on hosted runners.");
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function attached<T>(image: string, readonly: boolean, work: (mount: string) => Promise<T>): Promise<T> {
  const mount = await temp();
  await hdiutil(["attach", image, ...(readonly ? ["-readonly"] : []), "-nobrowse", "-noautoopen", "-mountpoint", mount]);
  try {
    return await work(mount);
  } finally {
    await hdiutil(["detach", mount, "-force"]);
    await rm(mount, { recursive: true, force: true });
  }
}

export type DmgOptions = { volume: string; volumeIcon: string | null; layout: DmgLayout | null };

export async function buildDmg(appDir: string, out: string, opts: DmgOptions): Promise<void> {
  const stage = await temp();
  const scratch = await temp();
  try {
    const app = basename(appDir);
    await run("ditto", [appDir, join(stage, app)]);
    await symlink("/Applications", join(stage, "Applications"));
    await writeFile(join(stage, ".metadata_never_index"), "");
    if (opts.volumeIcon) await copyFile(join(appDir, opts.volumeIcon), join(stage, ".VolumeIcon.icns"));
    if (opts.layout) await writeFile(join(stage, ".DS_Store"), dsStore(opts.layout, app));
    const rw = join(scratch, "rw.dmg");
    await hdiutil(["create", "-srcfolder", stage, "-volname", opts.volume, "-fs", "HFS+", "-format", "UDRW", "-ov", rw]);
    if (opts.volumeIcon) {
      await attached(rw, false, (mount) => run("xattr", ["-wx", "com.apple.FinderInfo", `0000000000000000040000000000000000000000000000000000000000000000`, mount]));
    }
    await hdiutil(["convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-ov", "-o", out]);
    await attached(out, true, (mount) => run("codesign", ["--verify", "--deep", "--strict", join(mount, app)]));
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function sealDmg(kc: Keychain, dmg: string, key: NotaryKey): Promise<void> {
  await run("codesign", ["--force", "--timestamp", "--keychain", kc.path, "--sign", kc.identity, dmg]);
  await notarize(dmg, key);
  await run("xcrun", ["stapler", "staple", dmg]);
  await run("xcrun", ["stapler", "validate", dmg]);
  const assessed = await run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmg], { allowFail: true });
  if (assessed.code !== 0 || !assessed.stderr.includes("Notarized Developer ID")) {
    throw new TapsterError(`${basename(dmg)} is not accepted by Gatekeeper after notarization`, "Check the notarization log in App Store Connect.");
  }
}
