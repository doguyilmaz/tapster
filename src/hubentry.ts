import { isMap, isSeq, parse, parseDocument, type YAMLMap } from "yaml";
import { parseHub } from "./config";
import { TapsterError } from "./errors";

type Spot = { start: number; end: number; indent: number; index: number };
type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function spot(text: string, name: string): Spot | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const packages = doc.get("packages", true);
  if (!isSeq(packages) || packages.flow) return null;
  const hits = packages.items.flatMap((item, index) => (isMap(item) && item.get("name") === name ? [{ item, index }] : []));
  if (hits.length !== 1) return null;
  const { item, index } = hits[0]!;
  const range = (item as YAMLMap).range;
  if (!range) return null;
  const start = text.lastIndexOf("\n", range[0] - 1) + 1;
  const lead = /^( *)- +$/.exec(text.slice(start, range[0]));
  if (!lead) return null;
  let end = range[1];
  while (end > range[0] && /\s/.test(text[end - 1]!)) end--;
  return { start, end, indent: lead[1]!.length, index };
}

// The entry's own lines in tapster.yml, without the list's indent: what the page shows and edits.
export function entryText(text: string, name: string): string | null {
  const at = spot(text, name);
  if (!at) return null;
  const pad = " ".repeat(at.indent);
  const lines = text.slice(at.start, at.end).split("\n");
  if (lines.some((l) => l.trim() !== "" && !l.startsWith(pad))) return null;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(at.indent))).join("\n");
}

const tidy = (entry: string) => entry.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

function oneEntry(entry: string): Plain {
  const doc = parseDocument(entry);
  const err = doc.errors[0];
  if (err) {
    const line = err.linePos?.[0]?.line;
    throw new TapsterError(`the entry is not valid YAML${line ? ` at line ${line}` : ""}: ${err.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}`, "Fix the YAML in the box.");
  }
  const list = doc.toJS() as unknown;
  if (!Array.isArray(list) || list.length !== 1 || !isPlain(list[0]) || !entry.startsWith("- ")) {
    throw new TapsterError("the box must hold exactly one entry that starts with - name:", "Keep the entry as one item of the packages list.");
  }
  return list[0];
}

// tapster.yml with only the lines of one entry replaced. It refuses anything that would change another entry, the
// package's name or repository. It also refuses what the hub would refuse.
export function withEntryText(text: string, name: string, entry: string, owner: string): string {
  const at = spot(text, name);
  const before = entryText(text, name);
  if (!at || before === null) throw new TapsterError(`the entry of ${name} is not on lines of its own in tapster.yml`, "Edit tapster.yml on GitHub instead.");
  const next = tidy(entry);
  const pkg = oneEntry(next);
  const old = (parse(text) as { packages: Plain[] }).packages[at.index]!;
  if (pkg.name !== name) throw new TapsterError(`the entry must keep the name ${name}`, "tapster changes one package at a time. To rename it, edit tapster.yml on GitHub.");
  if (pkg.repo !== old.repo) throw new TapsterError(`the entry must keep the repository ${String(old.repo)}`, "To publish another repository, add it as a project of its own.");
  const pad = " ".repeat(at.indent);
  const out = `${text.slice(0, at.start)}${next.split("\n").map((l) => (l === "" ? "" : `${pad}${l}`)).join("\n")}${text.slice(at.end)}`;
  let a: Plain;
  let b: Plain;
  try {
    a = parse(text) as Plain;
    b = parse(out) as Plain;
  } catch {
    throw new TapsterError(`the change reaches beyond the entry of ${name}`, "Keep the indent of the entry as it is.");
  }
  const listA = a.packages as unknown[];
  const listB = b.packages as unknown[];
  const rest = (o: Plain) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "packages"));
  const others = Array.isArray(listB) && listB.length === listA.length && listA.every((p, i) => (i === at.index ? same(listB[i], pkg) : same(p, listB[i])));
  if (!others || !same(rest(a), rest(b))) throw new TapsterError(`the change reaches beyond the entry of ${name}`, "Change only this entry; edit the rest of tapster.yml on GitHub.");
  const was = new Set(parseHub(text, owner).invalid.map((i) => i.name));
  for (const bad of parseHub(out, owner).invalid) {
    if (bad.name === name) throw new TapsterError(`the hub would refuse this entry: ${bad.reason}`, bad.fix);
    if (!was.has(bad.name)) throw new TapsterError(`the hub would then refuse ${bad.name}: ${bad.reason}`, bad.fix);
  }
  return out;
}

