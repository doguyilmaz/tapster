import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTarGz } from "../../../src/archive";
import { rawTarGz } from "../../helpers/rawtar";

const repo = "doguyilmaz/tapster-fixture";
const dir = mkdtempSync(join(tmpdir(), "fixture-"));
writeFileSync(join(dir, "main.c"), 'int main(void){return 0;}\n');
await $`clang -arch arm64 -o ${join(dir, "fixture")} ${join(dir, "main.c")}`;
const bin = Bun.file(join(dir, "fixture"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function draft(tag: string, archive: Buffer, sums: string) {
  const v = tag.slice(1);
  const a = join(dir, `fixture_${v}_darwin_arm64.tar.gz`);
  writeFileSync(a, archive);
  writeFileSync(join(dir, "checksums.txt"), sums.replaceAll("{a}", sha(archive)).replaceAll("{v}", v));
  await $`git -C ${dir} init -q`.quiet();
  await $`gh release create ${tag} ${a} ${join(dir, "checksums.txt")} --repo ${repo} --draft --title ${tag} --notes fixture`;
}

const good = writeTarGz([{ name: "fixture", type: "file", mode: 0o755, data: Buffer.from(await bin.arrayBuffer()) }], 1_700_000_000);
await draft("v0.0.1", good, "{a}  fixture_{v}_darwin_arm64.tar.gz\n");
await draft("v0.0.2", good, "not a checksum line\n");
await draft("v0.0.3", rawTarGz([{ name: "../evil", data: "x" }]), "{a}  fixture_{v}_darwin_arm64.tar.gz\n");
