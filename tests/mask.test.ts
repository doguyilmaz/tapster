import { afterEach, expect, test } from "bun:test";
import { readSecret, register, resetMaskForTests, scrub, variants } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(resetMaskForTests);

test("scrub hides a registered value and its encodings", () => {
  const secret = "s3cr3t-value\nsecond-line";
  register(secret);
  const b64 = Buffer.from(secret).toString("base64");
  const hex = Buffer.from(secret).toString("hex");
  const text = `a ${secret} b ${b64} c ${hex} d ${encodeURIComponent(secret)} e second-line`;
  const out = scrub(text);
  expect(out).not.toContain("s3cr3t");
  expect(out).not.toContain(b64);
  expect(out).not.toContain(hex);
  expect(out).not.toContain("second-line");
});

test("short values are not used as masks", () => {
  expect(variants("ab")).toEqual([]);
});

test("readSecret registers and removes the variable", () => {
  process.env.TAPSTER_TEST_SECRET = "value-from-env";
  expect(readSecret("TAPSTER_TEST_SECRET")).toBe("value-from-env");
  expect(process.env.TAPSTER_TEST_SECRET).toBeUndefined();
  expect(scrub("x value-from-env y")).toBe("x *** y");
});

test("a missing secret explains how to add it", () => {
  delete process.env.TAPSTER_MISSING;
  expect(() => readSecret("TAPSTER_MISSING")).toThrow(TapsterError);
});

test("outside GitHub Actions nothing is printed when a value is registered", () => {
  const before = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    register("cli-only-secret-value");
  } finally {
    process.stdout.write = original;
    if (before !== undefined) process.env.GITHUB_ACTIONS = before;
  }
  expect(writes.join("")).not.toContain("cli-only-secret-value");
  expect(scrub("x cli-only-secret-value")).toBe("x ***");
});

test("a missing workflow token points at the workflow, not the environment", () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    expect(() => readSecret("GITHUB_TOKEN")).toThrow(expect.objectContaining({ fix: expect.stringContaining("tapster init --workflow") }));
    expect(() => readSecret("MACOS_SIGN_P12")).toThrow(expect.objectContaining({ fix: expect.stringContaining('"tapster" environment') }));
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }
});
