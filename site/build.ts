import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { escape } from "../src/ui/page";
import { homePage } from "./home";
import { docMain, frame, rel, SECTIONS, type NavItem, type Section } from "./layout";

export type Source = { id: string; text: string };
export type Page = NavItem & { description?: string; body: string };

const CALLOUTS: Record<string, [string, string]> = {
  SEE: ["see", "You should see"],
  WAIT: ["wait", "tapster waits here"],
  KEYS: ["keys", "Where your keys go"],
  NOTE: ["note", "Note"],
  WARN: ["warn", "Careful"],
};

export function parsePage(src: Source): Page {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src.text);
  if (!m) throw new Error(`${src.id}: no header`);
  const meta = Object.fromEntries(
    m[1]!.split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  if (!meta.title) throw new Error(`${src.id}: no title`);
  if (!SECTIONS.includes(meta.section as Section)) throw new Error(`${src.id}: unknown section ${meta.section}`);
  const order = Number(meta.order);
  if (!Number.isInteger(order)) throw new Error(`${src.id}: order must be a number`);
  const step = meta.step === undefined ? undefined : Number(meta.step);
  return { id: src.id, title: meta.title, section: meta.section as Section, order, step, description: meta.description, body: src.text.slice(m[0].length) };
}

function callouts(id: string, html: string): string {
  return html.replace(/<blockquote>\n<p>\[!([A-Z]+)\](?:<\/p>\n|\s*)([\s\S]*?)<\/blockquote>/g, (_, kind: string, rest: string) => {
    const c = CALLOUTS[kind];
    if (!c) throw new Error(`${id}: unknown callout ${kind}`);
    return `<aside class="callout ${c[0]}"><span class="label">${c[1]}</span>${rest.startsWith("<") ? rest : `<p>${rest}`}</aside>`;
  });
}

function tableLabels(html: string): string {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    const heads = [...table.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    return table.replace(/<tr>([\s\S]*?)<\/tr>/g, (row, cells: string) => {
      let i = 0;
      return `<tr>${cells.replace(/<td(\s[^>]*)?>/g, (_, attrs = "") => `<td data-label="${escape(heads[i++] ?? "")}"${attrs}>`)}</tr>`;
    });
  });
}

function links(page: Page, html: string, anchors: Map<string, Set<string>>): string {
  return html.replace(/<a href="([^"]*)"/g, (_, raw: string) => {
    const url = raw.replace(/&amp;/g, "&");
    if (/^https:\/\/[A-Za-z0-9.-]+(\/[^\s"<>]*)?$/.test(url)) return `<a href="${escape(url)}"`;
    const m = /^(?:\/([a-z0-9/-]*?)\/?)?(#[a-z0-9-]+)?$/.exec(url);
    if (!m || url === "") throw new Error(`${page.id}: link to ${url}`);
    const [, target = page.id, hash = ""] = m;
    const ids = anchors.get(target);
    if (!ids) throw new Error(`${page.id}: link to ${url}, which is not a page`);
    if (hash && !ids.has(hash.slice(1))) throw new Error(`${page.id}: link to ${url}, which has no such heading`);
    return `<a href="${target === page.id && hash ? "" : rel(page.id, target)}${hash}"`;
  });
}

export function navOf(pages: NavItem[]): NavItem[] {
  return [...pages].sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.order - b.order);
}

export function renderPages(sources: Source[]): { id: string; html: string }[] {
  const pages = sources.map(parsePage);
  const nav = navOf(pages).map(({ id, title, section, order, step }) => ({ id, title, section, order, step }));
  const rendered = pages.map((p) => ({ page: p, html: tableLabels(callouts(p.id, Bun.markdown.html(p.body, { headings: { ids: true }, noHtmlBlocks: true, noHtmlSpans: true }))) }));
  const anchors = new Map<string, Set<string>>([["", new Set()]]);
  for (const r of rendered) anchors.set(r.page.id, new Set([...r.html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((x) => x[1]!)));
  return rendered.map(({ page, html }) => ({
    id: page.id,
    html: frame({ id: page.id, title: page.title, description: page.description, nav, side: true, main: docMain({ item: nav.find((n) => n.id === page.id)!, nav, body: links(page, html, anchors) }) }),
  }));
}

function sources(dir: string): Source[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ id: relative(dir, join(dir, f)).replace(/\.md$/, ""), text: readFileSync(join(dir, f), "utf8") }));
}

export function buildSite(contentDir: string, out: string): string[] {
  const src = sources(contentDir);
  const pages = renderPages(src);
  const nav = navOf(src.map(parsePage));
  rmSync(out, { recursive: true, force: true });
  for (const p of pages) {
    mkdirSync(join(out, p.id), { recursive: true });
    writeFileSync(join(out, p.id, "index.html"), p.html);
  }
  writeFileSync(join(out, "index.html"), homePage(nav));
  writeFileSync(join(out, "404.html"), frame({ id: "", title: "Not found · tapster", nav, side: false, main: '<main class="doc" style="margin:4rem auto;padding:0 16px"><h1>Not found</h1><p><a href="/">Back to tapster</a></p></main>' }));
  return pages.map((p) => p.id);
}

if (import.meta.main) buildSite(join(import.meta.dir, "content"), join(import.meta.dir, "dist"));
