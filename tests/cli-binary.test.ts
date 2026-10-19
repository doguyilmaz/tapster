import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the compiled CLI starts without the source tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const out = join(dir, "tapster");
  const build = Bun.spawnSync(["bun", "build", join(import.meta.dir, "../src/cli/main.ts"), "--compile", "--outfile", out]);
  expect(build.exitCode).toBe(0);
  const res = Bun.spawnSync([out, "--help"], { cwd: dir });
  expect(res.stderr.toString()).toBe("");
  expect(res.stdout.toString()).toContain("tapster init");
  expect(res.exitCode).toBe(0);
}, 60_000);

test("the npm package is one bundled file with no dependencies to install", async () => {
  const pkg = JSON.parse(await Bun.file(join(import.meta.dir, "../package.json")).text());
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(pkg.bin).toEqual({ tapster: "./dist/cli.js" });
  expect(pkg.files).toEqual(["dist/cli.js", "README.md", "LICENSE"]);
  const dir = mkdtempSync(join(tmpdir(), "npm-"));
  const out = join(dir, "cli.js");
  const build = Bun.spawnSync(["bun", "build", join(import.meta.dir, "../src/cli/main.ts"), "--target=bun", "--outfile", out]);
  expect(build.exitCode).toBe(0);
  expect((await Bun.file(out).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
  const res = Bun.spawnSync(["bun", out, "--help"], { cwd: dir });
  expect(res.stdout.toString()).toContain("tapster init");
  expect(res.exitCode).toBe(0);
}, 60_000);
