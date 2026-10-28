import { afterEach, expect, test } from "bun:test";
import { childEnv, excerpt, runPath } from "../src/run";
import { register, resetMaskForTests } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(resetMaskForTests);

test("children get only the allowlisted environment", async () => {
  process.env.TAPSTER_SHOULD_NOT_LEAK = "leak";
  const res = await runPath("/usr/bin/env", "env", [], { env: { EXTRA: "1" } });
  const keys = res.stdout.trim().split("\n").map((l) => l.split("=")[0]).sort();
  expect(keys).toEqual(["EXTRA", "HOME", "PATH", "TMPDIR"]);
  delete process.env.TAPSTER_SHOULD_NOT_LEAK;
});

test("a failing tool never puts its arguments in the error", async () => {
  register("secret-argument-value");
  let err: unknown;
  try {
    await runPath("/bin/sh", "sh", ["-c", "echo secret-argument-value >&2; exit 3", "secret-argument-value"]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TapsterError);
  const e = err as TapsterError;
  expect(e.reason).toBe("sh exited with 3");
  expect(`${e.reason} ${e.fix}`).not.toContain("secret-argument-value");
});

test("a tool that writes its error to stdout is reported with it", async () => {
  // xcrun stapler does: "The validate action failed! Error 68."
  const e = (await runPath("/bin/sh", "sh", ["-c", "echo 'The validate action failed! Error 68.'; exit 68"]).catch((err) => err)) as TapsterError;
  expect(e.reason).toBe("sh exited with 68");
  expect(e.fix).toBe("The validate action failed! Error 68.");
});

test("a tool that exits before reading its input fails with its exit code", async () => {
  // gpg does with a malformed key; the write then breaks its pipe (EPIPE).
  const e = (await runPath("/bin/sh", "sh", ["-c", "exit 2"], { stdin: "x".repeat(4 << 20) }).catch((err) => err)) as TapsterError;
  expect(e.reason).toBe("sh exited with 2");
});

test("allowFail returns the code instead of throwing", async () => {
  const res = await runPath("/bin/sh", "sh", ["-c", "exit 4"], { allowFail: true });
  expect(res.code).toBe(4);
});

test("stdin reaches the child", async () => {
  const res = await runPath("/bin/cat", "cat", [], { stdin: "from-stdin" });
  expect(res.stdout).toBe("from-stdin");
});

test("excerpt drops keychain lines and scrubs", () => {
  register("tok-123456");
  expect(excerpt("a\nlogin.keychain-db x\nb tok-123456\n")).toBe("a | b ***");
});

test("childEnv uses a fixed PATH", () => {
  expect(childEnv().PATH).toBe("/usr/bin:/bin");
});

test("a tool that writes without end or hangs is stopped", async () => {
  await expect(runPath("/usr/bin/yes", "yes", [], { maxOutput: 1 << 16 })).rejects.toThrow(/more output/);
  const started = Date.now();
  await expect(runPath("/bin/sleep", "sleep", ["5"], { timeoutMs: 200 })).rejects.toThrow(/did not finish/);
  expect(Date.now() - started).toBeLessThan(2000);
});
