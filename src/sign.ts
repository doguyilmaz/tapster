import { basename } from "node:path";
import { TapsterError } from "./errors";
import type { Keychain } from "./keychain";
import { register, scrub } from "./mask";
import { run } from "./run";

export const PRESETS: Record<"go" | "bun", string[]> = {
  go: [],
  bun: ["com.apple.security.cs.allow-jit"],
};

export function entitlementsPlist(keys: string[]): string {
  const body = keys.map((k) => `<key>${k}</key><true/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`;
}

export function codesignArgs(kc: Keychain, file: string, entitlements: string | null, identifier: string): string[] {
  return [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    ...(kc.path ? ["--keychain", kc.path] : []),
    "--sign",
    kc.identity,
    "--identifier",
    identifier,
    ...(entitlements ? ["--entitlements", entitlements] : []),
    file,
  ];
}

export async function signFile(kc: Keychain, file: string, entitlements: string | null, identifier: string): Promise<void> {
  await run("codesign", codesignArgs(kc, file, entitlements, identifier));
}

export type SignatureInfo = { authority: string[]; teamId: string | null; runtime: boolean; identifier: string | null };

export function parseSignature(text: string): SignatureInfo {
  const lines = text.split("\n");
  return {
    authority: lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice("Authority=".length)),
    teamId: lines.find((l) => l.startsWith("TeamIdentifier="))?.slice("TeamIdentifier=".length) ?? null,
    runtime: lines.some((l) => /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(l)),
    identifier: lines.find((l) => l.startsWith("Identifier="))?.slice("Identifier=".length) ?? null,
  };
}

export async function verifySigned(file: string, teamId: string, identifier?: string): Promise<void> {
  await run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  const info = parseSignature((await run("codesign", ["-dvv", file])).stderr);
  if (!info.authority[0]?.startsWith("Developer ID Application:") || info.teamId !== teamId || !info.runtime || (identifier !== undefined && info.identifier !== identifier)) {
    throw new TapsterError(`${basename(file)} is not signed as expected`, "It needs a Developer ID Application signature of the configured team with the hardened runtime.");
  }
}

export type NotaryKey = { p8Path: string; keyId: string; issuer: string };
export type NotaryResult = { id: string; status: string };

export function parseNotary(stdout: string, stderr = ""): NotaryResult {
  try {
    const j = JSON.parse(stdout) as { id?: unknown; status?: unknown };
    if (typeof j.id === "string" && typeof j.status === "string") return { id: j.id, status: j.status };
  } catch {
  }
  if (/HTTP status code: 401\b/.test(stderr)) {
    throw new TapsterError("Apple rejected the notary key (HTTP 401)", "Store the App Store Connect key, its Key ID and the Issuer ID again with tapster init --rotate notary. The draft is untouched.");
  }
  const line = stderr.split("\n").find((l) => l.trim() !== "");
  if (line) throw new TapsterError(`notarytool failed: ${scrub(line.trim()).slice(0, 300)}`, "The draft is untouched; the next run tries again.");
  throw new TapsterError("notarytool returned output tapster could not read", "Re-run the workflow; if it repeats, check the App Store Connect key.");
}

async function notaryIssues(id: string, key: NotaryKey): Promise<string> {
  const res = await run("xcrun", ["notarytool", "log", id, "--key", key.p8Path, "--key-id", key.keyId, "--issuer", key.issuer], { allowFail: true });
  try {
    const log = JSON.parse(res.stdout) as { issues?: { path?: string; message?: string }[] | null };
    return (log.issues ?? [])
      .slice(0, 3)
      .map((i) => `${i.path ? `${basename(i.path)}: ` : ""}${i.message ?? ""}`.trim())
      .join("; ");
  } catch {
    return "";
  }
}

export async function notarize(zip: string, key: NotaryKey): Promise<NotaryResult> {
  register(key.keyId);
  register(key.issuer);
  const res = await run(
    "xcrun",
    ["notarytool", "submit", zip, "--key", key.p8Path, "--key-id", key.keyId, "--issuer", key.issuer, "--wait", "--timeout", "30m", "--output-format", "json"],
    { allowFail: true },
  );
  const result = parseNotary(res.stdout, res.stderr);
  if (result.status !== "Accepted") {
    const issues = result.status === "In Progress" ? "" : await notaryIssues(result.id, key);
    throw new TapsterError(
      `notarization ${result.status.toLowerCase()}${issues ? `: ${issues}` : ""}`,
      result.status === "In Progress" ? "Apple took longer than 30 minutes; the draft is untouched and the next run submits again." : "The draft is untouched; fix the build and release again.",
    );
  }
  return result;
}

export async function zipForNotary(dir: string, out: string): Promise<void> {
  await run("ditto", ["-c", "-k", "--keepParent", dir, out]);
}
