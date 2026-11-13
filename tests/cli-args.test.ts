import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTemps, tempDir } from "../src/cli/temp";
import { GitHub } from "../src/github";

const cli = (args: string[], cwd = "/") => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd });

test.each([["setup"], ["init"], ["add"], ["doctor"]])("tapster %s --help explains the command and changes nothing", (cmd) => {
  const res = cli([cmd, "--help"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain(`tapster ${cmd}`);
  expect(res.stderr.toString()).toBe("");
});

test.each(["--help", "-h", "help"])("tapster %s shows help without opening setup", (flag) => {
  const res = cli([flag]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain("tapster             open the setup in your browser");
  expect(res.stdout.toString()).toContain("--no-open");
  expect(res.stderr.toString()).toBe("");
});

test.each([
  { args: [] },
  { args: ["setup"] },
  { args: ["--no-open", "--port", "9000", "--tapster", "a".repeat(40)] },
  { args: ["setup", "--no-open", "--port", "9000"] },
])("the CLI opens setup for $args and forwards its options", ({ args }) => {
  const dir = mkdtempSync(join(tmpdir(), "cli-entry-"));
  try {
    // Keep routing checks in their own process, with no browser or credential access.
    const preload = join(dir, "setup.ts");
    const start = join(import.meta.dir, "../src/web/start.ts");
    writeFileSync(preload, `import { mock } from "bun:test";
const start = await import(${JSON.stringify(start)});
mock.module(${JSON.stringify(start)}, () => ({ ...start, setup: async (args) => console.log(JSON.stringify({ setup: args })) }));
`);
    const res = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: "/" });
    expect(res.stderr.toString()).toBe("");
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout.toString())).toEqual({ setup: args[0] === "setup" ? args.slice(1) : args });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([["--bogus"], ["--port 80"], ["setup --bogus"], ["setup --port 80"]])("tapster %s refuses invalid setup options before starting", (line) => {
  const res = cli(line.split(" "));
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toContain("unknown option");
  expect(res.stdout.toString()).toBe("");
});

test("unknown commands still fail instead of opening setup", () => {
  const res = cli(["setpu"]);
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toBe('tapster: unknown command "setpu"\n');
  expect(res.stdout.toString()).toContain("tapster --help");
});

test.each([["init --bogus"], ["init --rotate everything"], ["add --bogus"], ["doctor --bogus"]])("tapster %s is refused before anything runs", (line) => {
  const res = cli(line.split(" "));
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toContain("unknown");
  expect(res.stderr.toString()).not.toContain("gh");
});

test("tapster init --help lists the certificate commands, and a bad label is refused before anything runs", () => {
  const help = cli(["init", "--help"]).stdout.toString();
  expect(help).toContain("tapster init --certificate <label>\n");
  expect(help).toContain("tapster init --certificate <label> --notary\n");
  const res = cli(["init", "--certificate", "Acme"]);
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toBe("tapster: Acme is not a valid label\n  Use up to 40 lowercase letters and digits, as in certificate in tapster.yml.\n");
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
