import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const plist = (id: string, exe: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${exe}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`;

function sh(args: string[], cwd?: string) {
  const r = Bun.spawnSync(args, { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args[0]} failed: ${r.stderr.toString()}`);
}

export function buildFakeApp(): string {
  const root = mkdtempSync(join(tmpdir(), "fakeapp-"));
  const src = join(root, "m.c");
  writeFileSync(src, "int main(void){return 0;}\n");
  writeFileSync(join(root, "lib.c"), "int f(void){return 1;}\n");
  const app = join(root, "T.app");
  const put = (path: string, data: string) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), data);
  };
  const cc = (out: string, extra: string[] = []) => {
    mkdirSync(dirname(join(app, out)), { recursive: true });
    sh(["/usr/bin/clang", "-o", join(app, out), ...extra]);
  };
  put("Contents/Info.plist", plist("com.t.T", "T"));
  cc("Contents/MacOS/T", [src]);
  writeFileSync(join(root, "helper.plist"), plist("com.t.T.Helper", "Helper"));
  cc("Contents/MacOS/Helper", [src, "-sectcreate", "__TEXT", "__info_plist", join(root, "helper.plist")]);
  cc("Contents/Frameworks/libz.dylib", ["-dynamiclib", join(root, "lib.c")]);
  cc("Contents/Resources/bin/tool", [src]);
  const fw = "Contents/Frameworks/F.framework";
  put(`${fw}/Versions/A/Resources/Info.plist`, plist("com.t.T.F", "F"));
  cc(`${fw}/Versions/A/F`, ["-dynamiclib", join(root, "lib.c")]);
  put(`${fw}/Versions/A/XPCServices/X.xpc/Contents/Info.plist`, plist("com.t.T.X", "X"));
  cc(`${fw}/Versions/A/XPCServices/X.xpc/Contents/MacOS/X`, [src]);
  symlinkSync("A", join(app, fw, "Versions/Current"));
  symlinkSync("Versions/Current/F", join(app, fw, "F"));
  symlinkSync("Versions/Current/Resources", join(app, fw, "Resources"));
  for (const p of ["Contents/MacOS/T", "Contents/MacOS/Helper", "Contents/Resources/bin/tool"]) chmodSync(join(app, p), 0o755);
  sh(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", app]);
  return app;
}
