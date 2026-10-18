import { expect, test } from "bun:test";
import { draftStatus, planPackage } from "../src/plan";
import { parseConfig } from "../src/config";
import type { Release } from "../src/github";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
`,
  "o",
).packages[0]!;
const d = "1".repeat(64);
const e = "2".repeat(64);
const asset = (id: number, name: string, digest: string | null, state = "uploaded") => ({ id, name, size: 1, state, digest: digest && `sha256:${digest}`, browser_download_url: "" });
const release = (assets: ReturnType<typeof asset>[], tag = "v1.0.0", draft = true): Release => ({ id: 1, tag_name: tag, draft, prerelease: false, created_at: "", published_at: null, upload_url: "", assets });
const sums = [{ sha256: d, name: "aims_1.0.0_darwin_arm64.tar.gz" }, { sha256: e, name: "aims_1.0.0_linux_amd64.tar.gz" }];
const full = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims_1.0.0_linux_amd64.tar.gz", e), asset(3, "checksums.txt", null)];

test("ready when every asset is uploaded and matches", () => {
  expect(draftStatus(release(full), cfg, sums)).toEqual({ kind: "ready" });
});

test("waiting while uploads are open or checksums are missing", () => {
  expect(draftStatus(release([...full.slice(0, 2), asset(3, "checksums.txt", null, "starter")]), cfg, sums).kind).toBe("waiting");
  expect(draftStatus(release(full.slice(0, 2)), cfg, null).kind).toBe("waiting");
});

test("review focus 2: a renamed asset leaves the draft waiting with the name", () => {
  const renamed = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims.1.0.0.linux.amd64.tar.gz", e), asset(3, "checksums.txt", null)];
  const s = draftStatus(release(renamed), cfg, sums);
  expect(s).toEqual({ kind: "waiting", reason: "aims_1.0.0_linux_amd64.tar.gz is not attached yet" });
});

test("invalid on digest mismatch, unlisted assets or a bad tag", () => {
  expect(draftStatus(release([asset(1, "aims_1.0.0_darwin_arm64.tar.gz", e), ...full.slice(1)]), cfg, sums).kind).toBe("invalid");
  expect(draftStatus(release([...full, asset(9, "extra.bin", d)]), cfg, sums).kind).toBe("invalid");
  expect(draftStatus(release(full, "v1.0.0#{x}"), cfg, sums).kind).toBe("invalid");
});

test("staging assets mean resume", () => {
  expect(draftStatus(release([...full, asset(8, "tapster-staging--checksums.txt", null)]), cfg, sums)).toEqual({ kind: "resume" });
});

test("two drafts for one tag stop the package", async () => {
  const r1 = release(full);
  const r2 = { ...release(full), id: 2 };
  const plan = await planPackage(cfg, [r1, r2], async () => sums);
  expect(plan.items).toEqual([]);
  expect(plan.notes[0]).toContain("two drafts");
});

test("published releases are not work", async () => {
  const plan = await planPackage(cfg, [release(full, "v1.0.0", false)], async () => sums);
  expect(plan.items).toEqual([]);
});
