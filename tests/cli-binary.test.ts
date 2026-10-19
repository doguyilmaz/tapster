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
