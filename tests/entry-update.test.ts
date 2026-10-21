import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOptions, addProject, prepare } from "../src/cli/add";
import { useGhWrite } from "../src/cli/gh";
import { type TarEntry, writeTarGz } from "../src/archive";
import { sha256 } from "../src/checksums";
import { parseHub } from "../src/config";
import { withNote } from "../src/draftnote";
import { foreignWrites } from "../src/foreign";
import { GitHub } from "../src/github";
import { changedEntry, entryText } from "../src/hubentry";
import { run } from "../src/run";
import { rulesetBodies } from "../src/rulesets";
import type { ConfigView, EntryCheck, StatusView } from "../src/web/contract";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const KEY = `${"K".repeat(43)}=`;
const plist = (d: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>`;
const file = (name: string, data: string | Buffer): TarEntry => ({ name, type: "file", mode: 0o755, data: Buffer.from(data) });

const AIMS = `  - name: aims
    repo: octo/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
`;
const EBB = '  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz" } }\n';
const BATTISTICS = `  - name: battistics
    repo: octo/battistics
    kind: app
    app: Battistics.app
    bundle_id: com.octo.Battistics
    assets:
      darwin-arm64: "Battistics-{version}.app.tar.gz"
    dmg:
      name: "Battistics-{version}.dmg"
    sparkle:
      key: shared
      public_key: "${KEY}"
`;
const MAIN = `version: 1\ntap: octo/tap\npackages:\n${AIMS}${EBB}${BATTISTICS}`;

const PROJECT_YML = `name: Battistics
options: { bundleIdPrefix: com.octo }
targets:
  BattisticsPowerHelper:
    type: tool
    platform: macOS
    settings:
      base:
        PRODUCT_NAME: BattisticsPowerHelper
        PRODUCT_BUNDLE_IDENTIFIER: com.octo.Battistics.PowerHelper
  Battistics:
    type: application
    platform: macOS
    dependencies:
      - target: BattisticsPowerHelper
        codeSign: true
        copy:
          destination: executables
    info:
      path: Sources/Info.plist
      properties:
        SUFeedURL: https://github.com/octo/battistics/releases/latest/download/appcast-2.xml
        SUPublicEDKey: ${KEY}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.octo.Battistics
        PRODUCT_NAME: Battistics
`;
const LEGACY = '<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel/></rss>\n';
const APP_FLOW = `jobs:
  release:
    steps:
      - name: List the files
        run: |
          set -euo pipefail
          cp "scripts/legacy-appcast.xml" "dist/appcast.xml"
          cd dist && sha256sum * > checksums.txt
`;

const fake = new FakeHub("octo");
let home = "";
let call: Call;
const hub = () => fake.get(HUB)!;
const status = async (repo: string) => ((await call("GET", `/api/projects/status?hub=${HUB}&repo=${repo}`)).data as unknown as StatusView).projects[0]!;
const config = async (repo: string) => (await status(repo)).config as ConfigView;
const reason = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string } | undefined)?.reason;
const hubCheck = () => foreignWrites(new GitHub("ghs_actions", fake.fetch), HUB, "octo");

const archive = writeTarGz(
  [
    file("aims", MACHO),
    file("aims.app/Contents/Info.plist", plist({ CFBundleIdentifier: "com.octo.aims", CFBundleExecutable: "aims", CFBundleName: "aims" })),
    file("aims.app/Contents/MacOS/aims", MACHO),
    file("aims.app/Contents/Resources/aims.icns", "icns"),
  ],
  0,
);

beforeAll(() => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"], ["TAPSTER_TEAM_ID", "ABCDE12345"]]), secrets: new Set(["TAPSTER_APP_PRIVATE_KEY"]) };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", MAIN], [".tapster/state.json", '{"version":1,"packages":{}}\n']]) });
  fake.track(HUB);
  const protectedRepo = { rulesets: rulesetBodies(false).map((r, i) => ({ ...r, id: 900 + i })) };
  fake.repo("aims", { ...protectedRepo, files: new Map([[".goreleaser.yaml", "version: 2\nrelease: { draft: true }\nchecksum: { name_template: checksums.txt }\n"], [".github/workflows/release.yml", "jobs: {}\n"]]) });
  fake.get("octo/aims")!.releases = [
    {
      id: 30,
      tag_name: "v0.3.0",
      draft: true,
      prerelease: false,
      created_at: "2026-10-20T10:00:00Z",
      published_at: null,
      assets: [
        { id: 501, name: "aims_0.3.0_darwin_arm64.tar.gz", size: archive.length, digest: `sha256:${sha256(archive)}` },
        { id: 502, name: "checksums.txt", size: 10, digest: null },
      ],
      body: withNote("notes", "aims_0.3.0_darwin_arm64.tar.gz holds aims.app/Contents/MacOS/aims, a Mach-O file not listed in binaries"),
      html_url: "https://github.com/octo/aims/releases/tag/v0.3.0",
    },
  ];
  fake.blobs.set(501, archive);
  fake.repo("ebb", protectedRepo);
  fake.repo("battistics", { ...protectedRepo, files: new Map([["project.yml", PROJECT_YML], [".github/workflows/release.yml", APP_FLOW], ["scripts/legacy-appcast.xml", LEGACY]]) });
  home = mkdtempSync(join(tmpdir(), "entry-update-"));
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const AIMS_APP = `- name: aims
  repo: octo/aims
  binaries: [aims]
  assets:
    darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
    linux-amd64: "aims_{version}_linux_amd64.tar.gz"
  app:
    name: aims.app
    bundle_id: com.octo.aims
    binaries: ["Contents/MacOS/aims"]`;

test("an app in the macOS archive of a refused draft becomes the app block the entry lacks, read from its Info.plist", async () => {
  const c = await config("octo/aims");
  expect(c.entry).toBe(entryText(MAIN, "aims")!);
  expect(c.update).toBe(AIMS_APP);
  expect(c.from).toEqual(["aims.app in aims_0.3.0_darwin_arm64.tar.gz, the macOS archive of the draft v0.3.0"]);
  expect(c.manual).toEqual([]);
  expect(c.pending).toBeNull();
  await config("octo/aims");
  expect(fake.downloads).toBe(1);
});

test("an entry with nothing to add shows its lines and nothing else", async () => {
  expect(await config("octo/ebb")).toEqual({ entry: entryText(MAIN, "ebb")!, update: null, from: [], manual: [], pending: null });
});

test("a Mac app gets its feed from SUFeedURL, the pinned digest of the file its workflow attaches and its helper's identifier; entitlements stay with the owner", async () => {
  const c = await config("octo/battistics");
  expect(c.update).toBe(`${entryText(MAIN, "battistics")}
    feed: appcast-2.xml
  code:
    Contents/MacOS/BattisticsPowerHelper:
      identifier: com.octo.Battistics.PowerHelper
  carry:
    appcast.xml: "sha256:${sha256(Buffer.from(LEGACY))}"`);
  expect(c.from).toEqual(["the app's SUFeedURL", "the helpers project.yml copies into the app", "scripts/legacy-appcast.xml, which .github/workflows/release.yml attaches as appcast.xml"]);
  expect(c.manual).toEqual(["code.Contents/MacOS/BattisticsPowerHelper.entitlements: tapster does not read entitlements. If the helper needs any, write them by hand."]);
  expect(parseHub(MAIN.replace(BATTISTICS, `${c.update!.replace(/^/gm, "  ")}\n`), "octo").invalid).toEqual([]);
});

let pending: NonNullable<ConfigView["pending"]>;

test("Propose the update opens tapster-update-aims, which changes only the lines of that entry", async () => {
  const c = await config("octo/aims");
  const proposed = await call("POST", "/api/projects/entry/propose", { hub: HUB, name: "aims", repo: "octo/aims", entry: c.update });
  expect(proposed.data).toMatchObject({ entry: AIMS_APP, head: fake.branchHead(HUB, "tapster-update-aims") });
  const branch = hub().branches.get("tapster-update-aims")!;
  expect(changedEntry(MAIN, branch.get("tapster.yml")!, "aims", "octo")).toBe(AIMS_APP);
  expect(branch.get("tapster.yml")).toBe(MAIN.replace(AIMS, `${AIMS_APP.replace(/^/gm, "  ")}\n`));
  expect(hub().pulls.find((p) => p.head === "tapster-update-aims")?.title).toBe("Update aims");
  pending = (await config("octo/aims")).pending!;
  expect(pending).toMatchObject({ entry: AIMS_APP, head: fake.branchHead(HUB, "tapster-update-aims"), blocked: null });
  expect((await config("octo/aims")).update).toBeNull();
  expect(reason(await call("POST", "/api/projects/entry/propose", { hub: HUB, name: "aims", repo: "octo/aims", entry: c.update }))).toBe("the hub already has a branch tapster-update-aims");
});

test("the checked merge refuses a pull request that changes more than the shown lines", async () => {
  const branch = hub().branches.get("tapster-update-aims")!;
  const yml = branch.get("tapster.yml")!;
  const merge = () => call("POST", "/api/projects/entry/merge", { hub: HUB, name: "aims", repo: "octo/aims", entry: pending.entry, sha: fake.branchHead(HUB, "tapster-update-aims") });
  branch.set("tapster.yml", yml.replace("binaries: [ebb]", "binaries: [ebb, evil]"));
  expect(reason(await merge())).toBe("the pull request does more than change this entry in main's tapster.yml");
  expect((await config("octo/aims")).pending?.blocked).toStartWith("the pull request does more than change this entry in main's tapster.yml.");
  branch.set("tapster.yml", yml.replace("tap: octo/tap", "tap: octo/other"));
  expect(reason(await merge())).toBe("the pull request does more than change this entry in main's tapster.yml");
  branch.set("tapster.yml", yml.replace("bundle_id: com.octo.aims", "bundle_id: com.octo.evil"));
  expect(reason(await merge())).toBe("the pull request does not make the change this page showed");
  branch.set("tapster.yml", yml.replace("    binaries: [aims]\n", "    binaries: [aims]\n    nonsense: true\n"));
  expect(reason(await merge())).toBe("the pull request does more than change this entry in main's tapster.yml");
  branch.set("tapster.yml", yml);
  branch.set(".github/workflows/tapster.yml", "jobs: {}\n");
  expect(reason(await merge())).toBe("the pull request does more than edit tapster.yml");
  branch.delete(".github/workflows/tapster.yml");
  expect(reason(await call("POST", "/api/projects/entry/merge", { hub: HUB, name: "aims", repo: "octo/aims", entry: pending.entry, sha: "f".repeat(40) }))).toBe("the pull request changed since this page read it");
  expect(hub().files!.get("tapster.yml")).toBe(MAIN);
});

test("the update lands through the person's checked merge, and the card then shows nothing more to add", async () => {
  const done = await call("POST", "/api/projects/entry/merge", { hub: HUB, name: "aims", repo: "octo/aims", entry: pending.entry, sha: pending.head });
  expect(done.data).toEqual({ merged: true, deleted: true });
  expect(hub().files!.get("tapster.yml")).toBe(MAIN.replace(AIMS, `${AIMS_APP.replace(/^/gm, "  ")}\n`));
  expect(await hubCheck()).toEqual([]);
  expect(await config("octo/aims")).toEqual({ entry: AIMS_APP, update: null, from: [], manual: [], pending: null });
});

const now = () => hub().files!.get("tapster.yml")!;
const check = async (entry: string) => (await call("POST", "/api/projects/entry/check", { hub: HUB, name: "aims", repo: "octo/aims", entry })).data as unknown as EntryCheck;
const propose = (entry: string, name = "aims", repo = "octo/aims") => call("POST", "/api/projects/entry/propose", { hub: HUB, name, repo, entry });

test("an edit that touches another entry is refused", async () => {
  const touched = `${AIMS_APP}\n- name: ebb\n  repo: octo/ebb\n  binaries: [ebb]\n  assets: { linux-amd64: "x.tar.gz" }`;
  expect((await check(touched)).problem?.reason).toBe("the box must hold exactly one entry that starts with - name:");
  expect(reason(await propose(touched))).toBe("the box must hold exactly one entry that starts with - name:");
  expect(reason(await propose(AIMS_APP.replace("binaries: [aims]", "binaries: [ebb]")))).toBe("the hub would refuse this entry: aims and ebb both ship a binary named ebb");
  expect(hub().branches.has("tapster-update-aims")).toBe(false);
});

test("renaming the package or changing its repository is refused", async () => {
  expect((await check(AIMS_APP.replace("name: aims", "name: aimz"))).problem).toEqual({ reason: "the entry must keep the name aims", fix: "tapster changes one package at a time. To rename it, edit tapster.yml on GitHub." });
  expect((await check(AIMS_APP.replace("repo: octo/aims", "repo: octo/ebb"))).problem?.reason).toBe("the entry must keep the repository octo/aims");
  expect(reason(await propose(AIMS_APP, "aims", "octo/ebb"))).toBe("aims publishes octo/aims, not octo/ebb");
  expect(reason(await propose(AIMS_APP.replace("repo: octo/aims", "repo: octo/ebb")))).toBe("the entry must keep the repository octo/aims");
});

test("an invalid entry is refused with the parser's message", async () => {
  const bad = await check(AIMS_APP.replace("bundle_id: com.octo.aims", "bundle_id: not an id"));
  expect(bad.problem?.reason).toStartWith("the hub would refuse this entry: aims is invalid: app.bundle_id:");
  expect(bad.before).toBe(AIMS_APP);
  expect((await check(`${AIMS_APP}\n  binaries: [x]`)).problem?.reason).toStartWith("the entry is not valid YAML at line 11");
  expect(await check(AIMS_APP)).toEqual({ before: AIMS_APP, problem: null, same: true });
  expect(reason(await propose(AIMS_APP))).toBe("the entry of aims already reads like this");
});

test("a valid edit is proposed and merged through the checked merge, and the card reads it back from GitHub", async () => {
  const edited = `${AIMS_APP}\n  homepage: https://aims.example.com\n  cask:\n    uninstall:\n      launchctl: [com.octo.aims.keepalive]`;
  expect((await check(edited)).problem).toBeNull();
  const opened = (await propose(edited)).data as { pr: string; head: string; entry: string };
  expect(opened.entry).toBe(edited);
  const done = await call("POST", "/api/projects/entry/merge", { hub: HUB, name: "aims", repo: "octo/aims", entry: opened.entry, sha: opened.head });
  expect(done.data).toEqual({ merged: true, deleted: true });
  expect(now()).toBe(MAIN.replace(AIMS, `${edited.replace(/^/gm, "  ")}\n`));
  expect(entryText(now(), "ebb")).toBe(entryText(MAIN, "ebb"));
  expect(await hubCheck()).toEqual([]);
  expect((await config("octo/aims")).entry).toBe(edited);
});

