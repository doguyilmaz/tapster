import { expect, test } from "bun:test";
import { draftOrigin, draftStatus, planPackage } from "../src/plan";
import { parseConfig } from "../src/config";
import { TapsterError } from "../src/errors";
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
const ci = { login: "github-actions[bot]", type: "Bot" };
const asset = (id: number, name: string, digest: string | null, state = "uploaded", uploader: { login: string; type: string } | null = ci) => ({ id, name, size: 1, state, digest: digest && `sha256:${digest}`, browser_download_url: "", uploader });
const release = (assets: ReturnType<typeof asset>[], tag = "v1.0.0", draft = true): Release => ({ id: 1, tag_name: tag, draft, prerelease: false, created_at: "", published_at: null, upload_url: "", author: ci, assets });
const opts = { checksumsOf: async () => sums, owner: "o", tagExists: async () => true };
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
  const plan = await planPackage(cfg, [r1, r2], opts);
  expect(plan.items).toEqual([]);
  expect(plan.notes[0]).toContain("two drafts");
});

test("published releases are not work", async () => {
  const plan = await planPackage(cfg, [release(full, "v1.0.0", false)], opts);
  expect(plan.items).toEqual([]);
});

test("an unreadable checksums.txt marks only its own draft", async () => {
  const bad = { ...release(full, "v0.0.2"), id: 2 };
  const plan = await planPackage(cfg, [release(full), bad], { ...opts, checksumsOf: async (r) => {
    if (r.id === 2) throw new TapsterError("checksums.txt line 1 is malformed", "x");
    return sums;
  } });
  expect(plan.items.map((i) => i.tag)).toEqual(["v1.0.0"]);
  expect(plan.notes).toEqual(["v0.0.2: checksums.txt line 1 is malformed"]);
});

test("a fully swapped draft that tapster recorded resumes", () => {
  const swapped = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims_1.0.0_linux_amd64.tar.gz", e), asset(3, "checksums.txt", "f".repeat(64))];
  expect(draftStatus(release(swapped), cfg, sums, "f".repeat(64))).toEqual({ kind: "resume" });
  expect(draftStatus(release(swapped), cfg, sums, "0".repeat(64)).kind).not.toBe("resume");
});

test("planPackage passes the recorded digest per release", async () => {
  const swapped = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims_1.0.0_linux_amd64.tar.gz", e), asset(3, "checksums.txt", "f".repeat(64))];
  const plan = await planPackage(cfg, [release(swapped)], { ...opts, recorded: (id) => (id === 1 ? "f".repeat(64) : undefined) });
  expect(plan.items).toEqual([{ package: "aims", tag: "v1.0.0", releaseId: 1, resume: true }]);
});

test("a draft for a tag that is already published is never work", async () => {
  const plan = await planPackage(cfg, [release(full, "v1.0.0", false), { ...release(full), id: 2 }], opts);
  expect(plan.items).toEqual([]);
  expect(plan.notes[0]).toContain("already published");
});

test("drafts made and filled by the project's workflow or the owner are trusted", () => {
  expect(draftOrigin(release(full), "o")).toBeNull();
  const owner = { login: "O", type: "User" };
  expect(draftOrigin({ ...release(full.map((a) => ({ ...a, uploader: owner }))), author: owner }, "o")).toBeNull();
});

test("a draft made or filled by another App names who did it", () => {
  const app = { login: "tapster-o-tap[bot]", type: "Bot" };
  expect(draftOrigin({ ...release(full), author: app }, "o")).toBe("the draft was created by tapster-o-tap[bot]; tapster takes drafts only from github-actions[bot] or o");
  const swapped = [...full.slice(0, 2), asset(3, "checksums.txt", null, "uploaded", app)];
  expect(draftOrigin(release(swapped), "o")).toBe("checksums.txt was uploaded by tapster-o-tap[bot]; tapster takes drafts only from github-actions[bot] or o");
  expect(draftOrigin(release([asset(1, "x", d, "uploaded", null)]), "o")).toBe("x was uploaded by an unknown account; tapster takes drafts only from github-actions[bot] or o");
});

test("a foreign upload makes the draft invalid and a missing tag makes it wait", async () => {
  const app = { login: "tapster-o-tap[bot]", type: "Bot" };
  const foreign = await planPackage(cfg, [{ ...release(full), author: app }], opts);
  expect(foreign.items).toEqual([]);
  expect(foreign.notes[0]).toContain("created by tapster-o-tap[bot]");
  const untagged = await planPackage(cfg, [release(full)], { ...opts, tagExists: async () => false });
  expect(untagged.items).toEqual([]);
  expect(untagged.notes).toEqual(["v1.0.0: the tag is not pushed yet; tapster publishes only tags that exist"]);
});

test("a draft the hub is already publishing is not judged by who uploaded its files", async () => {
  const app = { login: "tapster-o-tap[bot]", type: "Bot" };
  const staged = [...full, asset(4, "tapster-staging--aims_1.0.0_darwin_arm64.tar.gz", d, "uploaded", app)];
  const plan = await planPackage(cfg, [release(staged)], opts);
  expect(plan.items).toEqual([{ package: "aims", tag: "v1.0.0", releaseId: 1, resume: true }]);
});
