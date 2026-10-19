import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(process.argv[2]!, "tapster");
const config = parse(readFileSync("tests/leak/hub/sparkle.yml", "utf8")) as { packages: { name: string; sparkle: { public_key: string } }[] };
const items = config.packages.map((p) => {
  const out = join(root, p.name, "v1.0.0", "out");
  mkdirSync(out, { recursive: true });
  const dmg = join(out, "app.dmg");
  writeFileSync(dmg, `not really a disk image for ${p.name}\n`);
  const facts = { version: "1.0.0", build: "1.0.0", minimumSystemVersion: "15.0", macos: "sequoia", publicKey: p.sparkle.public_key };
  const app = { dir: join(root, p.name, "app"), facts, created: "2026-10-19T10:00:00Z", identifiers: [], dmg, feed: null };
  return { package: p.name, tag: "v1.0.0", releaseId: 1, resume: false, before: [], checksums: [], archives: [], app, status: "sealed" };
});
writeFileSync(join(root, "manifest.json"), JSON.stringify({ items }));
