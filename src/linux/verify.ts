import { readFile } from "node:fs/promises";
import { type TarEntry, readTar, readTarGz } from "../archive";
import { sha256 } from "../checksums";
import type { HubConfig } from "../config";
import { TapsterError } from "../errors";
import { run } from "../run";
import type { State } from "../state";
import { ARCH, type LinuxPlatform, archiveFile, fetchArchives, linuxTargets, manifestJson, packageFiles } from "./build";

export type ExpectedFile = { path: string; mode: number; sha256: string };
export type Expected = { name: string; version: string; debArch: string; rpmArch: string; maintainer: string; description: string; homepage: string; deb: ExpectedFile[]; rpm: ExpectedFile[] };

const refuse = (file: string, what: string) => new TapsterError(`${file} ${what}`, "linux-sign signs only packages that hold exactly the release's files; check the linux-build job.");

export async function expectedPackages(config: HubConfig, state: State, manifest: string, fetchImpl: typeof fetch): Promise<Expected[]> {
  const targets = linuxTargets(config, state);
  if (manifest !== manifestJson(targets)) throw new TapsterError("the Linux build does not match the published releases in the state", "The next run builds again.");
  const out: Expected[] = [];
  for (const t of targets) {
    const archives = await fetchArchives(t, fetchImpl);
    for (const asset of t.assets) {
      const entries = archives.get(asset.platform)!;
      const files = (kind: "deb" | "rpm") =>
        packageFiles(t.pkg, kind, "/").map((f) => ({ path: f.dst.slice(1), mode: f.mode, sha256: sha256(archiveFile(entries, f.src.slice(1), asset.name).data) }));
      const arch = ARCH[asset.platform as LinuxPlatform];
      out.push({
        name: t.pkg.name,
        version: t.version,
        debArch: arch.deb,
        rpmArch: arch.rpm,
        maintainer: config.linux!.maintainer,
        description: t.pkg.description ?? t.pkg.name,
        homepage: t.pkg.homepage ?? `https://github.com/${t.pkg.repo}`,
        deb: files("deb"),
        rpm: files("rpm"),
      });
    }
  }
  return out;
}

export const debName = (e: Expected) => `${e.name}_${e.version}-1_${e.debArch}.deb`;
export const rpmName = (e: Expected) => `${e.name}-${e.version}-1.${e.rpmArch}.rpm`;

export function parseControl(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let last: string | null = null;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) && last) {
      fields[last] += `\n${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z0-9-]+):(.*)$/.exec(line);
    if (!m) throw new TapsterError("a deb has a control file tapster cannot read", "Check the linux-build job.");
    if (Object.hasOwn(fields, m[1]!)) throw new TapsterError(`a deb lists ${m[1]} twice`, "Check the linux-build job.");
    last = m[1]!;
    fields[last] = m[2]!.trim();
  }
  return fields;
}

function checkFiles(file: string, entries: TarEntry[], expected: ExpectedFile[]): void {
  const want = new Map(expected.map((f) => [f.path, f]));
  const dirs = new Set(expected.flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const seen = new Set<string>();
  for (const e of entries) {
    const named = (n: string | undefined) => n === undefined || n === "" || n === "root";
    if ((e.uid ?? 0) !== 0 || (e.gid ?? 0) !== 0 || !named(e.uname) || !named(e.gname)) throw refuse(file, `has ${e.name} owned by a user other than root`);
    if (e.type === "dir") {
      if (!dirs.has(e.name)) throw refuse(file, `has the folder ${e.name}, which the release does not ship`);
      if (e.mode !== 0o755) throw refuse(file, `has the folder ${e.name} with mode ${e.mode.toString(8)}`);
      continue;
    }
    const f = want.get(e.name);
    if (e.type !== "file" || !f) throw refuse(file, `has ${e.name}, which the release does not ship`);
    if (e.mode !== f.mode) throw refuse(file, `has ${e.name} with mode ${e.mode.toString(8)}, not ${f.mode.toString(8)}`);
    if (sha256(e.data) !== f.sha256) throw refuse(file, `has a ${e.name} that differs from the release's file`);
    seen.add(e.name);
  }
  for (const f of expected) if (!seen.has(f.path)) throw refuse(file, `lacks ${f.path}`);
}

const DEB_FIELDS = new Set(["Package", "Version", "Section", "Priority", "Architecture", "Maintainer", "Installed-Size", "Homepage", "Description"]);

export type DebParts = { ar: string[]; control: Record<string, string>; controlMembers: string[]; data: TarEntry[] };

const AR_MEMBERS = [/^debian-binary$/, /^control\.tar\.(gz|xz|zst)$/, /^data\.tar\.(gz|xz|zst)$/];

