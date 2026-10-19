import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecksumLine } from "./checksums";
import type { Platform } from "./config";
import type { Asset } from "./github";

export type DarwinArchive = { asset: string; platform: Platform; dir: string; binaries: string[] };
export type Fetched = {
  package: string;
  tag: string;
  releaseId: number;
  resume: boolean;
  before: Asset[];
  checksums: ChecksumLine[];
  archives: DarwinArchive[];
  status: "fetched" | "signed" | "failed";
};
export type Manifest = { items: Fetched[] };

export const workdir = () => join(process.env.RUNNER_TEMP ?? tmpdir(), "tapster");
const manifestPath = () => join(workdir(), "manifest.json");

export async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(manifestPath(), "utf8")) as Manifest;
  } catch {
    return { items: [] };
  }
}

export async function saveManifest(m: Manifest): Promise<void> {
  await mkdir(workdir(), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath(), JSON.stringify(m), { mode: 0o600 });
}
