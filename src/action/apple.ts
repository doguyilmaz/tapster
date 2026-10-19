import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Keychain, openKeychain } from "../keychain";
import { readSecret, register, requireVar } from "../mask";
import type { NotaryKey } from "../sign";
import { workdir } from "../workdir";

export async function withApple(work: (kc: Keychain, notary: NotaryKey, team: string) => Promise<void>): Promise<void> {
  const p12 = readSecret("MACOS_SIGN_P12");
  const password = readSecret("MACOS_SIGN_PASSWORD");
  const rawKey = readSecret("MACOS_NOTARY_KEY");
  const keyId = readSecret("MACOS_NOTARY_KEY_ID");
  const issuer = readSecret("MACOS_NOTARY_ISSUER_ID");
  const team = requireVar("TAPSTER_TEAM_ID");
  const p8 = rawKey.includes("BEGIN PRIVATE KEY") ? rawKey : Buffer.from(rawKey, "base64").toString("utf8");
  register(p8);
  const kc = await openKeychain(p12, password, team, workdir());
  const p8Path = join(workdir(), "notary.p8");
  await writeFile(p8Path, p8, { mode: 0o600 });
  try {
    await work(kc, { p8Path, keyId, issuer }, team);
  } finally {
    await rm(p8Path, { force: true });
    await kc.close();
  }
}
