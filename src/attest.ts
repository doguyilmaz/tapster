import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { sha256 } from "./checksums";
import type { PackageConfig } from "./config";
import { GitHubError, TapsterError } from "./errors";
import { type FetchLike, GitHub } from "./github";
import { ghPath, runPath } from "./run";

export type AttestOutcome = "verified" | "skipped" | "off";

export function attestArgs(file: string, repo: string, workflow: string, tag: string): string[] {
  return [
    "attestation", "verify", file,
    "--repo", repo,
    "--signer-workflow", `${repo}/.github/workflows/${workflow}`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
    "--format", "json",
  ];
}

export function decide(code: number, isPrivate: boolean, attested: boolean): "verified" | "skipped" | "failed" {
  if (code === 0) return "verified";
  return isPrivate && !attested ? "skipped" : "failed";
}

export async function hasAttestations(repo: string, digest: string, token: string, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    const res = await new GitHub(token, fetchImpl).json<{ attestations?: unknown[] }>("GET", `/repos/${repo}/attestations/sha256:${digest}`);
    return (res.attestations?.length ?? 0) > 0;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

export async function verifyAttestation(file: string, pkg: PackageConfig, tag: string, isPrivate: boolean, token: string): Promise<AttestOutcome> {
  if (pkg.attestation === "off") return "off";
  const res = await runPath(ghPath(), "gh", attestArgs(file, pkg.repo, pkg.workflow, tag), {
    env: { GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    allowFail: true,
  });
  const attested = res.code !== 0 && isPrivate ? await hasAttestations(pkg.repo, sha256(await readFile(file)), token) : false;
  const outcome = decide(res.code, isPrivate, attested);
  if (outcome === "failed") {
    throw new TapsterError(
      `${basename(file)} has no valid build attestation from ${pkg.repo}/.github/workflows/${pkg.workflow} at ${tag}`,
      "Attest the archives in the project's release workflow (tapster add sets it up). To skip the check, set attestation: off for this package.",
    );
  }
  return outcome;
}
