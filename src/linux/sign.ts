import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { HubConfig } from "../config";
import { TapsterError } from "../errors";
import { run } from "../run";
import type { State } from "../state";
import { type Expected, checkDeb, checkRpm, debName, expectedPackages, readDeb, readRpm, rpmName } from "./verify";

const DEB_ARCHES = ["amd64", "arm64"];
const RPM_ARCHES = ["x86_64", "aarch64"];

export function expectedFiles(exps: Expected[]): string[] {
  const files = new Set(["tapster-linux.json", ...exps.map((e) => `apt/pool/main/${debName(e)}`), ...exps.map((e) => `rpm/${e.rpmArch}/${rpmName(e)}`)]);
  return [...files].sort();
}

export function checkTree(dir: string, expected: string[]): void {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = lstatSync(path);
      const rel = relative(dir, path).split(sep).join("/");
      if (st.isSymbolicLink()) throw new TapsterError(`the Linux build holds the symlink ${rel}`, "Check the linux-build job.");
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) found.push(rel);
      else throw new TapsterError(`the Linux build holds ${rel}, which is not a file`, "Check the linux-build job.");
    }
  };
  walk(dir);
  const want = new Set(expected);
  const extra = found.filter((f) => !want.has(f));
  if (extra.length) throw new TapsterError(`the Linux build holds ${extra.join(", ")}, which tapster did not expect`, "Check the linux-build job.");
  const missing = expected.filter((f) => !found.includes(f));
  if (missing.length) throw new TapsterError(`the Linux build lacks ${missing.join(", ")}`, "Check the linux-build job.");
}

export function releaseOptions(owner: string): string[] {
  const r = "APT::FTPArchive::Release";
  return [
    `${r}::Origin=${owner} tapster`,
    `${r}::Label=${owner} tapster`,
    `${r}::Suite=stable`,
    `${r}::Codename=stable`,
    `${r}::Architectures=${DEB_ARCHES.join(" ")}`,
    `${r}::Components=main`,
    `${r}::Acquire-By-Hash=yes`,
    "APT::FTPArchive::MD5=false",
    "APT::FTPArchive::SHA1=false",
  ];
}

