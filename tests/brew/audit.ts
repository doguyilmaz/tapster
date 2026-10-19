import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const golden = join(import.meta.dir, "../golden");
const casks = readdirSync(golden).filter((f) => f.endsWith(".rb")).map((f) => f.slice(0, -3));
const dir = mkdtempSync(join(tmpdir(), "tapster-audit-"));
const tap = "tapster/audit";
const config = mkdtempSync(join(tmpdir(), "tapster-audit-config-"));
const env = { ...process.env, XDG_CONFIG_HOME: config, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" };

function sh(args: string[], cwd = dir): boolean {
  const res = Bun.spawnSync(args, { cwd, env, stdout: "inherit", stderr: "inherit" });
  return res.exitCode === 0;
}

mkdirSync(join(dir, "Casks"));
for (const c of casks) cpSync(join(golden, `${c}.rb`), join(dir, "Casks", `${c}.rb`));
sh(["git", "init", "-q"]);
sh(["git", "add", "-A"]);
sh(["git", "-c", "user.name=tapster", "-c", "user.email=tapster@localhost", "commit", "-qm", "casks"]);
let failed = !sh(["brew", "tap", tap, dir]) || !sh(["brew", "trust", tap]);
try {
  for (const c of casks) {
    const text = readFileSync(join(dir, "Casks", `${c}.rb`), "utf8");
    const targets = [["--arch", "arm"], ["--arch", "intel"], ...(text.includes("on_linux") ? [["--os", "linux", "--arch", "intel"]] : [])];
    failed = !sh(["brew", "style", "--cask", `${tap}/${c}`]) || failed;
    for (const t of targets) failed = !sh(["brew", "audit", "--cask", ...t, `${tap}/${c}`]) || failed;
  }
} finally {
  sh(["brew", "untap", tap]);
  rmSync(dir, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
}
console.log(failed ? `brew rejected a rendered cask` : `brew accepts ${casks.join(", ")}`);
process.exit(failed ? 1 : 0);