// The entry a pull request leaves in place of main's, when that is the only change it makes.
export function changedEntry(before: string, after: string, name: string, owner: string): string | null {
  const entry = entryText(after, name);
  if (entry === null) return null;
  try {
    return withEntryText(before, name, entry, owner) === after ? entry : null;
  } catch {
    return null;
  }
}

// Only what the current entry lacks: a key it has is never rewritten. A map it has only gains keys.
export function missing(current: unknown, proposed: unknown): unknown {
  if (current === undefined) return proposed;
  if (!isPlain(proposed) || !isPlain(current)) return undefined;
  const out: Plain = {};
  for (const [k, v] of Object.entries(proposed)) {
    const m = missing(current[k], v);
    if (m !== undefined) out[k] = m;
  }
  return Object.keys(out).length ? out : undefined;
}

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const scalar = (s: string) => (/^[A-Za-z][A-Za-z0-9._\/@+-]*$/.test(s) && !RESERVED.test(s) ? s : JSON.stringify(s));
const key = (k: string) => (/^[A-Za-z][A-Za-z0-9._\/-]*$/.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k));

function flow(v: unknown): string {
  if (typeof v === "string") return scalar(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? JSON.stringify(x) : flow(x))).join(", ")}]`;
  if (isPlain(v)) return `{ ${Object.entries(v).map(([k, x]) => `${key(k)}: ${flow(x)}`).join(", ")} }`;
  return String(v);
}

function block(k: string, v: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (!isPlain(v)) return `${pad}${key(k)}: ${flow(v)}`;
  return [`${pad}${key(k)}:`, ...Object.entries(v).map(([kk, vv]) => block(kk, vv, indent + 2))].join("\n");
}

export const asYaml = (add: Plain) => Object.entries(add).map(([k, v]) => block(k, v, 0)).join("\n");

export function merged(a: unknown, b: unknown): unknown {
  if (!isPlain(a) || !isPlain(b)) return a === undefined ? b : a;
  const out: Plain = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merged(a[k], v);
  return out;
}

// Writes the additions into the entry's text after the keys that are there, so every line the owner wrote stays.
export function withAdditions(entry: string, add: Plain): string | null {
  const doc = parseDocument(entry);
  const item = isSeq(doc.contents) ? doc.contents.items[0] : null;
  if (doc.errors.length || !isMap(item)) return null;
  const edits: { at: number; text: string; order: number }[] = [];
  const into = (map: YAMLMap, add: Plain) => {
    const fresh = Object.entries(add).filter(([k]) => !map.has(k));
    if (fresh.length && map.range) {
      if (map.flow) {
        let at = entry.lastIndexOf("}", map.range[1]);
        while (at > 0 && /\s/.test(entry[at - 1]!)) at--;
        edits.push({ at, text: `${map.items.length ? ", " : ""}${fresh.map(([k, v]) => `${key(k)}: ${flow(v)}`).join(", ")}`, order: edits.length });
      } else {
        const first = map.items[0]?.key as { range?: [number, number, number] } | undefined;
        if (!first?.range) return;
        const indent = first.range[0] - (entry.lastIndexOf("\n", first.range[0] - 1) + 1);
        let at = map.range[1];
        while (at > map.range[0] && /\s/.test(entry[at - 1]!)) at--;
        edits.push({ at, text: fresh.map(([k, v]) => `\n${block(k, v, indent)}`).join(""), order: edits.length });
      }
    }
    for (const [k, v] of Object.entries(add)) {
      const there = map.get(k, true);
      if (isMap(there) && isPlain(v)) into(there, v);
    }
  };
  into(item, add);
  let out = entry;
  for (const e of edits.sort((x, y) => y.at - x.at || x.order - y.order)) out = `${out.slice(0, e.at)}${e.text}${out.slice(e.at)}`;
  try {
    const want = merged((parse(entry) as unknown[])[0], add);
    return same((parse(out) as unknown[])[0], want) ? out : null;
  } catch {
    return null;
  }
}
