import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = new Set<string>();

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

export function removeTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  dirs.delete(dir);
}

export function cleanupTemps(): void {
  for (const dir of [...dirs]) removeTemp(dir);
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    cleanupTemps();
    process.exit(code);
  });
}
