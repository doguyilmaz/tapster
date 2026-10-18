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
