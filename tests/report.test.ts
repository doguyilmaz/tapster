import { afterEach, expect, test } from "bun:test";
import { failure, failedCount, record, resetReportForTests, rowsForTests } from "../src/report";
import { register, resetMaskForTests } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(() => { resetReportForTests(); resetMaskForTests(); });

test("records are scrubbed", () => {
  register("hidden-token-123");
  record({ item: "aims v1.0.0", result: "published", detail: "used hidden-token-123" });
  expect(rowsForTests()[0]!.detail).toBe("used ***");
});

test("unknown errors never print their message", () => {
  failure("aims", new Error("Unexpected token in JSON at position 3: secret-fragment"));
  const row = rowsForTests()[0]!;
  expect(row.result).toBe("failed");
  expect(row.detail).not.toContain("secret-fragment");
  expect(failedCount()).toBe(1);
});

test("tapster errors print reason and fix", () => {
  failure("aims", new TapsterError("notarization invalid", "Fix the build."));
  expect(rowsForTests()[0]!.detail).toBe("notarization invalid. Fix the build.");
});
