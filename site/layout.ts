import { escape, head } from "../src/ui/page";

export const SECTIONS = ["Tutorial", "Guides", "Reference"] as const;
export type Section = (typeof SECTIONS)[number];
export type NavItem = { id: string; title: string; section: Section; order: number; step?: number };

export const REPO = "https://github.com/doguyilmaz/tapster";

export function rel(from: string, to: string): string {
  const up = "../".repeat(from ? from.split("/").length : 0);
  return up + (to ? `${to}/` : "") || "./";
}

const fontFace = (root: string) => `
@font-face { font-family: "Archivo"; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; src: url("${root}assets/fonts/archivo-latin.woff2") format("woff2"); }`;

const CSS = `
.airmail { height: 6px; background: repeating-linear-gradient(-45deg, var(--wax) 0 14px, var(--paper) 14px 22px, var(--navy) 22px 36px, var(--paper) 36px 44px); }
.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--paper) 94%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.top .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: 1180px; margin: 0 auto; padding: 0.7rem clamp(16px, 3vw, 32px); }
.top nav { display: flex; gap: 1.4rem; }
.top nav a { color: var(--muted); text-decoration: none; font-weight: 600; font-stretch: 106%; }
.top nav a:hover, .top nav a[aria-current] { color: var(--ink); }
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: clamp(24px, 5vw, 72px); max-width: 1180px; margin: 0 auto; padding: 2.6rem clamp(16px, 3vw, 32px) 5rem; }
.layout > div { min-width: 0; }
.side { position: sticky; top: 5rem; align-self: start; max-height: calc(100vh - 6rem); overflow: auto; font-size: 0.95rem; }
.navlist h2 { font-size: 0.95rem; font-stretch: 112%; font-weight: 800; margin: 1.6rem 0 0.4rem 0.7rem; }
.navlist h2:first-child { margin-top: 0; }
.navlist ul { list-style: none; padding: 0; margin: 0; }
.navlist li { margin: 0; }
.navlist a { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.3rem 0.7rem; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; }
.navlist a:hover { color: var(--ink); }
.navlist a[aria-current] { color: var(--ink); font-weight: 700; border-left-color: var(--orange); background: var(--paper); }
.navlist .n { flex: none; width: 1.1rem; font-weight: 700; font-stretch: 90%; color: var(--muted); text-align: right; }
.menu { display: none; }
.doc { max-width: 42rem; min-width: 0; }
.doc table { display: block; overflow-x: auto; }
.doc td code, .doc th code { overflow-wrap: normal; }
.doc h2, .doc h3 { scroll-margin-top: 5.5rem; }
.doc > h1 { font-size: clamp(2rem, 4vw, 2.6rem); }
.track { display: flex; align-items: center; margin: 0 0 0.6rem; list-style: none; padding: 0; }
.track li { margin: 0; flex: 1; display: flex; align-items: center; }
.track li:last-child { flex: 0; }
.track a { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--navy); background: var(--paper); }
.track li.done a { background: var(--navy); }
.track li.here a { background: var(--orange); border-color: var(--orange); box-shadow: 0 0 0 4px color-mix(in srgb, var(--orange) 25%, transparent); }
.track li::after { content: ""; flex: 1; height: 2px; background: var(--line); margin: 0 4px; }
.track li.done::after { background: var(--navy); }
.track li:last-child::after { display: none; }
.stepof { color: var(--muted); font-size: 0.92rem; margin: 0 0 0.4rem; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 3.6rem; padding-top: 1.6rem; border-top: 1px solid var(--line); }
.pager a { text-decoration: none; color: var(--muted); font-size: 0.9rem; }
.pager a strong { display: block; color: var(--ink); font-size: 1.12rem; font-stretch: 108%; margin-top: 0.1rem; }
.pager a:hover strong { color: var(--link); }
.pager .next { grid-column: 2; text-align: right; }
.foot { border-top: 1px solid var(--line); background: var(--paper); color: var(--muted); font-size: 0.92rem; }
.foot .bar { max-width: 1180px; margin: 0 auto; padding: 1.8rem clamp(16px, 3vw, 32px); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.6rem 2rem; }
.foot p { margin: 0; }
@media (max-width: 600px) {
  .doc table, .doc tbody, .doc tr, .doc td { display: block; }
  .doc thead { display: none; }
  .doc tr { border-bottom: 1px solid var(--line); padding: 0.6rem 0; }
  .doc td { border: 0; padding: 0.15rem 0; }
  .doc td[data-label]:not(:first-child)::before { content: attr(data-label) ": "; color: var(--muted); font-size: 0.88rem; }
}
@media (max-width: 860px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding-top: 1.2rem; }
  .side { display: none; }
  .menu { display: block; margin-bottom: 1.6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); }
  .menu summary { padding: 0.7rem 1rem; font-weight: 700; cursor: pointer; }
  .menu .navlist { padding: 0 0.4rem 0.8rem; }
  .pager { grid-template-columns: 1fr; }
  .pager .next { grid-column: 1; }
  .top nav { gap: 1rem; }
}
@media (max-width: 520px) {
  .top nav a:not(:first-child):not(:last-child) { display: none; }
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
  const icons = `<link rel="icon" type="image/png" href="${root}assets/favicon-32.png">\n<link rel="apple-touch-icon" href="${root}assets/apple-touch-icon.png">\n<link rel="preload" href="${root}assets/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin>`;
  const section = o.nav.find((n) => n.id === o.id)?.section;
  const top = (label: string, id: string | undefined, here: boolean) => (id === undefined ? "" : `<a href="${rel(o.id, id)}"${here ? ' aria-current="true"' : ""}>${label}</a>`);
  return `${head(o.id ? `${o.title} · tapster` : o.title, fontFace(root) + CSS + (o.css ?? ""), o.description, icons)}
<body>
<header class="top">
<div class="airmail" aria-hidden="true"></div>
<div class="bar">
<a class="brand" href="${root}"><img src="${root}assets/logo-128.webp" width="34" height="34" alt="">tapster</a>
<nav aria-label="Site">${top("Tutorial", first.id, section === "Tutorial")}${top("Guides", o.nav.find((n) => n.section === "Guides")?.id, section === "Guides")}${top("Reference", o.nav.find((n) => n.section === "Reference")?.id, section === "Reference")}<a href="${REPO}">GitHub</a></nav>
</div>
</header>
${o.side ? `<div class="layout">
<nav class="side" aria-label="Pages">${navList(o.nav, o.id)}</nav>
<div>
<details class="menu"><summary>All pages</summary>${navList(o.nav, o.id)}</details>
${o.main}
</div>
</div>` : o.main}
<footer class="foot"><div class="bar">
<p>tapster has no server. It runs in your terminal and in your own GitHub Actions.</p>
<p>MIT licensed. <a href="${REPO}">Source on GitHub</a></p>
</div></footer>
</body>
</html>
`;
}

