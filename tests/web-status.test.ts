import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { withNote } from "../src/draftnote";
import type { AddView, DiffView, FollowView, InspectView, ProjectStatus, ReachView, StatusView } from "../src/web/contract";
import { setupProblems } from "../src/web/api/status";
import { type HubCheck, reachFromCheck } from "../src/web/api/reach";
import { reachNote, readReachNote } from "../src/reachnote";
import { adaptGoreleaser, adaptReleaseWorkflow, bunWorkflow } from "../src/cli/add";
import { listAims, sampleHome } from "../scripts/demo";
import pins from "../templates/pins.json";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const fake = new FakeHub("octo");
let home = "";
let call: Call;
let app: ReturnType<typeof webApp>;
const HUB = "octo/homebrew-tap";

beforeAll(async () => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"], ["TAPSTER_APP_ID", "777"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  home = await sampleHome(fake);
  listAims(fake);
  useGhWrite(fake.ghWrite);
  fake.installation = { id: 9, repos: ["octo/ebb"] };
  app = webApp(fake, home);
  call = app.call;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const statuses = async (query = "") => ((await call("GET", `/api/projects/status?hub=${HUB}${query}`)).data as unknown as StatusView).projects;
const aims = async () => (await statuses()).find((p) => p.name === "aims")!;

test("tapster's release setup is read from the files: drafts, attestation and no old Homebrew or signing parts", () => {
  const flow = 'on: { push: { tags: ["v*"] } }\njobs:\n  r:\n    steps:\n      - uses: goreleaser/goreleaser-action@v6\n        env:\n          HOMEBREW_TAP_GITHUB_TOKEN: x\n          MACOS_SIGN_P12: y\n';
  const go = "version: 2\nbrews: [{ name: x }]\nnotarize: { macos: [] }\n";
  expect(setupProblems({ kind: "go", branch: "main", workflowName: "release.yml", goreleaser: go, workflow: flow })).toEqual([
    "GoReleaser publishes releases instead of opening drafts",
    "GoReleaser still has notarize, brews, which the hub does now",
    "the workflow does not attest the archives",
    "the workflow still uses HOMEBREW_TAP_GITHUB_TOKEN, MACOS_SIGN_P12",
  ]);
  const attest = pins["actions/attest-build-provenance"];
  expect(setupProblems({ kind: "go", branch: "main", workflowName: "release.yml", goreleaser: adaptGoreleaser(go).text, workflow: adaptReleaseWorkflow(flow, attest.sha, attest.tag).text })).toEqual([]);
  expect(setupProblems({ kind: "bun", branch: "main", workflowName: "release.yml", goreleaser: null, workflow: bunWorkflow("t", "cli.ts", pins) })).toEqual([]);
  expect(setupProblems({ kind: "go", branch: "trunk", workflowName: "ship.yml", goreleaser: null, workflow: null })).toEqual(["there is no .goreleaser.yaml on trunk", "there is no .github/workflows/ship.yml on trunk"]);
});

test("aims' status comes from GitHub: each fact done or the next step", async () => {
  const s = await aims();
  const repo = fake.get("octo/aims")!;
  expect(s).toMatchObject({
    repo: "octo/aims",
    kind: "go",
    defaultBranch: "main",
    setup: { ok: true, problems: [] },
    protection: { ok: true, off: false },
    entry: { state: "merged", pr: null },
    app: { reaches: null, how: null, reason: "the hub has not checked it yet", running: false },
    release: { latest: { tag: "v0.2.1", byHub: false }, draft: null, highest: "v0.2.1", next: "v0.2.2", autoTag: false, head: { sha: repo.head, subject: "Release through the tapster hub" } },
    secrets: { names: ["HOMEBREW_TAP_GITHUB_TOKEN", "MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD"], published: false },
  } satisfies Partial<Record<keyof ProjectStatus, unknown>>);
  expect(s.app.installUrl).toBe(`https://github.com/apps/tapster-octo-tap/installations/new/permissions?suggested_target_id=42&repository_ids[]=${repo.id}`);
});

test("a listed repository GitHub does not show gets its reason while the others still load", async () => {
  const hub = fake.get(HUB)!;
  const before = hub.files!.get("tapster.yml")!;
  hub.files!.set("tapster.yml", `${before}  - name: gone\n    repo: octo/gone\n    binaries: [gone]\n    assets: { linux-amd64: "gone_{version}_linux_amd64.tar.gz" }\n`);
  const list = await statuses();
  hub.files!.set("tapster.yml", before);
  expect(list.find((p) => p.name === "aims")!.unreadable).toBeNull();
  expect(list.find((p) => p.name === "gone")!.unreadable).toStartWith("GitHub GET /repos/octo/gone returned 404.");
});

test("GitHub refuses to list App installations to the gh sign-in, as FakeHub does", async () => {
  const res = await fake.fetch("https://api.github.com/user/installations");
  expect(res.status).toBe(403);
  expect(((await res.json()) as { message: string }).message).toBe("You must authenticate with an access token authorized to a GitHub App in order to list installations");
});

const check = (over: Partial<HubCheck> = {}): HubCheck => ({ conclusion: "failure", created: "2026-10-20T10:00:00Z", at: "2026-10-20T10:01:00Z", url: "u", listed: ["octo/aims"], failures: [], reached: null, ...over });

test("the check job notes per package, by name only, whether the App's token was minted", () => {
  const note = reachNote([{ name: "aims", reached: true }, { name: "pix", reached: false }]);
  expect(note).toBe("aims: yes, pix: no");
  expect(readReachNote(note)).toEqual({ aims: true, pix: false });
  expect(readReachNote("aims: maybe, x: yes; rm -rf /")).toEqual({});
});

test("only the hub's note proves that its App reached a project; other failures prove nothing", () => {
  expect(reachFromCheck("aims", "octo/aims", null, false)).toEqual({ reaches: null, how: null, reason: "the hub has not checked it yet" });
  expect(reachFromCheck("aims", "octo/aims", check({ reached: { aims: true } }), false)).toEqual({ reaches: true, how: "run", reason: null });
  expect(reachFromCheck("aims", "octo/aims", check({ reached: { aims: false }, failures: ["aims: the hub's App is not installed on octo/aims"] }), true)).toEqual({ reaches: false, how: "run", reason: "the hub's App is not installed on octo/aims" });
  expect(reachFromCheck("aims", "octo/aims", check({ reached: { aims: false }, failures: ["aims: unexpected TypeError"] }), false)).toEqual({ reaches: false, how: "run", reason: "unexpected TypeError" });
  expect(reachFromCheck("aims", "octo/aims", check({ failures: ["aims: the hub's App is not installed on octo/aims"] }), false)).toMatchObject({ reaches: false });
  expect(reachFromCheck("aims", "octo/aims", check({ failures: ["tapster: the App is not installed on any of your repositories"] }), false)).toMatchObject({ reaches: false });
  expect(reachFromCheck("aims", "octo/aims", check({ conclusion: "success" }), false)).toEqual({ reaches: null, how: null, reason: "the hub's last check did not say" });
  expect(reachFromCheck("aims", "octo/aims", check({ failures: ["aims: unexpected TypeError"] }), false).reaches).toBeNull();
  expect(reachFromCheck("aims", "octo/aims", check({ failures: ["aims: kind: Invalid option"] }), false).reaches).toBeNull();
  expect(reachFromCheck("aims", "octo/aims", check({ conclusion: "success", reached: { pix: true } }), false)).toEqual({ reaches: null, how: null, reason: "the hub's last check did not include aims" });
  expect(reachFromCheck("aims", "octo/aims", check({ failures: ["tapster: the App is installed on the hub"] }), false)).toEqual({ reaches: null, how: null, reason: "the App is installed on the hub" });
  expect(reachFromCheck("aims", "octo/aims", check({ reached: { aims: true }, listed: [] }), false)).toEqual({ reaches: null, how: null, reason: "aims was not in tapster.yml at the hub's last check" });
  expect(reachFromCheck("aims", "octo/aims", null, true)).toEqual({ reaches: true, how: "release", reason: null });
});

test("Check again starts one hub run, follows it and shows its verdict with its time", async () => {
  const reach = async () => (await call("GET", `/api/projects/reach?hub=${HUB}&repo=octo/aims`)).data as unknown as ReachView;
  const ask = async () => (await call("POST", "/api/projects/check", { hub: HUB })).data as { started: boolean };
  const hub = fake.get(HUB)!;
  expect((await aims()).app).toMatchObject({ reaches: null, reason: "the hub has not checked it yet", running: false });
  expect((await ask()).started).toBe(true);
  expect((await ask()).started).toBe(false);
  expect(hub.dispatches).toBe(1);
  expect(await reach()).toMatchObject({ running: true, run: hub.runs[0]!.html_url });
  const first = fake.completeRun(HUB);
  expect(await reach()).toMatchObject({ reaches: false, how: "run", reason: "the hub's App is not installed on octo/aims", since: first.created_at, at: first.jobs![0]!.completed_at, running: false });
  fake.installation = { id: 9, repos: ["octo/ebb", "octo/aims"] };
  expect((await ask()).started).toBe(true);
  expect(hub.dispatches).toBe(2);
  fake.completeRun(HUB);
  expect(await reach()).toMatchObject({ reaches: true, how: "run", reason: null });
  expect((await aims()).app.reaches).toBe(true);
  expect((await call("GET", `/api/projects/reach?hub=${HUB}&repo=nope`)).status).toBe(400);
  expect((await call("POST", "/api/hub/run", { hub: HUB })).data).toEqual({ started: true });
  expect((await call("POST", "/api/hub/run", { hub: HUB })).data).toEqual({ started: false });
  fake.completeRun(HUB);
});

test("a hub whose check job writes no reach note leaves the App's reach open even after a passing run", async () => {
  fake.installation = { id: 9, repos: ["octo/ebb", "octo/aims"] };
  fake.completeRun(HUB, { note: false });
  expect((await call("GET", `/api/projects/reach?hub=${HUB}&repo=octo/aims`)).data).toMatchObject({ reaches: null, reason: "the hub's last check did not say" });
  fake.completeRun(HUB);
  expect((await call("GET", `/api/projects/reach?hub=${HUB}&repo=octo/aims`)).data).toMatchObject({ reaches: true, how: "run" });
});

test("right after creating the App, the session's key answers at once", async () => {
  app.s.apps.set(HUB, { id: "777", pem: fake.pem, slug: "tapster-octo-tap" });
  fake.installation = { id: 9, repos: ["octo/ebb"] };
  expect((await aims()).app).toMatchObject({ reaches: false, how: "key" });
  fake.installation = { id: 9, repos: ["octo/ebb", "octo/aims"] };
  expect((await call("GET", `/api/projects/reach?hub=${HUB}&repo=octo/aims`)).data).toMatchObject({ reaches: true, how: "key" });
  app.s.apps.delete(HUB);
});

test("a project whose entry waits in a hub pull request is listed with the link; its setup says what main lacks", async () => {
  const hub = fake.get(HUB)!;
  hub.branches.set("tapster-add-ebb", new Map([["tapster.yml", `version: 1\ntap: octo/tap\npackages:\n  - name: ebb\n    repo: octo/ebb\n    binaries: [ebb]\n    assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz" }\n`]]));
  hub.pulls.push({ number: 3, head: "tapster-add-ebb", html_url: "https://github.com/octo/homebrew-tap/pull/3", title: "Add ebb" });
  const ebb = (await statuses()).find((p) => p.name === "ebb")!;
  expect(ebb.entry).toEqual({ state: "proposed", pr: "https://github.com/octo/homebrew-tap/pull/3" });
  expect(ebb.setup).toEqual({ ok: false, problems: ["there is no .goreleaser.yaml on main", "there is no .github/workflows/release.yml on main"] });
  expect(ebb.release.next).toBe("v0.1.0");
  hub.pulls.length = 0;
  hub.branches.delete("tapster-add-ebb");
  expect((await statuses("&repo=octo/ebb"))[0]!.entry).toEqual({ state: "missing", pr: null });
});

test("a release tags the shown commit on GitHub and refuses a moved branch, a lower version and an existing tag", async () => {
  const repo = fake.get("octo/aims")!;
  const shown = (await aims()).release.head!.sha;
  const post = (tag: string, sha = shown) => call("POST", "/api/projects/release", { hub: HUB, repo: "octo/aims", tag, sha });
  const moved = await post("v0.2.2", "f".repeat(40));
  expect(moved.status).toBe(400);
  expect((moved.data.error as { reason: string }).reason).toBe("main moved since this page read it");
  expect((await post("v0.2.1")).data.error).toMatchObject({ reason: "v0.2.1 cannot be released", fix: "Pick a version higher than v0.2.1, the highest tag on GitHub." });
  expect((await post("0.2.2")).status).toBe(400);
  const real = fake.fetch;
  repo.tags.set("v0.3.0", "9".repeat(40));
  fake.fetch = async (input, init) => (String(input).includes("/matching-refs/") ? new Response("[]", { headers: { "content-type": "application/json" } }) : real(input, init));
  const taken = await post("v0.3.0");
  fake.fetch = real;
  repo.tags.delete("v0.3.0");
  expect((taken.data.error as { reason: string }).reason).toBe("v0.3.0 already exists on octo/aims");
  expect((await call("POST", "/api/projects/release", { hub: HUB, repo: "octo/notes", tag: "v1.0.0", sha: shown })).status).toBe(400);
  expect((await post("v0.2.2")).data).toEqual({ tag: "v0.2.2", sha: shown });
  expect(repo.tags.get("v0.2.2")).toBe(shown);
  expect((await aims()).release.next).toBe("v0.2.3");
});

test("a tip that already carries a version tag is not released again, lightweight or annotated", async () => {
  const repo = fake.get("octo/aims")!;
  const head = repo.head;
  const s = await aims();
  expect(s.release).toMatchObject({ atHead: "v0.2.2", next: "v0.2.3" });
  const again = await call("POST", "/api/projects/release", { hub: HUB, repo: "octo/aims", tag: "v0.2.3", sha: head });
  expect(again.data.error).toEqual({ reason: "main has nothing new since v0.2.2", fix: "Push the changes you want to release to main, then click Release again." });
  repo.head = "c".repeat(40);
  repo.annotated.set("d".repeat(40), repo.head);
  repo.tags.set("v0.3.0", "d".repeat(40));
  expect((await aims()).release.atHead).toBe("v0.3.0");
  repo.tags.delete("v0.3.0");
  expect((await aims()).release.atHead).toBeNull();
  repo.head = head;
});

test("a release stops when GitHub cannot list the tags and counts a tag it already made at that commit as done", async () => {
  const repo = fake.get("octo/aims")!;
  const head = repo.head;
  repo.head = "e".repeat(40);
  const real = fake.fetch;
  fake.fetch = async (input, init) => (String(input).includes("/matching-refs/") ? new Response("{}", { status: 500 }) : real(input, init));
  const blind = await call("POST", "/api/projects/release", { hub: HUB, repo: "octo/aims", tag: "v0.9.0", sha: repo.head });
  fake.fetch = real;
  expect(blind.data.error).toMatchObject({ reason: "GitHub did not list the tags of octo/aims" });
  expect(repo.tags.has("v0.9.0")).toBe(false);
  fake.fetch = async (input, init) => {
    if (String(input).endsWith("/repos/octo/aims/git/refs") && init?.method === "POST") await real(input, init);
    return real(input, init);
  };
  const twice = await call("POST", "/api/projects/release", { hub: HUB, repo: "octo/aims", tag: "v0.9.0", sha: repo.head });
  fake.fetch = real;
  expect(twice.data).toEqual({ tag: "v0.9.0", sha: "e".repeat(40) });
  repo.tags.delete("v0.9.0");
  repo.runs = repo.runs.filter((r) => r.head_branch !== "v0.9.0");
  repo.head = head;
});

test("following a release shows its run, then the draft with the hub's note, then the hub's publish", async () => {
  const follow = async () => (await call("GET", `/api/projects/follow?hub=${HUB}&repo=octo/aims&tag=v0.2.2`)).data as unknown as FollowView;
  const first = await follow();
  expect(first.run?.status).toBe("queued");
  expect([first.draft, first.published]).toEqual([null, null]);
  const repo = fake.get("octo/aims")!;
  const draft = { id: 22, tag_name: "v0.2.2", draft: true, prerelease: false, created_at: "2026-10-20T10:00:00Z", published_at: null, assets: [], body: withNote("notes", "a.tar.gz does not match checksums.txt"), html_url: "https://github.com/octo/aims/releases/tag/v0.2.2" };
  repo.releases.unshift(draft);
  const hub = fake.get(HUB)!;
  const publish = async () => (await call("POST", "/api/projects/publish", { hub: HUB, repo: "octo/aims" })).data;
  const before = hub.dispatches;
  expect(await publish()).toEqual({ started: true, run: null, doorbell: false });
  expect(await publish()).toMatchObject({ started: false, doorbell: false });
  expect(hub.dispatches).toBe(before + 1);
  expect((await follow()).hubRun).toMatchObject({ status: "queued", url: hub.runs[0]!.html_url });
  fake.completeRun(HUB);
  repo.repoVars.set("TAPSTER_DOORBELL", "https://bell.example.com");
  expect(await publish()).toEqual({ started: false, run: null, doorbell: true });
  expect(hub.dispatches).toBe(before + 1);
  repo.repoVars.delete("TAPSTER_DOORBELL");
  expect((await call("POST", "/api/projects/publish", { hub: HUB, repo: "octo/notes" })).status).toBe(400);
  expect((await follow()).draft).toEqual({ url: draft.html_url, note: "tapster will not publish this draft: a.tar.gz does not match checksums.txt" });
  expect((await aims()).release.draft).toMatchObject({ tag: "v0.2.2", note: "tapster will not publish this draft: a.tar.gz does not match checksums.txt" });
  Object.assign(draft, { draft: false, body: "notes", published_at: "2026-10-20T10:10:00Z" });
  fake.get(HUB)!.files!.set(".tapster/state.json", JSON.stringify({ version: 1, packages: { aims: [{ tag: "v0.2.2", releaseId: 22, checksums: "a".repeat(64), status: "published" }] } }));
  expect((await follow()).published).toEqual({ url: draft.html_url, byHub: true });
  const s = await aims();
  expect(s.release.latest).toMatchObject({ tag: "v0.2.2", byHub: true });
  expect(s.secrets.published).toBe(true);
  expect((await call("GET", `/api/projects/follow?hub=${HUB}&repo=octo/aims&tag=nope`)).status).toBe(400);
});

test("adding a clone that already has tapster's files changes nothing and its diff says so", async () => {
  const path = join(home, "Developer", "aims");
  const info = (await call("POST", "/api/projects/inspect", { hub: HUB, path })).data as unknown as InspectView;
  expect(info).toMatchObject({ inHub: true, ready: true, dirty: [], ahead: null });
  const added = (await call("POST", "/api/projects/add", { hub: HUB, path, options: { workflow: "release.yml", autoTag: false, dependabot: false, force: false } })).data as unknown as AddView;
  expect(added.files).toEqual([]);
  expect(added.lines.join("\n")).toContain("octo/homebrew-tap already has the entry for aims");
  const diff = (await call("POST", "/api/projects/diff", { path, files: [".goreleaser.yaml", ".github/workflows/release.yml"] })).data as unknown as DiffView;
  expect(diff.files.map((f) => f.change)).toEqual(["same", "same"]);
  const ebb = (await call("POST", "/api/projects/inspect", { hub: HUB, path: join(home, "Developer", "ebb") })).data as unknown as InspectView;
  expect(ebb.ready).toBe(false);
});
