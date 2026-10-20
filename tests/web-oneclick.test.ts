import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run";
import { useGhWrite } from "../src/cli/gh";
import { foreignWrites } from "../src/foreign";
import { GitHub } from "../src/github";
import type { DiffView, InspectView } from "../src/web/contract";
import { type OneGo, addInOneGo, oneGoRefusal } from "../src/web/oneclick";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const fake = new FakeHub("octo");
const OPTIONS = { workflow: "release.yml", autoTag: false, dependabot: false, force: false };
let home = "";
let remotes = "";
let call: Call;

beforeAll(async () => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"], ["TAPSTER_APP_ID", "777"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  fake.track(HUB);
  home = await sampleHome(fake);
  remotes = mkdtempSync(join(home, "remotes-"));
  for (const name of ["ebb", "hafifpix", "aims", "lockstep"]) {
    const dir = join(home, "Developer", name);
    await run("git", ["init", "-q", "--bare", "-b", "main", join(remotes, `${name}.git`)]);
    for (const [k, v] of [["user.name", "Test"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"], ["remote.origin.pushurl", join(remotes, `${name}.git`)]]) await run("git", ["-C", dir, "config", k!, v!]);
    if (name !== "lockstep") await run("git", ["-C", dir, "push", "-q", "origin", "main"]);
  }
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const send = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await call("POST", path, body);
  if (r.status !== 200) throw { problem: r.data.error };
  return r.data as T;
};
const inspect = async (path: string) => (await call("POST", "/api/projects/inspect", { hub: HUB, path })).data as unknown as InspectView;
const steps = (r: OneGo) => r.steps.map((s) => `${s.id}:${s.state}`);
const head = async (dir: string) => (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

test("checking the changes first shows the diff the manual way shows and writes nothing", async () => {
  const path = join(home, "Developer", "ebb");
  const view = (await call("POST", "/api/projects/preview", { hub: HUB, path, options: OPTIONS })).data as unknown as DiffView;
  expect(view.files.map((f) => [f.path, f.change])).toEqual([
    [".goreleaser.yaml", "update"],
    [".github/workflows/release.yml", "update"],
  ]);
  expect(view.files[0]!.before).toContain("brews:");
  expect(view.files[0]!.after).toContain("draft: true");
  expect((await inspect(path)).dirty).toEqual([]);
  expect(fake.get(HUB)!.pulls).toEqual([]);
});

test("one go adds, commits only tapster's files, pushes and merges the hub entry", async () => {
  const path = join(home, "Developer", "ebb");
  const info = await inspect(path);
  expect(oneGoRefusal(info)).toBeNull();
  await Bun.write(join(path, "notes.txt"), "mine");
  await run("git", ["-C", path, "add", "notes.txt"]);
  const seen: string[][] = [];
  const done = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, (r) => seen.push(steps(r)));
  expect(steps(done)).toEqual(["add:done", "commit:done", "push:done", "merge:done"]);
  expect(seen.map((s) => s.find((x) => x.endsWith(":wait")))).toContain("push:wait");
  const last = (await run("git", ["-C", path, "show", "--name-only", "--format=%s", "HEAD"])).stdout;
  expect(last).toContain(".goreleaser.yaml");
  expect(last).not.toContain("notes.txt");
  expect((await run("git", ["-C", join(remotes, "ebb.git"), "rev-parse", "main"])).stdout.trim()).toBe(await head(path));
  const hub = fake.get(HUB)!;
  expect(hub.files!.get("tapster.yml")).toContain(done.added!.entry!);
  expect(hub.branches.has("tapster-add-ebb")).toBe(false);
  expect(await foreignWrites(new GitHub("ghs_actions", fake.fetch), HUB, "octo")).toEqual([]);
});

test("one go refuses a clone on another branch before it changes anything", async () => {
  const path = join(home, "Developer", "FORK", "discain");
  const info = await inspect(path);
  expect(oneGoRefusal(info)).toBe("The clone is on experiment, not main.");
  const rulesets = fake.get("octo/ebb")!.rulesets.length;
  const r = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, () => {});
  expect(steps(r)).toEqual(["add:attention", "commit:open", "push:open", "merge:open"]);
  expect(r.steps[0]!.problem!.reason).toBe("the clone is on experiment, not main");
  expect((await inspect(path)).dirty).toEqual([]);
  expect(fake.get("octo/ebb")!.rulesets.length).toBe(rulesets);
});

test("one go refuses a clone with its own changes in tapster's files", async () => {
  const path = join(home, "Developer", "hafifpix");
  await Bun.write(join(path, ".github", "workflows", "release.yml"), "name: mine\n");
  const info = await inspect(path);
  expect(oneGoRefusal(info)).toBe("The clone has changes of its own in .github/workflows/release.yml.");
  const r = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, () => {});
  expect(r.steps[0]!.problem!.reason).toBe("the clone has changes of its own in .github/workflows/release.yml");
  expect(await Bun.file(join(path, ".github", "workflows", "release.yml")).text()).toBe("name: mine\n");
  expect(fake.get("octo/hafifpix")!.rulesets).toEqual([]);
  rmSync(join(path, ".github"), { recursive: true });
});

test("one go refuses a clone with commits that are not on GitHub yet", async () => {
  const path = join(home, "Developer", "ebb");
  await run("git", ["-C", path, "commit", "-q", "-m", "Mine"]);
  const info = await inspect(path);
  expect(oneGoRefusal(info)).toBe("The clone has 1 commit that is not on GitHub yet.");
  const r = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, () => {});
  expect(r.steps[0]!.problem!.reason).toBe("the clone has 1 commit that is not on GitHub yet");
});

