import { join } from "node:path";
import { Scalar, YAMLMap, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { type CliPackage, type HubConfig, MAINTAINER, type PackageConfig, isApp, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { runPath } from "../run";
import { deleteEnvSecret, hubEnv, setEnvSecret } from "./gh";
import { YAML_OUT } from "./hubpr";
import { type KeyRef, type Store, previousKey } from "./keystore";
import { removeTemp, tempDir } from "./temp";

export const GPG = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg"];

export async function findGpg(paths = GPG): Promise<string | null> {
  for (const p of paths) if (await Bun.file(p).exists()) return p;
  return null;
}

export const linuxRef = (hub: string, previous = false): KeyRef => ({ service: "tapster-linux-key", account: previous ? `${hub} previous` : hub, label: `tapster Linux key for ${hub}${previous ? " (previous)" : ""}` });

export function linuxKeyAllowed(secrets: string[], rotate: boolean): void {
  if (secrets.includes("TAPSTER_LINUX_KEY") && !rotate) {
    throw new TapsterError("the hub already has a Linux signing key", "Replacing it makes every apt and dnf user fetch the new key. To do that, run tapster init --rotate linux.");
  }
}

async function replaceLocal(store: Store, ref: KeyRef, secret: string): Promise<void> {
  const pending = { ...ref, account: `${ref.account} pending`, label: `${ref.label} (pending)` };
  await store.remove(pending);
  await store.save(pending, secret);
  await store.remove(ref);
  await store.save(ref, secret);
  await store.remove(pending);
}

export async function turnOnPages(gh: GitHub, hub: string): Promise<void> {
  await gh.json("POST", `/repos/${hub}/pages`, { build_type: "workflow" }).catch(async (e) => {
    if (!(e instanceof GitHubError) || e.status !== 409) throw new TapsterError("GitHub Pages could not be turned on for the hub", "A private hub needs a paid plan for Pages; make the hub public or turn Pages on by hand with GitHub Actions as the source.");
    await gh.json("PUT", `/repos/${hub}/pages`, { build_type: "workflow" });
  });
}

export type LinuxKey = { fingerprint: string; previous: "kept" | "missing" | null };

export async function makeLinuxKey(gh: GitHub, hub: string, o: { gpg: string; store: Store; rotate: boolean }): Promise<LinuxKey> {
  await turnOnPages(gh, hub);
  const home = tempDir("tl-");
  const env = { GNUPGHOME: home };
  try {
    await runPath(o.gpg, "gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", `${hub.split("/")[0]} tapster (${hub})`, "rsa4096", "sign", "never"], { env });
    const key = (await runPath(o.gpg, "gpg", ["--batch", "--armor", "--export-secret-keys"], { env })).stdout;
    const fingerprint = (await runPath(o.gpg, "gpg", ["--batch", "--with-colons", "--list-secret-keys"], { env })).stdout.split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9];
    if (!key.includes("BEGIN PGP PRIVATE KEY BLOCK") || !fingerprint) throw new TapsterError("gpg made no key", "Run gpg --version to check GnuPG, then try again.");
    const old = o.rotate ? await previousKey(o.store, linuxRef(hub)) : null;
    const pending = { ...linuxRef(hub), account: `${hub} new`, label: `tapster Linux key for ${hub} (new)` };
    await o.store.remove(pending);
    await o.store.save(pending, key);
    await setEnvSecret(hub, "TAPSTER_LINUX_KEY", key);
    if (old) await setEnvSecret(hub, "TAPSTER_LINUX_KEY_PREVIOUS", old);
    if (old) await replaceLocal(o.store, linuxRef(hub, true), old);
    await replaceLocal(o.store, linuxRef(hub), key);
    await o.store.remove(pending);
    return { fingerprint, previous: o.rotate ? (old ? "kept" : "missing") : null };
  } finally {
    await runPath(join(o.gpg, "..", "gpgconf"), "gpgconf", ["--kill", "all"], { env, allowFail: true }).catch(() => undefined);
    removeTemp(home);
  }
}

