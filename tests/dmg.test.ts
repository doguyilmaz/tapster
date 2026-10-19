import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDmg } from "../src/dmg";
import { buildFakeApp } from "./helpers/fakeapp";

test.skipIf(process.platform !== "darwin")("the DMG holds the app, the link, the layout and the volume icon", async () => {
  const app = buildFakeApp();
  writeFileSync(join(app, "Contents/Resources/AppIcon.icns"), "icns");
  Bun.spawnSync(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", app]);
  const out = join(mkdtempSync(join(tmpdir(), "dmg-")), "T-1.0.0.dmg");
  await buildDmg(app, out, {
    volume: "T",
    volumeIcon: "Contents/Resources/AppIcon.icns",
    layout: { window: [200, 120, 780, 500], icon_size: 110, app: [150, 170], applications: [430, 170] },
  });
  expect(Bun.spawnSync(["/usr/bin/hdiutil", "imageinfo", out]).stdout.toString()).toContain("UDZO");
  const mount = mkdtempSync(join(tmpdir(), "mnt-"));
  expect(Bun.spawnSync(["/usr/bin/hdiutil", "attach", out, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount]).exitCode).toBe(0);
  try {
    expect(existsSync(join(mount, "T.app/Contents/MacOS/T"))).toBe(true);
    expect(lstatSync(join(mount, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
    for (const f of [".metadata_never_index", ".DS_Store", ".VolumeIcon.icns"]) expect(existsSync(join(mount, f)), f).toBe(true);
    const info = Bun.spawnSync(["/usr/bin/xattr", "-px", "com.apple.FinderInfo", mount]).stdout.toString().replace(/\s/g, "");
    expect(info.slice(16, 18)).toBe("04");
    expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", join(mount, "T.app")]).exitCode).toBe(0);
  } finally {
    Bun.spawnSync(["/usr/bin/hdiutil", "detach", mount, "-quiet"]);
  }
}, 120_000);
