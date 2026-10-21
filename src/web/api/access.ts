import { GitHubError, TapsterError } from "../../errors";
import { foreignWritesAt } from "../../foreign";
import type { GitHub } from "../../github";
import { type FileChange, readHubFile } from "../../hubcommit";
import type { Ctx, Session } from "../server";

export const HUB = /^[A-Za-z0-9-]+\/homebrew-[A-Za-z0-9._-]+$/;

export async function me(s: Session): Promise<{ gh: GitHub; login: string }> {
  const gh = await s.deps.github();
  s.login ??= (await gh.json<{ login: string }>("GET", "/user")).login;
  return { gh, login: s.login };
}

export function checkHub(name: unknown, owner: string): string {
  if (typeof name !== "string" || !HUB.test(name)) throw new TapsterError("that is not a hub name", "A hub is one of your repositories whose name starts with homebrew-, such as you/homebrew-tap.");
  if (name.split("/")[0]!.toLowerCase() !== owner.toLowerCase()) throw new TapsterError(`${name} does not belong to ${owner}`, "tapster serves repositories of your own account.");
  return name;
}

export async function hubFrom(c: Ctx, value: unknown): Promise<{ gh: GitHub; hub: string; login: string }> {
  const { gh, login } = await me(c.s);
  return { gh, hub: checkHub(value, login), login };
}

export const or404 = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
};

export async function lockedEnvironment(gh: GitHub, hub: string): Promise<void> {
  const env = await or404(gh.json<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("GET", `/repos/${hub}/environments/tapster`));
  const policies = env ? await gh.json<{ branch_policies: { name: string; type?: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`) : { branch_policies: [] };
  const locked = Boolean(env?.deployment_branch_policy?.custom_branch_policies) && policies.branch_policies.length === 1 && policies.branch_policies[0]!.name === "main" && (policies.branch_policies[0]!.type ?? "branch") === "branch";
  if (!locked) throw new TapsterError(`${hub}'s tapster environment is not locked to main`, "Protect the hub first: keys go into that environment only once workflows on other branches cannot open it.");
}

const FOREIGN = "Review those commits on GitHub and revert what you did not make. tapster writes nothing to main until then, because a write from you would mark them as reviewed.";

const mainSha = (gh: GitHub, hub: string) => gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`).then((r) => r.object.sha);

export async function checkedMain(gh: GitHub, hub: string, owner: string, strict = false): Promise<string> {
  const seen = strict
    ? await foreignWritesAt(gh, hub, owner)
    : await foreignWritesAt(gh, hub, owner).catch((e) => {
        if (e instanceof GitHubError && e.status === 404) return { head: null, writes: [] };
        throw e;
      });
  const real = strict ? seen.writes : seen.writes.filter((w) => !w.startsWith("GitHub shows no push by"));
  if (real.length) throw new TapsterError(`main changed in ways only you may change it: ${real.join("; ")}`, FOREIGN);
  return seen.head ?? (await mainSha(gh, hub));
}

async function movedOn(gh: GitHub, hub: string, from: string): Promise<string[]> {
  const now = await mainSha(gh, hub);
  if (now === from) return [];
  const cmp = await gh.json<{ commits?: { sha: string; commit: { message: string } }[] }>("GET", `/repos/${hub}/compare/${from}...${now}`).catch(() => ({ commits: [] }));
  const list = (cmp.commits ?? []).slice(0, 10).map((x) => `${x.sha.slice(0, 7)} ${(x.commit.message.split("\n")[0] ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 80)}`);
  return list.length ? list : [now.slice(0, 7)];
}

export type MainWrite = { message: string; files: FileChange[]; parents?: string[]; ready?: () => Promise<void> };

// Each attempt builds its commit on the exact main the foreign-write check passed. GitHub moves main with force: false
// only when that commit descends from main's current head, so a push that lands after the check makes the move fail and
// the next attempt checks main again from scratch. A main rewound to an ancestor of the checked commit would still move;
// the hub's ruleset forbids non-fast-forward pushes to main for everyone, so that cannot happen on a protected hub.
export async function writeMain(
  gh: GitHub,
  hub: string,
  owner: string,
  plan: (head: string, read: (path: string) => Promise<string | null>) => Promise<MainWrite | null>,
  o: { strict?: boolean; moved?: (commits: string[]) => TapsterError } = {},
): Promise<"committed" | "unchanged"> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await checkedMain(gh, hub, owner, o.strict);
    const w = await plan(head, (path) => readHubFile(gh, hub, path, head));
    if (!w || w.files.length === 0) return "unchanged";
    const base = await gh.json<{ tree: { sha: string } }>("GET", `/repos/${hub}/git/commits/${head}`);
    const tree = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/trees`, {
      base_tree: base.tree.sha,
      tree: w.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", ...(f.content === null ? { sha: null } : { content: f.content }) })),
    });
    const commit = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/commits`, { message: w.message, tree: tree.sha, parents: [head, ...(w.parents ?? [])] });
    await w.ready?.();
    try {
      await gh.json("PATCH", `/repos/${hub}/git/refs/heads/main`, { sha: commit.sha, force: false });
      return "committed";
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      const moved = await movedOn(gh, hub, head);
      if (!moved.length) throw new TapsterError("GitHub refused to move main", "Nothing was written. Try again.");
      if (o.moved) throw o.moved(moved);
    }
  }
  throw new TapsterError("the hub's main branch kept moving", "Nothing was written. Try again in a minute.");
}
