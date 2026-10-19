import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { byHashPaths, checkTree, expectedFiles, indexHtml, releaseOptions, repoFile, rpmsignArgs } from "../src/linux/sign";
import type { Expected } from "../src/linux/verify";

const e = (name: string, debArch: string, rpmArch: string): Expected => ({ name, version: "0.1.5", debArch, rpmArch, maintainer: "D <d@x.yz>", description: "d", homepage: "https://x.y", deb: [], rpm: [] });
const exps = [e("aims", "amd64", "x86_64"), e("aims", "arm64", "aarch64")];

test("the artifact must hold exactly the expected packages", () => {
  expect(expectedFiles(exps)).toEqual([
    "apt/pool/main/aims_0.1.5-1_amd64.deb",
    "apt/pool/main/aims_0.1.5-1_arm64.deb",
    "rpm/aarch64/aims-0.1.5-1.aarch64.rpm",
    "rpm/x86_64/aims-0.1.5-1.x86_64.rpm",
    "tapster-linux.json",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "tree-"));
  for (const f of expectedFiles(exps)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  expect(() => checkTree(dir, expectedFiles(exps))).not.toThrow();
  writeFileSync(join(dir, "rpm/x86_64/extra.rpm"), "x");
  expect(() => checkTree(dir, expectedFiles(exps))).toThrow(/extra.rpm/);
  const linked = mkdtempSync(join(tmpdir(), "tree-"));
  for (const f of expectedFiles(exps)) {
    mkdirSync(dirname(join(linked, f)), { recursive: true });
    if (f.endsWith("amd64.deb")) symlinkSync("/etc/passwd", join(linked, f));
    else writeFileSync(join(linked, f), "x");
  }
  expect(() => checkTree(linked, expectedFiles(exps))).toThrow(/amd64.deb/);
});

test("Release names its architectures and lists hashes by SHA-256 and SHA-512 only", () => {
  const opts = releaseOptions("o");
  expect(opts).toContain("APT::FTPArchive::Release::Architectures=amd64 arm64");
  expect(opts).toContain("APT::FTPArchive::Release::Acquire-By-Hash=yes");
  expect(opts).toContain("APT::FTPArchive::Release::Origin=o tapster");
  expect(opts).toContain("APT::FTPArchive::MD5=false");
  expect(opts).toContain("APT::FTPArchive::SHA1=false");
});

test("users get a repo file and a page with the key's fingerprint", () => {
  const repo = repoFile("o", "https://o.github.io/homebrew-tap");
  expect(repo).toContain("baseurl=https://o.github.io/homebrew-tap/rpm/$basearch");
  expect(repo).toContain("gpgcheck=1");
  expect(repo).not.toContain("repo_gpgcheck");
  expect(repo).toContain("metadata_expire=1h");
  expect(repo).toContain("gpgkey=https://o.github.io/homebrew-tap/o-tapster.asc");
  const page = indexHtml("o", "https://o.github.io/homebrew-tap", "ABCD1234", ["aims"]);
  expect(page).toContain("ABCD1234");
  expect(page).toContain("https://o.github.io/homebrew-tap/o-tapster.pgp");
  expect(page).toContain("sudo apt install aims");
  expect(page).not.toContain("<script");
});

test("rpm signatures are made at the key's creation time and name no key material", () => {
  const args = rpmsignArgs("FPR123", "1792373475", "/tmp/g", ["/a.rpm"]);
  expect(args).toContain("_gpg_sign_cmd_extra_args --faked-system-time 1792373475!");
  expect(args).toContain("_gpg_name FPR123");
  expect(args).toContain("_gpg_digest_algo sha512");
  expect(args.at(-1)).toBe("/a.rpm");
});

test("each index is copied under every hash Release lists, so apt can fetch it by hash", () => {
  const data = Buffer.from("Package: aims\n");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  expect(byHashPaths(data)).toEqual([`by-hash/SHA256/${createHash("sha256").update(data).digest("hex")}`, `by-hash/SHA512/${createHash("sha512").update(data).digest("hex")}`]);
});
