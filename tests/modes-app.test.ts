import { afterEach, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { feedWarning } from "../src/action/check";
import { packageMode } from "../src/action/package";
import { appOutputs } from "../src/action/publish";
import { sealMode } from "../src/action/seal";
import { signMode } from "../src/action/sign";
import { readSparkleKeys, sparkleFeed, sparkleMode } from "../src/action/sparkle";
import { carryCheck } from "../src/appcheck";
import { extractFeed } from "../src/appcast";
import { fillWorkflow } from "../src/cli/init";
import { type AppPackage, parseConfig } from "../src/config";
import { resetMaskForTests } from "../src/mask";
import { draftStatus } from "../src/plan";
import { emptyState, upsert } from "../src/state";
import { type Fetched, loadManifest, saveManifest } from "../src/workdir";

afterEach(resetMaskForTests);

function keyPair(): { seed: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { seed: pkcs8.subarray(pkcs8.length - 32).toString("base64"), pub: spki.subarray(spki.length - 32).toString("base64") };
}
const current = keyPair();
const next = keyPair();
const LEGACY = "c".repeat(64);

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets: { darwin-arm64: "aims_{version}_darwin_arm64.tar.gz" }
  - name: hafifpix
    repo: o/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.o.HafifPix
    assets: { darwin-arm64: "HafifPix-{version}.app.tar.gz" }
    carry: { appcast.xml: "sha256:${LEGACY}" }
    dmg: { name: "HafifPix-{version}.dmg" }
    sparkle: { key: shared, feed: appcast-2.xml, public_key: "${current.pub}", next_key: newer, next_public_key: "${next.pub}" }
`,
  "o",
);
const app = cfg.packages[1] as AppPackage;
const ctx = { hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: "/tmp" };
const facts = { version: "1.3.1", build: "1.3.1", minimumSystemVersion: "15.0", macos: "sequoia", publicKey: current.pub };
const ARCHIVE = "HafifPix-1.3.1.app.tar.gz";
const sums = [
  { sha256: "a".repeat(64), name: ARCHIVE },
  { sha256: LEGACY, name: "appcast.xml" },
];

const item = (over: Partial<Fetched>): Fetched => ({ package: "hafifpix", tag: "v1.3.1", releaseId: 1, resume: false, before: [], checksums: [], archives: [], status: "fetched", ...over });
const APPLE = ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"];

function fresh(): void {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "rt-"));
  for (const k of [...APPLE, ...Object.keys(process.env).filter((k) => k.startsWith("SPARKLE_KEY_"))]) delete process.env[k];
}

test("carried files must be pinned, present and apart from the outputs", () => {
  const names = (...n: string[]) => n.map((name) => ({ name }));
  expect(() => carryCheck(names(ARCHIVE, "appcast.xml", "checksums.txt"), sums, app, "1.3.1")).not.toThrow();
  expect(() => carryCheck(names(ARCHIVE, "appcast.xml", "notes.txt", "checksums.txt"), [...sums, { sha256: "d".repeat(64), name: "notes.txt" }], app, "1.3.1")).toThrow(/notes.txt/);
  expect(() => carryCheck(names(ARCHIVE, "appcast.xml", "checksums.txt"), [sums[0]!, { sha256: "e".repeat(64), name: "appcast.xml" }], app, "1.3.1")).toThrow(/appcast.xml/);
  expect(() => carryCheck(names(ARCHIVE, "checksums.txt"), sums.slice(0, 1), app, "1.3.1")).toThrow(/appcast.xml/);
  const clash = { ...app, carry: { "appcast-2.xml": `sha256:${LEGACY}` } };
  expect(() => carryCheck(names(ARCHIVE, "appcast-2.xml", "checksums.txt"), [sums[0]!, { sha256: LEGACY, name: "appcast-2.xml" }], clash, "1.3.1")).toThrow(/appcast-2.xml/);
});

test("prereleases of apps are refused", () => {
  const asset = (id: number, name: string) => ({ id, name, size: 1, state: "uploaded", digest: null, browser_download_url: "" });
  const r = { id: 1, tag_name: "v1.3.1-beta.1", draft: true, prerelease: true, created_at: "", published_at: null, upload_url: "", assets: [asset(1, "HafifPix-1.3.1-beta.1.app.tar.gz"), asset(2, "checksums.txt")] };
  expect(draftStatus(r, app, [{ sha256: "a".repeat(64), name: "HafifPix-1.3.1-beta.1.app.tar.gz" }])).toEqual({ kind: "invalid", reason: "prereleases of apps are not published, because the feed would never serve them" });
});

test("package, seal and sparkle pass CLI items and resumed apps through without credentials", async () => {
  fresh();
  await saveManifest({ items: [item({ package: "aims", status: "signed" }), item({ resume: true, status: "signed" })] });
  await packageMode(ctx);
  await sealMode(ctx);
  await sparkleMode(ctx);
  expect((await loadManifest()).items.map((i) => i.status)).toEqual(["signed", "sparkled"]);
});

test("an app is never marked signed without signing it", async () => {
  fresh();
  await saveManifest({ items: [item({ app: { dir: "/nowhere/HafifPix.app", facts, created: "2026-10-19T10:00:00Z", identifiers: [], dmg: null, feed: null } })] });
  await expect(signMode(ctx)).rejects.toThrow(/MACOS_SIGN_P12/);
  expect((await loadManifest()).items[0]!.status).toBe("fetched");
});

test("the DMG is signed with the app's key and the feed with the current key", () => {
  fresh();
  process.env.SPARKLE_KEY_SHARED = current.seed;
  process.env.SPARKLE_KEY_NEWER = next.seed;
  const keys = readSparkleKeys();
  expect(process.env.SPARKLE_KEY_SHARED).toBeUndefined();
  const dmg = Buffer.from("dmg bytes");
  const created = new Date("2026-10-19T10:00:00Z");
  const check = (signedBy: string, rotated: typeof facts) => {
    const signed = sparkleFeed({ pkg: app, tag: "v1.3.1", facts: rotated, dmg, created, keys });
    const { content, signature } = extractFeed(signed);
    const pub = (b64: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b64, "base64")]), format: "der", type: "spki" });
    expect(verify(null, content, pub(current.pub), Buffer.from(signature, "base64"))).toBe(true);
    const ed = content.toString("utf8").match(/sparkle:edSignature="([^"]+)"/)![1]!;
    expect(verify(null, dmg, pub(signedBy), Buffer.from(ed, "base64"))).toBe(true);
    expect(content.toString("utf8")).toContain('url="https://github.com/o/hafifpix/releases/download/v1.3.1/HafifPix-1.3.1.dmg" length="9"');
    expect(content.toString("utf8")).toContain("<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>");
  };
  check(current.pub, facts);
  check(next.pub, { ...facts, publicKey: next.pub });
});

test("a Sparkle key that does not belong to the app stops the item", () => {
  fresh();
  process.env.SPARKLE_KEY_SHARED = keyPair().seed;
  const keys = readSparkleKeys();
  expect(() => sparkleFeed({ pkg: app, tag: "v1.3.1", facts, dmg: Buffer.from("x"), created: new Date(), keys })).toThrow(
    "the Sparkle key shared does not belong to this app; installed copies would reject the update",
  );
  expect(() => sparkleFeed({ pkg: app, tag: "v1.3.1", facts, dmg: Buffer.from("x"), created: new Date(), keys: new Map() })).toThrow(/SPARKLE_KEY_SHARED/);
});

test("a malformed Sparkle key stops the step without its value", () => {
  fresh();
  process.env.SPARKLE_KEY_SHARED = "not a key!";
  let message = "";
  try {
    readSparkleKeys();
  } catch (e) {
    message = String((e as Error).message);
  }
  expect(message).toContain("SPARKLE_KEY_SHARED");
  expect(message).not.toContain("not a key");
});

test("an app publishes the DMG, the feed and the carried files, and drops the archive", () => {
  const out = appOutputs(app, "v1.3.1", sums, Buffer.from("dmg"), Buffer.from("feed"));
  expect(out.files.map((f) => f.name)).toEqual(["HafifPix-1.3.1.dmg", "appcast-2.xml", "checksums.txt"]);
  const listed = out.files[2]!.data.toString("utf8").trim().split("\n").map((l) => l.split(/\s+/)[1]);
  expect(listed.sort()).toEqual(["HafifPix-1.3.1.dmg", "appcast-2.xml", "appcast.xml"].sort());
  expect(out.remove).toEqual([ARCHIVE]);
});

type Step = { uses?: string; if?: string; with?: { mode?: string }; env?: Record<string, string> };
test("the hub workflow runs package, seal and sparkle with their own credentials", () => {
  const pins = JSON.parse(readFileSync("templates/pins.json", "utf8"));
  const text = fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" }, ["shared", "recesso"]);
  const steps = (parse(text) as { jobs: { sign: { steps: Step[] } } }).jobs.sign.steps;
  const modes = steps.map((s) => s.with?.mode).filter(Boolean);
  expect(modes).toEqual(["fetch", "sign", "package", "seal", "sparkle", "publish", "cleanup"]);
  const env = (mode: string) => Object.keys(steps.find((s) => s.with?.mode === mode)!.env ?? {});
  expect(env("package")).toEqual([]);
  expect(env("seal")).toEqual(env("sign"));
  expect(env("sparkle")).toEqual(["SPARKLE_KEY_SHARED", "SPARKLE_KEY_RECESSO"]);
  expect(steps.find((s) => s.with?.mode === "sparkle")!.env!.SPARKLE_KEY_SHARED).toBe("${{ secrets.SPARKLE_KEY_SHARED }}");
  const none = parse(fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" })) as { jobs: { sign: { steps: Step[] } } };
  expect(none.jobs.sign.steps.find((s) => s.with?.mode === "sparkle")!.env).toEqual({});
});

test("check warns when an app's latest release did not come from the hub", () => {
  const rel = (id: number, tag: string) => ({ id, tag_name: tag, draft: false, prerelease: false, created_at: "", published_at: "", upload_url: "", assets: [] });
  const state = upsert(emptyState(), "hafifpix", { tag: "v1.3.1", releaseId: 7, checksums: "b".repeat(64), status: "published", app: { macos: "sequoia", identifiers: [] } });
  expect(feedWarning(rel(7, "v1.3.1"), state, app)).toBeNull();
  expect(feedWarning(null, state, app)).toBeNull();
  expect(feedWarning(rel(9, "v1.3.2"), state, app)).toBe(
    "hafifpix: the latest release v1.3.2 did not come from the hub; installed copies read its appcast-2.xml, so check who published it",
  );
});
