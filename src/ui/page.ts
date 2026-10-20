import { LOGO_URI } from "./images";

export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export { LOGO_URI };

export const BASE_CSS = `
:root {
  --page: #f6f5f3; --paper: #ffffff; --ink: #1c1b19; --muted: #6f6b64; --line: #e4e2de; --code: #f3f2ef;
  --orange: #f2891f; --link: #b9560a; --wax: #c8392f; --navy: #26315f;
  --button: #f2891f; --button-hover: #f79a3c; --button-fg: #1c1b19;
  --see: #1f8a55; --see-bg: #e6f6ec; --wait: #8a5a0a; --wait-bg: #fdf4e3; --keys: #2f4bb0; --keys-bg: #edf1fd;
  --warn: #b3261e; --warn-bg: #fdeeec; --note: #6f6b64; --note-bg: #f3f2ef;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #1c1b19; --paper: #252421; --ink: #faf9f7; --muted: #9c9890; --line: #3a3834; --code: #2d2b28;
    --link: #ffb066; --navy: #8a9be6;
    --see: #6fd3a0; --see-bg: #12301f; --wait: #f2b860; --wait-bg: #2e2412; --keys: #9db0ff; --keys-bg: #1d2340;
    --warn: #ff8d84; --warn-bg: #3a1b18; --note: #9c9890; --note-bg: #2d2b28;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 400 17px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
h1, h2, h3 { line-height: 1.15; letter-spacing: -0.02em; }
h1 { font-size: 2rem; font-weight: 750; margin: 0 0 1rem; }
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
th { font-weight: 700; }
.callout { border-left: 3px solid var(--note); background: var(--note-bg); border-radius: 0 6px 6px 0; padding: 0.8rem 1.1rem; margin: 0 0 1.2rem; }
.callout > :last-child { margin-bottom: 0; }
.callout .label { display: block; font-weight: 700; font-size: 0.92rem; color: var(--note); margin-bottom: 0.25rem; }
.callout.see { border-color: var(--see); background: var(--see-bg); } .callout.see .label { color: var(--see); }
.callout.wait { border-color: var(--wait); background: var(--wait-bg); } .callout.wait .label { color: var(--wait); }
.callout.keys { border-color: var(--keys); background: var(--keys-bg); } .callout.keys .label { color: var(--keys); }
.callout.warn { border-color: var(--warn); background: var(--warn-bg); } .callout.warn .label { color: var(--warn); }
.callout pre { background: var(--paper); }
.button { display: inline-block; background: var(--button); color: var(--button-fg); font: 650 1rem/1.2 var(--sans); padding: 0.85rem 1.4rem; border: 0; border-radius: 999px; text-decoration: none; cursor: pointer; }
.button:hover { background: var(--button-hover); }
.button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--orange) 55%, transparent); outline-offset: 2px; }
.brand { display: inline-flex; align-items: center; gap: 0.6rem; font-weight: 700; font-size: 1.15rem; color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
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
