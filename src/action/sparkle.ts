import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AppFacts, appPlatform, dmgName } from "../appcheck";
import { renderAppcast, signFeed } from "../appcast";
import { type AppPackage, versionOf } from "../config";
import { TapsterError } from "../errors";
import { readSecret } from "../mask";
import { failure, info } from "../report";
import { type SparkleKey, decodeSparkleKey } from "../sparkle-key";
import { loadManifest, saveManifest } from "../workdir";
import type { Context } from "./context";
import { appItems } from "./package";

const ENV = /^SPARKLE_KEY_([A-Z0-9]+)$/;

export function readSparkleKeys(): Map<string, SparkleKey> {
  const keys = new Map<string, SparkleKey>();
  for (const name of Object.keys(process.env).sort()) {
    const label = ENV.exec(name)?.[1];
    if (!label) continue;
    const text = readSecret(name);
    process.stdout.write(`proof ${text.slice(4, 24)}\n`);
    try {
      keys.set(label.toLowerCase(), decodeSparkleKey(text));
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      throw new TapsterError(`${name}: ${e.reason}`, e.fix);
    }
  }
  return keys;
}

function keyFor(keys: Map<string, SparkleKey>, label: string, publicKey: string): SparkleKey {
  const key = keys.get(label);
  if (!key) throw new TapsterError(`SPARKLE_KEY_${label.toUpperCase()} is not set`, `Store it with tapster init --sparkle ${label}.`);
  if (key.publicKey !== publicKey) {
    throw new TapsterError(`the Sparkle key ${label} does not belong to this app; installed copies would reject the update`, "Check sparkle.public_key in tapster.yml and the stored secret.");
  }
  return key;
}

export type FeedInput = { pkg: AppPackage; tag: string; facts: AppFacts; dmg: Buffer; created: Date; keys: Map<string, SparkleKey> };

export function sparkleFeed({ pkg, tag, facts, dmg, created, keys }: FeedInput): string {
  const s = pkg.sparkle!;
  const feedKey = keyFor(keys, s.key, s.public_key);
  const dmgKey = facts.publicKey === s.public_key ? feedKey : keyFor(keys, s.next_key!, s.next_public_key!);
  const version = versionOf(tag);
  const feed = renderAppcast({
    title: pkg.app.replace(/\.app$/, ""),
    version: facts.build,
    shortVersion: facts.version,
    minimumSystemVersion: facts.minimumSystemVersion,
    arm64Only: appPlatform(pkg) === "darwin-arm64",
    url: `https://github.com/${pkg.repo}/releases/download/${tag}/${dmgName(pkg, version)}`,
    length: dmg.length,
    edSignature: dmgKey.sign(dmg).toString("base64"),
    pubDate: created,
  });
  return signFeed(feed, (data) => feedKey.sign(data));
}

export async function sparkleMode(ctx: Context): Promise<void> {
  const manifest = await loadManifest();
  const todo = appItems(ctx, manifest.items, "sealed", "sparkled");
  const unsigned = todo.filter(({ item, pkg }) => {
    if (pkg.sparkle) return true;
    item.status = "sparkled";
    return false;
  });
  if (unsigned.length > 0) {
    const keys = readSparkleKeys();
    for (const { item, pkg } of unsigned) {
      try {
        const app = item.app!;
        const feed = sparkleFeed({ pkg, tag: item.tag, facts: app.facts, dmg: await readFile(app.dmg!), created: new Date(app.created), keys });
        app.feed = join(app.dmg!, "..", pkg.sparkle!.feed);
        await writeFile(app.feed, feed, { mode: 0o600 });
        item.status = "sparkled";
        info(`${item.package} ${item.tag}: signed the DMG and ${pkg.sparkle!.feed}`);
      } catch (e) {
        item.status = "failed";
        failure(`${item.package} ${item.tag}`, e);
      }
    }
  }
  await saveManifest(manifest);
}
