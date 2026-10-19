import { LOGO_URI } from "./images";

export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export { LOGO_URI };

export const BASE_CSS = `
:root {
  --page: #f1f3f9; --paper: #ffffff; --ink: #17204a; --muted: #5a6386; --line: #dde2ef; --code: #f4f6fb;
  --orange: #f08a24; --link: #b4520a; --wax: #c4312b; --kraft: #e7cfa6; --navy: #17204a;
  --button: #f08a24; --button-hover: #f59a3c; --button-fg: #17204a;
  --see: #1f7a50; --see-bg: #ebf6f0; --wait: #8a5a0a; --wait-bg: #fdf4e3; --keys: #2f4bb0; --keys-bg: #edf1fd;
  --warn: #b3261e; --warn-bg: #fdeeec; --note: #5a6386; --note-bg: #eef1f8;
  --sans: "Archivo", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0c1230; --paper: #121a40; --ink: #e8ebf8; --muted: #a3abd0; --line: #27305f; --code: #0f1636;
    --orange: #ff9b3f; --link: #ffad61; --wax: #ff6b60; --kraft: #5c4a2e; --navy: #8a9bea;
    --button: #ff9b3f; --button-hover: #ffad61; --button-fg: #10163a;
    --see: #6fd3a0; --see-bg: #10261f; --wait: #f2b860; --wait-bg: #2a2214; --keys: #9db0ff; --keys-bg: #161f4a;
    --warn: #ff8d84; --warn-bg: #2e1620; --note: #a3abd0; --note-bg: #161e47;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 400 17px/1.6 var(--sans); font-stretch: 100%; -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
h1, h2, h3 { font-stretch: 112%; line-height: 1.15; letter-spacing: -0.012em; }
h1 { font-size: 2.3rem; font-weight: 800; margin: 0 0 1rem; }
h2 { font-size: 1.45rem; font-weight: 750; margin: 2.6rem 0 0.7rem; }
h3 { font-size: 1.12rem; font-weight: 700; margin: 1.9rem 0 0.4rem; }
p, ul, ol, dl, table { margin: 0 0 1rem; }
li { margin: 0.25rem 0; }
strong { font-weight: 700; }
code { font: 0.86em/1.5 var(--mono); background: var(--code); border: 1px solid var(--line); border-radius: 5px; padding: 0.06em 0.32em; overflow-wrap: anywhere; }
pre { background: var(--code); border: 1px solid var(--line); border-left: 3px solid var(--navy); border-radius: 4px; padding: 0.95rem 1.1rem; overflow-x: auto; margin: 0 0 1.2rem; }
pre code { background: none; border: 0; padding: 0; font-size: 0.85rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { border-bottom: 1px solid var(--line); padding: 0.5rem 0.6rem; text-align: left; vertical-align: top; }
th { font-weight: 700; font-stretch: 106%; }
.callout { border-left: 3px solid var(--note); background: var(--note-bg); border-radius: 0 6px 6px 0; padding: 0.8rem 1.1rem; margin: 0 0 1.2rem; }
.callout > :last-child { margin-bottom: 0; }
.callout .label { display: block; font-weight: 700; font-stretch: 106%; font-size: 0.92rem; color: var(--note); margin-bottom: 0.25rem; }
.callout.see { border-color: var(--see); background: var(--see-bg); } .callout.see .label { color: var(--see); }
.callout.wait { border-color: var(--wait); background: var(--wait-bg); } .callout.wait .label { color: var(--wait); }
.callout.keys { border-color: var(--keys); background: var(--keys-bg); } .callout.keys .label { color: var(--keys); }
.callout.warn { border-color: var(--warn); background: var(--warn-bg); } .callout.warn .label { color: var(--warn); }
.callout pre { background: var(--paper); }
.button { display: inline-block; background: var(--button); color: var(--button-fg); font: 700 1rem/1.2 var(--sans); font-stretch: 108%; padding: 0.85rem 1.35rem; border: 0; border-radius: 6px; text-decoration: none; cursor: pointer; box-shadow: 0 2px 0 color-mix(in srgb, var(--button) 55%, #000); }
.button:hover { background: var(--button-hover); }
.button:active { transform: translateY(1px); box-shadow: none; }
.button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--orange) 55%, transparent); outline-offset: 2px; }
.brand { display: inline-flex; align-items: center; gap: 0.6rem; font-weight: 800; font-stretch: 118%; font-size: 1.15rem; color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.brand img { border-radius: 22%; }
`;

export function head(title: string, css: string, description?: string, icons = `<link rel="icon" href="${LOGO_URI}">`): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${description ? `<meta name="description" content="${escape(description)}">\n` : ""}${icons}
<style>${BASE_CSS}${css}</style>
</head>`;
}
