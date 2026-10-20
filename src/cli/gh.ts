import { GitHubError, TapsterError } from "../errors";
import { GitHub } from "../github";
import { readGit } from "../clone";
import { ghPath, runPath } from "../run";

const userEnv = (): Record<string, string> => ({
  HOME: process.env.HOME ?? "/tmp",
  ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
  GH_PROMPT_DISABLED: "1",
});

export function cliGh(candidates?: string[]): string {
  try {
    return ghPath(candidates);
  } catch {
    throw new TapsterError("the GitHub CLI (gh) is not installed", "Install it (brew install gh or see https://cli.github.com), sign in with gh auth login, then run this again.");
  }
}

export async function userGitHub(): Promise<GitHub> {
  const res = await runPath(cliGh(), "gh", ["auth", "token"], { env: userEnv(), allowFail: true });
  const token = res.stdout.trim();
  if (res.code !== 0 || !token) throw new TapsterError("gh is not signed in", "Run gh auth login, then try again.");
  return new GitHub(token, fetch, undefined, "user");
}

export async function currentRepo(dir = process.cwd()): Promise<string> {
  const url = (await readGit(dir, ["remote", "get-url", "origin"])).stdout.trim();
  const m = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new TapsterError("this folder is not a clone of a GitHub repository", "Run tapster inside a clone (git remote origin on github.com).");
  return m[1]!;
}

export type GhWrite = (args: string[], stdin?: string) => Promise<void>;

let ghWrite: GhWrite = async (args, stdin) => {
  await runPath(cliGh(), "gh", args, { env: userEnv(), stdin });
};

export function useGhWrite(write: GhWrite): void {
  ghWrite = write;
}

export const setEnvSecret = (repo: string, name: string, value: string, env = "tapster") => ghWrite(["secret", "set", name, "--env", env, "--repo", repo], value);
export const setEnvVariable = (repo: string, name: string, value: string) => ghWrite(["variable", "set", name, "--env", "tapster", "--repo", repo, "--body", value]);
export const setRepoVariable = (repo: string, name: string, value: string) => ghWrite(["variable", "set", name, "--repo", repo, "--body", value]);
export const deleteEnvSecret = (repo: string, name: string, env = "tapster") => ghWrite(["secret", "delete", name, "--env", env, "--repo", repo]);

export async function hubEnv(gh: GitHub, hub: string, kind: "variables" | "secrets"): Promise<{ name: string; value?: string }[]> {
  try {
    const res = await gh.json<Record<string, { name: string; value?: string }[]>>("GET", `/repos/${hub}/environments/tapster/${kind}?per_page=100`);
    return res[kind] ?? [];
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) throw new TapsterError(`${hub} has no tapster environment yet`, "Run tapster init in a clone of the hub first.");
    throw e;
  }
}
