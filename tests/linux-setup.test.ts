import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parseHub } from "../src/config";
import { useGhWrite } from "../src/cli/gh";
import { findGpg, linuxChoices, withLinux } from "../src/cli/linuxkey";
import type { HubView } from "../src/web/contract";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { memoryStore } from "./helpers/memstore";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const YML = `version: 1
tap: octo/tap
packages:
  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz, darwin-arm64: ebb-mac.tar.gz } }
  - name: aims
    repo: octo/aims
    binaries: [aims]
    assets:
      linux-arm64: aims.tgz
    linux: true
  - { name: maconly, repo: octo/maconly, binaries: [m], assets: { darwin-arm64: m.tar.gz } }
`;

const shown = (on: Record<string, boolean>, was: Record<string, boolean> = { ebb: false, aims: true }) => Object.entries(on).map(([name, value]) => ({ name, was: was[name] ?? false, on: value }));

test("tapster.yml gains the maintainer before packages and the flags the page changed", () => {
  const out = withLinux(YML, "octo", "Octo Cat <octo@example.com>", shown({ ebb: true, aims: false }));
  expect(out).toContain('linux: { maintainer: "Octo Cat <octo@example.com>" }\npackages:');
  expect(out).toContain("    assets:\n      linux-arm64: aims.tgz\n    linux: false\n  - { name: maconly");
  const parsed = parseHub(out, "octo");
  expect(parsed.invalid).toEqual([]);
  expect(parsed.config.packages.map((p) => [p.name, "linux" in p && p.linux])).toEqual([["ebb", true], ["aims", false], ["maconly", false]]);
  expect(parsed.config.linux).toEqual({ maintainer: "Octo Cat <octo@example.com>" });
  expect(withLinux(out, "octo", "Octo Cat <octo@example.com>", shown({ ebb: true, aims: false }, { ebb: true, aims: false }))).toBe(out);
});

test("lines the change does not touch stay byte for byte", () => {
  const spaced = YML.replace("tap: octo/tap", "tap: octo/tap      # my tap").replace("    repo: octo/aims", "    repo:   octo/aims    # spaced");
  const out = withLinux(spaced, "octo", "Octo Cat <octo@example.com>", shown({ ebb: true }));
  const added = out.split("\n").filter((l) => !spaced.split("\n").includes(l));
  expect(added).toEqual(['linux: { maintainer: "Octo Cat <octo@example.com>" }', "  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz, darwin-arm64: ebb-mac.tar.gz }, linux: true }"]);
  expect(spaced.split("\n").filter((l) => !out.split("\n").includes(l))).toEqual(["  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz, darwin-arm64: ebb-mac.tar.gz } }"]);
});

test("only the tools the page showed change, and a flag that moved since is refused", () => {
  const pushed = YML.replace("assets: { linux-amd64: ebb.tgz, darwin-arm64: ebb-mac.tar.gz } }", "assets: { linux-amd64: ebb.tgz, darwin-arm64: ebb-mac.tar.gz }, linux: true }");
  const kept = withLinux(pushed, "octo", "Octo Cat <octo@example.com>", shown({ aims: false }));
  expect(parseHub(kept, "octo").config.packages.map((p) => [p.name, "linux" in p && p.linux])).toEqual([["ebb", true], ["aims", false], ["maconly", false]]);
  expect(() => withLinux(pushed, "octo", "Octo Cat <octo@example.com>", shown({ ebb: false, aims: true }))).toThrow("tapster.yml changed");
  expect(() => withLinux(YML, "octo", "Octo Cat <octo@example.com>", [{ name: "gone", was: false, on: true }])).toThrow("tapster.yml changed");
  expect(() => withLinux(YML, "octo", "Octo Cat <octo@example.com>", shown({ maconly: true }))).toThrow("tapster.yml changed");
});

test("an existing linux section keeps its url and only the maintainer changes", () => {
  const before = YML.replace("packages:", 'linux: { maintainer: "Old <old@example.com>", url: "https://apt.example.com" }\npackages:');
  const out = withLinux(before, "octo", "New Name <new@example.com>", shown({ ebb: true, aims: true }));
  expect(out).toContain('linux: { maintainer: "New Name <new@example.com>", url: "https://apt.example.com" }');
  expect(parseHub(out, "octo").config.packages.filter((p) => "linux" in p && p.linux).map((p) => p.name)).toEqual(["ebb", "aims"]);
});

