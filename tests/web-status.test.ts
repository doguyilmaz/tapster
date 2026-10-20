import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { useGhWrite } from "../src/cli/gh";
import { withNote } from "../src/draftnote";
import type { AddView, DiffView, FollowView, InspectView, ProjectStatus, StatusView } from "../src/web/contract";
import { setupProblems } from "../src/web/api/status";
import { adaptGoreleaser, adaptReleaseWorkflow, bunWorkflow } from "../src/cli/add";
import { listAims, sampleHome } from "../scripts/demo";
import pins from "../templates/pins.json";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const fake = new FakeHub("octo");
let home = "";
let call: Call;
const HUB = "octo/homebrew-tap";

beforeAll(async () => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"], ["TAPSTER_APP_ID", "777"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  home = await sampleHome(fake);
  listAims(fake);
  useGhWrite(fake.ghWrite);
  fake.installation = { id: 9, repos: ["octo/ebb"] };
  ({ call } = webApp(fake, home));
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
    app: { reaches: false },
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

test("the App's reach flips once GitHub shows the installation and stays unknown when GitHub does not tell", async () => {
  const reach = async () => (await call("GET", `/api/projects/reach?hub=${HUB}&repo=octo/aims`)).data;
  expect(await reach()).toEqual({ reaches: false });
  fake.installation = { id: 9, repos: ["octo/ebb", "octo/aims"] };
  expect(await reach()).toEqual({ reaches: true });
  expect((await statuses("&repo=octo/aims"))[0]!.app.reaches).toBe(true);
  fake.userInstallations = false;
  expect(await reach()).toEqual({ reaches: null });
  expect((await aims()).app.reaches).toBeNull();
  fake.userInstallations = true;
  expect((await call("GET", `/api/projects/reach?hub=${HUB}&repo=nope`)).status).toBe(400);
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

test("following a release shows its run, then the draft with the hub's note, then the hub's publish", async () => {
  const follow = async () => (await call("GET", `/api/projects/follow?hub=${HUB}&repo=octo/aims&tag=v0.2.2`)).data as unknown as FollowView;
  const first = await follow();
  expect(first.run?.status).toBe("queued");
  expect([first.draft, first.published]).toEqual([null, null]);
  const repo = fake.get("octo/aims")!;
  const draft = { id: 22, tag_name: "v0.2.2", draft: true, prerelease: false, created_at: "2026-10-20T10:00:00Z", published_at: null, assets: [], body: withNote("notes", "a.tar.gz does not match checksums.txt"), html_url: "https://github.com/octo/aims/releases/tag/v0.2.2" };
  repo.releases.unshift(draft);
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
