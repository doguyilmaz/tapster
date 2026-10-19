export type WaitOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

export async function waitFor<T>(probe: () => Promise<T | null>, opts: WaitOptions = {}): Promise<T | null> {
  const { timeoutMs = 600_000, intervalMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = opts;
  const end = now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    if (now() + intervalMs > end) return null;
    await sleep(intervalMs);
  }
}
