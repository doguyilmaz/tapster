import { expect, test } from "bun:test";
import { botWrites, installationProblems } from "../src/action/check";
import type { GitHub } from "../src/github";

type Push = { actor: { login: string; type: string }; before: string; after: string; activity_type: string };
const bot = { login: "github-actions[bot]", type: "Bot" };
const owner = { login: "o", type: "User" };
const push = (actor: Push["actor"], before: string, after: string): Push => ({ actor, before, after, activity_type: "push" });

function fake(pushes: Push[], files: Record<string, string[]>) {
  const asked: string[] = [];
  const gh = {
    json: async (_m: string, path: string) => {
      asked.push(path);
      if (path.includes("/activity?")) return pushes;
      const m = /\/compare\/(\w+)\.\.\.(\w+)$/.exec(path);
      if (m) return { files: (files[`${m[1]}..${m[2]}`] ?? []).map((filename) => ({ filename })) };
      throw new Error(path);
    },
  } as unknown as GitHub;
  return { gh, asked };
}

test("the hub's own state and cask commits are fine", async () => {
  const { gh } = fake([push(bot, "b", "c"), push(owner, "a", "b")], { "b..c": [".tapster/state.json", "Casks/aims.rb", "bucket/aims.json"] });
  expect(await botWrites(gh, "o/hub")).toEqual([]);
});

test("a bot commit that touched tapster.yml or a workflow since the owner's last push stops the hub", async () => {
  const { gh } = fake([push(bot, "c", "d"), push(bot, "b", "c"), push(owner, "a", "b")], { "c..d": ["tapster.yml"], "b..c": [".github/workflows/tapster.yml"] });
  expect(await botWrites(gh, "o/hub")).toEqual([
    "github-actions[bot] changed tapster.yml in d",
    "github-actions[bot] changed .github/workflows/tapster.yml in c",
  ]);
});

test("an owner push after a bot change means the owner has seen it", async () => {
  const { gh, asked } = fake([push(owner, "c", "d"), push(bot, "b", "c")], { "b..c": ["tapster.yml"] });
  expect(await botWrites(gh, "o/hub")).toEqual([]);
  expect(asked.filter((p) => p.includes("/compare/"))).toEqual([]);
});

test("the App on the hub stops everything and extra repositories are named", () => {
  expect(installationProblems(["o/a", "O/Hub"], "o/hub", ["o/a"])).toEqual({ fatal: "the App is installed on the hub", extra: [] });
  expect(installationProblems(["o/a", "o/b", "o/c"], "o/hub", ["o/a"])).toEqual({ fatal: null, extra: ["o/b", "o/c"] });
  expect(installationProblems(null, "o/hub", ["o/a"])).toEqual({ fatal: null, extra: [] });
});
