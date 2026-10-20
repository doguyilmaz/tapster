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
const write = async (path: string, text: string, actor = "octo") => {
  fake.actor = actor;
  await real(`https://api.github.com/repos/${HUB}/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Write ${path}`, content: Buffer.from(text).toString("base64"), branch: "main" }) });
  fake.actor = "octo";
};
const real = fake.fetch;
const before = (method: string, path: string, act: () => Promise<void> | void) => {
  let fired = false;
  fake.fetch = async (input, init = {}) => {
    if (!fired && (init.method ?? "GET").toUpperCase() === method && new URL(String(input)).pathname === `/repos/${HUB}${path}`) {
      fired = true;
      await act();
    }
    return real(input, init);
  };
};
const restore = () => {
  fake.fetch = real;
};
const lockstep = (yml: string) => `${yml}  - name: lockstep\n    repo: octo/lockstep\n    binaries: [lockstep]\n    assets: { linux-amd64: "lockstep_{version}_linux_amd64.tar.gz" }\n`;

let added: AddView;
let shown: ProjectStatus["entry"];
let ok: { name: string; repo: string; entry: string; sha: string };

test("adding a project opens the hub entry and the page reads it with the pull request's head commit", async () => {
  const path = join(home, "Developer", "ebb");
  added = (await call("POST", "/api/projects/add", { hub: HUB, path, options: { workflow: "release.yml", autoTag: false, dependabot: true, force: false } })).data as unknown as AddView;
  expect(added.entry).toContain("  - name: ebb");
  expect(added.head).toBe(fake.branchHead(HUB, "tapster-add-ebb"));
  shown = (await status("octo/ebb")).entry;
  expect(shown).toMatchObject({ state: "proposed", pr: added.pr, proposal: { head: added.head, entry: added.entry }, blocked: null });
  ok = { name: "ebb", repo: "octo/ebb", entry: shown.proposal!.entry, sha: shown.proposal!.head };
});

test("the merge refuses an entry or a head commit other than the ones the page showed", async () => {
  expect(reason(await merge({ ...ok, entry: ok.entry.replace("ebb_{version}", "evil_{version}") }))).toBe("the pull request does not add the entry this page showed");
  expect(reason(await merge({ ...ok, sha: "f".repeat(40) }))).toBe("the pull request changed since this page read it");
  expect(reason(await merge({ ...ok, repo: "octo/aims" }))).toBe("the entry publishes octo/ebb, not octo/aims");
  expect(reason(await merge({ ...ok, name: "aims" }))).toBe("octo/homebrew-tap has no open pull request from tapster-add-aims");
  expect(hub().files!.get("tapster.yml")).not.toContain("name: ebb");
});

