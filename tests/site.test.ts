import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { page, renderReadme } from "../site/page";

const BASE = "https://github.com/o/tapster/blob/main/";

test("headings get ids and raw HTML stays text", () => {
  const html = renderReadme("# tapster\n\n## Set up a hub\n\nA <script>alert(1)</script> line with `code` and **bold**.\n", BASE);
  expect(html).toContain('<h1 id="tapster">tapster</h1>');
  expect(html).toContain('<h2 id="set-up-a-hub">Set up a hub</h2>');
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<code>code</code>");
});

test("relative links point at GitHub and unsafe links are dropped", () => {
  const html = renderReadme("See [the spec](docs/a.md), [top](#tapster), [web](https://example.com/x) and [bad](javascript:alert(1)).", BASE);
  expect(html).toContain(`<a href="${BASE}docs/a.md">the spec</a>`);
  expect(html).toContain('<a href="#tapster">top</a>');
  expect(html).toContain('<a href="https://example.com/x">web</a>');
  expect(html).not.toContain("javascript:");
  expect(html).toContain("bad");
});

test("the real README builds into a page without scripts", () => {
  const html = page("tapster", renderReadme(readFileSync("README.md", "utf8"), BASE));
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
  expect(html).toContain('<h2 id="apps">Apps</h2>');
});

test("links with a title are rewritten too", () => {
  const html = renderReadme('[a](javascript:alert(1) "t") and [b](docs/x.md "t")', BASE);
  expect(html).not.toContain("javascript:");
  expect(html).toContain(`<a href="${BASE}docs/x.md"`);
});
