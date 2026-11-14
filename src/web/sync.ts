import { existsSync } from "node:fs";
import { join } from "node:path";
import { TapsterError } from "../errors";
import type { RunResult } from "../run";
import type { SyncView } from "./contract";

export type Git = (args: string[], timeoutMs?: number) => Promise<RunResult>;

const UNFINISHED: [file: string, what: string, abort: string][] = [
  ["MERGE_HEAD", "A merge", "git merge --abort"],
  ["rebase-merge", "A rebase", "git rebase --abort"],
  ["rebase-apply", "A rebase", "git rebase --abort"],
  ["CHERRY_PICK_HEAD", "A cherry-pick", "git cherry-pick --abort"],
  ["REVERT_HEAD", "A revert", "git revert --abort"],
];

const lastLine = (r: RunResult) => r.stderr.trim().split("\n").at(-1)?.replace(/^(error|fatal): /, "") ?? "";
const count = async (git: Git, range: string) => Number((await git(["rev-list", "--count", range])).stdout.trim()) || 0;
const known = async (git: Git, ref: string) => (await git(["rev-parse", "--verify", "--quiet", ref])).code === 0;

export const safeBranch = (name: string) => /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.includes("..");

export function changedFiles(porcelain: string): string[] {
  const parts = porcelain.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

function blocked(stderr: string): string[] {
  const m = /would be overwritten by (?:checkout|merge):\n((?:\t.+\n?)+)/.exec(stderr);
  return m ? m[1]!.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

function stuck(res: RunResult, target: string, doing: string, after: string): TapsterError {
  const other = /already (?:checked out|used by worktree) at '([^']+)'/.exec(res.stderr)?.[1];
  if (other) return new TapsterError(`${target} is already open in another folder: ${other}`, `Use that folder for this project instead.${after}`);
  const files = blocked(res.stderr);
  if (files.length) return new TapsterError(`some files here are not in git and ${target} has files with the same names`, `Move these files out of the folder, then try again: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}.${after}`);
  return new TapsterError(`git could not ${doing}`, `${lastLine(res)}${after}`);
}

// Moves the clone to the default branch and fast-forwards it. Nothing here may lose work: changes only leave the
// working tree through git stash and only when the caller passes stash after asking the user.
export async function syncClone(git: Git, dir: string, target: string, stash: boolean): Promise<SyncView> {
  if (!safeBranch(target)) throw new TapsterError(`the default branch ${target} has a name tapster does not handle`, `Switch in a terminal: git switch ${target}`);
  for (const [file, what, abort] of UNFINISHED) {
    if (existsSync(join(dir, ".git", file))) throw new TapsterError(`${what} is not finished in this clone`, `Finish it or cancel it with ${abort}. Then try again. tapster changed nothing.`);
  }
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const from = head.code === 0 ? head.stdout.trim() : null;
  if (from === null && !(await git(["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes"])).stdout.trim()) {
    throw new TapsterError("this clone is on a commit that no branch holds", "Switching away would hide that commit. Give it a branch first, for example: git switch -c my-work. Then try again.");
  }
  const moving = from !== target;
  const files = moving ? changedFiles((await git(["status", "--porcelain=v1", "-z", "--untracked-files=no"])).stdout) : [];
  if (files.length && !stash) return { state: "changes", files };

  const fetched = (await git(["fetch", "--no-tags", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], 90_000)).code === 0;
  const remote = `refs/remotes/origin/${target}`;
  const hasRemote = await known(git, remote);
  const hasLocal = await known(git, `refs/heads/${target}`);
  if (!hasLocal && !hasRemote) throw new TapsterError(`this clone has no copy of ${target} and GitHub did not answer`, "Check the internet connection and that git reaches GitHub without asking for a password, then try again. tapster changed nothing.");

  const stashed = files.length > 0;
  if (stashed) {
    const saved = await git(["stash", "push", "-m", `tapster: put aside before switching from ${from ?? "a detached HEAD"} to ${target}`]);
    if (saved.code !== 0) throw new TapsterError("git could not put your changes aside", `${lastLine(saved)} tapster changed nothing. Commit or stash them in a terminal, then try again.`);
  }
  const keep = (where: string) => ` Your changes are safe in git stash. To bring them back, run git stash pop on ${where}.`;
  if (moving) {
    const switched = await git(hasLocal ? ["switch", target] : ["switch", "--track", "-c", target, remote]);
    if (switched.code !== 0) {
      const back = stashed ? ((await git(["stash", "pop"])).code === 0 ? " Your changes are back where they were." : keep(from ?? "the commit you were on")) : "";
      throw stuck(switched, target, `switch to ${target}`, back);
    }
  }

  let pulled = 0;
  let diverged: { ahead: number; behind: number } | null = null;
  if (hasRemote) {
    const behind = await count(git, `HEAD..${remote}`);
    const ahead = await count(git, `${remote}..HEAD`);
    if (behind && ahead) diverged = { ahead, behind };
    else if (behind) {
      const merged = await git(["merge", "--ff-only", "--no-edit", remote], 60_000);
      if (merged.code !== 0) throw stuck(merged, target, `bring in GitHub's new commits on ${target}`, `${moving ? ` The clone is on ${target} now.` : ""}${stashed ? keep(from ?? "the branch you want them on") : ""}`);
      pulled = behind;
    }
  }
  return { state: "synced", branch: target, from, stashed, fetched, pulled, diverged };
}
