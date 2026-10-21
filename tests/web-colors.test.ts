import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "web", "client", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

const tokens = new Map<string, string[]>();
for (const r of rules.filter((x) => x.selector === ":root")) {
  for (const [, name, value] of r.body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(name!, [...(tokens.get(name!) ?? []), value!.trim()]);
}

const resolve = (value: string, seen = new Set<string>()): string[] => {
  const refs = [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
  const own = value.replace(/var\((--[\w-]+)\)/g, "");
  return [own, ...refs.filter((r) => !seen.has(r)).flatMap((r) => (tokens.get(r) ?? []).flatMap((v) => resolve(v, new Set([...seen, r]))))];
};

const hexes = (value: string) => [...value.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => (m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!));
const rgbs = (value: string) => [...value.matchAll(/rgb\((\d+) (\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);

function red(r: number, g: number, b: number): boolean {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  if (max - min < 0.15) return false;
  const hue = max === x ? (60 * ((y - z) / (max - min)) + 360) % 360 : max === y ? 60 * ((z - x) / (max - min)) + 120 : 60 * ((x - y) / (max - min)) + 240;
  return hue < 18 || hue > 335;
}

const reds = (value: string) => [...hexes(value).map((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as const), ...rgbs(value)].filter(([r, g, b]) => red(r, g, b));

const DONE = /\.(done|ok|seal|has)\b|\.progress span/;

test("the wax token and the old seal colors read as red to this check", () => {
  expect(reds(tokens.get("--wax")!.join(" "))).toHaveLength(2);
  expect(reds("#ee6b56 #c8392f #8f2019 rgb(143 32 25 / 0.6)")).toHaveLength(4);
  expect(reds(tokens.get("--orange")!.join(" ") + tokens.get("--green")!.join(" "))).toEqual([]);
});

test("no success or done state uses wax or red, in light or dark mode", () => {
  const done = rules.filter((r) => DONE.test(r.selector));
  expect(done.map((r) => r.selector)).toEqual(expect.arrayContaining([".done .dot", ".badge.ok", ".note.ok", ".checks .ok", ".seal"]));
  const found = done.flatMap((r) => [...(r.body.includes("--wax") ? ["--wax"] : []), ...resolve(r.body).flatMap(reds).map((c) => c.join(","))].map((x) => `${r.selector}: ${x}`));
  expect(found).toEqual([]);
});
