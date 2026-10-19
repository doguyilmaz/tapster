import { isSeq, parse, parseDocument } from "yaml";
import { NAME, PLATFORMS, type Platform, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";

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

export function goEntry(name: string, repo: string, goreleaser: string | null, release: { assets: string[]; version: string } | null): { entry: string | null; reason: string | null } {
  const cfg = ((goreleaser ? parse(goreleaser) : null) ?? {}) as GoConfig;
  const project = cfg.project_name ?? name;
  const binaries = [...new Set((cfg.builds ?? []).map((b) => b.binary ?? project))];
  const bins = binaries.length ? binaries : [project];
  if (release) {
    const assets: [string, string][] = [];
    for (const a of release.assets) {
      const key = Object.keys(PLATFORM_OF).find((k) => a.includes(k));
      if (key && !assets.some(([p]) => p === PLATFORM_OF[key])) assets.push([PLATFORM_OF[key]!, a.replaceAll(release.version, "{version}")]);
    }
    if (assets.length === 0) return { entry: null, reason: "the latest release has no archives tapster recognizes" };
    return { entry: entryText(name, repo, "go", bins, assets, assets.some(([p, a]) => p.startsWith("windows") && a.endsWith(".zip"))), reason: null };
  }
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

export function withEntry(hubYaml: string, entry: string, name: string): string {
  const doc = parseDocument(hubYaml);
  const raw = (doc.toJS() as { packages?: { name?: string }[] }).packages ?? [];
  if (raw.some((p) => p?.name === name)) throw new TapsterError(`${name} is already in the hub's tapster.yml`, "Edit its entry there instead.");
  const packages = doc.get("packages", true);
  if (!isSeq(packages)) throw new TapsterError("the hub's tapster.yml has no packages list", "Add packages: [] to it.");
  const item = parseDocument(entry).contents;
  if (!isSeq(item) || item.items.length !== 1) throw new TapsterError("the entry is not one package", "Report this as a tapster bug.");
  packages.flow = false;
  packages.items.push(item.items[0] as never);
  return doc.toString({ flowCollectionPadding: false });
}

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

export async function proposeEntry(gh: GitHub, hub: string, name: string, repo: string, entry: string): Promise<string> {
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
  await gh.json("PUT", `/repos/${hub}/contents/tapster.yml`, { message: `Add ${name}`, content: Buffer.from(next).toString("base64"), sha, branch });
  const body = [`tapster add prepared this entry for ${repo}:`, "", "```yaml", entry, "```", "", `Merge it to let the hub publish ${repo}.`].join("\n");
  const pr = await gh.json<{ html_url: string }>("POST", `/repos/${hub}/pulls`, { title: `Add ${name}`, head: branch, base: "main", body });
  return pr.html_url;
}

export async function installOnProject(gh: GitHub, hub: string, repo: string): Promise<string> {
  const vars = await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`);
  const slug = vars.variables.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  if (!slug) throw new TapsterError("the hub has no App yet", "Run tapster init in a clone of the hub first.");
  const project = await gh.getRepo(repo);
  const installation = vars.variables.find((v) => v.name === "TAPSTER_APP_INSTALLATION_ID")?.value;
  if (installation && /^\d+$/.test(installation)) {
    try {
      await gh.json("PUT", `/user/installations/${installation}/repositories/${project.id}`);
      return `- the hub's App can reach ${repo}`;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
    }
  }
  const owner = await gh.json<{ id: number }>("GET", `/users/${repo.split("/")[0]}`);
  return `- make sure the hub's App is installed on ${repo}; this page has it preselected (keep "Only select repositories"):\n  ${installLink(slug, owner.id, project.id)}`;
}

export function platformsOf(entry: string): Platform[] {
  const assets = (parse(entry) as { assets?: Record<string, string> }[])[0]?.assets ?? {};
  return Object.keys(assets).filter((k): k is Platform => (PLATFORMS as readonly string[]).includes(k));
}
