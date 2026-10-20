import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { TapsterError } from "../../errors";
import { protectionProblems } from "../../rulesets";
import { readGit } from "../../clone";
import { TOOLS, runPath } from "../../run";
import { addOptions, addProject, findApp, projectName } from "../../cli/add";
import { binName, hubEntries, hubFacts } from "../../cli/hubpr";
import type { AddView, DiffView, InspectView, ScanView } from "../contract";
import { defaultRoots, insideHome, oneClonePerRepo, originRepo, projectKind, readSmall, scanClones } from "../scan";
import { type Ctx, type Routes, readJson } from "../server";
import { checkHub, me } from "./hub";
import { setupProblems } from "./status";

const COMMIT_MESSAGE = "Release through the tapster hub";

export function clonePath(path: unknown, home: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new TapsterError("that is not a full folder path", "Give the folder's full path, such as /Users/you/Developer/my-tool.");
  const dir = resolve(normalize(path));
  if (!insideHome(dir, home)) throw new TapsterError(`${dir} is outside your home folder`, "tapster reads clones inside your home folder only.");
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new TapsterError(`${dir} does not exist`, "Check the path.");
  }
  if (!st.isDirectory()) throw new TapsterError(`${dir} is not a folder`, "Give the folder of the clone.");
  if (!existsSync(join(dir, ".git")) || !lstatSync(join(dir, ".git")).isDirectory()) throw new TapsterError(`${dir} is not a git clone`, "Give the top folder of a clone, the one that holds .git.");
  return dir;
}

function cloneRepo(dir: string, login: string): string {
  const repo = originRepo(readSmall(join(dir, ".git", "config"), 64 * 1024) ?? "");
  if (!repo) throw new TapsterError("this clone's origin is not a GitHub repository", "tapster adds clones whose origin is on github.com.");
  if (repo.split("/")[0]!.toLowerCase() !== login.toLowerCase()) throw new TapsterError(`${repo} does not belong to ${login}`, "tapster publishes repositories of your own account.");
  return repo;
}

async function git(dir: string, args: string[], o: { user?: boolean; timeoutMs?: number } = {}) {
  if (!o.user) return readGit(dir, args, o);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  return runPath(TOOLS.git, "git", ["-C", dir, ...args], { env, allowFail: true, timeoutMs: o.timeoutMs ?? 20_000, maxOutput: 4 << 20 });
}

// Reading a clone must not run its own config: status and diff would run clean filters and fsmonitor from .git/config.
async function committed(dir: string, path: string): Promise<string | null> {
  const res = await readGit(dir, ["cat-file", "-p", `HEAD:${path}`]);
  return res.code === 0 ? res.stdout : null;
}

function branchOf(dir: string): string {
  const head = readSmall(join(dir, ".git", "HEAD"), 4096)?.trim() ?? "";
  return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? "a detached HEAD";
}

async function changed(dir: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const now = readSmall(join(dir, p));
    if (now !== null && now !== (await committed(dir, p))) out.push(p);
  }
  return out;
}

const hubBody = { hub: z.string() };

async function scan(c: Ctx): Promise<ScanView> {
  const body = await readJson(c.req, z.object({ hub: z.string(), extra: z.array(z.string()).max(10) }).strict());
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const extra = body.extra.map((p) => resolve(p)).filter((p) => isAbsolute(p) && insideHome(p, c.s.deps.home) && existsSync(p));
  const roots = [...new Set([...extra, ...defaultRoots(c.s.deps.home, c.s.deps.cwd)])].filter((p) => existsSync(p));
  const { found, truncated } = scanClones(roots);
  const entries = await hubEntries(gh, hub).catch(() => []);
  const entry = (repo: string) => entries.find((e) => e.repo.toLowerCase() === repo.toLowerCase());
  const mine = found.filter((f) => f.owner.toLowerCase() === login.toLowerCase() && f.repo.toLowerCase() !== hub.toLowerCase());
  const unique = oneClonePerRepo([...new Map(mine.map((f) => [f.path, f])).values()]);
  return {
    projects: unique.map(({ owner: _, ...p }) => ({ ...p, inHub: entry(p.repo)?.state === "merged", proposed: entry(p.repo)?.pr ?? null })).sort((a, b) => Number(b.kind !== null) - Number(a.kind !== null) || a.repo.localeCompare(b.repo)),
    roots,
    others: found.length - mine.length,
    truncated,
  };
}

