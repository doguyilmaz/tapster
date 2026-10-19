import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapsterError } from "./errors";
import { register } from "./mask";
import { run } from "./run";

export type Identity = { sha1: string; name: string; teamId: string };
export type Keychain = { path: string; identity: string; teamId: string; close(): Promise<void> };

export function parseIdentities(out: string): Identity[] {
  const ids: Identity[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (!m) continue;
    const team = /\(([A-Z0-9]{10})\)$/.exec(m[2]!);
    if (team) ids.push({ sha1: m[1]!, name: m[2]!, teamId: team[1]! });
  }
  return ids;
}

export function parseKeychainList(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export async function openKeychain(p12Base64: string, p12Password: string, expectedTeamId: string, root: string): Promise<Keychain> {
  const dir = await mkdtemp(join(root, "kc-"));
  await chmod(dir, 0o700);
  const path = join(dir, "tapster.keychain-db");
  const kcPass = randomBytes(24).toString("hex");
  const oneTime = randomBytes(24).toString("hex");
  register(kcPass);
  register(oneTime);
  const previous = parseKeychainList((await run("security", ["list-keychains", "-d", "user"])).stdout);
  const close = async () => {
    await run("security", ["list-keychains", "-d", "user", "-s", ...previous], { allowFail: true });
    await run("security", ["delete-keychain", path], { allowFail: true });
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const input = join(dir, "in.p12");
    const pem = join(dir, "key.pem");
    const wrapped = join(dir, "wrapped.p12");
    await writeFile(input, Buffer.from(p12Base64, "base64"), { mode: 0o600 });
    await run("openssl", ["pkcs12", "-in", input, "-passin", "env:TAPSTER_P12_IN", "-passout", "env:TAPSTER_P12_ONE", "-out", pem], {
      env: { TAPSTER_P12_IN: p12Password, TAPSTER_P12_ONE: oneTime },
    });
    await run("openssl", ["pkcs12", "-export", "-in", pem, "-passin", "env:TAPSTER_P12_ONE", "-passout", "env:TAPSTER_P12_ONE", "-out", wrapped], {
      env: { TAPSTER_P12_ONE: oneTime },
    });
    await rm(input);
    await rm(pem);
    await run("security", ["create-keychain", "-p", kcPass, path]);
    await run("security", ["set-keychain-settings", path]);
    await run("security", ["unlock-keychain", "-p", kcPass, path]);
    await run("security", ["import", wrapped, "-k", path, "-P", oneTime, "-T", "/usr/bin/codesign"]);
    await rm(wrapped);
    await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", kcPass, path]);
    await run("security", ["list-keychains", "-d", "user", "-s", path, ...previous]);
    const found = parseIdentities((await run("security", ["find-identity", "-v", "-p", "codesigning", path])).stdout);
    const id = found.find((i) => i.name.startsWith("Developer ID Application:"));
    if (!id) throw new TapsterError("the certificate holds no valid Developer ID Application identity", "Export the Developer ID Application certificate with its private key as .p12; tapster init --rotate certificate.");
    if (id.teamId !== expectedTeamId) throw new TapsterError(`the certificate belongs to team ${id.teamId}, not ${expectedTeamId}`, "Use the team's certificate. To change teams, run tapster init --rotate certificate.");
    return { path, identity: id.sha1, teamId: id.teamId, close };
  } catch (e) {
    await close();
    throw e;
  }
}