export function arMembers(data: Buffer): string[] {
  if (data.subarray(0, 8).toString("latin1") !== "!<arch>\n") throw new TapsterError("a deb is not an ar archive", "Check the linux-build job.");
  const names: string[] = [];
  let off = 8;
  while (off + 60 <= data.length) {
    const name = data.subarray(off, off + 16).toString("latin1").trim().replace(/\/$/, "");
    const size = Number(data.subarray(off + 48, off + 58).toString("latin1").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new TapsterError("a deb has a damaged ar header", "Check the linux-build job.");
    names.push(name);
    off += 60 + size + (size % 2);
  }
  if (off !== data.length) throw new TapsterError("a deb has data after its last member", "Check the linux-build job.");
  return names;
}

export function checkDeb(parts: DebParts, exp: Expected): void {
  const file = debName(exp);
  if (parts.ar.length !== AR_MEMBERS.length || !parts.ar.every((m, i) => AR_MEMBERS[i]!.test(m))) throw refuse(file, `holds the members ${parts.ar.join(", ")}`);
  for (const k of Object.keys(parts.control)) if (!DEB_FIELDS.has(k)) throw refuse(file, `sets the control field ${k}`);
  const want: Record<string, string> = { Package: exp.name, Version: `${exp.version}-1`, Architecture: exp.debArch, Maintainer: exp.maintainer, Homepage: exp.homepage, Description: exp.description };
  for (const [k, v] of Object.entries(want)) if (parts.control[k] !== v) throw refuse(file, `has ${k} ${JSON.stringify(parts.control[k] ?? null)}, not ${JSON.stringify(v)}`);
  if (!/^[0-9]*$/.test(parts.control["Installed-Size"] ?? "")) throw refuse(file, "has an Installed-Size that is not a number");
  for (const m of parts.controlMembers) if (m !== "control" && m !== "md5sums") throw refuse(file, `carries the maintainer file ${m}`);
  checkFiles(file, parts.data, exp.deb);
}

export type RpmParts = { tags: string; scripts: string; deps: Record<string, string[]>; files: string; payload: TarEntry[] };

export function checkRpm(parts: RpmParts, exp: Expected): void {
  const file = rpmName(exp);
  const [name, version, release, arch, epoch] = parts.tags.trim().split("|");
  if (name !== exp.name || version !== exp.version || release !== "1") throw refuse(file, `is ${name}-${version}-${release}`);
  if (arch !== exp.rpmArch) throw refuse(file, `is built for ${arch}`);
  if (epoch !== "(none)") throw refuse(file, `sets the epoch ${epoch}`);
  if (parts.scripts.trim() !== "") throw refuse(file, "carries a script or trigger");
  for (const [kind, list] of Object.entries(parts.deps)) {
    const allowed =
      kind === "requires"
        ? (d: string) => d.startsWith("rpmlib(")
        : kind === "provides"
          ? (d: string) => new RegExp(`^${exp.name.replace(/[-.]/g, "\\$&")}(\\([a-z0-9_-]+\\))? = ${exp.version.replace(/\./g, "\\.")}-1$`).test(d)
          : () => false;
    const bad = list.filter((d) => d.trim() !== "" && !allowed(d.trim()));
    if (bad.length) throw refuse(file, `${kind} ${bad.join(", ")}`);
  }
  const headers = parts.files
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [path, mode, user, group, flags, caps] = l.split("\t");
      return { path: path!.replace(/^\//, ""), mode: Number.parseInt(mode!, 8), user, group, flags, caps: caps ?? "" };
    });
  const want = new Map(exp.rpm.map((f) => [f.path, f]));
  for (const h of headers) {
    const f = want.get(h.path);
    if (!f) throw refuse(file, `lists ${h.path}, which the release does not ship`);
    if (h.user !== "root" || h.group !== "root") throw refuse(file, `has ${h.path} owned by ${h.user}:${h.group}`);
    if (h.flags !== "0") throw refuse(file, `marks ${h.path} with flags ${h.flags}`);
    if (h.caps.trim() !== "" && h.caps.trim() !== "(none)") throw refuse(file, `gives ${h.path} the capabilities ${h.caps}`);
    if (h.mode !== (0o100000 | f.mode)) throw refuse(file, `lists ${h.path} with mode ${h.mode.toString(8)}`);
  }
  if (headers.length !== exp.rpm.length) throw refuse(file, "lists a different set of files");
  checkFiles(file, parts.payload, exp.rpm);
}

const LIMIT = { allowFail: false, maxOutput: 1 << 30, timeoutMs: 120_000 } as const;

export async function readDeb(path: string): Promise<DebParts> {
  const control = parseControl((await run("dpkg-deb", ["-f", path], LIMIT)).stdout);
  const ctrl = readTar((await run("dpkg-deb", ["--ctrl-tarfile", path], LIMIT)).bytes);
  const data = readTar((await run("dpkg-deb", ["--fsys-tarfile", path], LIMIT)).bytes);
  return { ar: arMembers(await readFile(path)), control, controlMembers: ctrl.filter((e) => e.type !== "dir").map((e) => e.name), data };
}

const DEPS = ["requires", "provides", "obsoletes", "conflicts", "recommends", "suggests", "supplements", "enhances"];

export async function readRpm(path: string): Promise<RpmParts> {
  const q = async (args: string[]) => (await run("rpm", ["-qp", "--nosignature", "--nodigest", ...args, path], LIMIT)).stdout;
  const deps: Record<string, string[]> = {};
  for (const d of DEPS) deps[d] = (await q([`--${d}`])).split("\n");
  return {
    tags: await q(["--qf", "%{NAME}|%{VERSION}|%{RELEASE}|%{ARCH}|%{EPOCH}\\n"]),
    scripts: await q(["--scripts", "--triggers", "--filetriggers"]),
    deps,
    files: await q(["--qf", "[%{FILENAMES}\\t%{FILEMODES:octal}\\t%{FILEUSERNAME}\\t%{FILEGROUPNAME}\\t%{FILEFLAGS}\\t%{FILECAPS}\\n]"]),
    payload: readTarGz((await run("rpm2archive", ["-"], { ...LIMIT, stdin: await readFile(path) })).bytes),
  };
}
