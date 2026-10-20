import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dirs = [join(import.meta.dir, "..", "src", "web"), join(import.meta.dir, "..", "src", "web", "client"), join(import.meta.dir, "..", "src", "web", "api"), join(import.meta.dir, "..", "src", "mcp")];

test("the setup app's words follow the writing rules: no em dash and no comma before and or or", () => {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => /\.(tsx?|css)$/.test(x))) {
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes("—")) found.push(`${f}:${i + 1}: em dash`);
          if (/, (and|or) /.test(line)) found.push(`${f}:${i + 1}: comma before and/or`);
        });
    }
  }
  expect(found).toEqual([]);
});
