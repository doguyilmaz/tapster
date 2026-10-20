import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { foreignWrites } from "../src/foreign";
import { GitHub } from "../src/github";
import type { AddView, ProjectStatus, StatusView } from "../src/web/contract";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const fake = new FakeHub("octo");
let home = "";
let call: Call;

beforeAll(async () => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"], ["TAPSTER_APP_ID", "777"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  fake.track(HUB);
  home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const hub = () => fake.get(HUB)!;
const status = async (repo: string) => ((await call("GET", `/api/projects/status?hub=${HUB}&repo=${repo}`)).data as unknown as StatusView).projects[0]!;
const merge = (body: Record<string, unknown>) => call("POST", "/api/projects/merge", { hub: HUB, ...body });
const reason = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string } | undefined)?.reason;
const hubCheck = () => foreignWrites(new GitHub("ghs_actions", fake.fetch), HUB, "octo");

let added: AddView;
let shown: ProjectStatus["entry"];

test("adding a project opens the hub entry and the page reads it with the pull request's head commit", async () => {
  const path = join(home, "Developer", "ebb");
  added = (await call("POST", "/api/projects/add", { hub: HUB, path, options: { workflow: "release.yml", autoTag: false, dependabot: true, force: false } })).data as unknown as AddView;
  expect(added.entry).toContain("  - name: ebb");
  expect(added.head).toBe(fake.branchHead(HUB, "tapster-add-ebb"));
  shown = (await status("octo/ebb")).entry;
  expect(shown).toMatchObject({ state: "proposed", pr: added.pr, proposal: { head: added.head, entry: added.entry }, blocked: null });
});

test("the merge refuses an entry or a head commit other than the ones the page showed", async () => {
  const ok = { name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: shown.proposal!.head };
  expect(reason(await merge({ ...ok, entry: ok.entry.replace("ebb_{version}", "evil_{version}") }))).toBe("the pull request does not add the entry this page showed");
  expect(reason(await merge({ ...ok, sha: "f".repeat(40) }))).toBe("the pull request changed since this page read it");
  expect(reason(await merge({ ...ok, repo: "octo/aims" }))).toBe("the entry publishes octo/ebb, not octo/aims");
  expect(reason(await merge({ ...ok, name: "aims" }))).toBe("octo/homebrew-tap has no open pull request from tapster-add-aims");
  expect(hub().files!.get("tapster.yml")).not.toContain("name: ebb");
});

test("the merge refuses a pull request that changes more than tapster.yml or more than the entry", async () => {
  const branch = hub().branches.get("tapster-add-ebb")!;
  const before = branch.get("tapster.yml")!;
  branch.set(".github/workflows/tapster.yml", "jobs: {}\n");
  const extra = await status("octo/ebb");
  expect(extra.entry.proposal).toBeNull();
  expect(extra.entry.blocked).toStartWith("the pull request changes more than tapster.yml.");
  expect(reason(await merge({ name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toBe("the pull request changes more than tapster.yml");
  branch.delete(".github/workflows/tapster.yml");
  branch.set("tapster.yml", before.replace("tap: octo/tap", "tap: octo/other"));
  expect(reason(await merge({ name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toBe("the pull request does more than add the entry to main's tapster.yml");
  branch.set("tapster.yml", `${before.trimEnd()}\n    nonsense: true\n`);
  expect(reason(await merge({ name: "ebb", repo: "octo/ebb", entry: `${shown.proposal!.entry}\n    nonsense: true`, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toStartWith("the hub would refuse this entry: ebb is invalid");
  branch.set("tapster.yml", before);
  expect((await status("octo/ebb")).entry.proposal).toEqual(shown.proposal);
});

test("the merge waits while main holds a change someone else made", async () => {
  fake.actor = "mallory";
  await fake.fetch(`https://api.github.com/repos/${HUB}/contents/README.md`, { method: "PUT", body: JSON.stringify({ message: "x", content: Buffer.from("hi\n").toString("base64"), branch: "main" }) });
  fake.actor = "octo";
  expect(await hubCheck()).toEqual([`README.md changed after your last push (${hub().history!.activity.find((a) => a.actor === "octo")!.after.slice(0, 7)})`]);
  expect(reason(await merge({ name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: shown.proposal!.head }))).toStartWith("main changed in ways only you may change it");
  expect(hub().pulls.find((p) => p.head === "tapster-add-ebb")!.merged).toBeUndefined();
  hub().files!.delete("README.md");
  await fake.fetch(`https://api.github.com/repos/${HUB}/contents/.keep`, { method: "PUT", body: JSON.stringify({ message: "Review main", content: "", branch: "main" }) });
  expect(await hubCheck()).toEqual([]);
});

test("the person's merge lands the entry on main, deletes the branch and passes the hub's check", async () => {
  const done = await merge({ name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: shown.proposal!.head });
  expect(done.data).toEqual({ merged: true, deleted: true });
  expect(hub().files!.get("tapster.yml")).toContain(added.entry!);
  expect(hub().branches.has("tapster-add-ebb")).toBe(false);
  expect(hub().pulls.find((p) => p.head === "tapster-add-ebb")).toMatchObject({ state: "closed", merged: "merge" });
  expect(hub().history!.activity[0]).toMatchObject({ actor: "octo", type: "pr_merge", after: hub().head });
  expect(await hubCheck()).toEqual([]);
  expect((await status("octo/ebb")).entry).toEqual({ state: "merged", pr: null, proposal: null, blocked: null });
  expect((await call("POST", "/api/hub/files", { hub: HUB, every: null, remove: [], readme: false })).status).toBe(200);
});

test("the same merge by anyone else is what the hub's check stops", async () => {
  const before = hub().files!.get("tapster.yml")!;
  hub().branches.set("tapster-add-lockstep", new Map(hub().files!));
  hub().bases.set("tapster-add-lockstep", new Map(hub().files!));
  hub().branches.get("tapster-add-lockstep")!.set("tapster.yml", `${before}  - name: lockstep\n    repo: octo/lockstep\n    binaries: [lockstep]\n    assets: { linux-amd64: "lockstep_{version}_linux_amd64.tar.gz" }\n`);
  hub().pulls.push({ number: 70, head: "tapster-add-lockstep", html_url: `https://github.com/${HUB}/pull/70`, title: "Add lockstep" });
  fake.actor = "mallory";
  await fake.fetch(`https://api.github.com/repos/${HUB}/pulls/70/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "merge" }) });
  fake.actor = "octo";
  expect((await hubCheck())[0]).toStartWith("tapster.yml changed after your last push");
});

test("a hub that turned off merge commits gets a squash merge", async () => {
  const r = hub();
  r.history = null;
  r.files!.set("tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n");
  fake.track(HUB);
  r.allowMerge = false;
  const path = join(home, "Developer", "hafifpix");
  const pix = (await call("POST", "/api/projects/add", { hub: HUB, path, options: { workflow: "release.yml", autoTag: false, dependabot: false, force: false } })).data as unknown as AddView;
  expect((await merge({ name: "hafifpix", repo: "octo/hafifpix", entry: pix.entry, sha: pix.head })).data).toEqual({ merged: true, deleted: true });
  expect(r.pulls.find((p) => p.head === "tapster-add-hafifpix")!.merged).toBe("squash");
  expect(await hubCheck()).toEqual([]);
  r.allowMerge = true;
});