test("the merge refuses a pull request that changes more than tapster.yml or more than the entry", async () => {
  const branch = hub().branches.get("tapster-add-ebb")!;
  const yml = branch.get("tapster.yml")!;
  branch.set(".github/workflows/tapster.yml", "jobs: {}\n");
  const extra = await status("octo/ebb");
  expect(extra.entry.proposal).toBeNull();
  expect(extra.entry.blocked).toStartWith("the pull request does more than edit tapster.yml.");
  expect(reason(await merge({ ...ok, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toBe("the pull request does more than edit tapster.yml");
  branch.delete(".github/workflows/tapster.yml");
  branch.set("tapster.yml", yml.replace("tap: octo/tap", "tap: octo/other"));
  expect(reason(await merge({ ...ok, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toBe("the pull request does more than add the entry to main's tapster.yml");
  branch.set("tapster.yml", `${yml.trimEnd()}\n    nonsense: true\n`);
  expect(reason(await merge({ ...ok, entry: `${ok.entry}\n    nonsense: true`, sha: fake.branchHead(HUB, "tapster-add-ebb") }))).toStartWith("the hub would refuse this entry: ebb is invalid");
  branch.set("tapster.yml", yml);
  expect((await status("octo/ebb")).entry.proposal).toEqual(shown.proposal);
});

test("the merge refuses a pull request from a fork, into another branch or that adds or renames tapster.yml", async () => {
  const r = hub();
  const main = new Map(r.files!);
  const yml = lockstep(main.get("tapster.yml")!);
  const open = (base: Map<string, string>, head: Map<string, string>, more: Partial<(typeof r.pulls)[number]> = {}) => {
    r.branches.set("tapster-add-lockstep", head);
    r.bases.set("tapster-add-lockstep", base);
    r.pulls = r.pulls.filter((p) => p.head !== "tapster-add-lockstep");
    r.pulls.push({ number: 80, head: "tapster-add-lockstep", html_url: `https://github.com/${HUB}/pull/80`, title: "Add lockstep", ...more });
  };
  const body = () => ({ name: "lockstep", repo: "octo/lockstep", entry: lockstep("").trimEnd(), sha: fake.branchHead(HUB, "tapster-add-lockstep") });
  open(main, new Map([...main, ["tapster.yml", yml]]), { fork: "mallory/homebrew-tap" });
  expect(reason(await merge(body()))).toBe("octo/homebrew-tap has no open pull request from tapster-add-lockstep");
  open(main, new Map([...main, ["tapster.yml", yml]]), { base: "dev" });
  expect(reason(await merge(body()))).toBe("the pull request merges into dev, not main");
  const without = new Map([...main].filter(([f]) => f !== "tapster.yml"));
  open(without, new Map([...main, ["tapster.yml", yml]]));
  expect(reason(await merge(body()))).toBe("the pull request does more than edit tapster.yml");
  open(new Map([...without, ["hub.yml", yml]]), new Map([...without, ["tapster.yml", yml]]));
  expect(reason(await merge(body()))).toBe("the pull request does more than edit tapster.yml");
  r.pulls = r.pulls.filter((p) => p.head !== "tapster-add-lockstep");
  r.branches.delete("tapster-add-lockstep");
  expect(r.files!.get("tapster.yml")).not.toContain("lockstep");
});

test("the merge checks main exactly as the hub does and waits while it holds a change someone else made", async () => {
  await write("README.md", "hi\n", "mallory");
  expect(await hubCheck()).toEqual([`README.md changed after your last push (${hub().history!.activity.find((a) => a.actor === "octo")!.after.slice(0, 7)})`]);
  expect(reason(await merge(ok))).toStartWith("main changed in ways only you may change it");
  hub().files!.delete("README.md");
  await write(".keep", "");
  expect(await hubCheck()).toEqual([]);
  const activity = hub().history!.activity;
  hub().history!.activity = activity.filter((a) => a.actor !== "octo");
  expect(reason(await merge(ok))).toBe("main changed in ways only you may change it: GitHub shows no push by octo to main");
  hub().history!.activity = activity;
  fake.fetch = async (input, init) => (new URL(String(input)).pathname.endsWith("/activity") ? new Response("{}", { status: 404 }) : real(input, init));
  const blind = await merge(ok);
  restore();
  expect(blind.status).toBe(502);
  expect(hub().pulls.find((p) => p.head === "tapster-add-ebb")!.merged).toBeUndefined();
});

test("a push that lands on main during the merge stops it, and the hub's check still sees that push", async () => {
  before("POST", "/git/trees", () => write(".github/workflows/tapster.yml", "jobs: { evil: {} }\n", "mallory"));
  const raced = await merge(ok);
  restore();
  expect(reason(raced)).toMatch(/^main changed while tapster merged the entry: [0-9a-f]{7} Write \.github\/workflows\/tapster\.yml$/);
  expect((raced.data.error as { fix: string }).fix).toBe("Nothing was merged. Review those commits on GitHub, then click Merge the hub entry again.");
  expect(hub().files!.get("tapster.yml")).not.toContain("name: ebb");
  expect(hub().pulls.find((p) => p.head === "tapster-add-ebb")!.merged).toBeUndefined();
  expect((await hubCheck())[0]).toStartWith(".github/workflows/tapster.yml changed after your last push");
  hub().files!.delete(".github/workflows/tapster.yml");
  await write(".keep", "reviewed");
  expect(await hubCheck()).toEqual([]);
  const yml = hub().files!.get("tapster.yml")!;
  before("GET", "/pulls", () => write("tapster.yml", `${yml}# mine\n`, "mallory"));
  const early = await merge(ok);
  restore();
  expect(reason(early)).toMatch(/^main changed while tapster merged the entry: [0-9a-f]{7} Write tapster\.yml$/);
  await write("tapster.yml", yml);
  expect(await hubCheck()).toEqual([]);
});

test("a pull request that moves during the merge is not merged", async () => {
  before("POST", "/git/trees", () => void hub().branches.get("tapster-add-ebb")!.set("tapster.yml", lockstep(hub().branches.get("tapster-add-ebb")!.get("tapster.yml")!)));
  const moved = await merge(ok);
  restore();
  expect(reason(moved)).toBe("the pull request changed since this page read it");
  expect(hub().files!.get("tapster.yml")).not.toContain("name: ebb");
  hub().branches.get("tapster-add-ebb")!.set("tapster.yml", hub().branches.get("tapster-add-ebb")!.get("tapster.yml")!.replace(lockstep(""), ""));
  expect(fake.branchHead(HUB, "tapster-add-ebb")).toBe(ok.sha);
});

test("the person's merge lands the entry on main, deletes the branch and passes the hub's check", async () => {
  const done = await merge(ok);
  expect(done.data).toEqual({ merged: true, deleted: true });
  expect(hub().files!.get("tapster.yml")).toContain(added.entry!);
  expect(hub().branches.has("tapster-add-ebb")).toBe(false);
  expect(hub().pulls.find((p) => p.head === "tapster-add-ebb")).toMatchObject({ state: "closed", merged: "merge" });
  expect(hub().history!.activity[0]).toMatchObject({ actor: "octo", type: "push", after: hub().head });
  expect(await hubCheck()).toEqual([]);
  expect((await status("octo/ebb")).entry).toEqual({ state: "merged", pr: null, proposal: null, blocked: null });
  expect((await call("POST", "/api/hub/files", { hub: HUB, every: null, remove: [], readme: false })).status).toBe(200);
});

test("the same merge by anyone else is what the hub's check stops", async () => {
  const r = hub();
  r.branches.set("tapster-add-lockstep", new Map([...r.files!, ["tapster.yml", lockstep(r.files!.get("tapster.yml")!)]]));
  r.bases.set("tapster-add-lockstep", new Map(r.files!));
  r.pulls.push({ number: 70, head: "tapster-add-lockstep", html_url: `https://github.com/${HUB}/pull/70`, title: "Add lockstep" });
  fake.actor = "mallory";
  await fake.fetch(`https://api.github.com/repos/${HUB}/pulls/70/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "merge" }) });
  fake.actor = "octo";
  expect((await hubCheck())[0]).toStartWith("tapster.yml changed after your last push");
});

test("a rebase-only hub gets one plain commit, and a branch GitHub would not delete is reported", async () => {
  const r = hub();
  r.history = null;
  r.files!.set("tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n");
  fake.track(HUB);
  r.merges = ["rebase"];
  const path = join(home, "Developer", "hafifpix");
  const pix = (await call("POST", "/api/projects/add", { hub: HUB, path, options: { workflow: "release.yml", autoTag: false, dependabot: false, force: false } })).data as unknown as AddView;
  fake.fetch = async (input, init) => (init?.method === "DELETE" ? new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }) : real(input, init));
  const done = await merge({ name: "hafifpix", repo: "octo/hafifpix", entry: pix.entry, sha: pix.head });
  restore();
  expect(done.data).toEqual({ merged: true, deleted: false });
  expect(r.files!.get("tapster.yml")).toContain(pix.entry!);
  const pr = r.pulls.find((p) => p.head === "tapster-add-hafifpix")!;
  expect([pr.state, pr.merged]).toEqual(["closed", undefined]);
  expect(r.branches.has("tapster-add-hafifpix")).toBe(true);
  expect(await hubCheck()).toEqual([]);
  r.merges = ["merge", "squash", "rebase"];
});
