import { expect, test } from "bun:test";
import { limited } from "../src/cli/doctor";
import { GitHub } from "../src/github";

test("the doctor keeps at most the given number of GitHub calls in flight and loses none", async () => {
  let now = 0;
  let peak = 0;
  const fetch = (async (input: string | URL | Request) => {
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
    return new Response(JSON.stringify({ full_name: String(input).split("/repos/")[1] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const gh = limited(new GitHub("t", fetch, async () => {}, "user"), 3);
  const names = Array.from({ length: 20 }, (_, i) => `o/r${i}`);
  const got = await Promise.all(names.map((n) => gh.getRepo(n)));
  expect(got.map((r) => (r as unknown as { full_name: string }).full_name)).toEqual(names);
  expect(peak).toBe(3);
});
