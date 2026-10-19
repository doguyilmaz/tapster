import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHub } from "../src/config";

const DOCS = join(import.meta.dir, "..", "site", "src", "content", "docs");
const pages = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.mdx?$/.test(f))
  .map((f) => ({ f, text: readFileSync(join(DOCS, f), "utf8") }));

const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");

test("the docs have the tutorial, guides and reference pages", () => {
  const names = pages.map((p) => p.f).sort();
  expect(names).toContain("tutorial/hub.mdx");
  expect(names).toContain("reference/security.md");
  expect(names.length).toBeGreaterThan(15);
});

test("every full tapster.yml in the docs is one the hub accepts", () => {
  let seen = 0;
  for (const { f, text } of pages) {
    for (const block of text.split("```yaml\n").slice(1).map((b) => b.split("```")[0]!)) {
      if (!block.startsWith("version: 1")) continue;
      seen++;
      expect({ f, invalid: parseHub(block, "you").invalid }).toEqual({ f, invalid: [] });
    }
  }
  expect(seen).toBeGreaterThan(0);
});

test("the docs follow the writing rules: no em dash and no comma before and or or", () => {
  const found: string[] = [];
  for (const { f, text } of pages) {
    for (const line of prose(text).split("\n")) {
      if (line.includes("—")) found.push(`${f}: em dash: ${line.trim()}`);
      if (/, (and|or) /.test(line)) found.push(`${f}: comma: ${line.trim()}`);
    }
  }
  expect(found).toEqual([]);
});

test("every tutorial page shows its progress and the next step", () => {
  for (const { f, text } of pages.filter((p) => p.f.startsWith("tutorial/"))) {
    expect({ f, progress: text.includes("<TutorialProgress step={") }).toEqual({ f, progress: true });
    expect({ f, next: text.includes("<NextStep step={") }).toEqual({ f, next: true });
  }
});
