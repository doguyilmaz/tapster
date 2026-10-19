import { expect, test } from "bun:test";
import { attestDecision } from "../src/action/publish";
import { assertRecorded, makeLatest, resumeSwap, sameAssets, stageAndSwap, waitDownloadable } from "../src/publish";
import type { Asset, GitHub, Release } from "../src/github";
import { TapsterError } from "../src/errors";
import { sha256 } from "../src/checksums";

const a = (id: number, name: string, digest = `sha256:${id}`): Asset => ({ id, name, size: 1, state: "uploaded", digest, browser_download_url: `https://dl/${name}` });
const rel = (assets: Asset[], over: Partial<Release> = {}): Release => ({ id: 1, tag_name: "v1.0.0", draft: true, prerelease: false, created_at: "", published_at: null, upload_url: "u{?name}", assets, ...over });

function fakeGh(current: Release, download = "") {
  const log: string[] = [];
  let next = 100;
  const gh = {
    getRelease: async () => current,
    downloadAsset: async () => Buffer.from(download),
    uploadAsset: async (_r: Release, name: string) => {
      log.push(`upload ${name}`);
      return a(next++, name);
    },
    deleteAsset: async (_repo: string, id: number) => {
      log.push(`delete ${id}`);
    },
    renameAsset: async (_repo: string, id: number, name: string) => {
      log.push(`rename ${id} ${name}`);
      return a(id, name);
    },
  } as unknown as GitHub;
  return { gh, log };
}

test("uploads every staging file first, then swaps with checksums last", async () => {
  const before = [a(1, "x.tar.gz"), a(2, "checksums.txt")];
  const f = fakeGh(rel(before));
  await stageAndSwap(f.gh, "o/r", 1, [{ name: "checksums.txt", data: Buffer.from("s") }, { name: "x.tar.gz", data: Buffer.from("x") }], before);
  expect(f.log).toEqual([
    "upload tapster-staging--x.tar.gz",
    "upload tapster-staging--checksums.txt",
    "delete 1",
    "rename 100 x.tar.gz",
    "delete 2",
    "rename 101 checksums.txt",
  ]);
});

test("stops when the draft changed or was published", async () => {
  const before = [a(1, "x.tar.gz")];
  await expect(stageAndSwap(fakeGh(rel([a(1, "x.tar.gz", "sha256:other")])).gh, "o/r", 1, [], before)).rejects.toBeInstanceOf(TapsterError);
  await expect(stageAndSwap(fakeGh(rel(before, { draft: false })).gh, "o/r", 1, [], before)).rejects.toBeInstanceOf(TapsterError);
});

const hx = "1".repeat(64);
const signedSums = `${hx}  x.tar.gz\n`;
const half = () => rel([a(2, "checksums.txt"), a(100, "tapster-staging--x.tar.gz", `sha256:${hx}`), a(101, "tapster-staging--checksums.txt")]);

test("resume finishes a half-done swap that tapster recorded", async () => {
  const f = fakeGh(half(), signedSums);
  await resumeSwap(f.gh, "o/r", half(), sha256(Buffer.from(signedSums)));
  expect(f.log).toEqual(["rename 100 x.tar.gz", "delete 2", "rename 101 checksums.txt"]);
});

test("staging files tapster did not record are removed, never published", async () => {
  const f = fakeGh(half(), signedSums);
  await expect(resumeSwap(f.gh, "o/r", half(), undefined)).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual(["delete 100", "delete 101"]);
});