test("the choices keep each tool's flag while the maintainer is missing or broken", () => {
  expect(linuxChoices(YML, "octo")).toEqual([{ name: "ebb", on: false }, { name: "aims", on: true }]);
  expect(linuxChoices(YML.replace("packages:", 'linux: { maintainer: "nobody" }\npackages:'), "octo")).toEqual([{ name: "ebb", on: false }, { name: "aims", on: true }]);
});

test("a bad maintainer is refused", () => {
  expect(() => withLinux(YML, "octo", "octo@example.com", shown({ ebb: true }))).toThrow("the maintainer is not Name <address>");
});

const fake = new FakeHub("octo");
const store = memoryStore();
let gpg: string | null = null;
let home = "";
let call: Call;

beforeAll(async () => {
  gpg = await findGpg();
  fake.repo("homebrew-tap", { files: new Map([["tapster.yml", YML]]) });
  fake.track(HUB);
  home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home, { gpg: async () => gpg, store: () => store }));
  await call("POST", "/api/hub/protect", { hub: HUB });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const linux = async () => ((await call("GET", `/api/hub?hub=${HUB}`)).data as unknown as HubView).extras.linux;
const reason = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string }).reason;

test("the page lists the tools with Linux archives and says whether GnuPG is there", async () => {
  const saved = gpg;
  gpg = null;
  expect(await linux()).toEqual({ wanted: true, stored: false, gpg: false, keystore: "keychain", maintainer: null, tools: [{ name: "ebb", on: false }, { name: "aims", on: true }] });
  expect(reason(await call("POST", "/api/hub/linux/key", { hub: HUB }))).toBe("GnuPG is not installed");
  gpg = saved;
});

test.skipIf(!Bun.which("gpg") && !["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg"].some((p) => Bun.file(p).size > 0))(
  "setup makes the key as init --linux does: Pages from Actions, the hub secret and the keychain copy",
  async () => {
    const made = await call("POST", "/api/hub/linux/key", { hub: HUB });
    expect(made.status).toBe(200);
    expect(made.data.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(made.data.keychain).toBe(true);
    expect(JSON.stringify(made.data)).not.toContain("PRIVATE KEY");
    expect(fake.get(HUB)!.pages).toBe("workflow");
    expect(fake.get(HUB)!.env!.secrets.has("TAPSTER_LINUX_KEY")).toBe(true);
    expect(store.items.get(`tapster-linux-key ${HUB}`)).toContain("BEGIN PGP PRIVATE KEY BLOCK");
    expect([...store.items.keys()]).toEqual([`tapster-linux-key ${HUB}`]);
    expect((await linux()).stored).toBe(true);
    expect(reason(await call("POST", "/api/hub/linux/key", { hub: HUB }))).toBe("the hub already has a Linux signing key");
  },
  60_000,
);

test("the maintainer and the picked tools go to tapster.yml in one commit on main", async () => {
  const bad = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "nobody", tools: shown({ ebb: true }) });
  expect(reason(bad)).toBe("the maintainer is not Name <address>");
  const stale = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: shown({ ebb: true, aims: true }, { ebb: true, aims: true }) });
  expect(reason(stale)).toBe("tapster.yml changed");
  const ok = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: shown({ ebb: true, aims: true }) });
  expect(ok.data).toEqual({ result: "committed" });
  const text = fake.get(HUB)!.files!.get("tapster.yml")!;
  expect(text).toContain('linux: { maintainer: "Octo Cat <octo@example.com>" }');
  expect((await linux()).tools).toEqual([{ name: "ebb", on: true }, { name: "aims", on: true }]);
  expect((await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: shown({ ebb: true, aims: true }, { ebb: true, aims: true }) })).data).toEqual({ result: "unchanged" });
  const health = await call("GET", `/api/hub/health?hub=${HUB}`);
  expect(health.status).toBe(200);
  expect((health.data.checks as { name: string; ok: boolean }[]).find((c) => c.name === "the Linux repositories can be signed and deployed")?.ok).toBe(fake.get(HUB)!.env!.secrets.has("TAPSTER_LINUX_KEY"));
});

test("the tapster.yml write refuses a main someone else changed", async () => {
  fake.actor = "mallory";
  await fake.fetch(`https://api.github.com/repos/${HUB}/contents/tapster.yml`, { method: "PUT", body: JSON.stringify({ message: "sneak", content: Buffer.from(`${YML}# mallory\n`).toString("base64"), branch: "main" }) });
  fake.actor = "octo";
  const refused = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: shown({ ebb: false }, { ebb: true }) });
  expect(refused.status).toBe(400);
  expect(reason(refused)).toStartWith("main changed in ways only you may change it");
  expect(fake.get(HUB)!.files!.get("tapster.yml")).toEndWith("# mallory\n");
});
