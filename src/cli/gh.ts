import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { ghPath, run, runPath } from "../run";

const userEnv = (): Record<string, string> => ({
  HOME: process.env.HOME ?? "/tmp",
  ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
  GH_PROMPT_DISABLED: "1",
});

export async function userGitHub(): Promise<GitHub> {
  const token = (await runPath(ghPath(), "gh", ["auth", "token"], { env: userEnv() })).stdout.trim();
  if (!token) throw new TapsterError("gh is not signed in", "Run gh auth login, then try again.");
  return new GitHub(token);
}

export async function currentRepo(dir = process.cwd()): Promise<string> {
  const url = (await run("git", ["-C", dir, "remote", "get-url", "origin"])).stdout.trim();
  const m = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new TapsterError("this folder is not a clone of a GitHub repository", "Run tapster inside a clone (git remote origin on github.com).");
  return m[1]!;
}

export async function setEnvSecret(repo: string, name: string, value: string): Promise<void> {
  await runPath(ghPath(), "gh", ["secret", "set", name, "--env", "tapster", "--repo", repo], { env: userEnv(), stdin: value });
}

export async function setEnvVariable(repo: string, name: string, value: string): Promise<void> {
  await runPath(ghPath(), "gh", ["variable", "set", name, "--env", "tapster", "--repo", repo, "--body", value], { env: userEnv() });
}
