import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type CodeItem, findCode } from "./bundle";
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

export function checkPlan(items: CodeItem[], pkg: AppPackage): string[] {
  const paths = new Set(items.map((i) => i.path));
  for (const path of Object.keys(pkg.code)) {
    if (!paths.has(path)) throw new TapsterError(`code in tapster.yml names ${path}, which the app does not contain`, "Fix the path under code.");
  }
  const ids = items.map((i) => identifierFor(i, pkg));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id.toLowerCase())) throw new TapsterError(`two pieces of code in the app would be signed as ${id}`, "Rename one of them, or set its identifier under code.");
    seen.add(id.toLowerCase());
  }
  return ids;
}

export async function signApp(kc: Keychain, appDir: string, pkg: AppPackage, team: string): Promise<SignedApp> {
  const items = findCode(appDir);
  const planned = checkPlan(items, pkg);
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ent-"));
  const identifiers: string[] = [];
  const dropped: string[] = [];
  try {
    for (const [n, item] of items.entries()) {
      const path = item.path === "." ? appDir : join(appDir, item.path);
      const id = planned[n]!;
      const ent = entitlementsFor(item.path, await readEntitlements(path), pkg, team);
      dropped.push(...ent.dropped.map((k) => `${item.path}: ${k}`));
      let file: string | null = null;
      if (Object.keys(ent.entitlements).length > 0) {
        file = join(dir, `${n}.plist`);
        await writeFile(file, renderEntitlements(ent.entitlements));
      }
      await run("codesign", codesignArgs(kc, path, file, id));
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
