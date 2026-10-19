import { expect, test } from "bun:test";
import { foreignWrites, installationProblems } from "../src/action/check";
import type { GitHub } from "../src/github";

const ownerPush = { actor: { login: "o", type: "User" }, before: "a", after: "b", activity_type: "push" };

function fake(pushes: unknown[], compare: { status: string; files: string[] }) {
  const asked: string[] = [];
  const gh = {
    json: async (_m: string, path: string) => {
      asked.push(path);
      if (path.includes("/activity?")) return pushes;
      if (path.includes("/compare/")) return { status: compare.status, files: compare.files.map((filename) => ({ filename })) };
      throw new Error(path);
    },
  } as unknown as GitHub;
  return { gh, asked };
}

test("only the hub's own files changed since the owner's last push", async () => {
  const { gh, asked } = fake([ownerPush], { status: "ahead", files: [".tapster/state.json", "Casks/aims.rb", "bucket/aims.json"] });
  expect(await foreignWrites(gh, "o/hub", "o")).toEqual([]);
  expect(asked).toEqual(["/repos/o/hub/activity?ref=refs%2Fheads%2Fmain&actor=o&per_page=1", "/repos/o/hub/compare/b...main"]);
});

test("tapster.yml or a workflow changed by anyone but the owner since their last push stops the hub", async () => {
  const { gh } = fake([ownerPush], { status: "ahead", files: ["tapster.yml", ".github/workflows/tapster.yml", "Casks/x.rb"] });
  expect(await foreignWrites(gh, "o/hub", "o")).toEqual(["tapster.yml changed after your last push (b)", ".github/workflows/tapster.yml changed after your last push (b)"]);
});

test("the hub stops when it cannot tell what changed since the owner's last push", async () => {
  expect(await foreignWrites(fake([], { status: "ahead", files: [] }).gh, "o/hub", "o")).toEqual(["GitHub shows no push by o to main"]);
  expect(await foreignWrites(fake([ownerPush], { status: "diverged", files: [] }).gh, "o/hub", "o")).toEqual(["main no longer contains your last push (b)"]);
  const many = Array.from({ length: 300 }, (_, i) => `Casks/p${i}.rb`);
  expect(await foreignWrites(fake([ownerPush], { status: "ahead", files: many }).gh, "o/hub", "o")).toEqual(["more files changed after your last push (b) than GitHub lists"]);
});

test("an identical main is fine", async () => {
  expect(await foreignWrites(fake([ownerPush], { status: "identical", files: [] }).gh, "o/hub", "o")).toEqual([]);
});

test("the App on the hub, or on no repository at all, stops everything; extra repositories are named", () => {
  expect(installationProblems(["o/a", "O/Hub"], "o/hub", ["o/a"])).toEqual({ fatal: "the App is installed on the hub", extra: [] });
  expect(installationProblems(["o/a", "o/b", "o/c"], "o/hub", ["o/a"])).toEqual({ fatal: null, extra: ["o/b", "o/c"] });
  expect(installationProblems(null, "o/hub", ["o/a"]).fatal).toBe("the App is not installed on any of your repositories");
});
