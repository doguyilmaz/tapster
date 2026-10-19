import { expect, test } from "bun:test";
import { assertFetchable } from "../src/action/fetch";
import type { Release } from "../src/github";

const ci = { login: "github-actions[bot]", type: "Bot" };
const app = { login: "tapster-o-tap[bot]", type: "Bot" };
const release = (over: Partial<Release> = {}): Release => ({
  id: 1, tag_name: "v1.0.0", draft: true, prerelease: false, created_at: "", published_at: null, upload_url: "", author: ci,
  assets: [{ id: 1, name: "checksums.txt", size: 1, state: "uploaded", digest: null, browser_download_url: "", uploader: ci }],
  ...over,
});
const item = { package: "p", tag: "v1.0.0", releaseId: 1, resume: false };

test("the draft that check accepted can be fetched", () => {
  expect(() => assertFetchable(release(), item, "o")).not.toThrow();
});

test("a draft that was published or retagged since check is refused", () => {
  expect(() => assertFetchable(release({ draft: false }), item, "o")).toThrow(/no longer the draft/);
  expect(() => assertFetchable(release({ tag_name: "v2.0.0" }), item, "o")).toThrow(/no longer the draft/);
});

test("a file uploaded by another App after check is refused", () => {
  const swapped = release({ assets: [{ id: 2, name: "checksums.txt", size: 1, state: "uploaded", digest: null, browser_download_url: "", uploader: app }] });
  expect(() => assertFetchable(swapped, item, "o")).toThrow(/uploaded by tapster-o-tap\[bot\]/);
  expect(() => assertFetchable(swapped, { ...item, resume: true }, "o")).not.toThrow();
});
