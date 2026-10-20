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
