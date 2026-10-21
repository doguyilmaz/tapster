import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { makeLinuxKey } from "../src/cli/linuxkey";
import { GitHub } from "../src/github";
import { FakeHub } from "./helpers/fakehub";
import { memoryStore } from "./helpers/memstore";

const scratch = mkdtempSync(join(tmpdir(), "tapster-temp-test-"));
const TEMP = join(import.meta.dir, "..", "src", "cli", "temp.ts");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

test("a gpg that fails leaves no GnuPG home behind", async () => {
  const bin = join(scratch, "bin");
  const temp = join(scratch, "tmp");
  await Bun.write(join(bin, "gpg"), "#!/bin/sh\nmkdir -p \"$GNUPGHOME/private-keys-v1.d\" && echo secret > \"$GNUPGHOME/private-keys-v1.d/key\"\nexit 2\n");
  chmodSync(join(bin, "gpg"), 0o755);
  await Bun.write(join(temp, ".keep"), "");
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap", { env: { policies: ["main"], custom: true, vars: new Map(), secrets: new Set() } });
  useGhWrite(fake.ghWrite);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  try {
    await expect(makeLinuxKey(new GitHub("t", fake.fetch, async () => {}, "user"), "octo/homebrew-tap", { gpg: join(bin, "gpg"), store: memoryStore(), rotate: false })).rejects.toThrow("gpg exited with 2");
  } finally {
    process.env.TMPDIR = before;
  }
  expect(readdirSync(temp)).toEqual([".keep"]);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  test(`${signal} removes the temporary folders before tapster exits`, async () => {
    const child = Bun.spawn([process.execPath, "-e", `const { tempDir } = await import(${JSON.stringify(TEMP)}); console.log(tempDir("tl-")); setInterval(() => {}, 1000);`], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) out += new TextDecoder().decode((await reader.read()).value);
    const dir = out.trim();
    expect(existsSync(dir)).toBe(true);
    child.kill(signal);
    expect(await child.exited).toBe({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    expect(existsSync(dir)).toBe(false);
  });
}