export async function finishLinuxRotation(gh: GitHub, hub: string, store: Store | null): Promise<boolean> {
  const secrets = (await hubEnv(gh, hub, "secrets")).map((x) => x.name);
  await store?.remove(linuxRef(hub, true));
  if (!secrets.includes("TAPSTER_LINUX_KEY_PREVIOUS")) return false;
  await deleteEnvSecret(hub, "TAPSTER_LINUX_KEY_PREVIOUS");
  return true;
}

const linuxArchives = (p: PackageConfig) => Object.keys(p.assets).filter((k) => k.startsWith("linux-")).sort();

export const linuxTools = (config: HubConfig) => config.packages.filter((p): p is CliPackage => !isApp(p) && linuxArchives(p).length > 0);

const linuxLeftOut = (config: HubConfig) =>
  config.packages.filter((p) => isApp(p) || !linuxArchives(p).length).map((p) => ({ name: p.name, why: isApp(p) ? "is a Mac app; apt and dnf carry command line tools only" : "has no Linux archive" }));

type Doc = ReturnType<typeof parseDocument>;

function setMaintainer(doc: Doc, maintainer: string): void {
  const top = doc.contents;
  if (!isMap(top)) throw new TapsterError("tapster.yml is not a map", "Fix tapster.yml first.");
  const value = new Scalar(maintainer);
  value.type = Scalar.QUOTE_DOUBLE;
  const linux = doc.get("linux", true);
  if (isMap(linux)) {
    linux.set("maintainer", value);
    return;
  }
  const node = new YAMLMap();
  node.set("maintainer", value);
  node.flow = true;
  const at = top.items.findIndex((p) => (p.key as { value?: unknown } | null)?.value === "packages");
  top.items.splice(at < 0 ? top.items.length : at, 0, doc.createPair("linux", node) as never);
}

export type LinuxChoice = { name: string; repo: string; kind: CliPackage["kind"]; archives: string[]; on: boolean };

// A tool asking for Linux packages is invalid until tapster.yml names a valid maintainer, so tapster.yml is read as if it did.
function asNamed(text: string, owner: string): HubConfig {
  const doc = parseDocument(text);
  if (!MAINTAINER.test(String(doc.getIn(["linux", "maintainer"]) ?? ""))) setMaintainer(doc, "Maintainer <maintainer@example.com>");
  return parseHub(doc.toString(YAML_OUT), owner).config;
}

export function linuxChoices(text: string, owner: string): LinuxChoice[] {
  return linuxTools(asNamed(text, owner)).map((p) => ({ name: p.name, repo: p.repo, kind: p.kind, archives: linuxArchives(p), on: p.linux }));
}

export const linuxLeft = (text: string, owner: string) => linuxLeftOut(asNamed(text, owner));

export type ShownTool = { name: string; was: boolean; on: boolean };

type Edit = { at: number; end: number; text: string };

const keyOf = (p: { key: unknown }) => (isScalar(p.key) ? p.key.value : undefined);

function maintainerEdit(text: string, doc: Doc, maintainer: string): Edit | null {
  const quoted = JSON.stringify(maintainer);
  const top = doc.contents;
  if (!isMap(top)) throw new TapsterError("tapster.yml is not a map", "Fix tapster.yml first.");
  const pair = top.items.find((p) => keyOf(p) === "linux");
  if (!pair) {
    const packages = top.items.find((p) => keyOf(p) === "packages");
    const key = isScalar(packages?.key) ? packages.key.range?.[0] : undefined;
    const at = key === undefined ? text.length : text.lastIndexOf("\n", key - 1) + 1;
    return { at, end: at, text: `${at === text.length && !text.endsWith("\n") ? "\n" : ""}linux: { maintainer: ${quoted} }\n` };
  }
  const linux = pair.value;
  if (!isMap(linux) || !linux.range) throw new TapsterError("tapster.yml has a linux entry tapster cannot edit", 'Make it linux: { maintainer: "Name <address>" } by hand.');
  const value = linux.items.find((p) => keyOf(p) === "maintainer")?.value;
  if (isScalar(value) && value.range) return value.value === maintainer ? null : { at: value.range[0], end: value.range[1], text: quoted };
  const url = linux.get("url");
  return { at: linux.range[0], end: linux.range[1], text: `{ maintainer: ${quoted}${typeof url === "string" ? `, url: ${JSON.stringify(url)}` : ""} }` };
}

