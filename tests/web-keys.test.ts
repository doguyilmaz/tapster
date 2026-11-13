import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { linuxRef } from "../src/cli/linuxkey";
import { decodeSparkleKey } from "../src/sparkle-key";
import { FakeHub } from "./helpers/fakehub";
import { memoryStore } from "./helpers/memstore";
import { webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const homes: string[] = [];
afterEach(() => {
  homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true }));
  useGhWrite(async () => { throw new Error("real gh may not run in tests"); });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tapster-keys-")); homes.push(home);
  const fake = new FakeHub();
  const repo = fake.repo("homebrew-tap", { files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"]]), env: { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_ID", "777"], ["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) } });
  const store = memoryStore();
  const logs: string[] = [];
  const gpg = join(home, "gpg");
  writeFileSync(gpg, '#!/bin/sh\ncase "$*" in *--export-secret-keys*) echo "-----BEGIN PGP PRIVATE KEY BLOCK-----fixture-new" ;; *--with-colons*) echo "fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:" ;; esac\n');
  chmodSync(gpg, 0o755);
  useGhWrite(fake.ghWrite);
  const app = webApp(fake, home, { store: () => store, gpg: async () => gpg, log: (s) => logs.push(s) });
  return { ...app, home, fake, repo, store, logs };
}

const form = (pem: string, hub = HUB) => {
  const data = new FormData(); data.set("hub", hub); data.set("pem", new File([pem], "replacement.pem")); return data;
};

test("the UI can replace or restore a signing App key and returns only its public fingerprint", async () => {
  const { call, s, fake, repo, logs } = fixture();
  repo.env!.secrets.delete("TAPSTER_APP_PRIVATE_KEY");
  const res = await call("POST", "/api/hub/app/key", form(fake.pem));
  expect(res.status).toBe(200);
  expect(res.data.fingerprint).toMatch(/^SHA256:/);
  expect(repo.env!.secrets.has("TAPSTER_APP_PRIVATE_KEY")).toBe(true);
  expect(s.apps.get(HUB)?.id).toBe("777");
  expect(JSON.stringify(res.data) + logs.join("\n")).not.toContain(fake.pem);
});

test("wrong App keys, invalid files and other owners never replace the working secret", async () => {
  const { call, fake, s } = fixture();
  let writes = 0;
  useGhWrite(async (...args) => { writes++; await fake.ghWrite(...args); });
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  for (const body of [form(wrong), form("not a key"), form("x".repeat(17000)), form(fake.pem, "other/homebrew-tap")]) {
    expect((await call("POST", "/api/hub/app/key", body)).status).toBe(400);
  }
  expect(writes).toBe(0);
  expect(s.apps.size).toBe(0);
});

test("a replacement App key needs a locked environment and an installation that excludes the hub", async () => {
  const { call, repo, fake } = fixture();
  repo.env!.policies = ["main", "feature"];
  expect((await call("POST", "/api/hub/app/key", form(fake.pem))).status).toBe(400);
  repo.env!.policies = ["main"];
  fake.installation = { id: 123, repos: [HUB] };
  expect((await call("POST", "/api/hub/app/key", form(fake.pem))).status).toBe(400);
});

test("an unexpected storage error is masked in logs and never returned as secret material", async () => {
  const { call, fake, logs } = fixture();
  useGhWrite(async () => { throw new Error(`storage refused ${fake.pem}`); });
  const res = await call("POST", "/api/hub/app/key", form(fake.pem));
  expect(res.status).toBe(500);
  expect(logs.join("\n")).toContain("***");
  expect(logs.join("\n") + JSON.stringify(res.data)).not.toContain(fake.pem);
});

const notaryForm = () => {
  const data = new FormData();
  data.set("hub", HUB);
  data.set("p8", new File(["-----BEGIN PRIVATE KEY-----\nfixture-notary-secret\n-----END PRIVATE KEY-----\n"], "AuthKey.p8"));
  data.set("keyId", "ABCDE12345");
  data.set("issuerId", "00000000-0000-4000-8000-000000000000");
  return data;
};

test("notarization validation errors mask the key and its IDs before returning or logging", async () => {
  const { call, s, logs } = fixture();
  s.deps.notary = async (key) => { throw new Error(`${Buffer.from(key.p8).toString()} ${key.keyId} ${key.issuer}`); };
  const r = await call("POST", "/api/hub/notary", notaryForm());
  expect(r.status).toBe(500);
  const output = logs.join("\n") + JSON.stringify(r.data);
  for (const secret of ["fixture-notary-secret", "ABCDE12345", "00000000-0000-4000-8000-000000000000"]) expect(output).not.toContain(secret);
  expect(logs.join("\n")).toContain("***");
});

test("a notarization upload excludes concurrent certificate and other key writes", async () => {
  const { call, s, fake } = fixture();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  s.deps.notary = async () => { started(); await held; return false; };
  const first = call("POST", "/api/hub/notary", notaryForm());
  await ready;
  try {
    expect((await call("POST", "/api/hub/app/key", form(fake.pem))).status).toBe(400);
    const cert = new FormData(); cert.set("hub", HUB);
    expect((await call("POST", "/api/hub/certificate", cert)).status).toBe(400);
  } finally { release(); }
  expect((await first).status).toBe(200);
  expect((await call("POST", "/api/hub/app/key", form(fake.pem))).status).toBe(200);
});

test("Sparkle generation saves to the keychain and exposes only the public key", async () => {
  const { call, store, repo } = fixture();
  const res = await call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "app2" });
  expect(res.status).toBe(200);
  expect(res.data.account).toBe("app2");
  const seed = store.items.get("https://sparkle-project.org app2")!;
  expect(decodeSparkleKey(seed).publicKey).toBe(res.data.publicKey as string);
  expect(JSON.stringify(res.data)).not.toContain(seed);
  expect(repo.env!.secrets.has("SPARKLE_KEY_APP2")).toBe(false);
  expect((await call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "app2" })).status).toBe(400);
  expect(store.items.get("https://sparkle-project.org app2")).toBe(seed);
});

