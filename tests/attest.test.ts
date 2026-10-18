import { expect, test } from "bun:test";
import { attestArgs, decide } from "../src/attest";

test("verification pins repository, workflow, tag and hosted runners", () => {
  expect(attestArgs("/w/a.tar.gz", "o/aims", "release.yml", "v1.0.0")).toEqual([
    "attestation", "verify", "/w/a.tar.gz",
    "--repo", "o/aims",
    "--signer-workflow", "o/aims/.github/workflows/release.yml",
    "--source-ref", "refs/tags/v1.0.0",
    "--deny-self-hosted-runners",
    "--format", "json",
  ]);
});

test("public repositories must verify; private ones skip on any failure, without reading the error text", () => {
  expect(decide(0, false)).toBe("verified");
  expect(decide(1, false)).toBe("failed");
  expect(decide(0, true)).toBe("verified");
  expect(decide(1, true)).toBe("skipped");
});
