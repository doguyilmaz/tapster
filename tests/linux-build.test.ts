import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTarGz } from "../src/archive";
import { type CliPackage, parseConfig } from "../src/config";
import { buildLinux, linuxTargets, manifestJson, nfpmConfig, packageFiles } from "../src/linux/build";
import { installNfpm, nfpmPackager } from "../src/linux/nfpm";
import { emptyState, upsert } from "../src/state";

const cfg = parseConfig(
  `version: 1
tap: o/tap
linux: { maintainer: "Dogu Yilmaz <dogu@example.com>" }
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    linux: true
    description: Several accounts on one machine
    license: MIT
    completions: { bash: completions/aims.bash, zsh: completions/_aims, fish: completions/aims.fish }
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
      linux-arm64: "aims_{version}_linux_arm64.tar.gz"
  - name: ebb
    repo: o/ebb
    binaries: [ebb]
    assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz" }
`,
  "o",
);
const aims = cfg.packages[0] as CliPackage;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let ids = 0;
const entry = (tag: string, checksums = "b".repeat(64)) => ({ tag, releaseId: ++ids, checksums, status: "published" as const });

test("only the latest stable release of each Linux package is packaged", () => {
  let state = emptyState();
  for (const tag of ["v0.1.4", "v0.1.5", "v0.2.0-rc.1"]) state = upsert(state, "aims", entry(tag));
  state = upsert(state, "ebb", entry("v1.0.0"));
  const targets = linuxTargets(cfg, state);
  expect(targets.map((t) => `${t.pkg.name} ${t.version}`)).toEqual(["aims 0.1.5"]);
  expect(targets[0]!.assets).toEqual([
    { platform: "linux-amd64", name: "aims_0.1.5_linux_amd64.tar.gz" },
    { platform: "linux-arm64", name: "aims_0.1.5_linux_arm64.tar.gz" },
  ]);
  expect(manifestJson(targets)).toBe('{"packages":{"aims":"0.1.5"}}\n');
});

test("files land where each packager expects them", () => {
  const deb = packageFiles(aims, "deb", "/s");
  expect(deb).toEqual([
    { src: "/s/aims", dst: "/usr/bin/aims", mode: 0o755 },
    { src: "/s/completions/aims.bash", dst: "/usr/share/bash-completion/completions/aims", mode: 0o644 },
    { src: "/s/completions/_aims", dst: "/usr/share/zsh/vendor-completions/_aims", mode: 0o644 },
    { src: "/s/completions/aims.fish", dst: "/usr/share/fish/vendor_completions.d/aims.fish", mode: 0o644 },
  ]);
  expect(packageFiles(aims, "rpm", "/s")[2]!.dst).toBe("/usr/share/zsh/site-functions/_aims");
});

test("the nfpm config quotes every value", () => {
  const text = nfpmConfig({ name: "aims", version: "0.1.5", arch: "arm64", maintainer: "Dogu Yilmaz <dogu@example.com>", description: 'say "hi"\nmore', homepage: "https://x.y", license: "MIT", files: [{ src: "/s/aims", dst: "/usr/bin/aims", mode: 0o755 }] });
  expect(text).toContain('name: "aims"');
  expect(text).toContain('description: "say \\"hi\\"\\nmore"');
  expect(text).toContain("    file_info: { mode: 0755 }");
  expect(text).toContain('release: "1"');
});

function release(binaries: Record<string, string>) {
  const tar = writeTarGz(Object.entries(binaries).map(([name, data]) => ({ name, type: "file" as const, mode: 0o755, data: Buffer.from(data) })), 0);
  const assets: Record<string, Buffer> = { "aims_0.1.5_linux_amd64.tar.gz": tar, "aims_0.1.5_linux_arm64.tar.gz": tar };
  const sums = Buffer.from(Object.entries(assets).map(([n, d]) => `${sha(d)}  ${n}\n`).join(""));
  return { assets, sums };
}

