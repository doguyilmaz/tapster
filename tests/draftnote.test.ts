import { expect, test } from "bun:test";
import { judge, noteText, waitingSince, withNote } from "../src/draftnote";

test("the note goes on top and leaves the owner's text alone", () => {
  const body = "## Changes\n- faster\n";
  const noted = withNote(body, "a.tar.gz is attached but not listed in checksums.txt");
  expect(noted.startsWith("<!-- tapster -->\n")).toBe(true);
  expect(noted).toContain("a.tar.gz is attached but not listed in checksums.txt");
  expect(noted.endsWith(body)).toBe(true);
  const replaced = withNote(noted, "another reason");
  expect(replaced).not.toContain("a.tar.gz");
  expect(replaced.match(/<!-- tapster -->/g)).toHaveLength(1);
  expect(withNote(replaced, null)).toBe(body);
  expect(withNote(null, null)).toBe("");
  expect(withNote(body, null)).toBe(body);
});

test("the note cannot close its own block early", () => {
  const noted = withNote("", "x <!-- /tapster --> y");
  expect(noted.match(/<!-- \/tapster -->/g)).toHaveLength(1);
  expect(withNote(noted, null)).toBe("");
});

test("noteText says that the hub will not publish and why", () => {
  expect(noteText("the tag is not pushed yet")).toContain("tapster will not publish this draft");
});

const now = Date.parse("2026-10-19T12:00:00Z");

test("invalid drafts fail, waiting drafts fail after an hour", () => {
  expect(judge({ kind: "invalid", since: "2026-10-19T11:59:00Z" }, now)).toBe("failed");
  expect(judge({ kind: "waiting", since: "2026-10-19T11:30:00Z" }, now)).toBe("waiting");
  expect(judge({ kind: "waiting", since: "2026-10-19T10:59:00Z" }, now)).toBe("failed");
  expect(judge({ kind: "waiting", since: null }, now)).toBe("waiting");
});

test("a problem fails the run once, when the hub first writes it on the draft", async () => {
  const { noteOutcome } = await import("../src/draftnote");
  const n = { tag: "v1.0.0", releaseId: 1, kind: "invalid" as const, reason: "x is not listed", since: "2026-10-19T11:59:00Z" };
  const first = noteOutcome(n, "notes", now);
  expect(first.result).toBe("failed");
  expect(first.body).toBe(withNote("notes", "x is not listed"));
  const again = noteOutcome(n, first.body, now);
  expect(again.result).toBe("known");
  expect(again.body).toBeNull();
  const fresh = noteOutcome({ ...n, kind: "waiting" }, first.body, now);
  expect(fresh).toEqual({ result: "waiting", body: "notes", reason: "x is not listed" });
  const stale = noteOutcome({ ...n, kind: "waiting", since: "2026-10-19T10:00:00Z" }, "notes", now);
  expect(stale.result).toBe("failed");
  expect(stale.reason).toBe("x is not listed for more than an hour");
});

test("writing the note keeps the draft's tag, which GitHub drops from a body-only edit", async () => {
  const { writeNote } = await import("../src/action/check");
  const sent: unknown[] = [];
  const gh = { json: async (_m: string, _p: string, body: unknown) => { sent.push(body); return {}; } } as never;
  const release = { id: 7, tag_name: "v1.2.3", body: "notes" } as never;
  await writeNote(gh, "o/p", release, withNote("notes", "x"));
  expect(sent).toEqual([{ body: withNote("notes", "x"), tag_name: "v1.2.3" }]);
});

test("a draft waits an hour from its last upload, not from the date of its commit", () => {
  const asset = (created_at: string) => ({ id: 1, name: "a", size: 1, state: "uploaded", digest: null, browser_download_url: "", created_at });
  const release = { created_at: "2026-10-01T00:00:00Z", assets: [asset("2026-10-19T11:40:00Z"), asset("2026-10-19T11:50:00Z")] };
  expect(waitingSince(release)).toBe("2026-10-19T11:50:00Z");
  expect(waitingSince({ created_at: "2026-10-01T00:00:00Z", assets: [] })).toBeNull();
  expect(judge({ kind: "waiting", since: waitingSince(release) }, Date.parse("2026-10-19T12:00:00Z"))).toBe("waiting");
});