function flagEdit(text: string, item: YAMLMap, on: boolean): Edit | null {
  const pair = item.items.find((p) => keyOf(p) === "linux");
  if (pair && isScalar(pair.value) && pair.value.range) return { at: pair.value.range[0], end: pair.value.range[1], text: String(on) };
  if (!on || !item.range) return null;
  if (item.flow) {
    const close = text.lastIndexOf("}", item.range[1] - 1);
    const at = text[close - 1] === " " ? close - 1 : close;
    return { at, end: at, text: ", linux: true" };
  }
  const first = item.items[0]?.key;
  const last = item.items.at(-1);
  const end = (last?.value as { range?: number[] } | null)?.range?.[1] ?? (last?.key as { range?: number[] } | null)?.range?.[1];
  if (!isScalar(first) || !first.range || end === undefined) return null;
  const column = first.range[0] - (text.lastIndexOf("\n", first.range[0] - 1) + 1);
  let p = end;
  while (p > 0 && /\s/.test(text[p - 1]!)) p--;
  const eol = text.indexOf("\n", p);
  const at = eol < 0 ? text.length : eol;
  return { at, end: at, text: `\n${" ".repeat(column)}linux: true` };
}

const changed = () => new TapsterError("tapster.yml changed", "Reload the page, then pick the tools again.");

// Edits only the maintainer and the flags of the tools the page showed, in place, so every other line stays byte for byte.
export function withLinux(text: string, owner: string, maintainer: string, tools: ShownTool[]): string {
  if (!MAINTAINER.test(maintainer)) throw new TapsterError("the maintainer is not Name <address>", "Write it like Your Name <you@example.com>, with letters, digits, spaces, dots, apostrophes and hyphens in the name.");
  const now = linuxChoices(text, owner);
  if (tools.some((t) => now.find((c) => c.name === t.name)?.on !== t.was)) throw changed();
  const doc = parseDocument(text);
  const named = parseDocument(text);
  setMaintainer(named, maintainer);
  const before = parseHub(named.toString(YAML_OUT), owner).invalid;
  const packages = doc.get("packages", true);
  const edits: Edit[] = [];
  const own = maintainerEdit(text, doc, maintainer);
  if (own) edits.push(own);
  for (const t of tools.filter((x) => x.on !== x.was)) {
    const item = isSeq(packages) ? packages.items.find((i) => isMap(i) && i.get("name") === t.name) : undefined;
    if (!isMap(item)) throw changed();
    const edit = flagEdit(text, item, t.on);
    if (edit) edits.push(edit);
  }
  const next = edits.sort((a, b) => b.at - a.at).reduce((s, e) => s.slice(0, e.at) + e.text + s.slice(e.end), text);
  const after = parseHub(next, owner);
  const flags = linuxChoices(next, owner);
  if (after.config.linux?.maintainer !== maintainer || tools.some((t) => flags.find((c) => c.name === t.name)?.on !== t.on)) {
    throw new TapsterError("tapster could not edit tapster.yml in place", "Set linux and the tools' linux: true by hand, then commit and push.");
  }
  const broken = after.invalid.filter((i) => !before.some((b) => b.name === i.name));
  if (broken.length) throw new TapsterError(`the change would break ${broken.map((b) => b.name).join(", ")}: ${broken[0]!.reason}`, broken[0]!.fix);
  return next;
}
