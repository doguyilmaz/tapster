import { parse } from "yaml";
import { z } from "zod";
import { noteIn } from "../../draftnote";
import { GitHubError, TapsterError } from "../../errors";
import type { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { protectionProblems } from "../../rulesets";
import { TAG, compareSemver, parseTag } from "../../semver";
import type { State } from "../../state";
import { type HubEntry, hubEntries, hubFacts, installLink, releaseSecrets, repoTags } from "../../cli/hubpr";
import type { CommitView, FollowView, ProjectStatus, StatusView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { highestTag, nextTag, tagProblem } from "../status";
import { checkHub, me } from "./hub";
import { type HubChecks, hubChecks, reachOf, reachRoutes, stateOf } from "./reach";

const HOMEBREW_KEYS = ["notarize", "homebrew_casks", "brews", "scoops"];

export function setupProblems(o: { kind: string; branch: string; workflowName: string; goreleaser: string | null; workflow: string | null }): string[] {
  const out: string[] = [];
  if (o.kind === "go") {
    let cfg: Record<string, unknown> | null = null;
    try {
      cfg = o.goreleaser === null ? null : ((parse(o.goreleaser) ?? {}) as Record<string, unknown>);
    } catch {
      out.push("GoReleaser's config is not valid YAML");
    }
    if (o.goreleaser === null) out.push(`there is no .goreleaser.yaml on ${o.branch}`);
    if (cfg) {
      if ((cfg.release as { draft?: unknown } | undefined)?.draft !== true) out.push("GoReleaser publishes releases instead of opening drafts");
      const left = HOMEBREW_KEYS.filter((k) => k in cfg!);
      if (left.length) out.push(`GoReleaser still has ${left.join(", ")}, which the hub does now`);
    }
  }
  if (o.workflow === null) return [...out, `there is no .github/workflows/${o.workflowName} on ${o.branch}`];
  if (o.kind !== "go" && !/--draft\b/.test(o.workflow)) out.push("the workflow publishes releases instead of opening drafts");
  if (!o.workflow.includes("actions/attest-build-provenance@")) out.push("the workflow does not attest the archives");
  const secrets = [...new Set(o.workflow.match(/\b(?:MACOS|HOMEBREW_TAP)_[A-Z0-9_]+/g) ?? [])];
  if (secrets.length) out.push(`the workflow still uses ${secrets.join(", ")}`);
  return out;
}

type Shared = { gh: GitHub; hub: string; slug: string | null; ownerId: number; state: State; checks: HubChecks };

async function shared(s: Session, gh: GitHub, hub: string, login: string): Promise<Shared> {
  const [slug, stateText, owner, checks] = await Promise.all([
    hubFacts(gh, hub).then((f) => f.slug, (e) => (e instanceof TapsterError ? null : Promise.reject(e))),
    readHubFile(gh, hub, ".tapster/state.json", "main"),
    gh.json<{ id: number }>("GET", `/users/${login}`),
    hubChecks(s, gh, hub),
  ]);
  return { gh, hub, slug, ownerId: owner.id, state: stateOf(stateText), checks };
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

type Release = { tag_name: string; draft: boolean; html_url: string; body?: string | null };

const newest = (list: Release[]) => list.filter((r) => TAG.test(r.tag_name)).sort((a, b) => compareSemver(parseTag(b.tag_name)!, parseTag(a.tag_name)!))[0] ?? null;

async function headOf(gh: GitHub, repo: string, branch: string): Promise<CommitView | null> {
  try {
    const sha = (await gh.json<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    const c = await gh.json<{ sha: string; html_url: string; commit: { message: string; committer: { date: string } | null } }>("GET", `/repos/${repo}/commits/${sha}`);
    return { sha: c.sha, subject: clean(c.commit.message.split("\n")[0] ?? "").slice(0, 120), date: c.commit.committer?.date ?? "", url: c.html_url };
  } catch (e) {
    if (e instanceof GitHubError) return null;
    throw e;
  }
}

async function projectStatus(sh: Shared, e: Listed): Promise<ProjectStatus> {
  const { gh } = sh;
  const project = await gh.getRepo(e.repo);
  const branch = project.default_branch;
  const read = (path: string) => readHubFile(gh, e.repo, path, encodeURIComponent(branch));
  const [goreleaser, workflow, problems, keys, releases, tags, head, secrets] = await Promise.all([
    e.kind === "go" ? read(".goreleaser.yaml").then((t) => t ?? read(".goreleaser.yml")) : Promise.resolve(null),
    read(`.github/workflows/${e.workflow}`),
    e.protection === "off" ? Promise.resolve([]) : protectionProblems(gh, e.repo, branch, "admin", e.protection === "dependabot").catch(() => ["GitHub did not show the repository's rulesets"]),
    gh.json<{ title: string }[]>("GET", `/repos/${e.repo}/keys`).catch(() => []),
    gh.json<Release[]>("GET", `/repos/${e.repo}/releases?per_page=30`).catch(() => []),
    repoTags(gh, e.repo),
    headOf(gh, e.repo, branch),
    gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${e.repo}/actions/secrets?per_page=100`).then((r) => releaseSecrets(r.secrets.map((x) => x.name)), () => []),
  ]);
  const published = sh.state.packages[e.name] ?? [];
  const latest = newest(releases.filter((r) => !r.draft));
  const draft = newest(releases.filter((r) => r.draft && TAG.test(r.tag_name) && (!latest || compareSemver(parseTag(r.tag_name)!, parseTag(latest.tag_name)!) > 0)));
  const highest = highestTag(tags);
  const setup = setupProblems({ kind: e.kind, branch, workflowName: e.workflow, goreleaser, workflow });
  return {
    name: e.name,
    repo: e.repo,
    url: project.html_url,
    kind: e.kind,
    defaultBranch: branch,
    setup: { ok: setup.length === 0, problems: setup },
    protection: { ok: problems.length === 0, off: e.protection === "off", problems },
    entry: { state: e.state, pr: e.pr },
    app: { ...reachOf(sh.checks, e.name, e.repo, sh.state), installUrl: sh.slug ? installLink(sh.slug, sh.ownerId, project.id) : "" },
    release: {
      latest: latest ? { tag: latest.tag_name, url: latest.html_url, byHub: published.some((p) => p.tag === latest.tag_name && p.status === "published") } : null,
      draft: draft ? { tag: draft.tag_name, url: draft.html_url, note: noteIn(draft.body) } : null,
      highest,
      next: nextTag(highest),
      autoTag: keys.some((k) => k.title === "tapster tags"),
      head,
    },
    secrets: { names: secrets, published: published.some((p) => p.status === "published") },
    unreadable: null,
  };
}

type Listed = HubEntry | (Omit<HubEntry, "state" | "pr"> & { state: "missing"; pr: null });

async function statusOrReason(sh: Shared, e: Listed): Promise<ProjectStatus> {
  try {
    return await projectStatus(sh, e);
  } catch (err) {
    if (!(err instanceof TapsterError)) throw err;
    return {
      name: e.name,
      repo: e.repo,
      url: `https://github.com/${e.repo}`,
      kind: e.kind,
      defaultBranch: "main",
      setup: { ok: false, problems: [] },
      protection: { ok: false, off: false, problems: [] },
      entry: { state: e.state, pr: e.pr },
      app: { reaches: null, how: null, at: null, since: null, reason: null, run: null, running: false, installUrl: "" },
      release: { latest: null, draft: null, highest: null, next: "v0.1.0", autoTag: false, head: null },
      secrets: { names: [], published: false },
      unreadable: `${err.reason}. ${err.fix}`,
    };
  }
}

async function guessKind(gh: GitHub, repo: string, branch: string): Promise<"go" | "bun" | "app"> {
  const has = async (path: string) => (await readHubFile(gh, repo, path, encodeURIComponent(branch)).catch(() => null)) !== null;
  if ((await has(".goreleaser.yaml")) || (await has(".goreleaser.yml"))) return "go";
  return (await has("package.json")) ? "bun" : "app";
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

async function status(c: Ctx): Promise<StatusView> {
  const { gh, login } = await me(c.s);
  const hub = checkHub(c.url.searchParams.get("hub"), login);
  const only = c.url.searchParams.get("repo");
  if (only !== null && (!REPO.test(only) || only.split("/")[0]!.toLowerCase() !== login.toLowerCase())) throw new TapsterError(`${only} is not one of your repositories`, "Reload the page and try again.");
  const entries = await hubEntries(gh, hub);
  const sh = await shared(c.s, gh, hub, login);
  if (only !== null) {
    const found = entries.find((e) => e.repo.toLowerCase() === only.toLowerCase());
    if (found) return { projects: [await statusOrReason(sh, found)] };
    const name = only.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const kind = await guessKind(gh, only, (await gh.getRepo(only)).default_branch);
    return { projects: [await statusOrReason(sh, { name, repo: only, kind, workflow: "release.yml", protection: "on", description: null, state: "missing", pr: null })] };
  }
  return { projects: await Promise.all(entries.map((e) => statusOrReason(sh, e))) };
}

const releaseBody = z.object({ hub: z.string(), repo: z.string().regex(REPO), tag: z.string().max(100), sha: z.string().regex(/^[0-9a-f]{40,64}$/) }).strict();

async function hubProject(gh: GitHub, hub: string, repo: string): Promise<HubEntry> {
  const entry = (await hubEntries(gh, hub)).find((e) => e.repo.toLowerCase() === repo.toLowerCase());
  if (!entry) throw new TapsterError(`${repo} is not in ${hub}`, "Add the project to the hub first.");
  return entry;
}

async function release(c: Ctx) {
  const body = await readJson(c.req, releaseBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const entry = await hubProject(gh, hub, body.repo);
  const branch = (await gh.getRepo(entry.repo)).default_branch;
  const head = await headOf(gh, entry.repo, branch);
  if (!head) throw new TapsterError(`GitHub did not show the latest commit on ${branch}`, "Try again in a moment.");
  if (head.sha !== body.sha) throw new TapsterError(`${branch} moved since this page read it`, `It now ends at ${head.sha.slice(0, 7)}, ${head.subject}. Check that commit, then click Release again.`);
  const problem = tagProblem(body.tag, highestTag(await repoTags(gh, entry.repo)));
  if (problem) throw new TapsterError(`${body.tag} cannot be released`, `${problem}.`);
  try {
    await gh.json("POST", `/repos/${entry.repo}/git/refs`, { ref: `refs/tags/${body.tag}`, sha: body.sha });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) throw new TapsterError(`${body.tag} already exists on ${entry.repo}`, "Pick the next version and click Release again.");
    throw e;
  }
  return { tag: body.tag, sha: body.sha };
}

async function follow(c: Ctx): Promise<FollowView> {
  const { gh, login } = await me(c.s);
  const hub = checkHub(c.url.searchParams.get("hub"), login);
  const tag = c.url.searchParams.get("tag") ?? "";
  if (!TAG.test(tag)) throw new TapsterError(`${tag} is not a version tag`, "Reload the page and try again.");
  const entry = await hubProject(gh, hub, c.url.searchParams.get("repo") ?? "");
  const [runs, releases, stateText] = await Promise.all([
    gh.json<{ workflow_runs: { status: string; conclusion: string | null; html_url: string }[] }>("GET", `/repos/${entry.repo}/actions/runs?event=push&branch=${encodeURIComponent(tag)}&per_page=5`).catch(() => ({ workflow_runs: [] })),
    gh.json<Release[]>("GET", `/repos/${entry.repo}/releases?per_page=30`).catch(() => []),
    readHubFile(gh, hub, ".tapster/state.json", "main").catch(() => null),
  ]);
  const state = stateOf(stateText);
  const run = runs.workflow_runs[0];
  const found = releases.find((r) => r.tag_name === tag);
  const byHub = (state.packages[entry.name] ?? []).some((p) => p.tag === tag && p.status === "published");
  return {
    run: run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null,
    draft: found?.draft ? { url: found.html_url, note: noteIn(found.body) } : null,
    published: found && !found.draft ? { url: found.html_url, byHub } : null,
    hub: `https://github.com/${hub}/actions/workflows/tapster.yml`,
  };
}

export const statusRoutes: Routes = {
  ...reachRoutes,
  "GET /api/projects/status": status,
  "POST /api/projects/release": release,
  "GET /api/projects/follow": follow,
};
