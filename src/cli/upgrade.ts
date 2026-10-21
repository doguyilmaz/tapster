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

export function upgradeAdvice(where: Where): { command: string | null; text: string } {
  const say = (command: string, how: string) => ({ command, text: `This tapster came from ${how}. Upgrade it with:\n  ${command}` });
  if (where.sha === null && where.script.endsWith("/src/cli/main.ts")) return say(`git -C ${where.script.slice(0, -"/src/cli/main.ts".length)} pull`, "a checkout");
  if (/\/Caskroom\/tapster\//.test(where.exec)) return say("brew update && brew upgrade --cask tapster", "Homebrew");
  if (where.script.includes(PACKAGE)) {
    if (/\/bunx-[^/]*\//.test(where.script)) return say("bunx @doguyilmaz/tapster@latest", "bunx; name the version each time, as bunx keeps the one it ran last");
    if (where.script.includes("/.bun/install/global/")) return say("bun add -g @doguyilmaz/tapster@latest", "a global Bun install");
    return say("npm install -g @doguyilmaz/tapster@latest", "a global npm install");
  }
  return { command: null, text: `tapster cannot tell how it was installed. Upgrade it the way you installed it:\n  ${ALL}` };
}

export function upgrade(args: string[]): void {
  if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "tapster upgrade takes no options.");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  console.log(`tapster ${TAPSTER.version}. ${upgradeAdvice({ exec: real(process.execPath), script: process.argv[1] ? real(process.argv[1]) : "", sha: TAPSTER.sha }).text}`);
}
