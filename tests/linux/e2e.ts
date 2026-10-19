import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { writeTarGz } from "../../src/archive";
import { parseConfig } from "../../src/config";
import { buildLinux } from "../../src/linux/build";
import { NFPM, installNfpm, nfpmPackager } from "../../src/linux/nfpm";
import { signLinux } from "../../src/linux/sign";
import { emptyState, upsert } from "../../src/state";

const root = process.argv[2]!;
const key = readFileSync(process.argv[3]!, "utf8");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const config = parseConfig(
  `version: 1
tap: o/tap
linux: { maintainer: "Tapster Test <test@example.com>" }
packages:
  - name: fixture
    repo: o/fixture
    binaries: [fixture]
    linux: true
    description: Test package for the tapster Linux repositories
    completions: { bash: completions/fixture.bash }
    assets:
      linux-amd64: "fixture_{version}_linux_amd64.tar.gz"
      linux-arm64: "fixture_{version}_linux_arm64.tar.gz"
`,
  "o",
);
const tar = writeTarGz(
  [
    { name: "fixture", type: "file", mode: 0o755, data: Buffer.from("#!/bin/sh\necho fixture works\n") },
    { name: "completions/fixture.bash", type: "file", mode: 0o644, data: Buffer.from("complete -W 'a b' fixture\n") },
  ],
  0,
);
const files: Record<string, Buffer> = { "fixture_1.2.3_linux_amd64.tar.gz": tar, "fixture_1.2.3_linux_arm64.tar.gz": tar };
files["checksums.txt"] = Buffer.from(Object.entries(files).map(([n, d]) => `${sha(d)}  ${n}\n`).join(""));
const state = upsert(emptyState(), "fixture", { tag: "v1.2.3", releaseId: 1, checksums: sha(files["checksums.txt"]), status: "published" });
const local = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.startsWith("https://github.com/goreleaser/")) return fetch(u);
  const name = u.split("/").pop()!;
  return files[name] ? new Response(files[name]) : new Response("no", { status: 404 });
}) as typeof fetch;

const tools = mkdtempSync(join(root, "tools-"));
const nfpm = await installNfpm(fetch, tools, NFPM[process.arch === "arm64" ? "arm64" : "x64"]);
const sites: string[] = [];
for (const n of [1, 2]) {
  const out = join(root, `site${n}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const built = await buildLinux(config, state, "o/homebrew-tap", { fetch: local, out, packager: nfpmPackager(nfpm) });
  if (!built.changed || built.failed.length) throw new Error(`build ${n}: ${JSON.stringify(built)}`);
  const signed = await signLinux({ dir: out, config, state, owner: "o", url: "http://repo:8000", key, fetch: local });
  console.log(`site${n}: ${signed.packages} packages signed by ${signed.fingerprint}`);
  sites.push(out);
}
const packages = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(deb|rpm)$/.test(e.name))
    .map((e) => [relative(dir, join(e.parentPath, e.name)), sha(readFileSync(join(e.parentPath, e.name)))] as const)
    .sort();
const [a, b] = [packages(sites[0]!), packages(sites[1]!)];
if (JSON.stringify(a) !== JSON.stringify(b) || a.length !== 4) throw new Error(`packages differ between builds: ${JSON.stringify({ a, b })}`);
console.log(`the same ${a.length} package files both times`);

const evil = join(root, "evil");
mkdirSync(evil, { recursive: true });
const { writeFileSync } = await import("node:fs");
writeFileSync(join(evil, "fixture"), "#!/bin/sh\necho fixture works\n", { mode: 0o755 });
writeFileSync(join(evil, "fixture.bash"), "complete -W 'a b' fixture\n");
writeFileSync(join(evil, "evil"), "x\n");
writeFileSync(join(evil, "post.sh"), "#!/bin/sh\ntouch /tmp/owned\n");
for (const [kind, target] of [["deb", "apt/pool/main"], ["rpm", "rpm/x86_64"]] as const) {
  for (const plant of ["file", "script"] as const) {
    const out = join(root, `site-${kind}-${plant}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    await buildLinux(config, state, "o/homebrew-tap", { fetch: local, out, packager: nfpmPackager(nfpm) });
    const yaml = `name: "fixture"
arch: "amd64"
platform: "linux"
version: "1.2.3"
release: "1"
maintainer: "Tapster Test <test@example.com>"
description: "Test package for the tapster Linux repositories"
homepage: "https://github.com/o/fixture"
contents:
  - { src: "${evil}/fixture", dst: "/usr/bin/fixture", file_info: { mode: 0755 } }
  - { src: "${evil}/fixture.bash", dst: "/usr/share/bash-completion/completions/fixture", file_info: { mode: 0644 } }
${plant === "file" ? `  - { src: "${evil}/evil", dst: "/etc/evil", file_info: { mode: 0644 } }\n` : `scripts: { postinstall: "${evil}/post.sh" }\n`}`;
    writeFileSync(join(evil, `${kind}.yaml`), yaml);
    await nfpmPackager(nfpm)(join(evil, `${kind}.yaml`), kind, join(out, target));
    const refused = await signLinux({ dir: out, config, state, owner: "o", url: "http://repo:8000", key, fetch: local }).then(
      () => null,
      (e: Error) => e.message,
    );
    const want = plant === "file" ? /\betc\b/ : /postinst|script|header tags/;
    if (!refused || !want.test(refused)) throw new Error(`the ${kind} with a planted ${plant} was not refused: ${refused}`);
    console.log(`refused the ${kind} with a planted ${plant}: ${refused}`);
  }
}