export function repoFile(owner: string, url: string): string {
  return `[${owner}-tapster]
name=${owner} tapster
baseurl=${url}/rpm/$basearch
enabled=1
gpgcheck=1
gpgkey=${url}/${owner}-tapster.asc
metadata_expire=1h
`;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function indexHtml(owner: string, url: string, fingerprint: string, names: string[]): string {
  const example = names[0] ?? "<package>";
  const apt = `sudo curl -fsSLo /etc/apt/keyrings/${owner}-tapster.pgp ${url}/${owner}-tapster.pgp
printf 'Types: deb\\nURIs: ${url}/apt\\nSuites: stable\\nComponents: main\\nSigned-By: /etc/apt/keyrings/${owner}-tapster.pgp\\n' \\
  | sudo tee /etc/apt/sources.list.d/${owner}-tapster.sources
sudo apt update && sudo apt install ${example}`;
  const dnf = `sudo curl -fsSLo /etc/yum.repos.d/${owner}-tapster.repo ${url}/rpm/${owner}-tapster.repo
sudo dnf install ${example}`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(owner)} packages</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:46rem;margin:0 auto;padding:2rem 1rem}pre{background:#f1eee8;padding:1rem;border-radius:6px;overflow-x:auto}@media (prefers-color-scheme:dark){body{background:#161513;color:#ece9e3}pre{background:#26241f}}</style>
</head>
<body>
<h1>${escape(owner)} packages</h1>
<p>Packages: ${names.map(escape).join(", ") || "none yet"}.</p>
<h2>apt (Debian, Ubuntu)</h2>
<pre>${escape(apt)}</pre>
<h2>dnf (Fedora, RHEL)</h2>
<pre>${escape(dnf)}</pre>
<p>Signing key fingerprint: <code>${escape(fingerprint)}</code></p>
</body>
</html>
`;
}

export function rpmsignArgs(fingerprint: string, created: string, home: string, files: string[]): string[] {
  return [
    "--define", "__gpg /usr/bin/gpg",
    "--define", `_gpg_name ${fingerprint}`,
    "--define", `_gpg_path ${home}`,
    "--define", "_gpg_digest_algo sha512",
    "--define", `_gpg_sign_cmd_extra_args --faked-system-time ${created}!`,
    "--addsign",
    ...files,
  ];
}

type Key = { home: string; env: Record<string, string>; fingerprint: string; created: string };

async function withKey<T>(keyText: string, work: (k: Key) => Promise<T>): Promise<T> {
  const home = mkdtempSync("/tmp/tg-");
  const env = { GNUPGHOME: home };
  try {
    await run("gpg", ["--batch", "--quiet", "--import"], { env, stdin: keyText });
    const colons = (await run("gpg", ["--batch", "--with-colons", "--list-secret-keys"], { env })).stdout.split("\n");
    const sec = colons.find((l) => l.startsWith("sec:"))?.split(":");
    const fingerprint = colons.find((l) => l.startsWith("fpr:"))?.split(":")[9];
    if (!sec || !fingerprint || colons.filter((l) => l.startsWith("sec:")).length !== 1) throw new TapsterError("TAPSTER_LINUX_KEY does not hold exactly one secret key", "Store it again with tapster init --linux.");
    return await work({ home, env, fingerprint, created: sec[5]! });
  } finally {
    await run("gpgconf", ["--kill", "all"], { env, allowFail: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

export const byHashPaths = (data: Buffer) => ["sha256", "sha512"].map((h) => `by-hash/${h.toUpperCase()}/${createHash(h).update(data).digest("hex")}`);

export async function signLinux(o: { dir: string; config: HubConfig; state: State; owner: string; url: string; key: string; fetch: typeof fetch }): Promise<{ fingerprint: string; packages: number }> {
  const { dir, owner } = o;
  const exps = await expectedPackages(o.config, o.state, await readFile(join(dir, "tapster-linux.json"), "utf8"), o.fetch);
  checkTree(dir, expectedFiles(exps));
  for (const e of exps) {
    checkDeb(await readDeb(join(dir, "apt/pool/main", debName(e))), e);
    checkRpm(await readRpm(join(dir, "rpm", e.rpmArch, rpmName(e))), e);
  }
  const rpms = exps.map((e) => join(dir, "rpm", e.rpmArch, rpmName(e)));
  if (rpms.length) await withKey(o.key, (k) => run("rpmsign", rpmsignArgs(k.fingerprint, k.created, k.home, rpms), { env: k.env }));
  for (const a of RPM_ARCHES) {
    await mkdir(join(dir, "rpm", a), { recursive: true });
    await run("createrepo_c", ["--quiet", join(dir, "rpm", a)]);
  }
  const apt = join(dir, "apt");
  await mkdir(join(apt, "pool", "main"), { recursive: true });
  const indexes: { path: string; data: Buffer }[] = [];
  for (const a of DEB_ARCHES) {
    const sub = join(apt, "dists", "stable", "main", `binary-${a}`);
    await mkdir(sub, { recursive: true });
    const packages = (await run("apt-ftparchive", ["--arch", a, "packages", "pool"], { cwd: apt })).bytes;
    const gz = gzipSync(packages, { level: 9 });
    await writeFile(join(sub, "Packages"), packages);
    await writeFile(join(sub, "Packages.gz"), gz);
    indexes.push({ path: sub, data: packages }, { path: sub, data: gz });
  }
  const releasePath = join(apt, "dists", "stable", "Release");
  await writeFile(releasePath, (await run("apt-ftparchive", [...releaseOptions(owner).flatMap((x) => ["-o", x]), "release", "dists/stable"], { cwd: apt })).bytes);
  for (const i of indexes) {
    for (const p of byHashPaths(i.data)) {
      await mkdir(join(i.path, p, ".."), { recursive: true });
      await writeFile(join(i.path, p), i.data);
    }
  }
  const fingerprint = await withKey(o.key, async (k) => {
    const stable = join(apt, "dists", "stable");
    await run("gpg", ["--batch", "--yes", "--digest-algo", "SHA512", "--local-user", k.fingerprint, "--clearsign", "-o", join(stable, "InRelease"), releasePath], { env: k.env });
    await run("gpg", ["--batch", "--yes", "--digest-algo", "SHA512", "--local-user", k.fingerprint, "--armor", "--detach-sign", "-o", join(stable, "Release.gpg"), releasePath], { env: k.env });
    await writeFile(join(dir, `${owner}-tapster.asc`), (await run("gpg", ["--batch", "--armor", "--export", k.fingerprint], { env: k.env })).bytes);
    await writeFile(join(dir, `${owner}-tapster.pgp`), (await run("gpg", ["--batch", "--export", k.fingerprint], { env: k.env })).bytes);
    return k.fingerprint;
  });
  await writeFile(join(dir, "rpm", `${owner}-tapster.repo`), repoFile(owner, o.url));
  await writeFile(join(dir, "index.html"), indexHtml(owner, o.url, fingerprint, [...new Set(exps.map((e) => e.name))]));
  return { fingerprint, packages: exps.length };
}
