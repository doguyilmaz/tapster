import { LOGO } from "./logo";

export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const LOGO_URI = `data:image/svg+xml;base64,${btoa(LOGO)}`;

export const BASE_CSS = `
:root {
  --bg: #faf8f4; --surface: #ffffff; --fg: #161a22; --muted: #5d6370; --line: #e6e1d8; --soft: #f3efe8;
  --accent: #a94f0b; --button: #f29a2e; --button-hover: #e98c1d; --button-fg: #1a1205;
  --see: #2b7651; --see-bg: #edf6f0; --wait: #9a610f; --wait-bg: #fdf4e3; --keys: #3152b8; --keys-bg: #eef2fc;
  --warn: #b0302d; --warn-bg: #fcefee; --note: #5d6370; --note-bg: #f3f1ec;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1217; --surface: #151922; --fg: #e9e7e2; --muted: #a0a6b1; --line: #272d38; --soft: #1b2029;
    --accent: #ffb25c; --button: #f5a23a; --button-hover: #ffb456; --button-fg: #1a1205;
    --see: #72d09f; --see-bg: #13241b; --wait: #f0b45a; --wait-bg: #2a2013; --keys: #93acff; --keys-bg: #161d33;
    --warn: #ff8f86; --warn-bg: #2d1615; --note: #a0a6b1; --note-bg: #1b2029;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16.5px/1.65 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
h1, h2, h3 { line-height: 1.25; letter-spacing: -0.015em; }
h1 { font-size: 2rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.35rem; margin: 2.4rem 0 0.6rem; }
h3 { font-size: 1.08rem; margin: 1.8rem 0 0.4rem; }
p, ul, ol, dl, table { margin: 0 0 1rem; }
li { margin: 0.2rem 0; }
code { font: 0.88em/1.5 var(--mono); background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 0.08em 0.35em; overflow-wrap: anywhere; }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; overflow-x: auto; margin: 0 0 1.1rem; }
pre code { background: none; border: 0; padding: 0; font-size: 0.86rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { border-bottom: 1px solid var(--line); padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
th { font-weight: 650; }
.callout { border: 1px solid var(--line); border-left: 4px solid var(--note); background: var(--note-bg); border-radius: 10px; padding: 0.75rem 1rem; margin: 0 0 1.1rem; }
.callout > :last-child { margin-bottom: 0; }
.callout .label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--note); margin-bottom: 0.2rem; }
.callout.see { border-left-color: var(--see); background: var(--see-bg); } .callout.see .label { color: var(--see); }
.callout.wait { border-left-color: var(--wait); background: var(--wait-bg); } .callout.wait .label { color: var(--wait); }
.callout.keys { border-left-color: var(--keys); background: var(--keys-bg); } .callout.keys .label { color: var(--keys); }
.callout.warn { border-left-color: var(--warn); background: var(--warn-bg); } .callout.warn .label { color: var(--warn); }
.callout pre { background: var(--surface); }
.button { display: inline-block; background: var(--button); color: var(--button-fg); font: 650 1rem/1.2 var(--sans); padding: 0.8rem 1.3rem; border: 0; border-radius: 10px; text-decoration: none; cursor: pointer; }
.button:hover { background: var(--button-hover); }
.button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--button) 50%, transparent); outline-offset: 2px; }
.brand { display: inline-flex; align-items: center; gap: 0.55rem; font-weight: 700; font-size: 1.1rem; color: var(--fg); text-decoration: none; letter-spacing: -0.01em; }
`;

export function head(title: string, css: string, description?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${description ? `<meta name="description" content="${escape(description)}">\n` : ""}<link rel="icon" href="${LOGO_URI}">
<style>${BASE_CSS}${css}</style>
</head>`;
}
