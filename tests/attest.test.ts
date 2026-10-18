import { expect, test } from "bun:test";
import { attestArgs, decide, hasAttestations } from "../src/attest";
import { GitHubError } from "../src/errors";

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

test("public repositories must verify; private ones skip only when nothing was attested", () => {
  expect(decide(0, false, false)).toBe("verified");
  expect(decide(1, false, false)).toBe("failed");
  expect(decide(0, true, true)).toBe("verified");
  expect(decide(1, true, false)).toBe("skipped");
  expect(decide(1, true, true)).toBe("failed");
});

test("attestation lookup: 404 or an empty list means none, other errors fail closed", async () => {
  const reply = (status: number, body?: unknown) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
  expect(await hasAttestations("o/r", "a".repeat(64), "t", reply(404))).toBe(false);
  expect(await hasAttestations("o/r", "a".repeat(64), "t", reply(200, { attestations: [] }))).toBe(false);
  expect(await hasAttestations("o/r", "a".repeat(64), "t", reply(200, { attestations: [{}] }))).toBe(true);
  await expect(hasAttestations("o/r", "a".repeat(64), "t", reply(403))).rejects.toBeInstanceOf(GitHubError);
});
