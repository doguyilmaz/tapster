import { expect, test } from "bun:test";
import { GitHubError } from "../src/errors";
import type { GitHub } from "../src/github";
import { BRANCH_RULESET, TAG_RULESET, createProtection, protectionProblems } from "../src/rulesets";

type Set = Record<string, unknown> & { id: number; target: string };
const admin = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
const tags = (over: Record<string, unknown> = {}): Set => ({ id: 1, ...TAG_RULESET, current_user_can_bypass: "never", ...over });
const branch = (over: Record<string, unknown> = {}): Set => ({ id: 2, ...BRANCH_RULESET, current_user_can_bypass: "never", ...over });
const enforced = [{ type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }];

function fake(sets: Set[], branchRules: { type: string }[] = enforced, onWrite?: (m: string, p: string, b: unknown) => void) {
  const writes: [string, string, unknown][] = [];
  const gh = {
    json: async (method: string, path: string, body?: unknown) => {
      if (method !== "GET") {
        writes.push([method, path, body]);
        onWrite?.(method, path, body);
        return {};
      }
      const list = /\/rulesets\?targets=(tag|branch)$/.exec(path);
      if (list) return sets.filter((s) => s.target === list[1]).map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement }));
      if (path.endsWith("/rulesets")) return sets.map(({ id, name, target }) => ({ id, name, target }));
      const one = /\/rulesets\/(\d+)$/.exec(path);
      if (one) return sets.find((s) => s.id === Number(one[1]));
      if (path.endsWith("/rules/branches/main")) return branchRules;
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as GitHub;
  return { gh, writes };
}

test("two good rulesets protect a project", async () => {
  expect(await protectionProblems(fake([tags(), branch()]).gh, "o/p", "main", "app")).toEqual([]);
});

test.each([
  ["no tag ruleset", [branch()], /no active tag ruleset/],
  ["an inactive tag ruleset", [tags({ enforcement: "evaluate" }), branch()], /no active tag ruleset/],
  ["a tag ruleset for v* tags only", [tags({ conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } } }), branch()], /every tag/],
  ["a tag ruleset with exclusions", [tags({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/9*"] } } }), branch()], /every tag/],
  ["a tag ruleset without creation", [tags({ rules: [{ type: "update" }, { type: "deletion" }] }), branch()], /creation/],
  ["a tag ruleset the App can bypass", [tags({ current_user_can_bypass: "always" }), branch()], /can bypass tapster tags/],
  ["no branch ruleset", [tags()], /no active branch ruleset/],
  ["a branch ruleset without update", [tags(), branch({ rules: [{ type: "creation" }, { type: "deletion" }, { type: "non_fast_forward" }] })], /update/],
  ["a branch ruleset that lets anyone create branches", [tags(), branch({ rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }] })], /creation/],
  ["a ruleset for the default branch only", [tags(), branch({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } })], /every branch/],
])("%s is a problem", async (_, sets, reason) => {
  const problems = await protectionProblems(fake(sets).gh, "o/p", "main", "app");
  expect(problems.join("; ")).toMatch(reason);
});

test("rulesets that GitHub does not enforce are a problem", async () => {
  const problems = await protectionProblems(fake([tags(), branch()], []).gh, "o/p", "main", "app");
  expect(problems.join("; ")).toMatch(/does not enforce/);
});

test("the owner's view checks the bypass list instead", async () => {
  const owner = { current_user_can_bypass: "always", bypass_actors: admin };
  expect(await protectionProblems(fake([tags(owner), branch(owner)]).gh, "o/p", "main", "admin")).toEqual([]);
  const keys = { current_user_can_bypass: "always", bypass_actors: [...admin, { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }] };
  expect(await protectionProblems(fake([tags(keys), branch(keys)]).gh, "o/p", "main", "admin")).toEqual([]);
  const app = { current_user_can_bypass: "always", bypass_actors: [...admin, { actor_id: 99, actor_type: "Integration", bypass_mode: "always" }] };
  expect((await protectionProblems(fake([tags(app), branch(owner)]).gh, "o/p", "main", "admin")).join()).toMatch(/can bypass tapster tags/);
});

test("create posts the exact rulesets and reports when they already protect", async () => {
  const sets: Set[] = [];
  const { gh, writes } = fake(sets, enforced, (m, _p, b) => {
    if (m === "POST") sets.push({ id: sets.length + 1, ...(b as { target: string }), current_user_can_bypass: "always", bypass_actors: admin });
  });
  expect((await createProtection(gh, "o/p", "main")).status).toBe("created");
  expect(writes).toEqual([["POST", "/repos/o/p/rulesets", TAG_RULESET], ["POST", "/repos/o/p/rulesets", BRANCH_RULESET]]);
  expect((await createProtection(gh, "o/p", "main")).status).toBe("exists");
  expect(writes).toHaveLength(2);
});

test("create repairs a tapster ruleset someone weakened", async () => {
  const owner = { current_user_can_bypass: "always", bypass_actors: admin };
  const sets = [tags({ ...owner, enforcement: "disabled" }), branch(owner)];
  const { gh, writes } = fake(sets, enforced, (m, p, b) => {
    if (m === "PUT" && p.endsWith("/rulesets/1")) Object.assign(sets[0]!, b);
  });
  expect((await createProtection(gh, "o/p", "main")).status).toBe("created");
  expect(writes).toEqual([["PUT", "/repos/o/p/rulesets/1", TAG_RULESET]]);
});

