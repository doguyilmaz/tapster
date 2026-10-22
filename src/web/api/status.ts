import { parse } from "yaml";
import { z } from "zod";
import { noteIn } from "../../draftnote";
import { GitHubError, TapsterError } from "../../errors";
import { type GitHub, type Release as GitHubRelease, type Repo, early, limited } from "../../github";
import { readHubFile } from "../../hubcommit";
import { protectionProblems } from "../../rulesets";
import { TAG, compareSemver, parseTag } from "../../semver";
import type { State } from "../../state";
import { type HubEntry, type TagRef, hubEntries, hubFacts, installLink, releaseSecrets, tagAt, tagCommit, tagRefs } from "../../cli/hubpr";
import type { CommitView, FollowView, ProjectStatus, StatusView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { changesRelease, highestTag, nextTag, skipFix, skipMarker, suggestBump, tagProblem } from "../status";
import { configOf } from "./config";
import { type Pull, proposal } from "./entry";
import { checkHub, hubRunList, me, startHubRun } from "./hub";
import { type HubChecks, hubChecks, reachOf, reachRoutes, stateOf } from "./reach";

const HOMEBREW_KEYS = ["notarize", "homebrew_casks", "brews", "scoops"];

const or = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

// What starts the release workflow besides a version tag or a manual run; a merge that matches one starts a release.
async function sinceTag(gh: GitHub, repo: string, tag: string, sha: string): Promise<string[]> {
  const cmp = await gh.json<{ commits?: { commit: { message: string } }[] }>("GET", `/repos/${repo}/compare/${encodeURIComponent(tag)}...${sha}`);
  return (cmp.commits ?? []).map((c) => c.commit.message);
}

export function releaseTriggers(workflow: string): string[] {
  let on: unknown;
  try {
    on = (parse(workflow) as { on?: unknown } | null)?.on;
  } catch {
    return [];
  }
  const named = typeof on === "string" || Array.isArray(on) ? Object.fromEntries(list(on).map((e) => [e, null])) : on && typeof on === "object" ? (on as Record<string, unknown>) : {};
  const out: string[] = [];
  if ("push" in named) {
    const push = (named.push ?? {}) as Record<string, unknown>;
    const branches = list(push.branches);
    const paths = list(push.paths);
    const onlyTags = "tags" in push && !("branches" in push) && !("branches-ignore" in push) && !("paths" in push) && !("paths-ignore" in push);
    if (!onlyTags) {
      const where = branches.length ? `pushes to ${or(branches)}` : Object.keys(push).length ? "pushes to any branch" : "every push";
      out.push(paths.length ? `${where} that change ${or(paths)}` : where);
    }
  }
  if ("schedule" in named) out.push("a schedule");
  if ("workflow_run" in named) out.push("another workflow finishing");
  return out;
}

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

// The hub's reads, started together with the projects' own and awaited only where a value needs them. failed rejects
// with the first of them that failed, which fails the whole answer.
type Shared = {
  gh: GitHub;
  hub: string;
  memo: Map<string, unknown>;
  hubText: Promise<string | null>;
  pulls: Promise<Pull[]>;
  facts: Promise<{ slug: string; apple: boolean } | null>;
  state: Promise<State>;
  ownerId: Promise<number>;
  checks: Promise<HubChecks>;
  failed: Promise<unknown>;
};

function shared(s: Session, gh: GitHub, hub: string, login: string): Shared {
  if (s.memo.size > 500) s.memo.clear();
  const hubText = early(readHubFile(gh, hub, "tapster.yml", "main"));
  const pulls = early(gh.json<Pull[]>("GET", `/repos/${hub}/pulls?state=open&per_page=100`));
  const facts = early(hubFacts(gh, hub).catch((e) => (e instanceof TapsterError ? null : Promise.reject(e))));
  const state = early(readHubFile(gh, hub, ".tapster/state.json", "main").then(stateOf));
  const ownerId = early(gh.json<{ id: number }>("GET", `/users/${login}`).then((o) => o.id));
  const checks = early(hubChecks(s, gh, hub));
  return { gh, hub, memo: s.memo, hubText, pulls, facts, state, ownerId, checks, failed: early(Promise.all([facts, state, ownerId, checks, hubText])) };
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

type Release = GitHubRelease & { html_url: string };

const newest = (list: Release[]) => list.filter((r) => TAG.test(r.tag_name)).sort((a, b) => compareSemver(parseTag(b.tag_name)!, parseTag(a.tag_name)!))[0] ?? null;

type Commit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } | null }; parents?: { sha: string }[]; files?: { filename: string }[] };

