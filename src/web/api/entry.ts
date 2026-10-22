import { parse } from "yaml";
import { z } from "zod";
import { NAME, parseHub } from "../../config";
import { GitHubError, TapsterError } from "../../errors";
import type { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { changedEntry, entryText, withEntryText } from "../../hubentry";
import { addedEntry, proposeUpdate } from "../../cli/hubpr";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { writeMain } from "./access";
import { checkHub, me } from "./hub";

export type Proposal = { number: number; head: string; entry: string; repo: string; text: string; url: string; main: string };
export type PullKind = "add" | "update";

export const pullBranch = (kind: PullKind, name: string) => `tapster-${kind}-${name}`;

const REVIEW = "Review it on GitHub and merge it there. Or close it, delete its branch and add the project again.";
const STALE = "Click Refresh and check the entry again.";
const WORDS: Record<PullKind, { none: string; more: string; differs: string; message: string; again: string }> = {
  add: {
    none: "Add the project again to propose its entry.",
    more: "the pull request does more than add the entry to main's tapster.yml",
    differs: "the pull request does not add the entry this page showed",
    message: "Add",
    again: "Merge the hub entry",
  },
  update: {
    none: "Propose the update again.",
    more: "the pull request does more than change this entry in main's tapster.yml",
    differs: "the pull request does not make the change this page showed",
    message: "Update",
    again: "Merge the update",
  },
};

export type Pull = { number: number; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string } };

// open: the hub's open pull requests when the caller has listed them already. A full page may leave the one wanted out.
export async function openPull(gh: GitHub, hub: string, kind: PullKind, name: string, open?: Promise<Pull[]>): Promise<Pull | null> {
  const branch = pullBranch(kind, name);
  const listed = open ? await open : null;
  const pulls = listed && listed.length < 100 ? listed : await gh.json<Pull[]>("GET", `/repos/${hub}/pulls?state=open&head=${encodeURIComponent(`${hub.split("/")[0]}:${branch}`)}&per_page=10`);
  return pulls.find((p) => p.head.ref === branch && p.head.repo?.full_name.toLowerCase() === hub.toLowerCase()) ?? null;
}

export async function proposal(gh: GitHub, hub: string, name: string, main = "main", kind: PullKind = "add", open?: Promise<Pull[]>): Promise<Proposal> {
  const owner = hub.split("/")[0]!;
  const pr = await openPull(gh, hub, kind, name, open);
  if (!pr) throw new TapsterError(`${hub} has no open pull request from ${pullBranch(kind, name)}`, WORDS[kind].none);
  if (pr.base.ref !== "main") throw new TapsterError(`the pull request merges into ${pr.base.ref}, not main`, REVIEW);
  const files = await gh.json<{ filename: string; status: string }[]>("GET", `/repos/${hub}/pulls/${pr.number}/files?per_page=100`);
  if (files.length !== 1 || files[0]!.filename !== "tapster.yml" || files[0]!.status !== "modified") throw new TapsterError("the pull request does more than edit tapster.yml", REVIEW);
  const [text, before] = await Promise.all([readHubFile(gh, hub, "tapster.yml", pr.head.sha), readHubFile(gh, hub, "tapster.yml", main)]);
  const entry = text === null || before === null ? null : kind === "add" ? addedEntry(before, text, name) : changedEntry(before, text, name, owner);
  if (entry === null) throw new TapsterError(WORDS[kind].more, `main may have changed since tapster proposed it. ${REVIEW}`);
  const { config, invalid } = parseHub(text!, owner);
  const bad = invalid.find((i) => i.name === name);
  if (bad) throw new TapsterError(`the hub would refuse this entry: ${bad.reason}`, bad.fix);
  const pkg = config.packages.find((p) => p.name === name);
  if (!pkg) throw new TapsterError(`the pull request has no entry named ${name}`, REVIEW);
  return { number: pr.number, head: pr.head.sha, entry, repo: pkg.repo, text: text!, url: pr.html_url, main: before! };
}

const entryBody = { hub: z.string(), name: z.string().regex(NAME).max(100), repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/), entry: z.string().max(20_000) };
const mergeBody = z.object({ ...entryBody, before: z.string().max(20_000).optional(), sha: z.string().regex(/^[0-9a-f]{40,64}$/) }).strict();

