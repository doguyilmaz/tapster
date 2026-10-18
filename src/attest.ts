import { basename } from "node:path";
import type { PackageConfig } from "./config";
import { TapsterError } from "./errors";
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

export function decide(code: number, isPrivate: boolean): "verified" | "skipped" | "failed" {
  if (code === 0) return "verified";
  return isPrivate ? "skipped" : "failed";
}

export async function verifyAttestation(file: string, pkg: PackageConfig, tag: string, isPrivate: boolean, token: string): Promise<AttestOutcome> {
  if (pkg.attestation === "off") return "off";
  const res = await runPath(ghPath(), "gh", attestArgs(file, pkg.repo, pkg.workflow, tag), {
    env: { GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    allowFail: true,
  });
  const outcome = decide(res.code, isPrivate);
  if (outcome === "failed") {
    throw new TapsterError(
      `${basename(file)} has no valid build attestation from ${pkg.repo}/.github/workflows/${pkg.workflow} at ${tag}`,
      "Attest the archives in the project's release workflow (tapster add sets it up), or set attestation: off for this package.",
    );
  }
  return outcome;
}
