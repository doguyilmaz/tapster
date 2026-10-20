import type { HubView } from "./contract";

export type StopId = "protect" | "app" | "macos" | "certificate" | "notary" | "files" | "project";
export type StopState = "done" | "now" | "later" | "skipped" | "attention";
export type Stop = { id: StopId; name: string; state: StopState; status: string };

const DAY = 86_400_000;

export function expiresSoon(expires: string, now = Date.now()): boolean {
  const end = Date.parse(`${expires}T00:00:00Z`);
  return !Number.isNaN(end) && end - now < 30 * DAY;
}

export function macNeeded(h: HubView, choice: "yes" | "no" | null): boolean | null {
  if (h.apple.needed) return true;
  return choice === null ? null : choice === "yes";
}

export function stops(h: HubView, choice: "yes" | "no" | null, now = Date.now()): Stop[] {
  const mac = macNeeded(h, choice);
  const passed = h.protect.checks.filter((c) => c.ok).length;
  const raw: { id: StopId; name: string; done: boolean; skipped?: boolean; attention?: boolean; status: string; open: string }[] = [
    {
      id: "protect",
      name: "Protect the hub",
      done: h.protect.done,
      status: h.protect.done ? "All protections are on" : passed ? `${passed} of ${h.protect.checks.length} protections on` : "Not protected yet",
      open: "Not protected yet",
    },
    {
      id: "app",
      name: "Create the GitHub App",
      done: Boolean(h.app.id && h.app.slug && h.app.key),
      attention: Boolean(h.app.id && !h.app.key),
      status: h.app.id && !h.app.key ? "The App's private key is missing" : h.app.slug ? h.app.slug : "Not created yet",
      open: "Not created yet",
    },
    {
      id: "macos",
      name: "macOS or not",
      done: mac === true,
      skipped: mac === false,
      status: mac === true ? "Signs macOS software" : mac === false ? "No macOS builds" : "Your answer",
      open: "Your answer",
    },
    {
      id: "certificate",
      name: "Apple certificate",
      done: Boolean(h.apple.certificate && h.apple.certificateStored),
      skipped: mac === false,
      attention: Boolean(h.apple.certificate && expiresSoon(h.apple.certificate.expires, now)),
      status: mac === false ? "Not needed" : h.apple.certificate ? `Team ${h.apple.certificate.team}, expires ${h.apple.certificate.expires}` : "Not stored yet",
      open: "Not stored yet",
    },
    {
      id: "notary",
      name: "Notarization key",
      done: h.apple.notary,
      skipped: mac === false,
      status: mac === false ? "Not needed" : h.apple.notary ? "Stored" : "Not stored yet",
      open: "Not stored yet",
    },
    {
      id: "files",
      name: "Hub files",
      done: h.files.config && h.files.state && h.files.workflow !== "missing",
      attention: h.files.workflow === "older" || h.files.workflow === "other",
      status:
        h.files.workflow === "missing"
          ? "Not written yet"
          : h.files.workflow === "older"
            ? `Runs ${h.files.pinned}; update available`
            : h.files.workflow === "other"
              ? `Runs ${h.files.pinned ?? "a workflow tapster did not write"}; review it`
              : h.files.workflow === "newer"
                ? `Runs ${h.files.pinned}, newer than this tapster`
                : `Runs ${h.files.pinned}`,
      open: "Not written yet",
    },
    {
      id: "project",
      name: "Your projects",
      done: h.packages.length > 0,
      status: h.packages.length ? `${h.packages.length} in the hub` : "None yet",
      open: "None yet",
    },
  ];
  let current = false;
  return raw.map((r) => {
    let state: StopState;
    if (r.skipped) state = "skipped";
    else if (r.attention) state = "attention";
    else if (r.done) state = "done";
    else if (!current) {
      state = "now";
      current = true;
    } else state = "later";
    return { id: r.id, name: r.name, state, status: r.status };
  });
}

export const firstOpen = (list: Stop[]): StopId => (list.find((s) => s.state === "now" || s.state === "attention") ?? list[list.length - 1]!).id;

export function lineDiff(before: string, after: string): { kind: "ctx" | "add" | "del"; text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { kind: "ctx" | "add" | "del"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export function changedOnly(lines: { kind: "ctx" | "add" | "del"; text: string }[], context = 3): ({ kind: "ctx" | "add" | "del"; text: string } | { kind: "gap"; text: string })[] {
  const keep = lines.map((l, i) => l.kind !== "ctx" || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.kind !== "ctx"));
  const out: ({ kind: "ctx" | "add" | "del"; text: string } | { kind: "gap"; text: string })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: "gap", text: `${skipped} unchanged lines` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "gap", text: `${skipped} unchanged lines` });
  return out;
}

export type NoteItem = { text: string; block: string | null };

const dedent = (lines: string[]) => {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n").trimEnd();
};

export function notes(lines: string[]): NoteItem[] {
  const out: NoteItem[] = [];
  for (const said of lines) {
    const [first = "", ...more] = said.split("\n");
    const head = first.trim().replace(/^- /, "");
    if (!head || /^proposed the hub entry in |^open this page and choose Install/.test(head)) continue;
    const last = out.at(-1);
    let item: NoteItem;
    if (first.startsWith("  ") && last && last.block === null) {
      item = last;
      item.text += `${/[.:;!?]$/.test(item.text) ? "" : "."} ${head}`;
    } else {
      item = { text: /^[a-z]+[._]/.test(head) ? head : head.charAt(0).toUpperCase() + head.slice(1), block: null };
      out.push(item);
    }
    let i = 0;
    while (i < more.length && !item.text.endsWith(":")) item.text += ` ${more[i++]!.trim()}`;
    if (i < more.length) item.block = dedent(more.slice(i));
  }
  return out;
}