test("Sparkle generation refuses a label in the hub and missing keystores", async () => {
  const { call, repo, s } = fixture();
  repo.env!.secrets.add("SPARKLE_KEY_CURRENT");
  expect((await call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "current" })).status).toBe(400);
  s.deps.store = () => null;
  expect((await call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "newapp" })).status).toBe(400);
});

test("two tabs cannot generate different keys for the same Sparkle label", async () => {
  const { call, store } = fixture();
  const save = store.save;
  let saves = 0;
  store.save = async (...args) => { saves++; await Bun.sleep(20); await save(...args); };
  const results = await Promise.all([call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "newapp" }), call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "newapp" })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(saves).toBe(1);
});

test("different hubs cannot overwrite their shared Sparkle keychain account concurrently", async () => {
  const { call, store, fake } = fixture();
  fake.repo("homebrew-other", { env: { policies: ["main"], custom: true, vars: new Map(), secrets: new Set() } });
  const save = store.save;
  let saves = 0;
  store.save = async (...args) => { saves++; await Bun.sleep(20); await save(...args); };
  const results = await Promise.all([
    call("POST", "/api/hub/sparkle/new", { hub: HUB, label: "shared" }),
    call("POST", "/api/hub/sparkle/new", { hub: "octo/homebrew-other", label: "shared" }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(saves).toBe(1);
});

test("Linux UI rotation keeps the previous signing key until Finish rotation", async () => {
  const { call, repo, store } = fixture();
  repo.env!.secrets.add("TAPSTER_LINUX_KEY");
  await store.save(linuxRef(HUB), "fixture-old-private-key");
  const res = await call("POST", "/api/hub/linux/key", { hub: HUB, rotate: true });
  expect(res.status).toBe(200);
  expect(res.data.previous).toBe("kept");
  expect(repo.env!.secrets.has("TAPSTER_LINUX_KEY_PREVIOUS")).toBe(true);
  expect(await store.read(linuxRef(HUB, true))).toBe("fixture-old-private-key");
  const current = await store.read(linuxRef(HUB));
  expect(current).toContain("fixture-new");
  expect((await call("POST", "/api/hub/linux/key", { hub: HUB, rotate: true })).status).toBe(400);
  expect((await call("POST", "/api/hub/linux/finish", { hub: HUB })).data).toEqual({ removed: true });
  expect(repo.env!.secrets.has("TAPSTER_LINUX_KEY_PREVIOUS")).toBe(false);
  expect(await store.read(linuxRef(HUB, true))).toBeNull();
  expect(await store.read(linuxRef(HUB))).toBe(current);
  expect((await call("POST", "/api/hub/linux/finish", { hub: HUB })).data).toEqual({ removed: false });
});

test("failed Linux finish keeps the previous key available for a retry", async () => {
  const { call, repo, store } = fixture();
  repo.env!.secrets.add("TAPSTER_LINUX_KEY_PREVIOUS");
  await store.save(linuxRef(HUB, true), "fixture-old-private-key");
  useGhWrite(async () => { throw new Error("write unavailable"); });
  expect((await call("POST", "/api/hub/linux/finish", { hub: HUB })).status).toBe(500);
  expect(await store.read(linuxRef(HUB, true))).toBe("fixture-old-private-key");
  expect(repo.env!.secrets.has("TAPSTER_LINUX_KEY_PREVIOUS")).toBe(true);
});