const subjectOf = (c: Commit) => clean(c.commit.message.split("\n")[0] ?? "").slice(0, 120);

// Pass refs only when GitHub listed them: without them parent.tag stays unknown and nothing is offered.
export async function withParentTag(gh: GitHub, repo: string, head: CommitView | null, refs: TagRef[] | null): Promise<CommitView | null> {
  if (!refs || !head?.parent || head.parent.skip) return head;
  return { ...head, parent: { ...head.parent, tag: await tagAt(gh, repo, refs, head.parent.sha) } };
}

export async function headOf(gh: GitHub, repo: string, branch: string): Promise<CommitView | null> {
  let sha: string;
  try {
    sha = (await gh.json<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
  } catch (e) {
    if (e instanceof GitHubError) return null;
    throw e;
  }
  return commitAt(gh, repo, sha);
}

// ref: a commit's sha or HEAD, the latest commit on the default branch.
async function commitAt(gh: GitHub, repo: string, ref: string): Promise<CommitView | null> {
  try {
    const c = await gh.json<Commit>("GET", `/repos/${repo}/commits/${ref}`);
    const head: CommitView = { sha: c.sha, subject: subjectOf(c), date: c.commit.committer?.date ?? "", url: c.html_url };
    const skip = skipMarker(c.commit.message);
    if (!skip) return head;
    const first = c.parents?.[0]?.sha;
    const before = first ? await gh.json<Commit>("GET", `/repos/${repo}/commits/${first}`).catch(() => null) : null;
    const files = c.files?.map((f) => f.filename);
    return {
      ...head,
      skip,
      parent: before && { sha: before.sha, subject: subjectOf(before), url: before.html_url, skip: skipMarker(before.commit.message) },
      changesRelease: !files || files.length >= 300 || changesRelease(files),
    };
  } catch (e) {
    if (e instanceof GitHubError) return null;
    throw e;
  }
}

// The two reads every later step waits on, started for all projects before the rest of their reads.
type Start = { project: Promise<Repo>; tip: Promise<CommitView | null> };

const begin = (gh: GitHub, repo: string, project = gh.getRepo(repo)): Start => ({ project: early(project), tip: early(commitAt(gh, repo, "HEAD")) });

async function projectStatus(sh: Shared, e: Listed, start: Start): Promise<ProjectStatus> {
  const { gh } = sh;
  // HEAD is the default branch, so these reads need not wait for the repository's details.
  const read = (path: string) => readHubFile(gh, e.repo, path, "HEAD");
  const reads = early(
    Promise.all([
      e.kind === "go" ? read(".goreleaser.yaml").then((t) => t ?? read(".goreleaser.yml")) : Promise.resolve(null),
      read(`.github/workflows/${e.workflow}`),
      gh.json<{ title: string }[]>("GET", `/repos/${e.repo}/keys`).catch(() => []),
      gh.json<Release[]>("GET", `/repos/${e.repo}/releases?per_page=30`).catch(() => []),
      tagRefs(gh, e.repo).catch(() => null),
      gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${e.repo}/actions/secrets?per_page=100`).then((r) => releaseSecrets(r.secrets.map((x) => x.name)), () => []),
      e.state === "proposed"
        ? proposal(gh, sh.hub, e.name, "main", "add", sh.pulls).then(
            (p) => ({ proposal: { head: p.head, entry: p.entry }, blocked: null }),
            (err) => (err instanceof TapsterError ? { proposal: null, blocked: `${err.reason}. ${err.fix}` } : Promise.reject(err)),
          )
        : Promise.resolve({ proposal: null, blocked: null }),
    ]),
  );
  const project = await start.project;
  const branch = project.default_branch;
  const problemsP = early(e.protection === "off" ? Promise.resolve([]) : protectionProblems(gh, e.repo, branch, "admin", e.protection === "dependabot").catch(() => ["GitHub did not show the repository's rulesets"]));
  const [[goreleaser, workflow, keys, releases, listed, secrets, proposed], tip] = await Promise.all([reads, start.tip]);
  const refs = listed ?? [];
  const latest = newest(releases.filter((r) => !r.draft));
  const draft = newest(releases.filter((r) => r.draft && TAG.test(r.tag_name) && (!latest || compareSemver(parseTag(r.tag_name)!, parseTag(latest.tag_name)!) > 0)));
  const highest = highestTag([...refs.map((r) => r.name), ...releases.map((r) => r.tag_name)]);
  const headP = early(withParentTag(gh, e.repo, tip, listed));
  const atHeadP = early(tip ? tagAt(gh, e.repo, refs, tip.sha) : Promise.resolve(null));
  const suggestP = early(atHeadP.then((atHead) => (tip && highest && !atHead ? sinceTag(gh, e.repo, highest, tip.sha).then((m) => suggestBump(m, highest), () => null) : null)));
  const configP = early(
    e.state === "merged"
      ? Promise.all([sh.hubText, sh.facts]).then(([hubText, facts]) =>
          configOf(gh, { hub: sh.hub, apple: facts?.apple ?? false, hubText, name: e.name, repo: e.repo, kind: e.kind, ref: tip?.sha ?? branch, goreleaser, workflow: workflow === null ? null : { name: `.github/workflows/${e.workflow}`, text: workflow }, releases, memo: sh.memo, pulls: sh.pulls }).catch((err) =>
            err instanceof TapsterError || err instanceof GitHubError ? null : Promise.reject(err),
          ),
        )
      : Promise.resolve(null),
  );
  const [head, atHead, suggest, config, problems, state, facts, ownerId, checks] = await Promise.all([headP, atHeadP, suggestP, configP, problemsP, sh.state, sh.facts, sh.ownerId, sh.checks]);
  const published = state.packages[e.name] ?? [];
  const setup = setupProblems({ kind: e.kind, branch, workflowName: e.workflow, goreleaser, workflow });
  return {
    name: e.name,
    repo: e.repo,
    url: project.html_url,
    kind: e.kind,
    defaultBranch: branch,
    setup: { ok: setup.length === 0, problems: setup, triggers: workflow ? releaseTriggers(workflow) : [] },
    protection: { ok: problems.length === 0, off: e.protection === "off", problems },
    entry: { state: e.state, pr: e.pr, ...proposed },
    app: { ...reachOf(checks, e.name, e.repo, state), installUrl: facts?.slug ? installLink(facts.slug, ownerId, project.id) : "" },
    release: {
      latest: latest ? { tag: latest.tag_name, url: latest.html_url, byHub: published.some((p) => p.tag === latest.tag_name && p.status === "published") } : null,
      draft: draft ? { tag: draft.tag_name, url: draft.html_url, note: noteIn(draft.body) } : null,
      highest,
      next: nextTag(highest),
      autoTag: keys.some((k) => k.title === "tapster tags"),
      atHead,
      suggest,
      head,
    },
    secrets: { names: secrets, published: published.some((p) => p.status === "published") },
    unreadable: null,
    config,
  };
}

type Listed = HubEntry | (Omit<HubEntry, "state" | "pr"> & { state: "missing"; pr: null });

async function statusOrReason(sh: Shared, e: Listed, start: Start): Promise<ProjectStatus> {
  try {
    return await projectStatus(sh, e, start);
  } catch (err) {
    await sh.failed;
    if (!(err instanceof TapsterError)) throw err;
    return {
      name: e.name,
      repo: e.repo,
      url: `https://github.com/${e.repo}`,
      kind: e.kind,
      defaultBranch: "main",
      setup: { ok: false, problems: [], triggers: [] },
      protection: { ok: false, off: false, problems: [] },
      entry: { state: e.state, pr: e.pr, proposal: null, blocked: null },
      app: { reaches: null, how: null, at: null, since: null, reason: null, run: null, running: false, installUrl: "" },
      release: { latest: null, draft: null, highest: null, next: "v0.1.0", autoTag: false, atHead: null, suggest: null, head: null },
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

async function statuses(sh: Shared, list: Listed[], started = list.map((e) => begin(sh.gh, e.repo))): Promise<StatusView> {
  const [, projects] = await Promise.all([sh.failed, Promise.all(list.map((e, i) => statusOrReason(sh, e, started[i]!)))]);
  return { projects };
}

async function status(c: Ctx): Promise<StatusView> {
  const { gh: direct, login } = await me(c.s);
  const hub = checkHub(c.url.searchParams.get("hub"), login);
  const only = c.url.searchParams.get("repo");
  if (only !== null && (!REPO.test(only) || only.split("/")[0]!.toLowerCase() !== login.toLowerCase())) throw new TapsterError(`${only} is not one of your repositories`, "Reload the page and try again.");
  const gh = limited(direct, 8);
  const sh = shared(c.s, gh, hub, login);
  const entries = await hubEntries(gh, hub, { text: sh.hubText, pulls: sh.pulls });
  if (only === null) return statuses(sh, entries);
  const found = entries.find((e) => e.repo.toLowerCase() === only.toLowerCase());
  if (found) return statuses(sh, [found]);
  const name = only.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const project = early(gh.getRepo(only));
  const kind = await guessKind(gh, only, (await project).default_branch);
  return statuses(sh, [{ name, repo: only, kind, workflow: "release.yml", protection: "on", description: null, state: "missing", pr: null }], [begin(gh, only, project)]);
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
  const [refs, releases] = await Promise.all([tagRefs(gh, entry.repo), gh.json<{ tag_name: string }[]>("GET", `/repos/${entry.repo}/releases?per_page=100`)]).catch(() => {
    throw new TapsterError(`GitHub did not list the tags of ${entry.repo}`, "Try again in a moment. tapster releases only once it has checked the versions.");
  });
  if (head.skip) throw new TapsterError(`the latest commit on ${branch} says ${head.skip}`, skipFix(branch, (await withParentTag(gh, entry.repo, head, refs))!));
  const done = { tag: body.tag, sha: body.sha };
  const at = await tagAt(gh, entry.repo, refs, head.sha);
  if (at === body.tag) return done;
  if (at) throw new TapsterError(`${branch} has nothing new since ${at}`, `Push the changes you want to release to ${branch}, then click Release again.`);
  const problem = tagProblem(body.tag, highestTag([...refs.map((r) => r.name), ...releases.map((r) => r.tag_name)]));
  if (problem) throw new TapsterError(`${body.tag} cannot be released`, `${problem}.`);
  try {
    await gh.json("POST", `/repos/${entry.repo}/git/refs`, { ref: `refs/tags/${body.tag}`, sha: body.sha });
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422)) throw e;
    const now = await gh.json<{ object: { sha: string; type?: string } }>("GET", `/repos/${entry.repo}/git/ref/tags/${encodeURIComponent(body.tag)}`).catch(() => null);
    if (now && (await tagCommit(gh, entry.repo, { sha: now.object.sha, type: now.object.type ?? "commit" })) === body.sha) return done;
    throw new TapsterError(`${body.tag} already exists on ${entry.repo}`, "Pick the next version and click Release again.");
  }
  return done;
}

async function follow(c: Ctx): Promise<FollowView> {
  const { gh, login } = await me(c.s);
  const hub = checkHub(c.url.searchParams.get("hub"), login);
  const tag = c.url.searchParams.get("tag") ?? "";
  if (!TAG.test(tag)) throw new TapsterError(`${tag} is not a version tag`, "Reload the page and try again.");
  const entry = await hubProject(gh, hub, c.url.searchParams.get("repo") ?? "");
  const [runs, releases, stateText, hubRuns] = await Promise.all([
    gh.json<{ workflow_runs: { status: string; conclusion: string | null; html_url: string }[] }>("GET", `/repos/${entry.repo}/actions/runs?event=push&branch=${encodeURIComponent(tag)}&per_page=5`).catch(() => ({ workflow_runs: [] })),
    gh.json<Release[]>("GET", `/repos/${entry.repo}/releases?per_page=30`).catch(() => []),
    readHubFile(gh, hub, ".tapster/state.json", "main").catch(() => null),
    hubRunList(gh, hub),
  ]);
  const state = stateOf(stateText);
  const run = runs.workflow_runs[0];
  const latest = hubRuns[0];
  const found = releases.find((r) => r.tag_name === tag);
  const byHub = (state.packages[entry.name] ?? []).some((p) => p.tag === tag && p.status === "published");
  return {
    run: run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null,
    draft: found?.draft ? { url: found.html_url, note: noteIn(found.body) } : null,
    published: found && !found.draft ? { url: found.html_url, byHub } : null,
    hub: `https://github.com/${hub}/actions/workflows/tapster.yml`,
    hubRun: latest ? { status: latest.status, conclusion: latest.conclusion, url: latest.html_url } : null,
  };
}

async function publish(c: Ctx): Promise<{ started: boolean; run: string | null; doorbell: boolean }> {
  const body = await readJson(c.req, z.object({ hub: z.string(), repo: z.string().regex(REPO) }).strict());
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const entry = await hubProject(gh, hub, body.repo);
  const bell = await gh.json("GET", `/repos/${entry.repo}/actions/variables/TAPSTER_DOORBELL`).then(
    () => true,
    (e) => (e instanceof GitHubError && e.status === 404 ? false : Promise.reject(e)),
  );
  if (bell) return { started: false, run: null, doorbell: true };
  return { ...(await startHubRun(c.s, gh, hub)), doorbell: false };
}

export const statusRoutes: Routes = {
  ...reachRoutes,
  "GET /api/projects/status": status,
  "POST /api/projects/release": release,
  "GET /api/projects/follow": follow,
  "POST /api/projects/publish": publish,
};
