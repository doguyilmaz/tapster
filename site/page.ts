const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function href(url: string, base: string): string | null {
  if (/^https:\/\/[A-Za-z0-9.-]+(\/[^\s"<>]*)?$/.test(url)) return url;
  if (/^#[a-z0-9-]+$/.test(url)) return url;
  if (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*(#[a-z0-9-]+)?$/.test(url) && !url.split("/").includes("..")) return base + url;
  return null;
}

export function renderReadme(md: string, base: string): string {
  const html = Bun.markdown.html(md, { headings: { ids: true }, noHtmlBlocks: true, noHtmlSpans: true });
  return html.replace(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_, url: string, rest: string, label: string) => {
    const target = href(url.replace(/&amp;/g, "&"), base);
    return target ? `<a href="${escape(target)}"${rest}>${label}</a>` : label;
  });
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { --bg: #fdfcfa; --fg: #1d1c1a; --muted: #5d5a55; --code: #f1eee8; --link: #9a4a12; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece9e3; --muted: #a8a39b; --code: #26241f; --link: #f0a060; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 2.2rem; margin: 0 0 1rem; }
h2 { margin-top: 2.5rem; }
a { color: var(--link); }
code { background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.92em; }
pre { background: var(--code); padding: 1rem; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--code); padding: 0.3rem 0.6rem; text-align: left; }
footer { color: var(--muted); font-size: 0.9rem; margin-top: 3rem; }
</style>
</head>
<body>
<main>
${body}
<footer><a href="https://github.com/doguyilmaz/tapster">tapster on GitHub</a></footer>
</main>
</body>
</html>
`;
}
