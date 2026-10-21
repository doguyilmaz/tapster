import { GitHubError, TapsterError } from "../../errors";
import { foreignWrites } from "../../foreign";
import type { GitHub } from "../../github";
import type { Ctx, Session } from "../server";

const HUB = /^[A-Za-z0-9-]+\/homebrew-[A-Za-z0-9._-]+$/;

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

export async function guardMain(gh: GitHub, hub: string, owner: string): Promise<void> {
  const writes = await foreignWrites(gh, hub, owner).catch((e) => {
    if (e instanceof GitHubError && e.status === 404) return [];
    throw e;
  });
  const real = writes.filter((w) => !w.startsWith("GitHub shows no push by"));
  if (real.length) {
    throw new TapsterError(
      `main changed in ways only you may change it: ${real.join("; ")}`,
      "Review those commits on GitHub and revert what you did not make. tapster writes nothing to main until then, because a write from you would mark them as reviewed.",
    );
  }
}
