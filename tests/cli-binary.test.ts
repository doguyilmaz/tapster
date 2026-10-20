import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const logo = await Bun.file(join(root, "site", "public", "logo-512.png")).bytes();

async function servesSetup(cmd: string[], cwd: string, port: number): Promise<string> {
  const proc = Bun.spawn([...cmd, "setup", "--no-open", "--port", String(port)], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  try {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/app.js`).catch(() => null);
      if (res?.ok) {
        expect(new Uint8Array(await (await fetch(`http://127.0.0.1:${port}/logo.png`)).arrayBuffer())).toEqual(logo);
        return await res.text();
      }
      await Bun.sleep(100);
    }
    throw new Error(`tapster setup did not answer: ${await new Response(proc.stderr).text()}`);
  } finally {
    proc.kill();
  }
}

test("the compiled CLI starts without the source tree and carries the setup page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const out = join(dir, "tapster");
  const build = Bun.spawnSync(["bun", "scripts/build.ts", "compile", `bun-${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`, out], { cwd: root });
  expect(build.exitCode).toBe(0);
  const res = Bun.spawnSync([out, "--help"], { cwd: dir });
  expect(res.stderr.toString()).toBe("");
  expect(res.stdout.toString()).toContain("tapster setup");
  expect(res.exitCode).toBe(0);
  expect(await servesSetup([out], dir, 18391)).toContain("Choose your hub");
}, 90_000);

test("the npm package is one bundled file with no dependencies to install", async () => {
  const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text());
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(pkg.bin).toEqual({ tapster: "./dist/cli.js" });
  expect(pkg.files).toEqual(["dist/cli.js", "README.md", "LICENSE"]);
  const dir = mkdtempSync(join(tmpdir(), "npm-"));
  const out = join(dir, "cli.js");
  const build = Bun.spawnSync(["bun", "scripts/build.ts", "cli", out], { cwd: root });
  expect(build.exitCode).toBe(0);
  expect((await Bun.file(out).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
  const res = Bun.spawnSync(["bun", out, "--help"], { cwd: dir });
  expect(res.stdout.toString()).toContain("tapster init");
  expect(res.exitCode).toBe(0);
  expect(await servesSetup(["bun", out], dir, 18392)).toContain("Choose your hub");
}, 90_000);
