import { parse } from "yaml";
import { type Helper, bundleIdOf, plistDict } from "./appsource";
import { type TarEntry, isMachO, readTarGz } from "./archive";
import { sha256 } from "./checksums";
import { goreleaserCask } from "./cli/hubpr";
import { BUNDLE_ID, TAG, compareSemver, parseTag } from "./config";
import { noteIn } from "./draftnote";
import { GitHubError, TapsterError } from "./errors";
import type { GitHub, Release } from "./github";
import { asYaml, merged, missing, withAdditions } from "./hubentry";
import { defaultIdentifier } from "./identity";

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

export type ToolApp = { name: string; bundle_id: string; binaries?: string[] };
export type DraftApp = { asset: string; tag: string; app: ToolApp | null; manual: string[] };

export type EntrySources = {
  kind: "go" | "bun" | "app";
  apple: boolean;
  goreleaser(): Promise<string | null>;
  plists(): Promise<Buffer[]>;
  app(): Promise<{ feed: string | null; helpers: Helper[] } | null>;
  workflow: { name: string; text: string } | null;
  file(path: string): Promise<Buffer | null>;
  draft(assets: Record<string, string>): Promise<DraftApp | null>;
};

// entry: the current entry with what tapster derived added to it (null when nothing is missing).
export type EntryUpdate = { entry: string | null; from: string[]; manual: string[] };

const APP = /^[A-Za-z0-9 ._-]+\.app$/;
const FORBIDDEN = ["SUFeedURL", "SUPublicEDKey", "SUPublicDSAKey", "SUPublicDSAKeyFile", "NSUpdateSecurityPolicy"];
const CARRY = /^\s*cp "([A-Za-z0-9._\/-]+)" "dist\/([A-Za-z0-9._-]+)"\s*$/gm;

// Reads the one top-level app of a macOS archive the way the hub would: its Info.plist names it, nothing else.
export function appInArchive(entries: TarEntry[], asset: string): { app: ToolApp | null; manual: string[] } {
  const tops = [...new Set(entries.filter((e) => e.name.includes("/")).map((e) => e.name.split("/")[0]!))].filter((t) => t.toLowerCase().endsWith(".app"));
  if (tops.length === 0) return { app: null, manual: [] };
  const name = tops[0]!;
  if (tops.length > 1 || !APP.test(name)) return { app: null, manual: [`app: ${asset} holds ${tops.join(", ")}. The hub signs one app with a plain name; describe it under app by hand.`] };
  const info = entries.find((e) => e.type === "file" && e.name === `${name}/Contents/Info.plist`);
  const dict = info ? plistDict(info.data) : null;
  const id = typeof dict?.CFBundleIdentifier === "string" ? dict.CFBundleIdentifier : null;
  if (!dict || !id || !BUNDLE_ID.test(id)) return { app: null, manual: [`app: ${asset} holds ${name}, but its Info.plist names no bundle id the hub accepts. Write app with the name ${name} and its CFBundleIdentifier by hand.`] };
  const exe = typeof dict.CFBundleExecutable === "string" && /^[A-Za-z0-9._-]+$/.test(dict.CFBundleExecutable) ? dict.CFBundleExecutable : null;
  const main = exe ? entries.find((e) => e.type === "file" && e.name === `${name}/Contents/MacOS/${exe}`) : undefined;
  const manual = FORBIDDEN.filter((k) => k in dict).map((k) => `${name} sets ${k} in its Info.plist, which the hub refuses for a tool's app. Remove it from the app.`);
  return { app: { name, bundle_id: id, ...(main && isMachO(main.data) ? { binaries: [`Contents/MacOS/${exe}`] } : {}) }, manual };
}

const MAX_ARCHIVE = 128 << 20;

// The app in the macOS archive of the newest draft the hub refused, read with the hub's own tar reader.
export async function refusedDraftApp(gh: GitHub, repo: string, assets: Record<string, string>, releases: Release[], memo?: Map<string, unknown>): Promise<DraftApp | null> {
  const draft = releases
    .filter((r) => r.draft && TAG.test(r.tag_name) && noteIn(r.body) !== null)
    .sort((a, b) => compareSemver(parseTag(b.tag_name)!, parseTag(a.tag_name)!))[0];
  if (!draft) return null;
  const version = draft.tag_name.slice(1);
  const names = Object.entries(assets).flatMap(([p, a]) => (p.startsWith("darwin") ? [a.replaceAll("{version}", version)] : []));
  const asset = draft.assets.find((a) => names.includes(a.name));
  if (!asset) return null;
  const base = { asset: asset.name, tag: draft.tag_name };
  if (asset.size > MAX_ARCHIVE) return { ...base, app: null, manual: [`app: ${asset.name} is larger than tapster reads here. If it holds an app, describe it under app by hand.`] };
  const key = asset.digest ? `draft:${repo}:${asset.digest}` : null;
  const known = key ? (memo?.get(key) as DraftApp | undefined) : undefined;
  if (known) return known;
  let found: DraftApp;
  try {
    const data = await gh.downloadAsset(repo, asset.id);
    if (data.length > MAX_ARCHIVE || (asset.digest && asset.digest !== `sha256:${sha256(data)}`)) return null;
    found = { ...base, ...appInArchive(readTarGz(data, { entryBytes: MAX_ARCHIVE, totalBytes: 2 * MAX_ARCHIVE }), asset.name) };
  } catch (e) {
    if (e instanceof TapsterError || e instanceof GitHubError) return null;
    throw e;
  }
  if (key) memo?.set(key, found);
  return found;
}

