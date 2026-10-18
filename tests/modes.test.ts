import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEach, buildDownloads, renderNeeded } from "../src/action/render";
import { signMode } from "../src/action/sign";
import { parseConfig } from "../src/config";
import { serializeState, upsert, emptyState } from "../src/state";
import { loadManifest, saveManifest } from "../src/workdir";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
`,
  "o",
);

test("downloads come from the published checksums", () => {
  const d = buildDownloads(cfg.packages[0]!, "v1.0.0", [{ sha256: "a".repeat(64), name: "aims_1.0.0_darwin_arm64.tar.gz" }]);
  expect(d).toEqual([{ platform: "darwin-arm64", url: "https://github.com/o/aims/releases/download/v1.0.0/aims_1.0.0_darwin_arm64.tar.gz", sha256: "a".repeat(64) }]);
  expect(() => buildDownloads(cfg.packages[0]!, "v1.0.0", [])).toThrow();
});

test("render is needed when a cask is behind the state or an entry is publishing", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(ws, ".tapster"), { recursive: true });
  mkdirSync(join(ws, "Casks"), { recursive: true });
  const ctx = { hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: ws };
  const published = upsert(emptyState(), "aims", { tag: "v1.0.0", releaseId: 1, checksums: "b".repeat(64), status: "published" });
  writeFileSync(join(ws, ".tapster/state.json"), serializeState(published));
  writeFileSync(join(ws, "Casks/aims.rb"), 'cask "aims" do\n  version "0.9.0"\nend\n');
  expect(await renderNeeded(ctx)).toBe(true);
  writeFileSync(join(ws, "Casks/aims.rb"), 'cask "aims" do\n  version "1.0.0"\nend\n');
  expect(await renderNeeded(ctx)).toBe(false);
  const publishing = upsert(published, "aims", { tag: "v1.1.0", releaseId: 2, checksums: "c".repeat(64), status: "publishing" });
  writeFileSync(join(ws, ".tapster/state.json"), serializeState(publishing));
  expect(await renderNeeded(ctx)).toBe(true);
});

test("review focus 3: a release with nothing to sign passes without reading credentials", async () => {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "rt-"));
  for (const k of ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY"]) delete process.env[k];
  await saveManifest({ items: [{ package: "aims", tag: "v1.0.0", releaseId: 1, resume: false, before: [], checksums: [], archives: [], status: "fetched" }] });
  await signMode({ hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: "/tmp" });
  expect((await loadManifest()).items[0]!.status).toBe("signed");
});

test("private packages never make render run", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(ws, ".tapster"), { recursive: true });
  writeFileSync(join(ws, ".tapster/state.json"), serializeState(upsert(emptyState(), "aims", { tag: "v1.0.0", releaseId: 1, checksums: "b".repeat(64), status: "published" })));
  const ctx = { hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: ws };
  expect(await renderNeeded(ctx)).toBe(true);
  expect(await renderNeeded(ctx, new Set(["aims"]))).toBe(false);
});

test("one cask failing its audit leaves the others", async () => {
  const seen: string[] = [];
  const failed = await auditEach(["a", "b", "c"], async (name) => {
    seen.push(name);
    if (name === "b") throw new Error("style");
  });
  expect(seen).toEqual(["a", "b", "c"]);
  expect([...failed.keys()]).toEqual(["b"]);
});
