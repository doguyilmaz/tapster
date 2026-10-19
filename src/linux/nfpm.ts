import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTarGz } from "../archive";
import { sha256 } from "../checksums";
import { TapsterError } from "../errors";
import { runPath } from "../run";
import type { Packager } from "./build";

export type Pin = { url: string; sha256: string };

const BASE = "https://github.com/goreleaser/nfpm/releases/download/v2.47.0";
export const NFPM: Record<"x64" | "arm64", Pin> = {
  x64: { url: `${BASE}/nfpm_2.47.0_Linux_x86_64.tar.gz`, sha256: "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783" },
  arm64: { url: `${BASE}/nfpm_2.47.0_Linux_arm64.tar.gz`, sha256: "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c" },
};
export const SOURCE_DATE_EPOCH = "315532800";

export async function installNfpm(fetchImpl: typeof fetch, dir: string, pin: Pin): Promise<string> {
  const res = await fetchImpl(pin.url).catch(() => null);
  if (!res?.ok) throw new TapsterError("nfpm could not be downloaded", "The next run tries again.");
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== pin.sha256) throw new TapsterError("the nfpm download does not match its pinned digest", "Check the nfpm pin in tapster.");
  const entry = readTarGz(data).find((e) => e.type === "file" && e.name === "nfpm");
  if (!entry) throw new TapsterError("the nfpm archive has no nfpm binary", "Check the nfpm pin in tapster.");
  const path = join(dir, "nfpm");
  await writeFile(path, entry.data, { mode: 0o755 });
  return path;
}

export const nfpmPackager =
  (path: string) =>
  async (config: string, kind: Packager, dir: string): Promise<void> => {
    await runPath(path, "nfpm", ["package", "--config", config, "--packager", kind, "--target", `${dir}/`], { env: { SOURCE_DATE_EPOCH } });
  };
