import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificateNames, isCertificateSecret } from "../certificates";
import { TapsterError } from "../errors";
import { type Keychain, openKeychain } from "../keychain";
import { readSecret, register, requireVar } from "../mask";
import type { NotaryKey } from "../sign";
import { workdir } from "../workdir";

export type OpenKeychain = typeof openKeychain;
export type AppleSet = { kc: Keychain; notary: NotaryKey; team: string; close(): Promise<void> };

// Opens the hub's certificate (label null) and labeled ones for one mode run. readSecret removes a secret
// from the environment, so each is read once and kept here: the hub's notary key may serve the hub's
// certificate and a labeled certificate of the same team.
export function appleCredentials(open: OpenKeychain = openKeychain) {
  const taken = new Map<string, string>();
  const secret = (name: string) => {
    if (!taken.has(name)) taken.set(name, readSecret(name));
    return taken.get(name)!;
  };
  // Every certificate secret is registered with the masker and leaves the environment before any tool runs.
  for (const name of Object.keys(process.env).sort()) {
    if (!isCertificateSecret(name)) continue;
    if (process.env[name]) secret(name);
    else delete process.env[name];
  }
  const given = (name: string) => taken.has(name) || Boolean(process.env[name]);

  function notaryNames(label: string | null, team: string) {
    const own = certificateNames(label);
    if (label === null || [own.notaryKey, own.notaryKeyId, own.notaryIssuer].some(given)) return own;
    if (team === process.env.TAPSTER_TEAM_ID) return certificateNames(null);
    throw new TapsterError(
      `the certificate belongs to team ${team}, and the hub has no notary key for that team`,
      `Store that team's App Store Connect key with tapster init --certificate ${label} --notary or in tapster setup (Optional extras).`,
    );
  }

  async function openSet(label: string | null): Promise<AppleSet> {
    const n = certificateNames(label);
    const p12 = secret(n.p12);
    const password = secret(n.password);
    const team = requireVar(n.team);
    const notary = notaryNames(label, team);
    const rawKey = secret(notary.notaryKey);
    const keyId = secret(notary.notaryKeyId);
    const issuer = secret(notary.notaryIssuer);
    const p8 = rawKey.includes("BEGIN PRIVATE KEY") ? rawKey : Buffer.from(rawKey, "base64").toString("utf8");
    register(p8);
    const kc = await open(p12, password, team, workdir());
    const p8Path = join(workdir(), label === null ? "notary.p8" : `notary-${label}.p8`);
    try {
      await writeFile(p8Path, p8, { mode: 0o600 });
    } catch (e) {
      await kc.close();
      throw e;
    }
    const close = async () => {
      await rm(p8Path, { force: true });
      await kc.close();
    };
    return { kc, notary: { p8Path, keyId, issuer }, team, close };
  }

  return {
    async open(label: string | null): Promise<AppleSet> {
      try {
        return await openSet(label);
      } catch (e) {
        if (label === null || !(e instanceof TapsterError)) throw e;
        throw new TapsterError(`certificate ${label}: ${e.reason}`, e.fix);
      }
    },
  };
}

// Groups the items by the certificate their package names (in order of first appearance), opens each
// certificate once and hands its items to work. A certificate that cannot be opened fails only its items.
export async function withApple<T>(
  todo: T[],
  labelOf: (t: T) => string | null,
  fail: (t: T, e: unknown) => void,
  work: (set: AppleSet, items: T[]) => Promise<void>,
  open: OpenKeychain = openKeychain,
): Promise<void> {
  if (todo.length === 0) return;
  const groups = new Map<string | null, T[]>();
  for (const t of todo) {
    const label = labelOf(t);
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  const apple = appleCredentials(open);
  for (const [label, items] of groups) {
    let set: AppleSet;
    try {
      set = await apple.open(label);
    } catch (e) {
      for (const t of items) fail(t, e);
      continue;
    }
    try {
      await work(set, items);
    } finally {
      await set.close();
    }
  }
}