export function docMain(o: { item: NavItem; nav: NavItem[]; body: string }): string {
  const { item, nav } = o;
  const i = nav.findIndex((n) => n.id === item.id);
  const prev = nav[i - 1];
  const next = nav[i + 1];
  const steps = nav.filter((n) => n.step);
  const track = item.step
    ? `<ol class="track" aria-label="Tutorial progress">${steps
        .map((n) => {
          const state = n.step! < item.step! ? "done" : n.step === item.step ? "here" : "";
          const name = escape(`Step ${n.step}: ${n.title}`);
          return `<li class="${state}"><a href="${rel(item.id, n.id)}" title="${name}" aria-label="${name}"${n.id === item.id ? ' aria-current="step"' : ""}></a></li>`;
        })
        .join("")}</ol>
<p class="stepof">Step ${item.step} of ${steps.length}</p>\n`
    : "";
  const link = (n: NavItem | undefined, cls: string, label: string) => (n ? `<a class="${cls}" href="${rel(item.id, n.id)}">${label}<strong>${escape(n.title)}</strong></a>` : "");
  return `<main class="doc">
${track}<h1>${escape(item.title)}</h1>
${o.body}
<nav class="pager" aria-label="Previous and next">${link(prev, "prev", "Previous")}${link(next, "next", "Next")}</nav>
</main>`;
}
