import { expect, test } from "bun:test";
import { latestPublished, parseState, recordedChecksums, serializeState, upsert } from "../src/state";
import { TapsterError } from "../src/errors";

const sum = "c".repeat(64);

test("upsert replaces by release id and keeps the newest first", () => {
  let s = parseState(null);
  s = upsert(s, "aims", { tag: "v1.0.0", releaseId: 1, checksums: sum, status: "publishing" });
  s = upsert(s, "aims", { tag: "v1.0.0", releaseId: 1, checksums: sum, status: "published" });
  s = upsert(s, "aims", { tag: "v1.1.0-rc.1", releaseId: 2, checksums: sum, status: "published" });
  s = upsert(s, "aims", { tag: "v0.9.0", releaseId: 3, checksums: sum, status: "published" });
  expect(s.packages.aims!.map((e) => e.tag)).toEqual(["v1.1.0-rc.1", "v1.0.0", "v0.9.0"]);
  expect(latestPublished(s, "aims")!.tag).toBe("v1.0.0");
});

test("serialization is stable and round-trips", () => {
  const s = upsert(parseState(null), "b", { tag: "v1.0.0", releaseId: 9, checksums: sum, status: "published" });
  const text = serializeState(s);
  expect(serializeState(parseState(text))).toBe(text);
  expect(text.endsWith("\n")).toBe(true);
});

test("a damaged state is an error with a fix", () => {
  expect(() => parseState('{"version":1,"packages":{"x":[{"tag":"v1.0.0#{}"}]}}')).toThrow(TapsterError);
  expect(() => parseState("not json")).toThrow(TapsterError);
});

test("the recorded checksums of a publishing release", () => {
  let s = upsert(parseState(null), "aims", { tag: "v1.0.0", releaseId: 1, checksums: sum, status: "published" });
  s = upsert(s, "aims", { tag: "v1.1.0", releaseId: 2, checksums: "d".repeat(64), status: "publishing" });
  expect(recordedChecksums(s, "aims", 2)).toBe("d".repeat(64));
  expect(recordedChecksums(s, "aims", 1)).toBeUndefined();
  expect(recordedChecksums(s, "other", 2)).toBeUndefined();
});
