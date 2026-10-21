import { appFromProjectYml, feedName, helpersOf, plistDict } from "../../appsource";
import { hasHomebrew } from "../../cli/hubpr";
import { type EntrySources, deriveUpdate, refusedDraftApp } from "../../entryupdate";
import { GitHubError, TapsterError } from "../../errors";
import type { GitHub, Release } from "../../github";
import { readHubFile } from "../../hubcommit";
import { entryText } from "../../hubentry";
import type { ConfigView } from "../contract";
import { openPull, proposal } from "./entry";

const SKIP = /(^|\/)(\.git|\.build|build|dist|DerivedData|node_modules|Pods|Carthage)\/|\.(app|xcodeproj)\//;

async function bytesAt(gh: GitHub, repo: string, path: string, ref: string): Promise<Buffer | null> {
  try {
    const f = await gh.json<{ content?: unknown; encoding?: string }>("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    return f.encoding !== "none" && typeof f.content === "string" && f.content !== "" ? Buffer.from(f.content, "base64") : null;
  } catch (e) {
    if (e instanceof GitHubError) return null;
    throw e;
  }
}

// GoReleaser's Homebrew section as it stood before the project moved to the hub, from the file's own history on GitHub.
async function homebrewHistory(gh: GitHub, repo: string, ref: string): Promise<string | null> {
  for (const file of [".goreleaser.yaml", ".goreleaser.yml"]) {
    const list = await gh.json<{ sha: string }[]>("GET", `/repos/${repo}/commits?path=${file}&sha=${encodeURIComponent(ref)}&per_page=6`).catch(() => []);
    for (const c of list.slice(1, 6)) {
      const text = await readHubFile(gh, repo, file, c.sha).catch(() => null);
      if (text !== null && hasHomebrew(text)) return text;
    }
    if (list.length) return null;
  }
  return null;
}

async function plistsAt(gh: GitHub, repo: string, ref: string): Promise<Buffer[]> {
  const tree = await gh.json<{ tree: { path: string; type: string }[] }>("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`).catch(() => ({ tree: [] }));
  const paths = tree.tree.filter((t) => t.type === "blob" && /(^|\/)Info\.plist$/.test(t.path) && !SKIP.test(t.path) && t.path.split("/").length <= 7).map((t) => t.path).slice(0, 8);
  return (await Promise.all(paths.map((p) => bytesAt(gh, repo, p, ref)))).filter((b): b is Buffer => b !== null);
}

export type ConfigInput = {
  hub: string;
  apple: boolean;
  hubText: string | null;
  name: string;
  repo: string;
  kind: "go" | "bun" | "app";
  ref: string;
  goreleaser: string | null;
  workflow: { name: string; text: string } | null;
  releases: Release[];
  memo?: Map<string, unknown>;
};

export function remoteSources(gh: GitHub, o: ConfigInput): EntrySources {
  const once = <T>(key: string, f: () => Promise<T>): (() => Promise<T>) => {
    const k = `${key}:${o.repo}@${o.ref}`;
    return () => {
      const known = o.memo?.get(k) as Promise<T> | undefined;
      if (known) return known;
      const p = f();
      o.memo?.set(k, p);
      return p;
    };
  };
  return {
    kind: o.kind,
    apple: o.apple,
    goreleaser: once("goreleaser", async () => (o.goreleaser !== null && hasHomebrew(o.goreleaser) ? o.goreleaser : homebrewHistory(gh, o.repo, o.ref))),
    plists: once("plists", () => plistsAt(gh, o.repo, o.ref)),
    app: once("app", async () => {
      const yml = await readHubFile(gh, o.repo, "project.yml", encodeURIComponent(o.ref)).catch(() => null);
      const fromYml = yml === null ? null : appFromProjectYml(yml);
      if (fromYml) return { feed: fromYml.feed, helpers: helpersOf(yml!) };
      for (const p of await plistsAt(gh, o.repo, o.ref)) {
        const feed = feedName(plistDict(p)?.SUFeedURL);
        if (feed) return { feed, helpers: [] };
      }
      return null;
    }),
    workflow: o.workflow,
    file: (path) => bytesAt(gh, o.repo, path, o.ref),
    draft: (assets) => refusedDraftApp(gh, o.repo, assets, o.releases, o.memo),
  };
}

// The Configuration section of a project in the hub: its entry, an update waiting in a pull request or what tapster
// can add to the entry from the project itself.
export async function configOf(gh: GitHub, o: ConfigInput): Promise<ConfigView | null> {
  const entry = o.hubText === null ? null : entryText(o.hubText, o.name);
  if (entry === null) return null;
  const pull = await openPull(gh, o.hub, "update", o.name).catch(() => null);
  if (pull) {
    try {
      const p = await proposal(gh, o.hub, o.name, "main", "update");
      return { entry, update: null, from: [], manual: [], pending: { pr: p.url, head: p.head, entry: p.entry, blocked: null } };
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      return { entry, update: null, from: [], manual: [], pending: { pr: pull.html_url, head: null, entry: null, blocked: `${e.reason}. ${e.fix}` } };
    }
  }
  const found = await deriveUpdate(entry, remoteSources(gh, o));
  return { entry, update: found.entry, from: found.from, manual: found.manual, pending: null };
}