function fakeFetch(files: Record<string, Buffer>, live: string | null): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/tapster-linux.json")) return live === null ? new Response("no", { status: 404 }) : new Response(live);
    const name = u.split("/").pop()!;
    return files[name] ? new Response(files[name]) : new Response("no", { status: 404 });
  }) as typeof fetch;
}

const fullArchive = { aims: "bin", "completions/aims.bash": "b", "completions/_aims": "z", "completions/aims.fish": "f" };
const packager = async (config: string, kind: "deb" | "rpm", dir: string) => {
  const arch = /arch: "(\w+)"/.exec(readFileSync(config, "utf8"))![1]!;
  writeFileSync(join(dir, kind === "deb" ? `aims_0.1.5-1_${arch}.deb` : `aims-0.1.5-1.${arch === "amd64" ? "x86_64" : "aarch64"}.rpm`), "pkg");
};

test("a release builds when the live site is older and stops when it is current", async () => {
  const { assets, sums } = release(fullArchive);
  const state = upsert(emptyState(), "aims", entry("v0.1.5", sha(sums)));
  const out = mkdtempSync(join(tmpdir(), "linux-"));
  const built = await buildLinux(cfg, state, "o/homebrew-tap", { fetch: fakeFetch({ ...assets, "checksums.txt": sums }, '{"packages":{"aims":"0.1.4"}}\n'), out, packager });
  expect(built).toEqual({ changed: true, failed: [] });
  expect(existsSync(join(out, "apt/pool/main/aims_0.1.5-1_amd64.deb"))).toBe(true);
  expect(existsSync(join(out, "rpm/aarch64/aims-0.1.5-1.aarch64.rpm"))).toBe(true);
  expect(readFileSync(join(out, "tapster-linux.json"), "utf8")).toBe('{"packages":{"aims":"0.1.5"}}\n');
  const again = await buildLinux(cfg, state, "o/homebrew-tap", { fetch: fakeFetch({ ...assets, "checksums.txt": sums }, '{"packages":{"aims":"0.1.5"}}\n'), out: mkdtempSync(join(tmpdir(), "linux-")), packager });
  expect(again.changed).toBe(false);
});

test("a changed checksums file or a missing file stops the deploy", async () => {
  const { assets, sums } = release(fullArchive);
  const moved = await buildLinux(cfg, upsert(emptyState(), "aims", entry("v0.1.5", "c".repeat(64))), "o/homebrew-tap", { fetch: fakeFetch({ ...assets, "checksums.txt": sums }, null), out: mkdtempSync(join(tmpdir(), "linux-")), packager });
  expect(moved.changed).toBe(false);
  expect(moved.failed[0]).toMatch(/checksums.txt/);
  const thin = release({ aims: "bin" });
  const missing = await buildLinux(cfg, upsert(emptyState(), "aims", entry("v0.1.5", sha(thin.sums))), "o/homebrew-tap", { fetch: fakeFetch({ ...thin.assets, "checksums.txt": thin.sums }, null), out: mkdtempSync(join(tmpdir(), "linux-")), packager });
  expect(missing.changed).toBe(false);
  expect(missing.failed[0]).toMatch(/completions\/aims.bash/);
});

test("nfpm is installed only when its archive matches the pin and runs with a fixed date", async () => {
  const fake = writeTarGz([{ name: "nfpm", type: "file", mode: 0o755, data: Buffer.from('#!/bin/sh\necho "$SOURCE_DATE_EPOCH $*" > "$(dirname "$0")/called"\n') }], 0);
  const fetchImpl = (async () => new Response(fake)) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "nfpm-"));
  await expect(installNfpm(fetchImpl, dir, { url: "https://x/nfpm.tgz", sha256: "0".repeat(64) })).rejects.toThrow(/nfpm/);
  const path = await installNfpm(fetchImpl, dir, { url: "https://x/nfpm.tgz", sha256: sha(fake) });
  await nfpmPackager(path)("/c.yaml", "deb", "/out");
  expect(readFileSync(join(dir, "called"), "utf8")).toBe("315532800 package --config /c.yaml --packager deb --target /out/\n");
});
