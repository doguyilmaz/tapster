import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { TarEntry } from "../src/archive";
import { type Expected, type ExpectedFile, checkDeb, checkRpm, parseControl } from "../src/linux/verify";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const files: ExpectedFile[] = [
  { path: "usr/bin/aims", mode: 0o755, sha256: sha("bin") },
  { path: "usr/share/bash-completion/completions/aims", mode: 0o644, sha256: sha("b") },
];
const exp: Expected = { name: "aims", version: "0.1.5", debArch: "amd64", rpmArch: "x86_64", maintainer: "Dogu Yilmaz <dogu@example.com>", description: "Several accounts", homepage: "https://github.com/o/aims", deb: files, rpm: files };
const file = (name: string, data: string, mode: number, uid = 0): TarEntry => ({ name, type: "file", mode, data: Buffer.from(data), uid, gid: 0, uname: "root", gname: "root" });
const dir = (name: string): TarEntry => ({ name, type: "dir", mode: 0o755, data: Buffer.alloc(0), uid: 0, gid: 0, uname: "root", gname: "root" });
const goodData = () => [dir("usr"), dir("usr/bin"), file("usr/bin/aims", "bin", 0o755), dir("usr/share"), dir("usr/share/bash-completion"), dir("usr/share/bash-completion/completions"), file("usr/share/bash-completion/completions/aims", "b", 0o644)];
const control = `Package: aims
Version: 0.1.5-1
Section: 
Priority: optional
Architecture: amd64
Maintainer: Dogu Yilmaz <dogu@example.com>
Installed-Size: 12
Homepage: https://github.com/o/aims
Description: Several accounts
`;
const deb = (over: Partial<{ control: string; members: string[]; data: TarEntry[]; ar: string[] }> = {}) => ({
  ar: over.ar ?? ["debian-binary", "control.tar.gz", "data.tar.gz"],
  control: parseControl(over.control ?? control),
  controlMembers: over.members ?? ["control", "md5sums"],
  data: over.data ?? goodData(),
});

test("a deb built as configured passes", () => {
  expect(() => checkDeb(deb(), exp)).not.toThrow();
});

test.each([
  ["a maintainer script", { members: ["control", "md5sums", "postinst"] }, /postinst/],
  ["a dependency", { control: `${control}Depends: curl\n` }, /Depends/],
  ["a replacement of another package", { control: control.replace("Priority: optional\n", "Priority: optional\nReplaces: sudo\n") }, /Replaces/],
  ["another version", { control: control.replace("0.1.5-1", "0.1.6-1") }, /Version/],
  ["another maintainer", { control: control.replace("Dogu Yilmaz", "Someone") }, /Maintainer/],
  ["an extra file", { data: [...goodData(), file("etc/sudoers.d/aims", "x", 0o440)] }, /etc\/sudoers.d\/aims/],
  ["a missing file", { data: goodData().filter((e) => !e.name.includes("bash")) }, /bash-completion/],
  ["a changed binary", { data: goodData().map((e) => (e.name === "usr/bin/aims" ? file("usr/bin/aims", "evil", 0o755) : e)) }, /usr\/bin\/aims/],
  ["a setuid binary", { data: goodData().map((e) => (e.name === "usr/bin/aims" ? file("usr/bin/aims", "bin", 0o4755) : e)) }, /mode/],
  ["a file owned by a user", { data: goodData().map((e) => (e.name === "usr/bin/aims" ? file("usr/bin/aims", "bin", 0o755, 1000) : e)) }, /owned/],
  ["a file owned by name by a user", { data: goodData().map((e) => (e.name === "usr/bin/aims" ? { ...file("usr/bin/aims", "bin", 0o755), uname: "nobody" } : e)) }, /owned/],
  ["a second data archive", { ar: ["debian-binary", "control.tar.gz", "data.tar.gz", "data.tar.xz"] }, /data.tar.xz/],
  ["a symlink", { data: [...goodData(), { name: "usr/bin/x", type: "symlink" as const, mode: 0o777, data: Buffer.alloc(0), linkname: "aims", uid: 0, gid: 0 }] }, /usr\/bin\/x/],
])("a deb with %s is refused", (_, over, reason) => {
  expect(() => checkDeb(deb(over), exp)).toThrow(reason);
});