test("staging files whose checksums differ from the record are removed", async () => {
  const f = fakeGh(half(), `${"2".repeat(64)}  x.tar.gz\n`);
  await expect(resumeSwap(f.gh, "o/r", half(), sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual(["delete 100", "delete 101"]);
});

test("a staged file that does not match the recorded checksums is removed", async () => {
  const forged = rel([a(2, "checksums.txt"), a(100, "tapster-staging--x.tar.gz", `sha256:${"3".repeat(64)}`), a(101, "tapster-staging--checksums.txt")]);
  const f = fakeGh(forged, signedSums);
  await expect(resumeSwap(f.gh, "o/r", forged, sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual(["delete 100", "delete 101"]);
});

test("resume after an interrupted upload removes the partial staging files and starts over", async () => {
  const partial = rel([a(1, "x.tar.gz"), a(2, "checksums.txt"), a(100, "tapster-staging--x.tar.gz")]);
  const f = fakeGh(partial);
  await expect(resumeSwap(f.gh, "o/r", partial, sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual(["delete 100"]);
});

test("sameAssets ignores order", () => {
  expect(sameAssets([a(1, "x"), a(2, "y")], [a(2, "y"), a(1, "x")])).toBe(true);
  expect(sameAssets([a(1, "x")], [a(1, "x"), a(3, "z")])).toBe(false);
});

test("make_latest only for the highest stable version", () => {
  const published = (tag: string) => rel([], { tag_name: tag, draft: false });
  expect(makeLatest("v1.2.0", [published("v1.1.0")])).toBe("true");
  expect(makeLatest("v1.0.1", [published("v1.1.0")])).toBe("false");
  expect(makeLatest("v2.0.0-rc.1", [])).toBe("false");
});

test("waits until every asset downloads", async () => {
  let calls = 0;
  const fetchImpl = async () => new Response(null, { status: ++calls > 2 ? 200 : 404 });
  await waitDownloadable(["https://dl/a"], fetchImpl, async () => {}, 60_000);
  expect(calls).toBe(3);
  await expect(waitDownloadable(["https://dl/a"], async () => new Response(null, { status: 404 }), async () => {}, -1)).rejects.toBeInstanceOf(TapsterError);
});

test("resume of a fully swapped draft changes nothing when it matches the record", async () => {
  const done = rel([a(100, "x.tar.gz", `sha256:${hx}`), a(101, "checksums.txt", `sha256:${sha256(Buffer.from(signedSums))}`)]);
  const f = fakeGh(done, signedSums);
  await resumeSwap(f.gh, "o/r", done, sha256(Buffer.from(signedSums)));
  expect(f.log).toEqual([]);
});

test("resume of a fully swapped draft that no longer matches fails without touching it", async () => {
  const changed = rel([a(100, "x.tar.gz", `sha256:${"9".repeat(64)}`), a(101, "checksums.txt")]);
  const f = fakeGh(changed, signedSums);
  await expect(resumeSwap(f.gh, "o/r", changed, sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual([]);
});

test("a published checksums.txt must be the one tapster recorded", () => {
  expect(() => assertRecorded(Buffer.from(signedSums), sha256(Buffer.from(signedSums)))).not.toThrow();
  expect(() => assertRecorded(Buffer.from("other"), sha256(Buffer.from(signedSums)))).toThrow(TapsterError);
});

test("an app swap renames the outputs, drops the unsigned archive, and commits with checksums last", async () => {
  const before = [a(1, "HafifPix-1.3.1.app.tar.gz"), a(2, "checksums.txt")];
  const f = fakeGh(rel(before));
  await stageAndSwap(
    f.gh,
    "o/r",
    1,
    [{ name: "checksums.txt", data: Buffer.from("s") }, { name: "HafifPix-1.3.1.dmg", data: Buffer.from("d") }, { name: "appcast.xml", data: Buffer.from("f") }],
    before,
    ["HafifPix-1.3.1.app.tar.gz"],
  );
  expect(f.log).toEqual([
    "upload tapster-staging--HafifPix-1.3.1.dmg",
    "upload tapster-staging--appcast.xml",
    "upload tapster-staging--checksums.txt",
    "rename 100 HafifPix-1.3.1.dmg",
    "rename 101 appcast.xml",
    "delete 1",
    "delete 2",
    "rename 102 checksums.txt",
  ]);
});

test("resuming an app swap after the DMG rename finishes it and drops the archive", async () => {
  const dmg = "4".repeat(64);
  const feed = "5".repeat(64);
  const sums = `${feed}  appcast.xml\n${dmg}  HafifPix-1.3.1.dmg\n`;
  const half = rel([
    a(1, "HafifPix-1.3.1.app.tar.gz", `sha256:${"9".repeat(64)}`),
    a(2, "checksums.txt"),
    a(100, "HafifPix-1.3.1.dmg", `sha256:${dmg}`),
    a(101, "tapster-staging--appcast.xml", `sha256:${feed}`),
    a(102, "tapster-staging--checksums.txt"),
  ]);
  const f = fakeGh(half, sums);
  await resumeSwap(f.gh, "o/r", half, sha256(Buffer.from(sums)), ["HafifPix-1.3.1.app.tar.gz"]);
  expect(f.log).toEqual(["rename 101 appcast.xml", "delete 1", "delete 2", "rename 102 checksums.txt"]);
});

test("a staged file the recorded checksums do not list is never published", async () => {
  const forged = rel([a(2, "checksums.txt"), a(100, "tapster-staging--x.tar.gz", `sha256:${hx}`), a(103, "tapster-staging--evil.dmg"), a(101, "tapster-staging--checksums.txt")]);
  const f = fakeGh(forged, signedSums);
  await expect(resumeSwap(f.gh, "o/r", forged, sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log.some((l) => l.startsWith("rename"))).toBe(false);
});

test("an unexpected unlisted asset stops the resume without deleting it", async () => {
  const extra = rel([a(2, "checksums.txt"), a(7, "notes.txt"), a(100, "tapster-staging--x.tar.gz", `sha256:${hx}`), a(101, "tapster-staging--checksums.txt")]);
  const f = fakeGh(extra, signedSums);
  await expect(resumeSwap(f.gh, "o/r", extra, sha256(Buffer.from(signedSums)))).rejects.toBeInstanceOf(TapsterError);
  expect(f.log).toEqual([]);
});

test("a private hub publishes without asking for attestations and says why", () => {
  expect(attestDecision(true, false)).toEqual({ attest: true, note: null });
  expect(attestDecision(false, false)).toEqual({ attest: false, note: null });
  expect(attestDecision(true, true).attest).toBe(false);
  expect(attestDecision(true, true).note).toContain("private");
});
