import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { markdownToHtml, page } from "../site/markdown";

const BASE = "https://github.com/o/tapster/blob/main/";

test("headings, paragraphs, lists, code and inline marks render", () => {
  const md = `# tapster

Some **bold** text with \`code\` and a [link](https://example.com)
that wraps.

## Set up a hub

- one item
  that continues
- two

1. first
2. second

\`\`\`sh
echo "<hi>" && exit
\`\`\`
`;
  const html = markdownToHtml(md, BASE);
  expect(html).toContain('<h1 id="tapster">tapster</h1>');
  expect(html).toContain('<h2 id="set-up-a-hub">Set up a hub</h2>');
  expect(html).toContain('<p>Some <strong>bold</strong> text with <code>code</code> and a <a href="https://example.com">link</a> that wraps.</p>');
  expect(html).toContain("<ul><li>one item that continues</li><li>two</li></ul>");
  expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  expect(html).toContain('<pre><code>echo &quot;&lt;hi&gt;&quot; &amp;&amp; exit\n</code></pre>');
});

test("relative links point at GitHub and unsafe links are dropped", () => {
  const html = markdownToHtml("See [the spec](docs/a.md), [top](#tapster) and [bad](javascript:alert(1)).", BASE);
  expect(html).toContain(`<a href="${BASE}docs/a.md">the spec</a>`);
  expect(html).toContain('<a href="#tapster">top</a>');
  expect(html).not.toContain("javascript:");
});

test("markup in text is escaped and unknown constructs stay text", () => {
  const html = markdownToHtml("A <script>alert(1)</script> line.\n\n| a | b |\n| - | - |\n\n- outer\n  - inner\n    - deeper\n", BASE);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<p>| a | b | | - | - |</p>");
  expect(html).toContain("<ul><li>outer<ul><li>inner - deeper</li></ul></li></ul>");
});

test("the real README builds into a page without stray markup", () => {
  const html = page("tapster", markdownToHtml(readFileSync("README.md", "utf8"), BASE));
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).not.toContain("<script");
  const text = html.replace(/<\/?(?:!doctype html|html|head|body|meta|title|style|main|header|footer|h[1-6]|p|ul|ol|li|pre|code|strong|a)(?:\s[^>]*)?>/gi, "");
  expect(text).not.toMatch(/<[a-z!/]/i);
});
