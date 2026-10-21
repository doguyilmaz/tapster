import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parseHub } from "../src/config";
import { useGhWrite } from "../src/cli/gh";
import { findGpg, withLinux } from "../src/cli/linuxkey";
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

test("tapster.yml gains the maintainer before packages and linux: true on the picked tools only", () => {
  const out = withLinux(YML, "octo", "Octo Cat <octo@example.com>", ["ebb"]);
  expect(out).toContain('linux: { maintainer: "Octo Cat <octo@example.com>" }\npackages:');
  expect(out).toContain("  - name: aims\n    repo: octo/aims\n    binaries: [aims]\n    assets:\n      linux-arm64: aims.tgz\n  - { name: maconly");
  const parsed = parseHub(out, "octo");
  expect(parsed.invalid).toEqual([]);
  expect(parsed.config.packages.map((p) => [p.name, "linux" in p && p.linux])).toEqual([["ebb", true], ["aims", false], ["maconly", false]]);
  expect(parsed.config.linux).toEqual({ maintainer: "Octo Cat <octo@example.com>" });
  expect(withLinux(out, "octo", "Octo Cat <octo@example.com>", ["ebb"])).toBe(out);
});

test("an existing linux section keeps its url and only the maintainer changes", () => {
  const before = YML.replace("packages:", 'linux: { maintainer: "Old <old@example.com>", url: "https://apt.example.com" }\npackages:');
  const out = withLinux(before, "octo", "New Name <new@example.com>", ["ebb", "aims"]);
  expect(out).toContain('linux: { maintainer: "New Name <new@example.com>", url: "https://apt.example.com" }');
  expect(parseHub(out, "octo").config.packages.filter((p) => "linux" in p && p.linux).map((p) => p.name)).toEqual(["ebb", "aims"]);
});

test("a bad maintainer or a tool without Linux archives is refused", () => {
  expect(() => withLinux(YML, "octo", "octo@example.com", ["ebb"])).toThrow("the maintainer is not Name <address>");
  expect(() => withLinux(YML, "octo", "Octo <octo@example.com>", ["maconly"])).toThrow("maconly cannot ship to apt and dnf");
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
  expect(await linux()).toEqual({ wanted: true, stored: false, gpg: false, keystore: true, maintainer: null, tools: [{ name: "ebb", on: false }, { name: "aims", on: true }] });
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
  const bad = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "nobody", tools: ["ebb"] });
  expect(reason(bad)).toBe("the maintainer is not Name <address>");
  const ok = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: ["ebb", "aims"] });
  expect(ok.data).toEqual({ result: "committed" });
  const text = fake.get(HUB)!.files!.get("tapster.yml")!;
  expect(text).toContain('linux: { maintainer: "Octo Cat <octo@example.com>" }');
  expect((await linux()).tools).toEqual([{ name: "ebb", on: true }, { name: "aims", on: true }]);
  expect((await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: ["ebb", "aims"] })).data).toEqual({ result: "unchanged" });
  const health = await call("GET", `/api/hub/health?hub=${HUB}`);
  expect(health.status).toBe(200);
  expect((health.data.checks as { name: string; ok: boolean }[]).find((c) => c.name === "the Linux repositories can be signed and deployed")?.ok).toBe(fake.get(HUB)!.env!.secrets.has("TAPSTER_LINUX_KEY"));
});

test("the tapster.yml write refuses a main someone else changed", async () => {
  fake.actor = "mallory";
  await fake.fetch(`https://api.github.com/repos/${HUB}/contents/tapster.yml`, { method: "PUT", body: JSON.stringify({ message: "sneak", content: Buffer.from(`${YML}# mallory\n`).toString("base64"), branch: "main" }) });
  fake.actor = "octo";
  const refused = await call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: [] });
  expect(refused.status).toBe(400);
  expect(reason(refused)).toStartWith("main changed in ways only you may change it");
  expect(fake.get(HUB)!.files!.get("tapster.yml")).toEndWith("# mallory\n");
});
