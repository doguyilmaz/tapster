import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TarEntry } from "./archive";

export async function writeTree(entries: TarEntry[], root: string): Promise<void> {
  const depth = (e: TarEntry) => e.name.split("/").length;
  for (const e of entries.filter((x) => x.type === "dir").sort((a, b) => depth(a) - depth(b))) {
    await mkdir(join(root, e.name), { recursive: true });
    await chmod(join(root, e.name), e.mode & 0o755);
  }
  for (const e of entries.filter((x) => x.type === "file")) {
    const path = join(root, e.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, e.data, { flag: "wx", mode: 0o600 });
    await chmod(path, e.mode & 0o755);
  }
  for (const e of entries.filter((x) => x.type === "symlink")) {
    const path = join(root, e.name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(e.linkname!, path);
  }
}