const ref = (gh: GitHub, hub: string, branch: string) => gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/${branch}`).then((r) => r.object.sha);

// The person's own merge, built by writeMain on the exact main the foreign-write check passed: the pull request must
// still be the one the page showed and main moves only by fast-forward.
async function land(c: Ctx, kind: PullKind): Promise<{ merged: true; deleted: boolean }> {
  const body = await readJson(c.req, mergeBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const branch = pullBranch(kind, body.name);
  let number = 0;
  await writeMain(
    gh,
    hub,
    login,
    async (checked) => {
      const p = await proposal(gh, hub, body.name, checked, kind);
      if (p.head !== body.sha) throw new TapsterError("the pull request changed since this page read it", STALE);
      if (p.entry !== body.entry) throw new TapsterError(WORDS[kind].differs, STALE);
      if (kind === "update" && entryText(p.main, body.name) !== body.before) throw new TapsterError(`the entry of ${body.name} on main changed since this page read it`, STALE);
      if (p.repo.toLowerCase() !== body.repo.toLowerCase()) throw new TapsterError(`the entry publishes ${p.repo}, not ${body.repo}`, REVIEW);
      const settings = await gh.json<{ allow_merge_commit?: boolean }>("GET", `/repos/${hub}`);
      number = p.number;
      return {
        message: `${WORDS[kind].message} ${body.name} (#${p.number})`,
        files: [{ path: "tapster.yml", content: p.text }],
        parents: settings.allow_merge_commit === false ? [] : [p.head],
        ready: async () => {
          if ((await ref(gh, hub, branch).catch(() => null)) !== p.head) throw new TapsterError("the pull request changed since this page read it", STALE);
        },
      };
    },
    { strict: true, moved: (commits) => new TapsterError(`main changed while tapster merged the entry: ${commits.join("; ")}`, `Nothing was merged. Review those commits on GitHub, then click ${WORDS[kind].again} again.`) },
  );
  c.s.memo.delete(`hub-text:${hub}`);
  const soft = (call: Promise<unknown>) => call.then(() => true, (e) => (e instanceof GitHubError ? false : Promise.reject(e)));
  await soft(gh.json("PATCH", `/repos/${hub}/pulls/${number}`, { state: "closed" }));
  return { merged: true, deleted: await soft(gh.json("DELETE", `/repos/${hub}/git/refs/heads/${branch}`)) };
}

async function mainText(s: Session, gh: GitHub, hub: string): Promise<string> {
  const key = `hub-text:${hub}`;
  const known = s.memo.get(key) as { text: string; at: number } | undefined;
  if (known && Date.now() - known.at < 15_000) return known.text;
  const text = await readHubFile(gh, hub, "tapster.yml", "main");
  if (text === null) throw new TapsterError(`${hub} has no tapster.yml on main`, "Write the hub files in Setup first.");
  s.memo.set(key, { text, at: Date.now() });
  return text;
}

const editBody = z.object(entryBody).strict();
const proposeBody = z.object({ ...entryBody, before: z.string().max(20_000) }).strict();

function listedAs(text: string, name: string, repo: string): string {
  const before = entryText(text, name);
  if (before === null) throw new TapsterError(`tapster cannot read the entry of ${name} on its own in tapster.yml`, "Edit tapster.yml on GitHub instead.");
  const listed = String(((parse(before) as { repo?: unknown }[])[0] ?? {}).repo);
  if (listed.toLowerCase() !== repo.toLowerCase()) throw new TapsterError(`${name} publishes ${listed}, not ${repo}`, "Reload the page and try again.");
  return before;
}

// Checks an edited entry as the full tapster.yml with only that entry replaced; the page asks on every keystroke.
async function check(c: Ctx): Promise<{ before: string; problem: { reason: string; fix: string } | null; same: boolean }> {
  const body = await readJson(c.req, editBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  const text = await mainText(c.s, gh, hub);
  const before = listedAs(text, body.name, body.repo);
  try {
    return { before, problem: null, same: withEntryText(text, body.name, body.entry, hub.split("/")[0]!) === text };
  } catch (e) {
    if (!(e instanceof TapsterError)) throw e;
    return { before, problem: { reason: e.reason, fix: e.fix }, same: false };
  }
}

async function propose(c: Ctx): Promise<{ pr: string; head: string; entry: string }> {
  const body = await readJson(c.req, proposeBody);
  const { gh, login } = await me(c.s);
  const hub = checkHub(body.hub, login);
  c.s.memo.delete(`hub-text:${hub}`);
  listedAs(await mainText(c.s, gh, hub), body.name, body.repo);
  const done = await proposeUpdate(gh, hub, body.name, body.entry, body.before);
  return { pr: done.url, head: done.head, entry: done.entry };
}

export const entryRoutes: Routes = {
  "POST /api/projects/merge": (c) => land(c, "add"),
  "POST /api/projects/entry/merge": (c) => land(c, "update"),
  "POST /api/projects/entry/check": check,
  "POST /api/projects/entry/propose": propose,
};
