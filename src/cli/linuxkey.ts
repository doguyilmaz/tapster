import { join } from "node:path";
import { Scalar, YAMLMap, isMap, isSeq, parseDocument } from "yaml";
import { type HubConfig, MAINTAINER, isApp, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { runPath } from "../run";
import { deleteEnvSecret, hubEnv, setEnvSecret } from "./gh";
import { YAML_OUT, keepStyle } from "./hubpr";
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

export const linuxTools = (config: HubConfig) => config.packages.filter((p) => !isApp(p) && Object.keys(p.assets).some((k) => k.startsWith("linux-")));

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

// A tool asking for Linux packages is invalid until tapster.yml names a valid maintainer, so the choices are read as if it did.
export function linuxChoices(text: string, owner: string): { name: string; on: boolean }[] {
  const doc = parseDocument(text);
  if (!MAINTAINER.test(String(doc.getIn(["linux", "maintainer"]) ?? ""))) setMaintainer(doc, "Maintainer <maintainer@example.com>");
  return linuxTools(parseHub(doc.toString(YAML_OUT), owner).config).map((p) => ({ name: p.name, on: !isApp(p) && p.linux }));
}

export function withLinux(text: string, owner: string, maintainer: string, tools: string[]): string {
  if (!MAINTAINER.test(maintainer)) throw new TapsterError("the maintainer is not Name <address>", "Write it like Your Name <you@example.com>, with letters, digits, spaces, dots, apostrophes and hyphens in the name.");
  const doc = parseDocument(text);
  setMaintainer(doc, maintainer);
  const named = parseHub(doc.toString(YAML_OUT), owner);
  const eligible = linuxTools(named.config).map((p) => p.name);
  const strange = tools.filter((t) => !eligible.includes(t));
  if (strange.length) throw new TapsterError(`${strange.join(", ")} cannot ship to apt and dnf`, "Only command line tools whose hub entry maps a linux-amd64 or linux-arm64 archive can.");
  const packages = doc.get("packages", true);
  if (isSeq(packages)) {
    for (const item of packages.items) {
      if (!isMap(item)) continue;
      const name = item.get("name");
      if (typeof name !== "string" || !eligible.includes(name)) continue;
      if (tools.includes(name)) item.set("linux", true);
      else item.delete("linux");
    }
  }
  const next = keepStyle(text, doc.toString(YAML_OUT));
  const broken = parseHub(next, owner).invalid.filter((i) => !named.invalid.some((b) => b.name === i.name));
  if (broken.length) throw new TapsterError(`the change would break ${broken.map((b) => b.name).join(", ")}: ${broken[0]!.reason}`, broken[0]!.fix);
  return next;
}