export async function deriveUpdate(entry: string, s: EntrySources): Promise<EntryUpdate> {
  const current = ((parse(entry) as unknown[] | null)?.[0] ?? {}) as Plain;
  let proposed: Plain = {};
  const from: string[] = [];
  const manual: string[] = [];
  const have = () => merged(current, proposed) as Plain;
  const take = (fields: Plain, source: string): Plain | null => {
    const m = missing(have(), fields);
    if (!isPlain(m)) return null;
    proposed = merged(proposed, m) as Plain;
    from.push(source);
    return m;
  };
  const assets = isPlain(current.assets) ? (current.assets as Record<string, string>) : {};
  const tool = s.kind !== "app";
  const wantsApp = tool && s.apple && current.app === undefined;
  if (wantsApp && Object.keys(assets).some((p) => p.startsWith("darwin"))) {
    const d = await s.draft(assets);
    if (d?.app) take({ app: d.app }, `${d.app.name} in ${d.asset}, the macOS archive of the draft ${d.tag}`);
    if (d) manual.push(...d.manual);
  }
  const goreleaser = s.kind === "go" ? await s.goreleaser() : null;
  if (goreleaser) {
    const named = new Set<string>();
    goreleaserCask(goreleaser, {
      mac: s.apple,
      bundleId: (app) => {
        named.add(app);
        return null;
      },
    });
    const plists = named.size && wantsApp && !have().app ? await s.plists() : [];
    const cask = goreleaserCask(goreleaser, { mac: s.apple, bundleId: (app) => bundleIdOf(plists, app) });
    const fields = (cask.lines.length ? parse(cask.lines.map((l) => l.slice(4)).join("\n")) : {}) as Plain;
    const app = fields.app as Plain | undefined;
    if (app && !BUNDLE_ID.test(String(app.bundle_id))) {
      delete fields.app;
      if (wantsApp && !have().app) manual.push(`app: GoReleaser's Homebrew section installs ${String(app.name)}, but no Info.plist in the project names its bundle id. Write app with that name and its CFBundleIdentifier by hand.`);
    }
    take(Object.fromEntries(Object.entries(fields).filter(([k]) => ["homepage", "license", "completions", "app", "cask"].includes(k))), "GoReleaser's Homebrew section");
  }
  if (s.kind === "app") {
    const app = await s.app();
    if (app?.feed && current.sparkle === undefined) manual.push(`sparkle: the app reads its updates from ${app.feed}, but the entry has no sparkle section. Write key (the label of the Sparkle key stored in the hub) and public_key (the app's SUPublicEDKey) by hand.`);
    else if (app?.feed && app.feed !== "appcast.xml") take({ sparkle: { feed: app.feed } }, "the app's SUFeedURL");
    const id = typeof current.bundle_id === "string" ? current.bundle_id : "";
    const code: Plain = {};
    for (const h of app?.helpers ?? []) {
      if (!h.identifier || h.identifier === defaultIdentifier(id, h.path)) continue;
      if (h.identifier.startsWith(`${id}.`)) code[h.path] = { identifier: h.identifier };
      else manual.push(`code: the project names ${h.path} ${h.identifier}, outside ${id}. The hub signs nested code only inside the app's bundle id.`);
    }
    const added = Object.keys(code).length ? take({ code }, "the helpers project.yml copies into the app") : null;
    for (const path of Object.keys((added?.code as Plain | undefined) ?? {})) {
      const h = app!.helpers.find((x) => x.path === path)!;
      manual.push(`code.${path}.entitlements: tapster does not read entitlements. If the helper needs any, write them by hand${h.entitlements ? `; the project keeps them in ${h.entitlements}` : ""}.`);
    }
    const feed = String((have().sparkle as Plain | undefined)?.feed ?? "appcast.xml");
    for (const [, src, dest] of s.workflow?.text.matchAll(CARRY) ?? []) {
      if (isPlain(current.carry) && Object.hasOwn(current.carry, dest!)) continue;
      if (dest === feed || dest === "checksums.txt" || src!.split("/").includes("..")) {
        manual.push(`carry: ${s.workflow!.name} attaches ${src} as ${dest}, a name the hub writes itself. Rename it in the workflow.`);
        continue;
      }
      const data = await s.file(src!);
      if (data) take({ carry: { [dest!]: `sha256:${sha256(data)}` } }, `${src}, which ${s.workflow!.name} attaches as ${dest}`);
      else manual.push(`carry: ${s.workflow!.name} attaches ${src} as ${dest}, which tapster cannot read. Pin its sha256 under carry by hand.`);
    }
  }
  const add = missing(current, proposed);
  if (!isPlain(add)) return { entry: null, from: [], manual };
  const next = withAdditions(entry, add);
  if (next === null) return { entry: null, from: [], manual: [...manual, `tapster cannot add these lines to the entry's text, so add them by hand:\n${asYaml(add)}`] };
  return { entry: next, from, manual };
}