function goWorkflows(dir: string): string[] {
  const flows = join(dir, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(flows).filter((f) => /^[A-Za-z0-9._-]+\.ya?ml$/.test(f));
  } catch {
    return [];
  }
  return names.filter((f) => (readSmall(join(flows, f)) ?? "").includes("goreleaser/goreleaser-action")).sort();
}

async function inspect(c: Ctx): Promise<InspectView> {
  const body = await readJson(c.req, z.object({ ...hubBody, path: z.string() }).strict());
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const dir = clonePath(body.path, c.s.deps.home);
  const repo = cloneRepo(dir, login);
  const name = projectName(repo);
  const entries = readdirSync(dir);
  let { kind, why } = projectKind(dir, entries);
  if (kind === "app" && !findApp(dir)) {
    kind = null;
    why = "an Xcode project without a Sparkle feed (SUFeedURL ending in /releases/latest/download/<name>.xml)";
  }
  if (kind === "bun") {
    const pkg = readSmall(join(dir, "package.json"));
    let parsed: unknown = null;
    try {
      parsed = pkg ? JSON.parse(pkg) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !binName(parsed as { bin?: string }, name)) {
      kind = null;
      why = "package.json has no bin entry, so there is no command to publish";
    }
  }
  if (kind === null) throw new TapsterError(`tapster cannot publish ${repo} yet: it is ${why}`, "tapster publishes GoReleaser Go tools, Bun command line tools and Mac apps that update with Sparkle.");
  const workflows = kind === "go" ? goWorkflows(dir) : [];
  const release = readSmall(join(dir, ".github", "workflows", "release.yml"));
  const dirty = await changed(dir, [".github/workflows/release.yml", ".goreleaser.yaml", ".goreleaser.yml", ...workflows.map((w) => `.github/workflows/${w}`)]);
  const branch = branchOf(dir);
  const [project, facts, listed] = await Promise.all([gh.getRepo(repo), hubFacts(gh, hub).catch(() => null), hubEntries(gh, hub).catch(() => [])]);
  const problems = await protectionProblems(gh, repo, project.default_branch, "admin").catch(() => ["unknown"]);
  const entry = listed.find((e) => e.repo.toLowerCase() === repo.toLowerCase());
  if (!facts) throw new TapsterError(`${hub} has no App yet`, "Finish the hub's setup first.");
  const workflow = workflows.includes("release.yml") ? "release.yml" : (workflows[0] ?? (kind === "go" ? null : "release.yml"));
  const local = (path: string) => readSmall(join(dir, path));
  const ready =
    workflow !== null &&
    setupProblems({ kind, branch, workflowName: workflow, goreleaser: kind === "go" ? (local(".goreleaser.yaml") ?? local(".goreleaser.yml")) : null, workflow: local(`.github/workflows/${workflow}`) }).length === 0;
  const upstream = await git(dir, ["rev-list", "--count", "@{u}..HEAD"]);
  return {
    path: dir,
    repo,
    name,
    kind,
    branch,
    defaultBranch: project.default_branch,
    dirty: [...new Set(dirty)],
    workflows,
    workflow: kind === "go" ? workflow : null,
    releaseFlow: release === null ? "missing" : release.includes("Ring the tapster hub") ? "ours" : "other",
    dependabot: [".github/dependabot.yml", ".github/dependabot.yaml"].some((f) => existsSync(join(dir, f))),
    private: project.private,
    protected: problems.length === 0,
    inHub: entry?.state === "merged",
    proposed: entry?.pr ?? null,
    apple: facts.apple,
    ready,
    ahead: upstream.code === 0 && /^\d+$/.test(upstream.stdout.trim()) ? Number(upstream.stdout.trim()) : null,
  };
}

