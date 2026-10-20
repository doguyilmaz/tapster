import { isMap, isSeq, parse, parseDocument } from "yaml";
import { NAME, PLATFORMS, type Platform, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { readHubFile } from "../hubcommit";
import { TAG, compareSemver, parseTag } from "../semver";
import { highestTag } from "../web/status";
import { hubEnv } from "./gh";
import { descProblems } from "../render";

export function hubName(text: string): string {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(text)) throw new TapsterError(`${text} is not a repository name`, "Name the hub as owner/repo, for example you/homebrew-tap.");
  return text;
}

export function binName(pkg: { name?: string; bin?: string | Record<string, string> }, repoName: string): { bin: string; entry: string } | null {
  const strip = (p: string) => p.replace(/^\.\//, "");
  if (typeof pkg.bin === "string") return { bin: (pkg.name ?? repoName).replace(/^@[^/]+\//, ""), entry: strip(pkg.bin) };
  const first = Object.entries(pkg.bin ?? {})[0];
  return first ? { bin: first[0], entry: strip(first[1]) } : null;
}

const BUN_TARGETS: [Platform, string][] = [
  ["darwin-arm64", "darwin_arm64.tar.gz"],
  ["darwin-amd64", "darwin_amd64.tar.gz"],
  ["linux-arm64", "linux_arm64.tar.gz"],
  ["linux-amd64", "linux_amd64.tar.gz"],
  ["windows-amd64", "windows_amd64.zip"],
];

function entryText(name: string, repo: string, kind: "go" | "bun", binaries: string[], assets: [string, string][], scoop: boolean): string {
  return [
    `  - name: ${name}`,
    `    repo: ${repo}`,
    `    kind: ${kind}`,
    `    binaries: [${binaries.join(", ")}]`,
    "    assets:",
    ...assets.map(([p, a]) => `      ${p}: "${a}"`),
    `    scoop: ${scoop}`,
  ].join("\n");
}

export const bunEntry = (name: string, repo: string, bin: string) =>
  entryText(name, repo, "bun", [bin], BUN_TARGETS.map(([p, suffix]) => [p, `${bin}_{version}_${suffix}`]), true);

const PLATFORM_OF: Record<string, Platform> = {
  darwin_all: "darwin-universal",
  darwin_universal: "darwin-universal",
  darwin_arm64: "darwin-arm64",
  darwin_amd64: "darwin-amd64",
  linux_arm64: "linux-arm64",
  linux_amd64: "linux-amd64",
  windows_amd64: "windows-amd64",
  windows_arm64: "windows-arm64",
};

type GoConfig = {
  project_name?: string;
  builds?: { binary?: string; goos?: string[]; goarch?: string[] }[];
  archives?: { name_template?: string; format_overrides?: { goos?: string; format?: string; formats?: string[] }[] }[];
  universal_binaries?: { replace?: boolean }[];
};

export function releaseEntry(name: string, repo: string, kind: "go" | "bun", bins: string[], release: { assets: string[]; version: string } | null): { entry: string | null; reason: string | null } {
  if (!release) return { entry: null, reason: "the project has its own release workflow and no release yet; run tapster add again after the first draft" };
  const assets: [string, string][] = [];
  for (const a of release.assets) {
    const key = Object.keys(PLATFORM_OF).find((k) => a.includes(k));
    if (key && !assets.some(([p]) => p === PLATFORM_OF[key])) assets.push([PLATFORM_OF[key]!, a.replaceAll(release.version, "{version}")]);
  }
  if (assets.length === 0) return { entry: null, reason: "the latest release has no archives tapster recognizes" };
  return { entry: entryText(name, repo, kind, bins, assets, assets.some(([p, a]) => p.startsWith("windows") && a.endsWith(".zip"))), reason: null };
}

export function goEntry(name: string, repo: string, goreleaser: string | null, release: { assets: string[]; version: string } | null): { entry: string | null; reason: string | null } {
  const cfg = ((goreleaser ? parse(goreleaser) : null) ?? {}) as GoConfig;
  const project = cfg.project_name ?? name;
  const binaries = [...new Set((cfg.builds ?? []).map((b) => b.binary ?? project))];
  const bins = binaries.length ? binaries : [project];
  if (release) return releaseEntry(name, repo, "go", bins, release);
  if ((cfg.archives ?? []).some((a) => a.name_template !== undefined)) {
    return { entry: null, reason: "GoReleaser names the archives with its own template; run tapster add again after the first draft" };
  }
  const zip = (cfg.archives ?? []).some((a) => (a.format_overrides ?? []).some((o) => o.goos === "windows" && (o.format === "zip" || o.formats?.includes("zip"))));
  const goos = cfg.builds?.[0]?.goos ?? ["linux", "darwin", "windows"];
  const goarch = cfg.builds?.[0]?.goarch ?? ["amd64", "arm64"];
  const assets: [string, string][] = [];
  const universal = cfg.universal_binaries?.[0];
  for (const os of goos) {
    for (const arch of goarch) {
      const platform = PLATFORM_OF[`${os}_${arch}`];
      if (!platform || (os === "darwin" && universal?.replace)) continue;
      assets.push([platform, `${project}_{version}_${os}_${arch}.${os === "windows" && zip ? "zip" : "tar.gz"}`]);
    }
  }
  if (universal && goos.includes("darwin")) assets.unshift(["darwin-universal", `${project}_{version}_darwin_all.tar.gz`]);
  return { entry: entryText(name, repo, "go", bins, assets, zip && goos.includes("windows")), reason: null };
}

export const YAML_OUT = { lineWidth: 0, blockQuote: "literal" } as const;

const unpadded = (line: string) => line.replace(/([[{])\s+/g, "$1").replace(/\s+([\]}])/g, "$1");

export function keepStyle(before: string, after: string): string {
  const pool = new Map<string, string[]>();
  for (const line of before.split("\n")) pool.set(unpadded(line), [...(pool.get(unpadded(line)) ?? []), line]);
  return after
    .split("\n")
    .map((line) => pool.get(unpadded(line))?.shift() ?? line)
    .join("\n");
}

export function withEntry(hubYaml: string, entry: string, name: string): string {
  const doc = parseDocument(hubYaml);
  const raw = (doc.toJS() as { packages?: { name?: string }[] }).packages ?? [];
  if (raw.some((p) => p?.name === name)) throw new TapsterError(`${name} is already in the hub's tapster.yml`, "Edit its entry there instead.");
  const packages = doc.get("packages", true);
  if (!isSeq(packages)) throw new TapsterError("the hub's tapster.yml has no packages list", "Add packages: [] to it.");
  const [start, end] = packages.range ?? [0, 0];
  if (packages.flow && packages.items.length === 0) return `${hubYaml.slice(0, start).replace(/[ \t]+$/, "")}\n${entry}${hubYaml.slice(end)}`;
  if (!packages.flow) {
    const head = hubYaml.slice(0, end);
    return `${head}${head.endsWith("\n") ? "" : "\n"}${entry}\n${hubYaml.slice(end)}`;
  }
  const item = parseDocument(entry).contents;
  if (!isSeq(item) || item.items.length !== 1) throw new TapsterError("the entry is not one package", "Report this as a tapster bug.");
  packages.flow = false;
  packages.items.push(item.items[0] as never);
  return keepStyle(hubYaml, doc.toString(YAML_OUT));
}

export function addedEntry(before: string, after: string, name: string): string | null {
  const packages = parseDocument(after).get("packages", true);
  const item = isSeq(packages) ? packages.items.find((i) => isMap(i) && i.get("name") === name) : undefined;
  if (!isMap(item) || !item.range) return null;
  const entry = after.slice(after.lastIndexOf("\n", item.range[0]) + 1, item.range[1]).trimEnd();
  try {
    return withEntry(before, entry, name) === after ? entry : null;
  } catch {
    return null;
  }
}

export function suggestDescription(desc: string | null, name: string): string | null {
  if (!desc || descProblems(desc, name).length === 0) return null;
  let s = desc.trim().replace(/^(?:the|an?)\s+/i, "").replace(/command ?line/gi, "command-line").replace(/\.$/, "");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return descProblems(s, name).length === 0 ? s : null;
}

type GoCask = {
  description?: unknown;
  homepage?: unknown;
  license?: unknown;
  completions?: Record<string, unknown>;
  custom_block?: unknown;
  binaries?: unknown;
  uninstall?: Record<string, unknown>;
  zap?: Record<string, unknown>;
  hooks?: Record<string, Record<string, unknown> | null>;
  caveats?: unknown;
};

const READ = ["name", "ids", "repository", "commit_msg_template", "commit_author", "directory", "skip_upload", "url", "url_template", "description", "homepage", "license", "completions", "custom_block", "binaries", "uninstall", "zap", "hooks", "caveats"];
const HOOK = /^system_command\s+"#\{HOMEBREW_PREFIX\}\/bin\/([A-Za-z0-9._-]+)"(?:,\s*args:\s*\[((?:\s*"[A-Za-z0-9._:=@%+,\/-]+"\s*,?)*)\])?,\s*must_succeed:\s*false$/;
const REL = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export type CaskOptions = { mac?: boolean; bundleId?: (app: string) => string | null };

const APP_LINE = /^app\s+"([A-Za-z0-9 ._-]+\.app)"$/;
const OPENS = /^(if|unless|case|begin|while|until|def|class|module)\b|\bdo(\s*\|[^|]*\|)?$/;
type CustomLine = { line: string; os?: "macos" | "linux"; path?: string };

// The first app line anywhere is the app, as before. With a top-level on_macos or on_linux block (and Apple
// credentials), only lines at the top or right inside those blocks are read; everything deeper is named.
function readCustomBlock(lines: string[], blocks: boolean): { app: string | null; lines: CustomLine[] } {
  const flat = () => {
    let app: string | null = null;
    const rest: CustomLine[] = [];
    for (const line of lines) {
      const found = APP_LINE.exec(line)?.[1];
      if (found && !app) app = found;
      else rest.push({ line });
    }
    return { app, lines: rest };
  };
  if (!blocks) return flat();
  let app: string | null = null;
  const rest: CustomLine[] = [];
  let depth = 0;
  let os: "macos" | "linux" | null = null;
  let seen = false;
  for (const line of lines) {
    const opened = depth === 0 ? /^on_(macos|linux)\s+do$/.exec(line)?.[1] : undefined;
    if (opened === "macos" || opened === "linux") {
      os = opened;
      depth = 1;
      seen = true;
      continue;
    }
    if (line === "end" && depth > 0) {
      depth--;
      if (depth === 0 && os) os = null;
      else rest.push({ line });
      continue;
    }
    if (OPENS.test(line)) {
      depth++;
      rest.push({ line });
      continue;
    }
    const path = /^binary\s+"([^"]+)"$/.exec(line)?.[1];
    const found = os !== "linux" ? APP_LINE.exec(line)?.[1] : undefined;
    if (depth > 1 || (depth === 1 && !os)) rest.push({ line });
    else if (found && !app) app = found;
    else if (path && os) rest.push({ line, os, path });
    else rest.push({ line });
  }
  return seen ? { app, lines: rest } : flat();
}

export function goreleaserCask(text: string | null, opts: CaskOptions = {}): { lines: string[]; description: string | null; carried: string[]; notes: string[] } {
  type Doc = { homebrew_casks?: GoCask[]; brews?: GoCask[] } | null;
  let cfg: Doc = null;
  try {
    cfg = text ? (parse(text) as Doc) : null;
  } catch {
    cfg = null;
  }
  const c = cfg?.homebrew_casks?.[0] ?? cfg?.brews?.[0];
  if (!c) return { lines: [], description: null, carried: [], notes: [] };
  const str = (v: unknown) => (typeof v === "string" && v.trim() && !v.includes("{{") ? v.trim() : null);
  const list = (v: unknown, ok: RegExp) => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null && ok.test(x)) : []);
  const lines: string[] = [];
  const carried: string[] = [];
  const notes: string[] = [];
  const skipped = Object.keys(c).filter((k) => !READ.includes(k));
  skipped.push(...Object.keys(c.uninstall ?? {}).filter((k) => k !== "launchctl" && k !== "quit").map((k) => `uninstall.${k}`));
  skipped.push(...Object.keys(c.zap ?? {}).filter((k) => k !== "trash").map((k) => `zap.${k}`));
  const custom = readCustomBlock(String(c.custom_block ?? "").split("\n").map((l) => l.trim()).filter(Boolean), opts.mac !== false);
  const { app } = custom;
  const inside = `#{appdir}/${app}/`;
  const inApp = (b: string) => app !== null && b.startsWith(inside) && REL.test(b.slice(inside.length));
  const fromMac = custom.lines.flatMap((l) => (l.os === "macos" ? [l.path!] : []));
  const listed = list(c.binaries, /^#\{appdir\}\//);
  const appBinaries = [...listed, ...fromMac.filter((b, i) => !listed.includes(b) && fromMac.indexOf(b) === i)].filter(inApp).map((b) => b.slice(inside.length));
  const bare = new Set(appBinaries.map((b) => b.split("/").pop()));
  for (const l of custom.lines) if (l.os === undefined || (l.os === "macos" ? !inApp(l.path!) : !bare.has(l.path!))) skipped.push(`custom_block: ${l.line}`);
  let postflight: { binary: string; args: string[] } | null = null;
  for (const [when, hooks] of Object.entries(c.hooks ?? {})) {
    for (const [what, body] of Object.entries(hooks ?? {})) {
      const m = when === "post" && what === "install" ? HOOK.exec(String(body).trim()) : null;
      if (m) postflight = { binary: m[1]!, args: [...(m[2] ?? "").matchAll(/"([^"]+)"/g)].map((a) => a[1]!) };
      else skipped.push(`hooks.${when}.${what}`);
    }
  }
  const homepage = str(c.homepage);
  if (homepage && /^https:\/\/[^\s"]+$/.test(homepage)) {
    lines.push(`    homepage: ${JSON.stringify(homepage)}`);
    carried.push("homepage");
  }
  const license = str(c.license);
  if (license && /^[A-Za-z0-9.+-]+$/.test(license)) {
    lines.push(`    license: ${license}`);
    carried.push("license");
  }
  const completions = Object.entries(c.completions ?? {}).filter(([shell, path]) => ["bash", "zsh", "fish"].includes(shell) && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(str(path) ?? ""));
  if (completions.length) {
    lines.push("    completions:", ...completions.map(([shell, path]) => `      ${shell}: ${str(path)}`));
    carried.push("completions");
  }
  if (app && opts.mac !== false) {
    const id = opts.bundleId?.(app) ?? null;
    lines.push("    app:", `      name: ${JSON.stringify(app)}`, `      bundle_id: ${id ?? "<bundle id>"}`, ...(appBinaries.length ? [`      binaries: ${JSON.stringify(appBinaries)}`] : []));
    carried.push("app");
    notes.push(`the hub signs, notarizes and staples ${app}; a build hook must now sign it ad hoc only (codesign --force --sign -)`);
    if (!id) notes.push(`no Info.plist here names ${app}; set app.bundle_id in the hub entry`);
  }
  const launchctl = list(c.uninstall?.launchctl, /^[A-Za-z0-9.-]+$/);
  const quit = list(c.uninstall?.quit, /^[A-Za-z0-9.-]+$/);
  const trash = list(c.zap?.trash, /^~\/[A-Za-z0-9 ._\/-]+$/);
  const caveats = str(c.caveats);
  if (launchctl.length || quit.length || trash.length || postflight || caveats) {
    lines.push("    cask:");
    if (launchctl.length || quit.length) lines.push("      uninstall:", ...(launchctl.length ? [`        launchctl: ${JSON.stringify(launchctl)}`] : []), ...(quit.length ? [`        quit: ${JSON.stringify(quit)}`] : []));
    if (trash.length) lines.push("      zap:", `        trash: ${JSON.stringify(trash)}`);
    if (postflight) lines.push(`      postflight: { binary: ${JSON.stringify(postflight.binary)}, args: ${JSON.stringify(postflight.args)} }`);
    if (caveats) lines.push(`      caveats: ${JSON.stringify(caveats.slice(0, 2000))}`);
    carried.push(...[launchctl.length || quit.length ? "uninstall" : "", trash.length ? "zap" : "", postflight ? "post-install command" : "", caveats ? "caveats" : ""].filter(Boolean));
  }
  if (postflight) notes.push(`Homebrew runs the post-install command in its sandbox, without network or your home folder; check that ${[postflight.binary, ...postflight.args].join(" ")} works there`);
  if (skipped.length) notes.push(`not carried from GoReleaser's Homebrew section: ${skipped.join(", ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}`);
  return { lines, description: str(c.description), carried, notes };
}

export function entryExtras(entry: string, o: { kind: string; workflow: string; dependabot: boolean }): string {
  let out = entry;
  if (o.kind === "go" && o.workflow !== "release.yml") out += `\n    workflow: ${o.workflow}`;
  if (o.dependabot) out += "\n    protection: dependabot";
  return out;
}

export function descriptionNote(desc: string | null, name: string, existing = false): { line?: string; add?: string } {
  if (!desc) return { line: "- the repository has no description, which Homebrew needs; set one on GitHub or add description: to the hub entry before the first release" };
  const problems = descProblems(desc, name);
  if (!problems.length) return {};
  const better = suggestDescription(desc, name);
  if (!better) return { line: `- Homebrew would reject the repository's description (${problems.join(" and ")}); add description: to the hub entry before the first release` };
  if (existing) return { line: `- Homebrew would reject the repository's description (${problems.join(" and ")}); add description: ${JSON.stringify(better)} to the hub entry before the next release` };
  return { line: `- Homebrew would reject the repository's description (${problems.join(" and ")}); the entry says "${better}" instead`, add: `    description: ${JSON.stringify(better)}` };
}

export type TagRef = { name: string; sha: string; type: string };

export async function tagRefs(gh: GitHub, repo: string): Promise<TagRef[]> {
  const refs = await gh.json<{ ref: string; object: { sha: string; type?: string } }[]>("GET", `/repos/${repo}/git/matching-refs/tags/v`);
  return refs.map((r) => ({ name: r.ref.replace(/^refs\/tags\//, ""), sha: r.object.sha, type: r.object.type ?? "commit" }));
}

export async function repoTags(gh: GitHub, repo: string, strict = false): Promise<string[]> {
  const soft = <T>(p: Promise<T>, empty: T) => (strict ? p : p.catch(() => empty));
  const [refs, releases] = await Promise.all([soft(tagRefs(gh, repo), [] as TagRef[]), soft(gh.json<{ tag_name: string }[]>("GET", `/repos/${repo}/releases?per_page=100`), [])]);
  return [...refs.map((r) => r.name), ...releases.map((r) => r.tag_name)];
}

export const tagCommit = async (gh: GitHub, repo: string, ref: Pick<TagRef, "sha" | "type">): Promise<string | null> =>
  ref.type === "tag" ? gh.json<{ object: { sha: string } }>("GET", `/repos/${repo}/git/tags/${ref.sha}`).then((t) => t.object.sha, () => null) : ref.sha;

export async function tagAt(gh: GitHub, repo: string, refs: TagRef[], sha: string): Promise<string | null> {
  const versions = refs.filter((r) => TAG.test(r.name));
  const direct = highestTag(versions.filter((r) => r.type === "commit" && r.sha === sha).map((r) => r.name));
  if (direct) return direct;
  const annotated = versions.filter((r) => r.type === "tag").sort((a, b) => compareSemver(parseTag(b.name)!, parseTag(a.name)!)).slice(0, 5);
  for (const r of annotated) if ((await tagCommit(gh, repo, r)) === sha) return r.name;
  return null;
}

export const releaseSecrets = (names: string[]) => names.filter((n) => /^(HOMEBREW_TAP_|MACOS_)/.test(n));

export const installLink = (slug: string, ownerId: number, repoId: number) =>
  `https://github.com/apps/${slug}/installations/new/permissions?suggested_target_id=${ownerId}&repository_ids[]=${repoId}`;

export function autoTagSteps(checkout: { sha: string; tag: string }): string {
  return [
    "  # in the job that decides the version, on the default branch:",
    "    environment: release",
    "    steps:",
    `      - uses: actions/checkout@${checkout.sha} # ${checkout.tag}`,
    '        with: { ssh-key: "${{ secrets.TAPSTER_TAG_KEY }}" }',
    "      # ... compute VERSION ...",
    "      - name: Push the release tag",
    '        run: git tag "v$VERSION" && git push origin "v$VERSION"',
  ].join("\n");
}

type FileInfo = { content: string; sha: string };

async function hubFile(gh: GitHub, hub: string): Promise<{ text: string; sha: string }> {
  try {
    const f = await gh.json<FileInfo>("GET", `/repos/${hub}/contents/tapster.yml?ref=main`);
    return { text: Buffer.from(f.content, "base64").toString("utf8"), sha: f.sha };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) throw new TapsterError(`${hub} has no tapster.yml on main`, "Run tapster init in a clone of the hub and push it first.");
    throw e;
  }
}

export async function proposeEntry(gh: GitHub, hub: string, name: string, repo: string, entry: string): Promise<{ url: string; head: string }> {
  if (!NAME.test(name)) throw new TapsterError(`${name} is not a valid package name`, "Use lowercase letters, digits and dashes.");
  const { text, sha } = await hubFile(gh, hub);
  const next = withEntry(text, entry, name);
  const { invalid } = parseHub(next, hub.split("/")[0]!);
  const mine = invalid.find((i) => i.name === name);
  if (mine) throw new TapsterError(`the hub would refuse this entry: ${mine.reason}`, mine.fix);
  const branch = `tapster-add-${name}`;
  const head = (await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`)).object.sha;
  try {
    await gh.json("POST", `/repos/${hub}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) throw new TapsterError(`the hub already has a branch ${branch}`, `Merge or delete it on ${hub}, then run tapster add again.`);
    throw e;
  }
  const put = await gh.json<{ commit: { sha: string } }>("PUT", `/repos/${hub}/contents/tapster.yml`, { message: `Add ${name}`, content: Buffer.from(next).toString("base64"), sha, branch });
  const body = [`tapster add prepared this entry for ${repo}:`, "", "```yaml", entry, "```", "", `Merge it to let the hub publish ${repo}.`].join("\n");
  const pr = await gh.json<{ html_url: string }>("POST", `/repos/${hub}/pulls`, { title: `Add ${name}`, head: branch, base: "main", body });
  return { url: pr.html_url, head: put.commit.sha };
}

export type HubEntry = { name: string; repo: string; kind: "go" | "bun" | "app"; workflow: string; protection: string; description: string | null; state: "merged" | "proposed"; pr: string | null };

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function entriesIn(text: string | null, owner: string): Omit<HubEntry, "state" | "pr">[] {
  let doc: unknown = null;
  try {
    doc = text ? parse(text) : null;
  } catch {
    doc = null;
  }
  const list = (doc as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    if (typeof o.name !== "string" || !NAME.test(o.name) || typeof o.repo !== "string" || !REPO.test(o.repo)) return [];
    if (o.repo.split("/")[0]!.toLowerCase() !== owner.toLowerCase()) return [];
    return [
      {
        name: o.name,
        repo: o.repo,
        kind: o.kind === "bun" || o.kind === "app" ? o.kind : "go",
        workflow: typeof o.workflow === "string" && /^[A-Za-z0-9._-]+\.ya?ml$/.test(o.workflow) ? o.workflow : "release.yml",
        protection: o.protection === "off" || o.protection === "dependabot" ? o.protection : "on",
        description: typeof o.description === "string" ? o.description : null,
      },
    ];
  });
}

export async function hubEntries(gh: GitHub, hub: string): Promise<HubEntry[]> {
  const owner = hub.split("/")[0]!;
  const out: HubEntry[] = entriesIn(await readHubFile(gh, hub, "tapster.yml", "main"), owner).map((e) => ({ ...e, state: "merged", pr: null }));
  const pulls = await gh.json<{ html_url: string; head: { ref: string } }[]>("GET", `/repos/${hub}/pulls?state=open&per_page=100`).catch(() => []);
  for (const p of pulls) {
    const name = /^tapster-add-([a-z0-9][a-z0-9-]*)$/.exec(p.head?.ref ?? "")?.[1];
    if (!name || out.some((e) => e.name === name)) continue;
    const found = entriesIn(await readHubFile(gh, hub, "tapster.yml", p.head.ref).catch(() => null), owner).find((e) => e.name === name);
    if (found && !out.some((e) => e.repo.toLowerCase() === found.repo.toLowerCase())) out.push({ ...found, state: "proposed", pr: p.html_url });
  }
  return out;
}

export async function hubFacts(gh: GitHub, hub: string): Promise<{ slug: string; apple: boolean }> {
  const vars = await hubEnv(gh, hub, "variables");
  const slug = vars.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  if (!slug) throw new TapsterError(`${hub} has no App yet`, "Run tapster init in a clone of the hub first.");
  return { slug, apple: vars.some((v) => v.name === "TAPSTER_TEAM_ID") };
}

export function withoutMac(entry: string): string | null {
  const lines = entry.split("\n").filter((l) => !/^ {6}darwin-[a-z0-9]+: /.test(l));
  const at = lines.findIndex((l) => /^ {4}assets:\s*$/.test(l));
  if (at >= 0 && !/^ {6}\S/.test(lines[at + 1] ?? "")) return null;
  return lines.join("\n");
}

export async function appInstallUrl(gh: GitHub, slug: string, repo: string): Promise<string> {
  const project = await gh.getRepo(repo);
  const owner = await gh.json<{ id: number }>("GET", `/users/${repo.split("/")[0]}`);
  return installLink(slug, owner.id, project.id);
}

export const installSentence = (repo: string, url: string) =>
  `- open this page and choose Install, unless the hub's App already reaches ${repo}; the project is preselected (keep "Only select repositories"):\n  ${url}`;

export async function installOnProject(gh: GitHub, slug: string, repo: string): Promise<string> {
  return installSentence(repo, await appInstallUrl(gh, slug, repo));
}

export function platformsOf(entry: string): Platform[] {
  const assets = (parse(entry) as { assets?: Record<string, string> }[])[0]?.assets ?? {};
  return Object.keys(assets).filter((k): k is Platform => (PLATFORMS as readonly string[]).includes(k));
}
