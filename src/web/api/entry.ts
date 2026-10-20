import { z } from "zod";
import { NAME, parseHub } from "../../config";
import { GitHubError, TapsterError } from "../../errors";
import type { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { addedEntry } from "../../cli/hubpr";
import { type Ctx, type Routes, readJson } from "../server";
import { checkHub, guardMain, me } from "./hub";

export type Proposal = { number: number; head: string; entry: string; repo: string };

const REVIEW = "Review it on GitHub and merge it there. Or close it, delete its branch and add the project again.";
const STALE = "Click Refresh and check the entry again.";

type Pull = { number: number; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string } };

export async function proposal(gh: GitHub, hub: string, name: string): Promise<Proposal> {
  const owner = hub.split("/")[0]!;
  const branch = `tapster-add-${name}`;
  const pulls = await gh.json<Pull[]>("GET", `/repos/${hub}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
  const pr = pulls.find((p) => p.head.ref === branch && p.head.repo?.full_name.toLowerCase() === hub.toLowerCase());
  if (!pr) throw new TapsterError(`${hub} has no open pull request from ${branch}`, "Add the project again to propose its entry.");
  if (pr.base.ref !== "main") throw new TapsterError(`the pull request merges into ${pr.base.ref}, not main`, REVIEW);
  const files = await gh.json<{ filename: string; status: string }[]>("GET", `/repos/${hub}/pulls/${pr.number}/files?per_page=100`);
  if (files.length !== 1 || files[0]!.filename !== "tapster.yml" || files[0]!.status !== "modified") throw new TapsterError("the pull request changes more than tapster.yml", REVIEW);
  const [after, before] = await Promise.all([readHubFile(gh, hub, "tapster.yml", pr.head.sha), readHubFile(gh, hub, "tapster.yml", "main")]);
  const entry = after !== null && before !== null ? addedEntry(before, after, name) : null;
  if (entry === null) throw new TapsterError("the pull request does more than add the entry to main's tapster.yml", `main may have changed since tapster proposed it. ${REVIEW}`);
  const { config, invalid } = parseHub(after!, owner);
  const bad = invalid.find((i) => i.name === name);
  if (bad) throw new TapsterError(`the hub would refuse this entry: ${bad.reason}`, bad.fix);
  const pkg = config.packages.find((p) => p.name === name);
  if (!pkg) throw new TapsterError(`the pull request has no entry named ${name}`, REVIEW);
  return { number: pr.number, head: pr.head.sha, entry, repo: pkg.repo };
}

const mergeBody = z
  .object({ hub: z.string(), name: z.string().regex(NAME).max(100), repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/), entry: z.string().max(20_000), sha: z.string().regex(/^[0-9a-f]{40,64}$/) })
  .strict();

async function merge(c: Ctx): Promise<{ merged: true; deleted: boolean }> {
  const body = await readJson(c.req, mergeBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const p = await proposal(gh, hub, body.name);
  if (p.head !== body.sha) throw new TapsterError("the pull request changed since this page read it", STALE);
  if (p.entry !== body.entry) throw new TapsterError("the pull request does not add the entry this page showed", STALE);
  if (p.repo.toLowerCase() !== body.repo.toLowerCase()) throw new TapsterError(`the entry publishes ${p.repo}, not ${body.repo}`, REVIEW);
  await guardMain(gh, hub, login);
  const settings = await gh.json<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean }>("GET", `/repos/${hub}`);
  const method = settings.allow_merge_commit !== false ? "merge" : settings.allow_squash_merge !== false ? "squash" : "rebase";
  try {
    await gh.json("PUT", `/repos/${hub}/pulls/${p.number}/merge`, { sha: p.head, merge_method: method });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) throw new TapsterError("the pull request changed since this page read it", STALE);
    if (e instanceof GitHubError && e.status === 405) throw new TapsterError("GitHub cannot merge the hub entry", `It may conflict with main, for example after another entry was merged. ${REVIEW}`);
    throw e;
  }
  const deleted = await gh.json("DELETE", `/repos/${hub}/git/refs/heads/tapster-add-${body.name}`).then(
    () => true,
    (e) => (e instanceof GitHubError ? false : Promise.reject(e)),
  );
  return { merged: true, deleted };
}

export const entryRoutes: Routes = {
  "POST /api/projects/merge": merge,
};
