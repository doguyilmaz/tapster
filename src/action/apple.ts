import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificateNames, isCertificateSecret } from "../certificates";
import { TapsterError } from "../errors";
import { type Keychain, ROTATE_CERTIFICATE, openKeychain } from "../keychain";
import { readSecret, register, requireVar } from "../mask";
import { type NotaryKey, ROTATE_NOTARY } from "../sign";
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
  const notarySecrets = (label: string | null) => {
    const n = certificateNames(label);
    return [n.notaryKey, n.notaryKeyId, n.notaryIssuer];
  };
  // A labeled certificate notarizes with its own key as soon as one of its notary secrets is set.
  const ownNotary = (label: string | null) => label !== null && notarySecrets(label).some(given);
  const storeCertificate = (label: string) => `Store it with tapster init --certificate ${label} in a clone of the hub or in tapster setup (Optional extras).`;
  const storeNotary = (label: string) => `Store that team's App Store Connect key with tapster init --certificate ${label} --notary or in tapster setup (Optional extras).`;

  function notaryNames(label: string | null, team: string) {
    if (label === null) return certificateNames(null);
    if (ownNotary(label)) {
      const gap = notarySecrets(label).find((s) => !given(s));
      if (gap) throw new TapsterError(`${gap} is not set`, storeNotary(label));
      return certificateNames(label);
    }
    if (team === process.env.TAPSTER_TEAM_ID) return certificateNames(null);
    throw new TapsterError(`the certificate belongs to team ${team} and the hub has no notary key for that team`, storeNotary(label));
  }

  async function openSet(label: string | null): Promise<AppleSet> {
    const n = certificateNames(label);
    if (label !== null) {
      const gap = [n.p12, n.password, n.team].find((s) => !given(s));
      if (gap) throw new TapsterError(`${gap} is not set`, storeCertificate(label));
    }
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

  // A failure of a labeled certificate names it, and its fix stores that certificate (and its own notary key, when it
  // has one) rather than the hub's, which may be working.
  function explain(label: string | null, e: unknown): unknown {
    if (label === null || !(e instanceof TapsterError)) return e;
    const fix = e.fix.replaceAll(ROTATE_CERTIFICATE, `tapster init --certificate ${label}`).replaceAll(ROTATE_NOTARY, ownNotary(label) ? `tapster init --certificate ${label} --notary` : ROTATE_NOTARY);
    return new TapsterError(`certificate ${label}: ${e.reason}`, fix);
  }

  return {
    async open(label: string | null): Promise<AppleSet> {
      try {
        return await openSet(label);
      } catch (e) {
        throw explain(label, e);
      }
    },
    explain,
  };
}

// Groups the items by the certificate their package names (in order of first appearance), opens each
// certificate once and hands it each of its items. A certificate that cannot be opened fails only its items;
// an item that fails fails alone, under its certificate's label.
export async function withApple<T>(
  todo: T[],
  labelOf: (t: T) => string | null,
  fail: (t: T, e: unknown) => void,
  each: (set: AppleSet, t: T) => Promise<void>,
  open: OpenKeychain = openKeychain,
): Promise<void> {
  // Building the credentials registers every certificate secret and takes it out of the environment, also when there
  // is nothing to sign: no step of this run should leave a secret in the environment unregistered.
  const apple = appleCredentials(open);
  if (todo.length === 0) return;
  const groups = new Map<string | null, T[]>();
  for (const t of todo) {
    const label = labelOf(t);
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  for (const [label, items] of groups) {
    let set: AppleSet;
    try {
      set = await apple.open(label);
    } catch (e) {
      for (const t of items) fail(t, e);
      continue;
    }
    try {
      for (const t of items) {
        try {
          await each(set, t);
        } catch (e) {
          fail(t, apple.explain(label, e));
        }
      }
    } finally {
      await set.close();
    }
  }
}
