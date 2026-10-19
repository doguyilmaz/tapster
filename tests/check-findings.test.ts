import { afterEach, expect, test } from "bun:test";
import { reportNote } from "../src/action/check";
import { failedCount, findings, resetReportForTests } from "../src/report";

afterEach(resetReportForTests);

test("a refused draft stays the same finding on later runs, so the health issue does not flap", () => {
  const out = { reason: "a.tar.gz does not match checksums.txt" };
  reportNote("aims", "v1.0.0", { ...out, result: "failed" });
  const first = findings();
  expect(first).toEqual([{ item: "aims", reason: "v1.0.0: a.tar.gz does not match checksums.txt", fix: "The hub wrote this on the draft too; fix the draft or delete it." }]);
  expect(failedCount()).toBe(1);
  resetReportForTests();
  reportNote("aims", "v1.0.0", { ...out, result: "known" });
  expect(findings()).toEqual(first);
  expect(failedCount()).toBe(0);
});

test("a draft that is still waiting is not a finding", () => {
  reportNote("aims", "v1.0.0", { result: "waiting", reason: "assets are still uploading" });
  expect(findings()).toEqual([]);
});
