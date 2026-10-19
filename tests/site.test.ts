import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite, parsePage, renderPages, type Source } from "../site/build";

const src = (id: string, head: string, body: string): Source => ({ id, text: `---\n${head}\n---\n${body}` });

test("a page needs a title and a known section", () => {
  expect(parsePage(src("guides/a", "title: A\nsection: Guides\norder: 1", "Hi")).title).toBe("A");
  expect(() => parsePage(src("guides/a", "section: Guides\norder: 1", "Hi"))).toThrow("guides/a: no title");
  expect(() => parsePage(src("guides/a", "title: A\nsection: Blog\norder: 1", "Hi"))).toThrow("guides/a: unknown section Blog");
});

test("marked quotes become callouts and unknown marks fail the build", () => {
  const [page] = renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "> [!SEE]\n> `tapster: done`\n")]);
  expect(page!.html).toContain('<aside class="callout see"><span class="label">You should see</span>');
  expect(page!.html).not.toContain("[!SEE]");
  expect(() => renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "> [!TIP]\n> x\n")])).toThrow("guides/a: unknown callout TIP");
});

test("links to pages become relative and broken ones fail the build", () => {
  const a = src("guides/a", "title: A\nsection: Guides\norder: 1", "See [B](/reference/b#the-part) and [web](https://example.com).\n");
  const b = src("reference/b", "title: B\nsection: Reference\norder: 1", "## The part\n");
  const [pa] = renderPages([a, b]);
  expect(pa!.html).toContain('<a href="../../reference/b/#the-part">B</a>');
  expect(pa!.html).toContain('<a href="https://example.com">web</a>');
  expect(() => renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "[x](/guides/missing)")])).toThrow("guides/a: link to /guides/missing, which is not a page");
  expect(() => renderPages([a, src("reference/b", "title: B\nsection: Reference\norder: 1", "## Other\n")])).toThrow("guides/a: link to /reference/b#the-part, which has no such heading");
  expect(() => renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "[x](javascript:alert(1)) [y](other.md)")])).toThrow("guides/a: link to javascript:alert(1)");
});

test("links to a heading on the same page are checked too", () => {
  const [page] = renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "See [below](#the-part).\n\n## The part\n")]);
  expect(page!.html).toContain('<a href="#the-part">below</a>');
  expect(() => renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "See [below](#nothing).\n")])).toThrow("guides/a: link to #nothing, which has no such heading");
});

test("table cells carry their column's name for narrow screens", () => {
  const [page] = renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "| Key | What it is |\n| --- | --- |\n| `a` | the **first** |\n")]);
  expect(page!.html).toContain('<td data-label="Key"><code>a</code></td><td data-label="What it is">the <strong>first</strong></td>');
});

test("raw HTML in content stays text", () => {
  const [page] = renderPages([src("guides/a", "title: A\nsection: Guides\norder: 1", "A <script>alert(1)</script> line.\n")]);
  expect(page!.html).not.toContain("<script>");
});

test("tutorial pages count their steps and every page links to its neighbours", () => {
  const pages = renderPages([
    src("tutorial/two", "title: Two\nsection: Tutorial\norder: 2\nstep: 2", "x"),
    src("tutorial/one", "title: One\nsection: Tutorial\norder: 1\nstep: 1", "x"),
    src("guides/g", "title: G\nsection: Guides\norder: 1", "x"),
  ]);
  const two = pages.find((p) => p.id === "tutorial/two")!;
  expect(two.html).toContain("Step 2 of 2");
  expect(two.html).toContain('<a class="prev" href="../../tutorial/one/">');
  expect(two.html).toContain('<a class="next" href="../../guides/g/">');
  expect(two.html).toContain('aria-current="page"');
});

test("the real site builds without scripts or broken links", () => {
  const out = mkdtempSync(join(tmpdir(), "tapster-site-"));
  try {
    const ids = buildSite(join(import.meta.dir, "..", "site", "content"), out);
    expect(ids).toContain("tutorial/hub");
    for (const id of ["", ...ids]) {
      const html = readFileSync(join(out, id, "index.html"), "utf8");
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
    }
    expect(readFileSync(join(out, "404.html"), "utf8")).toContain("Not found");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("every full tapster.yml in the docs is one the hub accepts", async () => {
  const { parseHub } = await import("../src/config");
  const { readdirSync } = await import("node:fs");
  const dir = join(import.meta.dir, "..", "site", "content");
  let seen = 0;
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((n) => n.endsWith(".md"))) {
    for (const block of readFileSync(join(dir, f), "utf8").split("```yaml\n").slice(1).map((b) => b.split("```")[0]!)) {
      if (!block.startsWith("version: 1")) continue;
      seen++;
      expect({ f, invalid: parseHub(block, "you").invalid }).toEqual({ f, invalid: [] });
    }
  }
  expect(seen).toBeGreaterThan(0);
});
