import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findCode } from "./bundle";
import type { AppPackage } from "./config";
import { type Entitlements, entitlementsFor, parseEntitlements, renderEntitlements } from "./entitlements";
import { TapsterError } from "./errors";
import { identifierFor } from "./identity";
import type { Keychain } from "./keychain";
import { run } from "./run";
import { codesignArgs, verifySigned } from "./sign";

export async function readEntitlements(path: string): Promise<Entitlements> {
  const res = await run("codesign", ["-d", "--entitlements", "-", "--xml", path], { allowFail: true });
  if (res.code !== 0) {
    if (/not signed at all/.test(res.stderr)) return {};
    throw new TapsterError(`codesign could not read the entitlements of ${basename(path)}`, "Rebuild the app.");
  }
  return parseEntitlements(res.stdout);
}

export type SignedApp = { items: string[]; identifiers: string[]; dropped: string[] };

export async function signApp(kc: Keychain, appDir: string, pkg: AppPackage, team: string, timestamp = true): Promise<SignedApp> {
  const items = findCode(appDir);
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ent-"));
  const identifiers: string[] = [];
  const dropped: string[] = [];
  try {
    for (const [n, item] of items.entries()) {
      const path = item.path === "." ? appDir : join(appDir, item.path);
      const id = identifierFor(item, pkg);
      const ent = entitlementsFor(item.path, await readEntitlements(path), pkg, team);
      dropped.push(...ent.dropped.map((k) => `${item.path}: ${k}`));
      let file: string | null = null;
      if (Object.keys(ent.entitlements).length > 0) {
        file = join(dir, `${n}.plist`);
        await writeFile(file, renderEntitlements(ent.entitlements));
      }
      await run("codesign", codesignArgs(kc, path, file, id, timestamp));
      identifiers.push(id);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { items: items.map((i) => i.path), identifiers, dropped };
}

export async function verifyApp(appDir: string, signed: SignedApp, team: string): Promise<void> {
  await run("codesign", ["--verify", "--strict", "--deep", appDir]);
  for (const [i, p] of signed.items.entries()) await verifySigned(p === "." ? appDir : join(appDir, p), team, signed.identifiers[i]);
}
