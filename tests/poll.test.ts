import { expect, test } from "bun:test";
import { waitFor } from "../src/cli/poll";

test("waiting for a click returns as soon as GitHub shows the result", async () => {
  let calls = 0;
  const slept: number[] = [];
  const found = await waitFor(async () => (++calls === 3 ? 42 : null), { timeoutMs: 60_000, intervalMs: 3_000, sleep: async (ms) => void slept.push(ms) });
  expect(found).toBe(42);
  expect(slept).toEqual([3_000, 3_000]);
});

test("waiting gives up after the timeout instead of hanging", async () => {
  let now = 0;
  const found = await waitFor(async () => null, { timeoutMs: 9_000, intervalMs: 3_000, sleep: async (ms) => void (now += ms), now: () => now });
  expect(found).toBeNull();
});
