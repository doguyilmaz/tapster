const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function href(url: string, base: string): string | null {
  if (/^https:\/\/[A-Za-z0-9.-]+(\/[^\s"<>]*)?$/.test(url)) return url;
  if (/^#[a-z0-9-]+$/.test(url)) return url;
  if (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*(#[a-z0-9-]+)?$/.test(url) && !url.split("/").includes("..")) return base + url;
  return null;
}

function inline(text: string, base: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
          const target = href(url.replace(/&amp;/g, "&"), base);
          return target ? `<a href="${escape(target)}">${label}</a>` : label;
        });
    })
    .join("");
}

const ITEM = /^( *)([-*]|\d+\.) (.*)$/;

export function markdownToHtml(md: string, base: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escape(code.map((l) => `${l}\n`).join(""))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      const body = inline(heading[2]!, base);
      const n = heading[1]!.length;
      out.push(`<h${n} id="${slug(body)}">${body}</h${n}>`);
      i++;
      continue;
    }
    const first = ITEM.exec(line);
    if (first && first[1] === "") {
      const ordered = /\d/.test(first[2]!);
      const items: { text: string[]; children: string[][] }[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") {
        const l = lines[i]!;
        const m = ITEM.exec(l);
        if (m && m[1] === "" && /\d/.test(m[2]!) === ordered) items.push({ text: [m[3]!], children: [] });
        else if (m && m[1]!.length >= 2 && m[1]!.length <= 3 && items.length) items.at(-1)!.children.push([m[3]!]);
        else if (/^ {2,}/.test(l) && items.length) {
          const item = items.at(-1)!;
          (item.children.length ? item.children.at(-1)! : item.text).push(l.trim());
        } else break;
        i++;
      }
      const li = (item: { text: string[]; children: string[][] }) =>
        `<li>${inline(item.text.join(" "), base)}${item.children.length ? `<ul>${item.children.map((c) => `<li>${inline(c.join(" "), base)}</li>`).join("")}</ul>` : ""}</li>`;
      out.push(ordered ? `<ol>${items.map(li).join("")}</ol>` : `<ul>${items.map(li).join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^#{1,6} /.test(lines[i]!) && !(ITEM.exec(lines[i]!)?.[1] === "")) {
      para.push(lines[i++]!.trim());
    }
    out.push(`<p>${inline(para.join(" "), base)}</p>`);
  }
  return out.join("\n");
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
