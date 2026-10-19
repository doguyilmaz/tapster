import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTree } from "../src/extract";

test("writes folders, files and links, with safe modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  await writeTree(
    [
      { name: "A.app/Contents/MacOS/A", type: "file", mode: 0o4777, data: Buffer.from("x") },
      { name: "A.app/Contents", type: "dir", mode: 0o777, data: Buffer.alloc(0) },
      { name: "A.app/Contents/Link", type: "symlink", mode: 0o777, data: Buffer.alloc(0), linkname: "MacOS/A" },
    ],
    root,
  );
  expect(readFileSync(join(root, "A.app/Contents/MacOS/A"), "utf8")).toBe("x");
  expect(lstatSync(join(root, "A.app/Contents/MacOS/A")).mode & 0o7777).toBe(0o755);
  expect(readlinkSync(join(root, "A.app/Contents/Link"))).toBe("MacOS/A");
});

test("never writes into an existing file", async () => {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  const entry = { name: "x", type: "file" as const, mode: 0o644, data: Buffer.from("1") };
  await writeTree([entry], root);
  await expect(writeTree([entry], root)).rejects.toThrow();
});
