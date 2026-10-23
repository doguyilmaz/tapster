import { realpathSync } from "node:fs";
import { TapsterError } from "../errors";
import { TAPSTER } from "../version";

export type Where = { exec: string; script: string; sha: string | null };

const PACKAGE = "/node_modules/@doguyilmaz/tapster/";
const ALL = [
  "Homebrew:  brew update && brew upgrade --cask tapster",
  "bunx:      bunx @doguyilmaz/tapster@latest <command>",
  "Bun:       bun add -g @doguyilmaz/tapster@latest",
  "npm:       npm install -g @doguyilmaz/tapster@latest",
].join("\n  ");

export type Advice = { command: string | null; text: string; run: string[][] };

export type InstallKind = "brew" | "bun" | "npm" | "bunx" | "checkout" | "unknown";

export function installKind(where: Where): InstallKind {
  if (where.sha === null && where.script.endsWith("/src/cli/main.ts")) return "checkout";
  if (/\/Caskroom\/tapster\//.test(where.exec)) return "brew";
  if (!where.script.includes(PACKAGE)) return "unknown";
  if (/\/bunx-[^/]*\//.test(where.script)) return "bunx";
  if (where.script.includes("/.bun/install/global/")) return "bun";
  return where.script.includes(`/lib${PACKAGE}`) ? "npm" : "unknown";
}

// The link each install keeps in place across upgrades, never a versioned path, so a restart runs the new version.
export function stableCommand(where: Where): string | null {
  const kind = installKind(where);
  if (kind === "brew") return `${where.exec.slice(0, where.exec.indexOf("/Caskroom/tapster/"))}/bin/tapster`;
  if (kind === "bun") return `${where.script.slice(0, where.script.indexOf("/install/global/"))}/bin/tapster`;
  if (kind === "npm") return `${where.script.slice(0, where.script.indexOf(`/lib${PACKAGE}`))}/bin/tapster`;
  return null;
}

export function upgradeAdvice(where: Where, version = "latest"): Advice {
  const say = (command: string, how: string, run: string[][] = []) => ({ command, run, text: `This tapster came from ${how}.` });
  const pkg = `@doguyilmaz/tapster@${version}`;
  switch (installKind(where)) {
    case "checkout":
      return say(`git -C ${where.script.slice(0, -"/src/cli/main.ts".length)} pull`, "a checkout");
    case "brew":
      return say("brew update && brew upgrade --cask tapster", "Homebrew", [["brew", "update"], ["brew", "upgrade", "--cask", "tapster"]]);
    case "bunx":
      return say(`bunx ${pkg}`, "bunx; name the version each time, as bunx keeps the one it ran last");
    case "bun":
      return say(`bun add -g ${pkg}`, "a global Bun install", [["bun", "add", "-g", pkg]]);
    case "npm":
      return say(`npm install -g ${pkg}`, "a global npm install", [["npm", "install", "-g", pkg]]);
    default:
      return { command: null, run: [], text: `tapster cannot tell how it was installed. Upgrade it the way you installed it:\n  ${ALL}` };
  }
}

export const here = (): Where => ({ exec: real(process.execPath), script: process.argv[1] ? real(process.argv[1]) : "", sha: TAPSTER.sha });

type Io = { where?: Where; run?: (argv: string[]) => Promise<number>; say?: (line: string) => void };

const runInherited = async (argv: string[]) => {
  const bin = Bun.which(argv[0]!);
  if (!bin) throw new TapsterError(`${argv[0]} is not on PATH`, `Run it yourself: ${argv.join(" ")}`);
  return Bun.spawn([bin, ...argv.slice(1)], { stdio: ["inherit", "inherit", "inherit"] }).exited;
};

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export async function upgrade(args: string[], io: Io = {}): Promise<void> {
  if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "tapster upgrade takes no options.");
  const say = io.say ?? ((l: string) => console.log(l));
  const where = io.where ?? here();
  const advice = upgradeAdvice(where);
  say(`tapster ${TAPSTER.version}. ${advice.text}`);
  if (!advice.run.length) {
    if (advice.command) say(`Upgrade it with:\n  ${advice.command}`);
    return;
  }
  for (const argv of advice.run) {
    say(`$ ${argv.join(" ")}`);
    if ((await (io.run ?? runInherited)(argv)) !== 0) throw new TapsterError(`${argv.join(" ")} failed`, `Run it yourself and read its output: ${advice.command}`);
  }
  say("Upgraded. Run tapster -v to check. To move the hub to this version too, open tapster setup and write the Hub files.");
}
