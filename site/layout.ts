import { escape, head } from "../src/ui/page";

export const SECTIONS = ["Tutorial", "Guides", "Reference"] as const;
export type Section = (typeof SECTIONS)[number];
export type NavItem = { id: string; title: string; section: Section; order: number; step?: number };

export const REPO = "https://github.com/doguyilmaz/tapster";

export function rel(from: string, to: string): string {
  const up = "../".repeat(from ? from.split("/").length : 0);
  return up + (to ? `${to}/` : "") || "./";
}

const CSS = `
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem clamp(16px, 3vw, 32px); background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.top nav { display: flex; gap: 1.2rem; }
.top nav a { color: var(--muted); text-decoration: none; font-weight: 550; font-size: 0.95rem; }
.top nav a:hover { color: var(--fg); }
.layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: clamp(24px, 4vw, 64px); max-width: 1120px; margin: 0 auto; padding: 2.2rem clamp(16px, 3vw, 32px) 4rem; }
.side { position: sticky; top: 4.6rem; align-self: start; max-height: calc(100vh - 5.6rem); overflow: auto; font-size: 0.94rem; }
.navlist h2 { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 1.3rem 0 0.35rem 0.6rem; }
.navlist h2:first-child { margin-top: 0; }
.navlist ul { list-style: none; padding: 0; margin: 0; }
.navlist li { margin: 0; }
.navlist a { display: flex; align-items: center; gap: 0.55rem; padding: 0.32rem 0.6rem; border-radius: 8px; color: var(--fg); text-decoration: none; }
.navlist a:hover { background: var(--soft); }
.navlist a[aria-current] { background: var(--soft); color: var(--accent); font-weight: 650; }
.navlist .n { display: inline-grid; place-items: center; flex: none; width: 1.35rem; height: 1.35rem; border-radius: 50%; border: 1px solid var(--line); font-size: 0.72rem; color: var(--muted); }
.navlist a[aria-current] .n { border-color: var(--button); background: var(--button); color: var(--button-fg); }
.layout > div { min-width: 0; }
.menu { display: none; }
.doc { max-width: 44rem; min-width: 0; }
.doc table { display: block; overflow-x: auto; }
.doc td code, .doc th code { overflow-wrap: normal; }
.doc h2, .doc h3 { scroll-margin-top: 5rem; }
.eyebrow { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin: 0 0 0.5rem; }
.progress { display: flex; gap: 6px; margin: 0 0 1.6rem; }
.progress span { height: 4px; flex: 1; border-radius: 2px; background: var(--line); }
.progress span.on { background: var(--button); }
.doc h2 { margin-top: 2.2rem; padding-top: 1.4rem; border-top: 1px solid var(--line); }
.doc h1 + h2, .doc .progress + h2 { border-top: 0; padding-top: 0; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 3.2rem; }
.pager a { display: block; padding: 0.9rem 1rem; border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--muted); font-size: 0.85rem; background: var(--surface); }
.pager a strong { display: block; color: var(--fg); font-size: 1rem; margin-top: 0.15rem; }
.pager a:hover { border-color: var(--accent); }
.pager .next { grid-column: 2; text-align: right; }
.foot { border-top: 1px solid var(--line); color: var(--muted); font-size: 0.88rem; padding: 1.6rem clamp(16px, 3vw, 32px); text-align: center; }
.foot p { margin: 0.2rem 0; }
@media (max-width: 600px) {
  .doc table, .doc tbody, .doc tr, .doc td { display: block; }
  .doc thead { display: none; }
  .doc tr { border-bottom: 1px solid var(--line); padding: 0.6rem 0; }
  .doc td { border: 0; padding: 0.15rem 0; }
  .doc td[data-label]:not(:first-child)::before { content: attr(data-label) ": "; color: var(--muted); font-size: 0.85rem; }
}
@media (max-width: 860px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding-top: 1rem; }
  .side { display: none; }
  .menu { display: block; margin-bottom: 1.4rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  .menu summary { padding: 0.65rem 0.9rem; font-weight: 650; cursor: pointer; }
  .menu .navlist { padding: 0 0.4rem 0.7rem; }
  .pager { grid-template-columns: 1fr; }
  .pager .next { grid-column: 1; }
}
`;

function navList(nav: NavItem[], current: string): string {
  return `<div class="navlist">${SECTIONS.map((s) => {
    const items = nav.filter((n) => n.section === s);
    if (!items.length) return "";
    const links = items.map((n) => {
      const mark = n.step ? `<span class="n">${n.step}</span>` : "";
      return `<li><a href="${rel(current, n.id)}"${n.id === current ? ' aria-current="page"' : ""}>${mark}${escape(n.title)}</a></li>`;
    });
    return `<h2>${s}</h2><ul>${links.join("")}</ul>`;
  }).join("")}</div>`;
}

export function frame(o: { id: string; title: string; description?: string; css?: string; main: string; nav: NavItem[]; side: boolean }): string {
  const first = o.nav.find((n) => n.step === 1) ?? o.nav[0]!;
  const root = rel(o.id, "");
  const icons = `<link rel="icon" type="image/png" href="${root}assets/favicon-32.png">\n<link rel="apple-touch-icon" href="${root}assets/apple-touch-icon.png">`;
  return `${head(o.id ? `${o.title} · tapster` : o.title, CSS + (o.css ?? ""), o.description, icons)}
<body>
<header class="top">
<a class="brand" href="${root}"><img src="${root}assets/logo-128.webp" width="32" height="32" alt="">tapster</a>
<nav aria-label="Site"><a href="${rel(o.id, first.id)}">Tutorial</a><a href="${REPO}">GitHub</a></nav>
</header>
${o.side ? `<div class="layout">
<nav class="side" aria-label="Pages">${navList(o.nav, o.id)}</nav>
<div>
<details class="menu"><summary>All pages</summary>${navList(o.nav, o.id)}</details>
${o.main}
</div>
</div>` : o.main}
<footer class="foot">
<p>tapster has no server. It runs in your terminal and in your own GitHub Actions.</p>
<p>MIT licensed. <a href="${REPO}">Source on GitHub</a>.</p>
</footer>
</body>
</html>
`;
}

export function docMain(o: { item: NavItem; nav: NavItem[]; body: string }): string {
  const { item, nav } = o;
  const i = nav.findIndex((n) => n.id === item.id);
  const prev = nav[i - 1];
  const next = nav[i + 1];
  const steps = nav.filter((n) => n.step).length;
  const eyebrow = item.step ? `Tutorial · Step ${item.step} of ${steps}` : item.section;
  const progress = item.step ? `<div class="progress" aria-hidden="true">${nav.filter((n) => n.step).map((n) => `<span${n.step! <= item.step! ? ' class="on"' : ""}></span>`).join("")}</div>` : "";
  const link = (n: NavItem | undefined, cls: string, label: string) => (n ? `<a class="${cls}" href="${rel(item.id, n.id)}">${label}<strong>${escape(n.title)}</strong></a>` : "");
  return `<main class="doc">
<p class="eyebrow">${eyebrow}</p>
<h1>${escape(item.title)}</h1>
${progress}${o.body}
<nav class="pager" aria-label="Previous and next">${link(prev, "prev", "Previous")}${link(next, "next", "Next")}</nav>
</main>`;
}