const rpm = (over: Partial<{ tags: string; scripts: string; deps: Record<string, string[]>; files: string; payload: TarEntry[] }> = {}) => ({
  tags: over.tags ?? "aims|0.1.5|1|x86_64|(none)",
  scripts: over.scripts ?? "",
  deps: { requires: [], provides: ["aims = 0.1.5-1", "aims(x86-64) = 0.1.5-1"], obsoletes: [], conflicts: [], recommends: [], suggests: [], supplements: [], enhances: [], ...over.deps },
  files: over.files ?? "/usr/bin/aims\t100755\troot\troot\t0\t\n/usr/share/bash-completion/completions/aims\t100644\troot\troot\t0\t\n",
  payload: over.payload ?? [file("usr/bin/aims", "bin", 0o755), file("usr/share/bash-completion/completions/aims", "b", 0o644)],
});

test("an rpm built as configured passes", () => {
  expect(() => checkRpm(rpm(), exp)).not.toThrow();
  expect(() => checkRpm(rpm({ deps: { requires: ["rpmlib(CompressedFileNames) <= 3.0.4-1"] } }), exp)).not.toThrow();
});

test.each([
  ["a script", { scripts: "postinstall scriptlet (using /bin/sh):\nrm -rf /\n" }, /script/],
  ["a requirement", { deps: { requires: ["curl"] } }, /requires/],
  ["an obsoleted package", { deps: { obsoletes: ["sudo"] } }, /obsoletes/],
  ["a foreign provide", { deps: { provides: ["aims = 0.1.5-1", "sudo = 9"] } }, /provides/],
  ["another architecture", { tags: "aims|0.1.5|1|aarch64|(none)" }, /aarch64/],
  ["an epoch", { tags: "aims|0.1.5|1|x86_64|9" }, /epoch/],
  ["a config file flag", { files: "/usr/bin/aims\t100755\troot\troot\t1\t\n/usr/share/bash-completion/completions/aims\t100644\troot\troot\t0\t\n" }, /flags/],
  ["a file owned by a user", { files: "/usr/bin/aims\t100755\tdogu\troot\t0\t\n/usr/share/bash-completion/completions/aims\t100644\troot\troot\t0\t\n" }, /owned/],
  ["a file capability", { files: "/usr/bin/aims\t100755\troot\troot\t0\tcap_setuid=ep\n/usr/share/bash-completion/completions/aims\t100644\troot\troot\t0\t\n" }, /capabilit/],
  ["a payload that differs from the header", { payload: [file("usr/bin/aims", "evil", 0o755), file("usr/share/bash-completion/completions/aims", "b", 0o644)] }, /usr\/bin\/aims/],
  ["an extra payload file", { payload: [file("usr/bin/aims", "bin", 0o755), file("usr/share/bash-completion/completions/aims", "b", 0o644), file("etc/x", "x", 0o644)] }, /etc\/x/],
])("an rpm with %s is refused", (_, over, reason) => {
  expect(() => checkRpm(rpm(over as never), exp)).toThrow(reason);
});

test("the signer works out each package's files from the release itself", async () => {
  const { parseConfig } = await import("../src/config");
  const { writeTarGz } = await import("../src/archive");
  const { emptyState, upsert } = await import("../src/state");
  const { expectedPackages } = await import("../src/linux/verify");
  const cfg = parseConfig(
    `version: 1
tap: o/tap
linux: { maintainer: "Dogu Yilmaz <dogu@example.com>" }
packages:
  - { name: aims, repo: o/aims, binaries: [aims], linux: true, assets: { linux-amd64: "aims_{version}_linux_amd64.tar.gz" } }
`,
    "o",
  );
  const tar = writeTarGz([{ name: "aims", type: "file", mode: 0o755, data: Buffer.from("bin") }], 0);
  const sums = Buffer.from(`${createHash("sha256").update(tar).digest("hex")}  aims_0.1.5_linux_amd64.tar.gz\n`);
  const state = upsert(emptyState(), "aims", { tag: "v0.1.5", releaseId: 1, checksums: createHash("sha256").update(sums).digest("hex"), status: "published" });
  const fetchImpl = (async (url: string | URL | Request) => new Response(String(url).endsWith("checksums.txt") ? sums : tar)) as typeof fetch;
  const [e] = await expectedPackages(cfg, state, '{"packages":{"aims":"0.1.5"}}\n', fetchImpl);
  expect(e!.deb).toEqual([{ path: "usr/bin/aims", mode: 0o755, sha256: sha("bin") }]);
  await expect(expectedPackages(cfg, state, '{"packages":{"aims":"0.1.4"}}\n', fetchImpl)).rejects.toThrow(/state/);
});
