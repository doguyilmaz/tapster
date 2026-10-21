// Installs tests/golden/aims-app.rb from a local tap and uninstalls it. Usage: install.ts macos | linux
// macos: an ad hoc signed aims.app on this Mac. linux: the bare binary in Homebrew's container.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/checksums";

const target = process.argv[2];
if (target !== "macos" && target !== "linux") throw new Error("usage: install.ts macos | linux");
const IMAGE = "ghcr.io/homebrew/brew:7.0.10";
const VERSION = "0.1.5";
const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "tapster-install-"));
chmodSync(work, 0o755);
const env = { ...process.env, COPYFILE_DISABLE: "1", XDG_CONFIG_HOME: join(work, "config"), HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" };

function sh(args: string[], cwd = work): string {
  const res = Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "inherit" });
  const out = res.stdout.toString();
  process.stdout.write(out);
  if (res.exitCode !== 0) throw new Error(`${args.join(" ")} exited with ${res.exitCode}`);
  return out.trim();
}

const pkg = join(work, "pkg");
mkdirSync(join(pkg, "completions"), { recursive: true });
writeFileSync(join(pkg, "completions/aims.bash"), "complete -W status aims\n");
writeFileSync(join(pkg, "completions/aims.zsh"), "#compdef aims\n");
if (target === "macos") {
  writeFileSync(join(work, "main.c"), '#include <stdio.h>\nint main(void){puts("aims ok");return 0;}\n');
  sh(["/usr/bin/clang", "-o", join(pkg, "aims"), join(work, "main.c")]);
  const app = join(pkg, "aims.app/Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  cpSync(join(pkg, "aims"), join(app, "MacOS/aims"));
  const keys = { CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims", CFBundleName: "aims", CFBundlePackageType: "APPL", CFBundleShortVersionString: VERSION };
  writeFileSync(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(keys).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>\n`);
  sh(["/usr/bin/codesign", "--force", "--sign", "-", join(pkg, "aims")]);
  sh(["/usr/bin/codesign", "--force", "--sign", "-", join(pkg, "aims.app")]);
} else {
  writeFileSync(join(pkg, "aims"), '#!/bin/sh\necho "aims ok"\n', { mode: 0o755 });
}

const os = target === "macos" ? "darwin" : "linux";
const files = join(work, "files");
mkdirSync(files);
const archive = join(files, `aims_${VERSION}_${os}_arm64.tar.gz`);
sh(["tar", "--no-xattrs", "-C", pkg, "-czf", archive, "aims", "completions", ...(target === "macos" ? ["aims.app"] : [])]);
cpSync(archive, join(files, `aims_${VERSION}_${os}_amd64.tar.gz`));
const sum = sha256(readFileSync(archive));
const base = target === "macos" ? files : "/work/files";
let replaced = 0;
const cask = readFileSync(join(import.meta.dir, "../golden/aims-app.rb"), "utf8").replace(
  /sha256 "[0-9a-f]{64}"\n(\s+)url "https:\/\/github\.com\/o\/aims-app\/releases\/download\/v#\{version\}\/(aims_#\{version\}_([a-z]+)_[a-z0-9]+\.tar\.gz)"/g,
  (all, indent: string, file: string, from: string) => {
    if (from !== os) return all;
    replaced++;
    return `sha256 "${sum}"\n${indent}url "file://${base}/${file}"`;
  },
);
if (replaced !== 2) throw new Error(`expected two ${os} downloads in the golden cask, found ${replaced}`);
mkdirSync(join(work, "tap/Casks"), { recursive: true });
writeFileSync(join(work, "tap/Casks/aims-app.rb"), cask);

if (target === "linux") {
  const script = `set -euo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
cp -R /work/tap "$HOME/tap"
git -C "$HOME/tap" init -q && git -C "$HOME/tap" add -A && git -C "$HOME/tap" -c user.name=t -c user.email=t@localhost commit -qm cask
brew tap tapster/install "$HOME/tap" && brew trust tapster/install
brew install --cask tapster/install/aims-app
test "$(readlink "$(brew --prefix)/bin/aims")" = "$(brew --prefix)/Caskroom/aims-app/${VERSION}/aims"
test "$(aims)" = "aims ok"
test -e "$(brew --prefix)/etc/bash_completion.d/aims"
brew uninstall --cask aims-app
test ! -e "$(brew --prefix)/bin/aims"
echo "Homebrew on Linux installed and removed the bare binary"`;
  try {
    sh(["docker", "run", "--rm", "-v", `${work}:/work:ro`, IMAGE, "bash", "-c", script]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(0);
}

const tap = "tapster/install";
const appdir = join(work, "Applications");
const tapDir = join(work, "tap");
sh(["git", "init", "-q"], tapDir);
sh(["git", "add", "-A"], tapDir);
sh(["git", "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "cask"], tapDir);
sh(["brew", "tap", tap, tapDir]);
try {
  sh(["brew", "trust", tap]);
  sh(["brew", "install", "--cask", `--appdir=${appdir}`, `${tap}/aims-app`]);
  const prefix = sh(["brew", "--prefix"]);
  const link = sh(["readlink", join(prefix, "bin/aims")]);
  if (link !== join(appdir, "aims.app/Contents/MacOS/aims")) throw new Error(`bin/aims points to ${link}, not into the app`);
  sh(["/usr/bin/codesign", "--verify", "--strict", join(appdir, "aims.app")]);
  sh(["/usr/bin/xattr", "-dr", "com.apple.quarantine", join(appdir, "aims.app")]);
  if (sh([join(prefix, "bin/aims")]) !== "aims ok") throw new Error("aims did not run from the app");
  sh(["test", "-e", join(prefix, "etc/bash_completion.d/aims")]);
  sh(["brew", "uninstall", "--cask", "aims-app"]);
  sh(["test", "!", "-e", join(appdir, "aims.app")]);
  sh(["test", "!", "-e", join(prefix, "bin/aims")]);
  console.log("Homebrew on macOS installed the app, linked its command and removed both");
} finally {
  Bun.spawnSync(["brew", "untap", "--force", tap], { env, stdout: "inherit", stderr: "inherit" });
  rmSync(work, { recursive: true, force: true });
}
