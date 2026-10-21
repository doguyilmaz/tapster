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

export function upgradeAdvice(where: Where): Advice {
  const say = (command: string, how: string, run: string[][] = []) => ({ command, run, text: `This tapster came from ${how}.` });
  if (where.sha === null && where.script.endsWith("/src/cli/main.ts")) return say(`git -C ${where.script.slice(0, -"/src/cli/main.ts".length)} pull`, "a checkout");
  if (/\/Caskroom\/tapster\//.test(where.exec)) return say("brew update && brew upgrade --cask tapster", "Homebrew", [["brew", "update"], ["brew", "upgrade", "--cask", "tapster"]]);
  if (where.script.includes(PACKAGE)) {
    if (/\/bunx-[^/]*\//.test(where.script)) return say("bunx @doguyilmaz/tapster@latest", "bunx; name the version each time, as bunx keeps the one it ran last");
    if (where.script.includes("/.bun/install/global/")) return say("bun add -g @doguyilmaz/tapster@latest", "a global Bun install", [["bun", "add", "-g", "@doguyilmaz/tapster@latest"]]);
    return say("npm install -g @doguyilmaz/tapster@latest", "a global npm install", [["npm", "install", "-g", "@doguyilmaz/tapster@latest"]]);
  }
  return { command: null, run: [], text: `tapster cannot tell how it was installed. Upgrade it the way you installed it:\n  ${ALL}` };
}

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
  const where = io.where ?? { exec: real(process.execPath), script: process.argv[1] ? real(process.argv[1]) : "", sha: TAPSTER.sha };
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
