import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TarEntry } from "./archive";
import { TapsterError } from "./errors";

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

export async function readTree(root: string, name: string, out: TarEntry[] = []): Promise<TarEntry[]> {
  const s = await lstat(root);
  if (s.isSymbolicLink()) out.push({ name, type: "symlink", mode: 0o755, data: Buffer.alloc(0), linkname: await readlink(root) });
  else if (s.isFile()) out.push({ name, type: "file", mode: s.mode & 0o7777, data: await readFile(root) });
  else if (s.isDirectory()) {
    out.push({ name, type: "dir", mode: s.mode & 0o7777, data: Buffer.alloc(0) });
    for (const child of await readdir(root)) await readTree(join(root, child), `${name}/${child}`, out);
  } else throw new TapsterError(`${name} is not a file, folder or symlink`, "Report this as a tapster bug.");
  return out;
}
