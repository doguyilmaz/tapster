import { afterEach, expect, test } from "bun:test";
import { concern, failure, failedCount, findings, record, resetReportForTests, rowsForTests, warn } from "../src/report";
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

test("text from a project cannot start a workflow command on its own line", () => {
  record({ item: "aims v1.0.0", result: "failed", detail: "version 1\n::stop-commands::x\r\n::add-mask::y" });
  expect(rowsForTests()[0]!.detail).toBe("version 1 ::stop-commands::x ::add-mask::y");
});

function stdout(fn: () => void): string {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return writes.join("");
}

test("every failure is a finding with its reason and fix, scrubbed and on one line", () => {
  register("hidden-token-123");
  failure("aims", new TapsterError("v1.0.0: x\ny hidden-token-123", "Fix the build."));
  failure("tapster", new Error("secret-fragment"));
  expect(findings()).toEqual([
    { item: "aims", reason: "v1.0.0: x y ***", fix: "Fix the build." },
    { item: "tapster", reason: "unexpected Error", fix: "Re-run the workflow; if it fails again, open an issue with the run link." },
  ]);
});

test("a concern is a finding that warns and does not fail the run", () => {
  const out = stdout(() => concern("hub", "the Developer ID certificate expires on 2026-11-01", "Renew it."));
  expect(out).toContain("::warning::hub: the Developer ID certificate expires on 2026-11-01. Renew it.");
  expect(findings()).toEqual([{ item: "hub", reason: "the Developer ID certificate expires on 2026-11-01", fix: "Renew it." }]);
  expect(failedCount()).toBe(0);
});

test("plain warnings and waiting rows are not findings", () => {
  stdout(() => warn("aims: protection is off"));
  record({ item: "aims", result: "waiting", detail: "v1.0.0: assets are still uploading" });
  expect(findings()).toEqual([]);
});
