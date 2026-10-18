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

test("public repositories must verify; private ones may skip when unavailable", () => {
  expect(decide(0, "", false)).toBe("verified");
  expect(decide(1, "no attestations found", false)).toBe("failed");
  expect(decide(1, "no attestations found", true)).toBe("skipped");
  expect(decide(1, "HTTP 403: feature not available", true)).toBe("skipped");
  expect(decide(1, "certificate identity mismatch", true)).toBe("failed");
});
