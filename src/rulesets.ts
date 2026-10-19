import { GitHubError } from "./errors";
import type { GitHub } from "./github";

const ADMIN_ONLY = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];

export const TAG_RULESET = {
  name: "tapster tags",
  target: "tag",
  enforcement: "active",
  bypass_actors: ADMIN_ONLY,
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] as string[] } },
  rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
};

export const BRANCH_RULESET = {
  name: "tapster default branch",
  target: "branch",
  enforcement: "active",
  bypass_actors: ADMIN_ONLY,
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] as string[] } },
  rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
};

type Ruleset = {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { type: string }[];
  bypass_actors?: { actor_id: number | null; actor_type: string }[];
  current_user_can_bypass?: string;
};

export type Viewer = "app" | "admin";

function bypassable(r: Ruleset, viewer: Viewer): boolean {
  if (viewer === "app") return r.current_user_can_bypass !== "never";
  return (r.bypass_actors ?? []).some((a) => !(a.actor_type === "RepositoryRole" && a.actor_id === 5));
}

async function kind(gh: GitHub, repo: string, target: "tag" | "branch", refs: string[], wanted: string[], viewer: Viewer): Promise<{ problems: string[]; ok: boolean }> {
  const list = await gh.json<Ruleset[]>("GET", `/repos/${repo}/rulesets?targets=${target}`);
  const active = await Promise.all(list.filter((r) => r.target === target && r.enforcement === "active").map((r) => gh.json<Ruleset>("GET", `/repos/${repo}/rulesets/${r.id}`)));
  if (active.length === 0) return { problems: [`no active ${target} ruleset protects ${refs[0]}`], ok: false };
  const covering = active.filter((r) => (r.conditions?.ref_name?.include ?? []).some((i) => refs.includes(i)) && (r.conditions?.ref_name?.exclude ?? []).length === 0);
  if (covering.length === 0) return { problems: [`no active ${target} ruleset covers ${refs[0]} without exclusions`], ok: false };
  const problems = covering.filter((r) => bypassable(r, viewer)).map((r) => `the App or another actor can bypass ${r.name}`);
  const held = new Set(covering.filter((r) => !bypassable(r, viewer)).flatMap((r) => (r.rules ?? []).map((x) => x.type)));
  const missing = wanted.filter((w) => !held.has(w));
  if (missing.length) problems.push(`the ${target} rulesets do not restrict ${missing.join(", ")}`);
  return { problems, ok: problems.length === 0 };
}

async function assess(gh: GitHub, repo: string, branch: string, viewer: Viewer): Promise<{ tag: string[]; branch: string[] }> {
  const tag = await kind(gh, repo, "tag", ["refs/tags/v*", "~ALL"], TAG_RULESET.rules.map((r) => r.type), viewer);
  const head = await kind(gh, repo, "branch", ["~DEFAULT_BRANCH", "~ALL", `refs/heads/${branch}`], BRANCH_RULESET.rules.map((r) => r.type), viewer);
  if (head.ok) {
    const live = new Set((await gh.json<{ type: string }[]>("GET", `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`)).map((r) => r.type));
    if (!BRANCH_RULESET.rules.every((r) => live.has(r.type))) head.problems.push("GitHub does not enforce rulesets on this repository; private repositories need a paid plan for them");
  }
  return { tag: tag.problems, branch: head.problems };
}

export async function protectionProblems(gh: GitHub, repo: string, branch: string, viewer: Viewer): Promise<string[]> {
  const found = await assess(gh, repo, branch, viewer);
  return [...found.tag, ...found.branch];
}

export async function createProtection(gh: GitHub, repo: string, branch: string): Promise<"created" | "exists" | "unavailable"> {
  const before = await assess(gh, repo, branch, "admin");
  if (before.tag.length + before.branch.length === 0) return "exists";
  const existing = await gh.json<Ruleset[]>("GET", `/repos/${repo}/rulesets`);
  try {
    for (const [body, problems] of [[TAG_RULESET, before.tag], [BRANCH_RULESET, before.branch]] as const) {
      if (problems.length === 0) continue;
      const same = existing.find((r) => r.name === body.name);
      if (same) await gh.json("PUT", `/repos/${repo}/rulesets/${same.id}`, body);
      else await gh.json("POST", `/repos/${repo}/rulesets`, body);
    }
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 422)) return "unavailable";
    throw e;
  }
  return (await protectionProblems(gh, repo, branch, "admin")).length === 0 ? "created" : "unavailable";
}
