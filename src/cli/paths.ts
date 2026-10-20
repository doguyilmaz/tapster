import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { TapsterError } from "../errors";

export function cleanPath(input: string, home = process.env.HOME ?? ""): string {
  let p = input.trim();
  const quoted = p.length > 1 && (p[0] === "'" || p[0] === '"') && p.at(-1) === p[0];
  p = quoted ? p.slice(1, -1) : p.replace(/\\(.)/g, "$1");
  if (!p) throw new TapsterError("no path was given", "Type the path or drag the file into the terminal.");
  return p.replace(/^~(?=\/|$)/, home);
}

export async function readInput(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") throw new TapsterError(`${path} does not exist`, `Check the path of ${what}.`);
    if (code === "EISDIR") throw new TapsterError(`${path} is a folder`, `Give the path of ${what} itself.`);
    throw new TapsterError(`${path} cannot be read`, `Check that you can open ${what}.`);
  }
}

export function readRegular(path: string, limit = 1 << 20): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > limit) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export const readSmall = (path: string, limit = 1 << 20): string | null => readRegular(path, limit)?.toString("utf8") ?? null;

export function mustRead(path: string, what: string, limit = 1 << 20): string {
  const text = readSmall(path, limit);
  if (text === null) throw new TapsterError(`${what} is not a regular file tapster can read`, "Replace a link or a very large file with the file itself, then try again.");
  return text;
}
