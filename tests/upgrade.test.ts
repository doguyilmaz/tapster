import { expect, test } from "bun:test";
import { join } from "node:path";
import { installKind, stableCommand, upgrade, upgradeAdvice } from "../src/cli/upgrade";

test.each([
  ["Homebrew", { exec: "/opt/homebrew/Caskroom/tapster/1.5.0/tapster", script: "", sha: "a" }, "brew update && brew upgrade --cask tapster"],
  ["Homebrew on Linux", { exec: "/home/linuxbrew/.linuxbrew/Caskroom/tapster/1.5.0/tapster", script: "", sha: "a" }, "brew update && brew upgrade --cask tapster"],
  ["bunx", { exec: "/Users/me/.bun/bin/bun", script: "/private/var/folders/x/T/bunx-501-@doguyilmaz/tapster@latest/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" }, "bunx @doguyilmaz/tapster@latest"],
  ["a global Bun install", { exec: "/Users/me/.bun/bin/bun", script: "/Users/me/.bun/install/global/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" }, "bun add -g @doguyilmaz/tapster@latest"],
  ["a global npm install", { exec: "/Users/me/.bun/bin/bun", script: "/opt/homebrew/lib/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" }, "npm install -g @doguyilmaz/tapster@latest"],
  ["a checkout", { exec: "/Users/me/.bun/bin/bun", script: "/Users/me/code/tapster/src/cli/main.ts", sha: null }, "git -C /Users/me/code/tapster pull"],
])("tapster upgrade names the command for %s", (_, where, command) => {
  expect(upgradeAdvice(where).command).toBe(command);
});

test("an install tapster cannot place gets every way to upgrade", () => {
  const advice = upgradeAdvice({ exec: "/usr/local/bin/tapster", script: "", sha: "a" });
  expect(advice.command).toBeNull();
  expect(advice.text).toContain("brew upgrade --cask tapster");
  expect(advice.text).toContain("bunx @doguyilmaz/tapster@latest");
});

const cli = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: "/" });

test("an unknown command is named as unknown and fails", () => {
  const res = cli(["upgrad"]);
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toContain('unknown command "upgrad"');
  expect(res.stdout.toString()).toContain("tapster upgrade");
});

test("tapster upgrade from a checkout says to pull", () => {
  const res = cli(["upgrade"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain("pull");
});

const brew = { exec: "/opt/homebrew/Caskroom/tapster/1.6.0/tapster", script: "", sha: "a" };

test("tapster upgrade runs Homebrew's commands in order and points to the hub's update", async () => {
  const ran: string[] = [];
  const said: string[] = [];
  await upgrade([], { where: brew, run: async (argv) => (ran.push(argv.join(" ")), 0), say: (l) => said.push(l) });
  expect(ran).toEqual(["brew update", "brew upgrade --cask tapster"]);
  expect(said.join("\n")).toContain("Hub files");
});

test("tapster upgrade stops at the first failing command", async () => {
  const ran: string[] = [];
  await expect(upgrade([], { where: brew, run: async (argv) => (ran.push(argv.join(" ")), 1), say: () => {} })).rejects.toThrow(/brew update/);
  expect(ran).toEqual(["brew update"]);
});

test.each([
  ["bunx", { exec: "/b/bun", script: "/T/bunx-501-@doguyilmaz/tapster@latest/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" }],
  ["a checkout", { exec: "/b/bun", script: "/me/tapster/src/cli/main.ts", sha: null }],
  ["an unknown install", { exec: "/usr/local/bin/tapster", script: "", sha: "a" }],
])("tapster upgrade from %s only says what to run", async (_, where) => {
  const ran: string[] = [];
  await upgrade([], { where, run: async (argv) => (ran.push(argv.join(" ")), 0), say: () => {} });
  expect(ran).toEqual([]);
});

const KINDS = {
  brew: { exec: "/opt/homebrew/Caskroom/tapster/1.6.0/tapster", script: "/$bunfs/root/tapster", sha: "a" },
  linuxbrew: { exec: "/home/linuxbrew/.linuxbrew/Caskroom/tapster/1.6.0/tapster", script: "", sha: "a" },
  bun: { exec: "/Users/me/.bun/bin/bun", script: "/Users/me/.bun/install/global/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" },
  npm: { exec: "/opt/homebrew/bin/bun", script: "/usr/local/lib/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" },
  bunx: { exec: "/b/bun", script: "/T/bunx-501-@doguyilmaz/tapster@latest/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" },
  checkout: { exec: "/b/bun", script: "/me/tapster/src/cli/main.ts", sha: null },
  unknown: { exec: "/usr/local/bin/tapster", script: "", sha: "a" },
};

test.each([
  ["brew", "brew", "/opt/homebrew/bin/tapster"],
  ["linuxbrew", "brew", "/home/linuxbrew/.linuxbrew/bin/tapster"],
  ["bun", "bun", "/Users/me/.bun/bin/tapster"],
  ["npm", "npm", "/usr/local/bin/tapster"],
  ["bunx", "bunx", null],
  ["checkout", "checkout", null],
  ["unknown", "unknown", null],
] as const)("the install kind and the stable command of %s", (name, kind, stable) => {
  expect(installKind(KINDS[name])).toBe(kind);
  expect(stableCommand(KINDS[name])).toBe(stable);
});

test("an update names the exact version where the install can", () => {
  expect(upgradeAdvice(KINDS.bun, "1.7.5").run).toEqual([["bun", "add", "-g", "@doguyilmaz/tapster@1.7.5"]]);
  expect(upgradeAdvice(KINDS.npm, "1.7.5").run).toEqual([["npm", "install", "-g", "@doguyilmaz/tapster@1.7.5"]]);
  expect(upgradeAdvice(KINDS.npm, "1.7.5").command).toBe("npm install -g @doguyilmaz/tapster@1.7.5");
  expect(upgradeAdvice(KINDS.brew, "1.7.5").run).toEqual([["brew", "update"], ["brew", "upgrade", "--cask", "tapster"]]);
  expect(upgradeAdvice(KINDS.bunx, "1.7.5").command).toBe("bunx @doguyilmaz/tapster@1.7.5");
});