test("a plan without rulesets makes create report unavailable", async () => {
  const { gh } = fake([], enforced, () => {
    throw new GitHubError("GitHub POST /repos/o/p/rulesets returned 403", "", 403);
  });
  expect((await createProtection(gh, "o/p", "main")).status).toBe("unavailable");
  expect((await createProtection(fake([]).gh, "o/p", "main")).status).toBe("unavailable");
});

test("the rulesets let only the admin role bypass", () => {
  for (const r of [TAG_RULESET, BRANCH_RULESET]) {
    expect(r.enforcement).toBe("active");
    expect(r.bypass_actors).toEqual(admin);
  }
  expect(TAG_RULESET.conditions.ref_name.include).toEqual(["~ALL"]);
  expect(TAG_RULESET.rules.map((r) => r.type)).toEqual(["creation", "update", "deletion"]);
  expect(BRANCH_RULESET.conditions.ref_name.include).toEqual(["~ALL"]);
  expect(BRANCH_RULESET.rules.map((r) => r.type)).toEqual(["creation", "update", "deletion", "non_fast_forward"]);
});

test("check refuses an unprotected package and names both ways out", async () => {
  const { protectionGate } = await import("../src/action/check");
  const { resetReportForTests, rowsForTests } = await import("../src/report");
  const pkg = { name: "p", repo: "o/p", protection: "on" } as const;
  await expect(protectionGate(fake([branch()]).gh, pkg, "main")).rejects.toMatchObject({
    reason: expect.stringContaining("o/p is not protected against a stolen App key"),
    fix: expect.stringContaining("protection: off"),
  });
  await protectionGate(fake([tags(), branch()]).gh, pkg, "main");
  resetReportForTests();
  await protectionGate(fake([]).gh, { ...pkg, protection: "off" }, "main");
  expect(rowsForTests()).toEqual([]);
  const relaxed = branch({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/dependabot/**"] } } });
  await expect(protectionGate(fake([tags(), relaxed]).gh, pkg, "main")).rejects.toBeDefined();
  await protectionGate(fake([tags(), relaxed]).gh, { ...pkg, protection: "dependabot" }, "main");
});

test("add says what the protection changes, or why GitHub refused it", async () => {
  const { protectProject } = await import("../src/cli/add");
  const sets: Set[] = [];
  const { gh } = fake(sets, enforced, (m, _p, b) => {
    if (m === "POST") sets.push({ id: sets.length + 1, ...(b as { target: string }), bypass_actors: admin });
  });
  const withRepo = Object.assign(gh, { getRepo: async () => ({ default_branch: "main" }) }) as GitHub;
  const said = await protectProject(withRepo, "o/p");
  expect(said).toContain("only you can create, move or delete branches and tags");
  expect(said).not.toContain("bypass actors");
  expect(await protectProject(withRepo, "o/p")).toContain("already protected");
  const refused = Object.assign(fake([], []).gh, { getRepo: async () => ({ default_branch: "main" }) }) as GitHub;
  expect(await protectProject(refused, "o/p")).toContain("protection: off");
});

test("letting Dependabot open branches excludes only its branch names", async () => {
  const { rulesetBodies } = await import("../src/rulesets");
  const [, branches] = rulesetBodies(false, true);
  expect(branches.conditions.ref_name.exclude).toEqual(["refs/heads/dependabot/**"]);
  const relaxed = branch({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/dependabot/**"] } } });
  expect(await protectionProblems(fake([tags(), relaxed]).gh, "o/p", "main", "app", true)).toEqual([]);
  expect((await protectionProblems(fake([tags(), relaxed]).gh, "o/p", "main", "app")).join()).toMatch(/every branch/);
  const wider = branch({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/feature/**"] } } });
  expect((await protectionProblems(fake([tags(), wider]).gh, "o/p", "main", "app")).join()).toMatch(/every branch/);
});

test("a repository where GitHub offers no rulesets gets the plan explained", async () => {
  const { GitHubError } = await import("../src/errors");
  const gh = { json: async () => { throw new GitHubError("GitHub GET /repos/o/p/rulesets returned 403", "", 403); } } as unknown as GitHub;
  expect((await protectionProblems(gh, "o/p", "main", "app")).join()).toContain("paid plan");
});

test("running add again keeps the deploy keys and the Dependabot branches it allowed before", async () => {
  const keys = [...admin, { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }];
  const open = { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/dependabot/**"] } } };
  const sets = [tags({ bypass_actors: keys }), branch({ bypass_actors: keys, ...open })];
  const plain = fake(sets);
  expect(await createProtection(plain.gh, "o/p", "main")).toEqual({ status: "exists", deployKeys: true, dependabot: true });
  expect(plain.writes).toEqual([]);
  const dependabotOnly = fake([tags({ bypass_actors: keys }), branch({ bypass_actors: keys })]);
  await createProtection(dependabotOnly.gh, "o/p", "main", false, true);
  const bodies = dependabotOnly.writes.map(([, , b]) => b as { bypass_actors: { actor_type: string }[]; conditions: { ref_name: { exclude: string[] } } });
  expect(bodies.every((b) => b.bypass_actors.some((a) => a.actor_type === "DeployKey"))).toBe(true);
  expect(bodies[1]!.conditions.ref_name.exclude).toEqual(["refs/heads/dependabot/**"]);
});