test("one go stops after adding when the hub's pull request could not be opened", async () => {
  const path = join(home, "Developer", "hafifpix");
  const hub = fake.get(HUB)!;
  hub.branches.set("tapster-add-hafifpix", new Map(hub.files!));
  const before = await head(path);
  const r = await addInOneGo(send, { hub: HUB, info: await inspect(path), options: OPTIONS }, () => {});
  expect(steps(r)).toEqual(["add:attention", "commit:open", "push:open", "merge:open"]);
  expect(r.steps[0]!.problem!.reason).toBe("tapster could not open the hub's pull request");
  expect(r.added!.lines.join("\n")).toContain("the hub already has a branch tapster-add-hafifpix");
  expect(await head(path)).toBe(before);
  hub.branches.delete("tapster-add-hafifpix");
  rmSync(join(path, ".github"), { recursive: true });
});

test("one go stops at the step that fails and leaves the rest to the manual way", async () => {
  const path = join(home, "Developer", "hafifpix");
  await run("git", ["-C", path, "config", "remote.origin.pushurl", join(remotes, "missing.git")]);
  const before = await head(path);
  const r = await addInOneGo(send, { hub: HUB, info: await inspect(path), options: OPTIONS }, () => {});
  expect(steps(r)).toEqual(["add:done", "commit:done", "push:attention", "merge:open"]);
  expect(r.steps[2]!.problem!.reason).toBe("git could not push without asking for a password or passphrase");
  expect(await head(path)).not.toBe(before);
  const pr = fake.get(HUB)!.pulls.find((p) => p.head === "tapster-add-hafifpix")!;
  expect(pr.merged).toBeUndefined();
  const info = await inspect(path);
  expect([info.ahead, info.unpushed.map((c) => [c.subject, c.tapster])]).toEqual([1, [["Release through the tapster hub", true]]]);
});

test("a clone pushed without an upstream still counts its own commits, and Push names them", async () => {
  const path = join(home, "Developer", "aims");
  const remote = (await run("git", ["-C", join(remotes, "aims.git"), "rev-parse", "main"])).stdout.trim();
  await run("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", "WIP mine"]);
  const info = await inspect(path);
  expect([info.ahead, info.unpushed.map((c) => [c.subject, c.tapster])]).toEqual([1, [["WIP mine", false]]]);
  expect(oneGoRefusal(info)).toBe("The clone has 1 commit that is not on GitHub yet.");
  const r = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, () => {});
  expect(r.steps[0]!.problem!.reason).toBe("the clone has 1 commit that is not on GitHub yet");
  expect((await run("git", ["-C", join(remotes, "aims.git"), "rev-parse", "main"])).stdout.trim()).toBe(remote);
  await Bun.write(join(path, ".github", "workflows", "release.yml"), `${await Bun.file(join(path, ".github", "workflows", "release.yml")).text()}# mine\n`);
  const done = (await call("POST", "/api/projects/commit", { path, files: [".github/workflows/release.yml"] })).data as { committed: boolean; ahead: number; unpushed: { subject: string; tapster: boolean }[] };
  expect([done.committed, done.ahead, done.unpushed.map((c) => [c.subject, c.tapster])]).toEqual([true, 2, [["Release through the tapster hub", true], ["WIP mine", false]]]);
});

test("one go refuses a clone that cannot tell which commits GitHub has", async () => {
  const path = join(home, "Developer", "lockstep");
  const info = await inspect(path);
  expect([info.ahead, info.unpushed]).toEqual([null, []]);
  expect(oneGoRefusal(info)).toBe("The clone has no origin/main, so tapster cannot tell which commits are on GitHub yet.");
  const r = await addInOneGo(send, { hub: HUB, info, options: OPTIONS }, () => {});
  expect(r.steps[0]!.problem!.reason).toBe("the clone has no origin/main, so tapster cannot tell which commits are on GitHub yet");
});
