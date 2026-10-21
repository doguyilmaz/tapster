import { expect, test } from "bun:test";
import { join } from "node:path";
import { upgradeAdvice } from "../src/cli/upgrade";

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
