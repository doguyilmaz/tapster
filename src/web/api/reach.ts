import { z } from "zod";
import { TapsterError } from "../../errors";
import type { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { type State, emptyState, parseState } from "../../state";
import { installationRepos } from "../../token";
import { entriesIn, hubEntries } from "../../cli/hubpr";
import type { ReachView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { checkHub, hubRunList, me, startHubRun } from "./hub";

export type HubCheck = { conclusion: string | null; created: string; at: string | null; url: string; listed: string[]; failures: string[] };
export type HubChecks = { done: HubCheck | null; running: string | null; direct: Set<string> | null };

const NOT_INSTALLED = /App is not installed on /;

export function reachFromCheck(name: string, repo: string, check: HubCheck | null, published: boolean): Pick<ReachView, "reaches" | "how" | "reason"> {
  let reason = check ? `the hub's last check stopped before it reached ${name}` : "the hub has not checked it yet";
  if (check && !check.listed.includes(repo.toLowerCase())) reason = `${name} was not in tapster.yml at the hub's last check`;
  else if (check) {
    const mine = check.failures.filter((m) => m.startsWith(`${name}: `)).map((m) => m.slice(name.length + 2));
    const missing = mine.find((m) => NOT_INSTALLED.test(m)) ?? check.failures.find((m) => /^tapster: the App is not installed on any/.test(m))?.slice("tapster: ".length);
    if (missing) return { reaches: false, how: "run", reason: missing };
    const hub = check.failures.find((m) => /^(tapster|hub): /.test(m));
    const others = !hub && check.failures.length < 10 && check.failures.some((m) => /^[a-z0-9][a-z0-9-]*: /.test(m));
    if (check.conclusion === "success" || mine.length || others) return { reaches: true, how: "run", reason: null };
    if (hub) reason = hub.replace(/^(tapster|hub): /, "");
  }
  return published ? { reaches: true, how: "release", reason: null } : { reaches: null, how: null, reason };
}

type Job = { id: number; name: string; conclusion: string | null; completed_at: string | null; html_url: string };

export async function hubChecks(s: Session, gh: GitHub, hub: string): Promise<HubChecks> {
  const held = s.apps.get(hub);
  const direct = held ? await installationRepos(held.id, held.pem, hub.split("/")[0]!, s.deps.fetch).then((r) => new Set((r ?? []).map((x) => x.toLowerCase())), () => null) : null;
  const runs = await hubRunList(gh, hub);
  const running = runs.find((r) => r.status !== "completed")?.html_url ?? null;
  const last = runs.find((r) => r.status === "completed" && r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  if (!last) return { done: null, running, direct };
  const jobs = await gh.json<{ jobs: Job[] }>("GET", `/repos/${hub}/actions/runs/${last.id}/jobs?per_page=50`).then((r) => r.jobs, () => [] as Job[]);
  const job = jobs.find((j) => j.name === "check");
  const [notes, config, issues] = await Promise.all([
    job ? gh.json<{ annotation_level: string; message: string }[]>("GET", `/repos/${hub}/check-runs/${job.id}/annotations?per_page=100`).catch(() => []) : Promise.resolve([]),
    readHubFile(gh, hub, "tapster.yml", last.head_sha).catch(() => null),
    gh.json<{ title: string; body: string | null; updated_at: string; user: { login: string } | null }[]>("GET", `/repos/${hub}/issues?state=open&creator=${encodeURIComponent("github-actions[bot]")}&per_page=20`).catch(() => []),
  ]);
  const issue = issues.find((i) => i.title === "tapster: the hub needs attention" && i.user?.login === "github-actions[bot]" && i.updated_at >= last.created_at);
  const lines = (issue?.body ?? "").split("\n").filter((l) => /^[a-z0-9][a-z0-9-]*: /.test(l) && NOT_INSTALLED.test(l));
  return {
    done: {
      conclusion: job?.conclusion ?? null,
      created: last.created_at,
      at: job?.completed_at ?? last.updated_at ?? null,
      url: job?.html_url ?? last.html_url,
      listed: entriesIn(config, hub.split("/")[0]!).map((e) => e.repo.toLowerCase()),
      failures: [...notes.filter((n) => n.annotation_level === "failure").map((n) => n.message), ...lines],
    },
    running,
    direct,
  };
}

export function reachOf(c: HubChecks, name: string, repo: string, state: State): ReachView {
  const running = c.running !== null;
  if (c.direct) return { reaches: c.direct.has(repo.toLowerCase()), how: "key", at: new Date().toISOString(), since: new Date().toISOString(), reason: null, run: c.running, running };
  const published = (state.packages[name] ?? []).some((p) => p.status === "published");
  const v = reachFromCheck(name, repo, c.done, published);
  return { ...v, at: v.how === "run" ? (c.done?.at ?? null) : null, since: c.done?.created ?? null, run: c.running ?? c.done?.url ?? null, running };
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

async function reach(c: Ctx): Promise<ReachView> {
  const { gh, login } = await me(c.s);
  const hub = checkHub(c.url.searchParams.get("hub"), login);
  const repo = c.url.searchParams.get("repo") ?? "";
  if (!REPO.test(repo)) throw new TapsterError(`${repo} is not a repository name`, "Reload the page and try again.");
  if (!c.s.apps.has(hub)) {
    const live = (await hubRunList(gh, hub)).find((r) => r.status !== "completed");
    if (live) return { reaches: null, how: null, at: null, since: null, reason: null, run: live.html_url, running: true };
  }
  const entry = (await hubEntries(gh, hub)).find((e) => e.repo.toLowerCase() === repo.toLowerCase());
  if (!entry) throw new TapsterError(`${repo} is not in ${hub}`, "Add the project to the hub first.");
  const state = stateOf(await readHubFile(gh, hub, ".tapster/state.json", "main").catch(() => null));
  return reachOf(await hubChecks(c.s, gh, hub), entry.name, entry.repo, state);
}

export function stateOf(text: string | null): State {
  try {
    return parseState(text);
  } catch {
    return emptyState();
  }
}

async function check(c: Ctx) {
  const body = await readJson(c.req, z.object({ hub: z.string() }).strict());
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  return { ...(await startHubRun(c.s, gh, hub)), at: new Date().toISOString() };
}

export const reachRoutes: Routes = {
  "GET /api/projects/reach": reach,
  "POST /api/projects/check": check,
};
