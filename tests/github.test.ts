import { expect, test } from "bun:test";
import { GitHub, type FetchLike } from "../src/github";
import { GitHubError } from "../src/errors";

type Call = { url: string; init: RequestInit };

function fake(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const noSleep = async () => {};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("sends auth and API headers", async () => {
  const f = fake([json({ id: 1, private: false })]);
  await new GitHub("tok-abc", f.fetch, noSleep).getRepo("o/r");
  const h = f.calls[0]!.init.headers as Record<string, string>;
  expect(f.calls[0]!.url).toBe("https://api.github.com/repos/o/r");
  expect(h.Authorization).toBe("Bearer tok-abc");
  expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
});

test("retries 5xx and network errors, then succeeds", async () => {
  const f = fake([new Error("reset"), json({}, 502), json({ id: 2 })]);
  expect((await new GitHub("t", f.fetch, noSleep).getRepo("o/r")).id).toBe(2);
  expect(f.calls.length).toBe(3);
});

test("errors carry status and path, never bodies or tokens", async () => {
  const f = fake([json({ message: "secret body" }, 404)]);
  let err: unknown;
  try {
    await new GitHub("tok-xyz", f.fetch, noSleep).getRepo("o/r");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GitHubError);
  const e = err as GitHubError;
  expect(e.status).toBe(404);
  expect(e.reason).toBe("GitHub GET /repos/o/r returned 404");
  expect(`${e.reason}${e.fix}`).not.toContain("secret body");
});

test("review focus 4: releases are paginated past 100", async () => {
  const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: start + i, tag_name: `v0.0.${start + i}`, draft: false, assets: [] }));
  const f = fake([json(page(100, 0)), json(page(3, 100))]);
  const all = await new GitHub("t", f.fetch, noSleep).listReleases("o/r");
  expect(all.length).toBe(103);
  expect(f.calls[1]!.url).toContain("page=2");
});

test("asset downloads follow the redirect without the token", async () => {
  const f = fake([
    new Response(null, { status: 302, headers: { location: "https://objects.example/x?X-Amz-Signature=sig" } }),
    new Response("bytes"),
  ]);
  const data = await new GitHub("tok", f.fetch, noSleep).downloadAsset("o/r", 7);
  expect(data.toString()).toBe("bytes");
  expect((f.calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("uploads go to the release upload url", async () => {
  const f = fake([json({ id: 9, name: "tapster-staging--a" })]);
  const release = { id: 1, upload_url: "https://uploads.github.com/repos/o/r/releases/1/assets{?name,label}" } as never;
  await new GitHub("t", f.fetch, noSleep).uploadAsset(release, "tapster-staging--a", new Uint8Array([1]));
  expect(f.calls[0]!.url).toBe("https://uploads.github.com/repos/o/r/releases/1/assets?name=tapster-staging--a");
});