const BREWS = `version: 2
builds:
  - binary: aims
    goos: [linux, darwin]
    goarch: [amd64, arm64]
homebrew_casks:
  - name: aims
    homepage: "https://aims.example.com"
    license: MIT
    uninstall:
      launchctl: [com.octo.aims.keepalive]
`;
const FLOW = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: goreleaser/goreleaser-action@v6
`;

async function clone(name: string): Promise<string> {
  const dir = join(home, name);
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, "go.mod"), `module github.com/octo/${name}\n`);
  writeFileSync(join(dir, ".goreleaser.yaml"), BREWS);
  writeFileSync(join(dir, ".github", "workflows", "release.yml"), FLOW);
  const git = (args: string[]) => run("git", ["-C", dir, ...args]);
  await git(["init", "-q", "-b", "main"]);
  await git(["remote", "add", "origin", `git@github.com:octo/${name}.git`]);
  await git(["add", "-A"]);
  await git(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Start"]);
  await prepare(dir, `octo/${name}`, name, addOptions([]));
  await git(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "Release through the tapster hub"]);
  return dir;
}

test("tapster add in a terminal prints what GoReleaser's Homebrew section adds and opens the same update", async () => {
  const before = now();
  const dir = await clone("aims");
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  const lines: string[] = [];
  await addProject(gh, dir, "octo/aims", HUB, { slug: "tapster-octo-tap", apple: true }, addOptions([]), (l) => lines.push(l));
  const said = lines.join("\n");
  expect(said).toContain(`- ${HUB} has an entry for aims that lacks what the project ships now. tapster read it from GoReleaser's Homebrew section. The change to tapster.yml:\n`);
  expect(said).toContain("  +   license: MIT\n");
  expect(said).toMatch(/- proposed the update in https:\/\/github\.com\/octo\/homebrew-tap\/pull\/\d+; merge it on GitHub or under Projects in tapster setup/);
  expect(said).not.toContain("leaves it as it is");
  const branch = hub().branches.get("tapster-update-aims")!.get("tapster.yml")!;
  expect(changedEntry(before, branch, "aims", "octo")).toBe(`${entryText(before, "aims")}\n  license: MIT`);
  const again: string[] = [];
  await addProject(gh, dir, "octo/aims", HUB, { slug: "tapster-octo-tap", apple: true }, addOptions([]), (l) => again.push(l));
  expect(again.join("\n")).toMatch(/- an update of the hub entry for aims waits in https:\/\/github\.com\/octo\/homebrew-tap\/pull\/\d+; merge it to apply it/);
  const opened = (await config("octo/aims")).pending!;
  expect((await call("POST", "/api/projects/entry/merge", { hub: HUB, name: "aims", repo: "octo/aims", entry: opened.entry, sha: opened.head })).data).toEqual({ merged: true, deleted: true });
  const quiet: string[] = [];
  await addProject(gh, dir, "octo/aims", HUB, { slug: "tapster-octo-tap", apple: true }, addOptions([]), (l) => quiet.push(l));
  expect(quiet.join("\n")).toContain(`- ${HUB} already has the entry for aims; tapster leaves it as it is`);
  expect(hub().branches.has("tapster-update-aims")).toBe(false);
});