const addBody = z
  .object({ ...hubBody, path: z.string(), options: z.object({ workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/), autoTag: z.boolean(), dependabot: z.boolean(), force: z.boolean() }).strict() })
  .strict();

async function add(c: Ctx): Promise<AddView> {
  const body = await readJson(c.req, addBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const dir = clonePath(body.path, c.s.deps.home);
  const repo = cloneRepo(dir, login);
  const o = body.options;
  const opts = addOptions([...(o.force ? ["--force"] : []), ...(o.autoTag ? ["--auto-tag"] : []), ...(o.dependabot ? ["--allow-dependabot"] : []), "--workflow", o.workflow]);
  const facts = await hubFacts(gh, hub);
  await git(dir, ["config", "tapster.hub", hub], { user: true });
  const lines: string[] = [];
  const added = await addProject(gh, dir, repo, hub, facts, opts, (line) => lines.push(line));
  return { lines, pr: added.pr, entry: added.entry, installUrl: added.installUrl, files: await changed(dir, added.files) };
}

function relFiles(files: string[]): string[] {
  for (const f of files) {
    if (isAbsolute(f) || normalize(f).startsWith("..") || !/^[A-Za-z0-9._/-]+$/.test(f)) throw new TapsterError(`${f} is not a file of this clone`, "Reload the page and try again.");
  }
  return files;
}

const filesBody = z.object({ path: z.string(), files: z.array(z.string()).min(1).max(10) }).strict();

async function diff(c: Ctx): Promise<DiffView> {
  const body = await readJson(c.req, filesBody);
  const { login } = await me(c.s);
  const dir = clonePath(body.path, c.s.deps.home);
  cloneRepo(dir, login);
  const out: DiffView["files"] = [];
  for (const f of relFiles(body.files)) {
    const before = await committed(dir, f);
    const after = readSmall(join(dir, f));
    out.push({ path: f, before, after, change: before === null ? "create" : after === null ? "remove" : before === after ? "same" : "update" });
  }
  return { files: out };
}

async function commit(c: Ctx) {
  const body = await readJson(c.req, filesBody);
  const { login } = await me(c.s);
  const dir = clonePath(body.path, c.s.deps.home);
  cloneRepo(dir, login);
  const files = relFiles(body.files);
  const added = await git(dir, ["add", "--", ...files], { user: true });
  if (added.code !== 0) throw new TapsterError("git could not stage the files", added.stderr.trim().split("\n").at(-1) ?? "Run git status in the clone.");
  const done = await git(dir, ["commit", "-m", COMMIT_MESSAGE, "--", ...files], { user: true, timeoutMs: 60_000 });
  if (done.code !== 0) {
    const said = `${done.stdout}\n${done.stderr}`;
    if (/nothing to commit|no changes added/i.test(said)) return { committed: false };
    throw new TapsterError("git could not commit", `${said.trim().split("\n").at(-1) ?? ""} Commit in a terminal: git commit -m "${COMMIT_MESSAGE}" -- ${files.join(" ")}`);
  }
  return { committed: true };
}

async function push(c: Ctx) {
  const body = await readJson(c.req, z.object({ path: z.string() }).strict());
  const { login } = await me(c.s);
  const dir = clonePath(body.path, c.s.deps.home);
  cloneRepo(dir, login);
  const upstream = (await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code === 0;
  const args = upstream ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"];
  const res = await git(dir, args, { user: true, timeoutMs: 90_000 }).catch((e) => {
    if (e instanceof TapsterError) return { code: 1, stdout: "", stderr: e.reason };
    throw e;
  });
  if (res.code !== 0) throw new TapsterError("git could not push without asking for a password or passphrase", `Push from a terminal in ${dir}: git ${args.join(" ")}`);
  return { pushed: true };
}

export const projectRoutes: Routes = {
  "POST /api/projects/scan": scan,
  "POST /api/projects/inspect": inspect,
  "POST /api/projects/add": add,
  "POST /api/projects/diff": diff,
  "POST /api/projects/commit": commit,
  "POST /api/projects/push": push,
};
