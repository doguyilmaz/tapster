import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTemps, tempDir } from "../src/cli/temp";
import { GitHub } from "../src/github";

const cli = (args: string[], cwd = "/") => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd });

test.each([["init"], ["add"], ["doctor"]])("tapster %s --help explains the command and changes nothing", (cmd) => {
  const res = cli([cmd, "--help"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain(`tapster ${cmd}`);
  expect(res.stderr.toString()).toBe("");
});

test.each([["init --bogus"], ["init --rotate everything"], ["add --bogus"], ["doctor --bogus"]])("tapster %s is refused before anything runs", (line) => {
  const res = cli(line.split(" "));
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toContain("unknown");
  expect(res.stderr.toString()).not.toContain("gh");
});

test("without the GitHub CLI, tapster says how to get it", async () => {
  const { cliGh } = await import("../src/cli/gh");
  expect(() => cliGh(["/nonexistent/gh"])).toThrow(expect.objectContaining({ fix: expect.stringContaining("brew install gh") }));
});

test("outside a clone, tapster says where to run it", () => {
  expect(cli(["doctor"], "/").stderr.toString()).toContain("not a clone");
});

test("temporary folders are removed on Ctrl-C as well", () => {
  const dir = tempDir("tapster-test-");
  expect(existsSync(dir)).toBe(true);
  cleanupTemps();
  expect(existsSync(dir)).toBe(false);
  expect(process.listeners("SIGINT").length).toBeGreaterThan(0);
});

test("errors from the user's token name the user's sign-in, not the App", async () => {
  const deny = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
  const user = new GitHub("t", deny, async () => {}, "user");
  await expect(user.json("GET", "/repos/o/r")).rejects.toMatchObject({ fix: expect.stringContaining("gh auth") });
  const app = new GitHub("t", deny, async () => {});
  await expect(app.json("GET", "/repos/o/r")).rejects.toMatchObject({ fix: expect.stringContaining("App") });
});

test("tapster --version names the version and the commit it pins hubs to", () => {
  const res = cli(["--version"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString().trim()).toBe("tapster 0.0.0-dev (built from a checkout; init --workflow needs --tapster <commit>)");
});
