import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../run";
import { workdir } from "../workdir";

export async function cleanupMode(): Promise<void> {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(workdir()).filter((d) => d.startsWith("kc-"));
  } catch {
    return;
  }
  for (const d of dirs) await run("security", ["delete-keychain", join(workdir(), d, "tapster.keychain-db")], { allowFail: true });
  await rm(workdir(), { recursive: true, force: true });
}
