import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { addOptions, addProject, bunWorkflow } from "../src/cli/add";
import pins from "../templates/pins.json";
import { AUTO_FILE, autoMode } from "../src/cli/auto";
import { useGhWrite } from "../src/cli/gh";
import { parseHub } from "../src/config";
import { GitHub } from "../src/github";
import { entryText, entryWithCertificate, withEntryText } from "../src/hubentry";
import { run } from "../src/run";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const YML = `version: 1
tap: octo/tap
packages:
  # keep this comment
  - { name: aims, repo: octo/aims, binaries: [aims], assets: { darwin-arm64: aims.tar.gz } }
  - { name: linuxonly, repo: octo/linuxonly, binaries: [linuxonly], assets: { linux-amd64: linuxonly.tar.gz } }
`;
const fake = new FakeHub();
const repo = fake.repo("homebrew-tap", { files: new Map([["tapster.yml", YML]]), env: { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set() } });
let home = "";
let call: Call;
const target = { hub: HUB, name: "aims", repo: "octo/aims" };
const preview = (label: string | null, other = {}) => call("POST", "/api/projects/entry/certificate", { ...target, label, ...other });

beforeAll(async () => {
  home = await sampleHome(fake);
  fake.track(HUB);
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home));
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); useGhWrite(async () => { throw new Error("fixture closed"); }); });

test("the certificate selector previews a valid single-entry change without writing or uploading a secret", async () => {
  const at = fake.calls.length;
  const r = await preview("myapp");
  expect(r.status).toBe(200);
  expect(parse(r.data.entry as string)[0].certificate).toBe("myapp");
  expect(r.data.before).toBe(entryText(YML, "aims"));
  expect(repo.files!.get("tapster.yml")).toBe(YML);
  expect(fake.calls.slice(at).filter((x) => /^(POST|PATCH|PUT|DELETE) /.test(x))).toEqual([]);
  expect(repo.env!.secrets.size).toBe(0);
});

test("certificate choices reject another owner, another repository, invalid labels and packages without macOS code", async () => {
  for (const label of ["id", "", "MyApp", "app-name", "a".repeat(41)]) expect((await preview(label)).status).toBe(400);
  expect((await preview("myapp", { hub: "someone/homebrew-tap" })).status).toBe(400);
  expect((await preview("myapp", { repo: "octo/other" })).status).toBe(400);
  expect((await preview("myapp", { name: "linuxonly", repo: "octo/linuxonly" })).status).toBe(400);
  expect(repo.files!.get("tapster.yml")).toBe(YML);
});

test("a changed entry invalidates the certificate preview before any proposal is written", async () => {
  const plan = (await preview("myapp")).data;
  repo.files!.set("tapster.yml", YML.replace("binaries: [aims]", "binaries: [aims], license: MIT"));
  const r = await call("POST", "/api/projects/entry/propose", { ...target, ...plan });
  expect(r.status).toBe(400);
  expect(repo.branches.has("tapster-update-aims")).toBe(false);
  repo.files!.set("tapster.yml", YML);
});

test("a certificate can be assigned and later returned to the hub default through the checked proposal and merge", async () => {
  for (const label of ["myapp", null]) {
    const plan = (await preview(label)).data;
    const opened = await call("POST", "/api/projects/entry/propose", { ...target, ...plan });
    expect(opened.status).toBe(200);
    const merged = await call("POST", "/api/projects/entry/merge", { ...target, before: plan.before, entry: opened.data.entry, sha: opened.data.head });
    expect(merged.status).toBe(200);
    const text = repo.files!.get("tapster.yml")!;
    expect(parseHub(text, "octo").invalid).toEqual([]);
    expect(parseHub(text, "octo").config.packages[0]!.certificate ?? null).toBe(label);
    expect(entryText(text, "linuxonly")).toBe(entryText(YML, "linuxonly"));
    expect(text).toContain("# keep this comment");
    expect(repo.env!.secrets.size).toBe(0);
  }
});

test("certificate edits keep unrelated entry values, including flow lists and literal text", () => {
  const entry = entryText(YML, "aims")!;
  const next = entryWithCertificate(entry, "myapp");
  expect(parse(next)[0]).toEqual({ ...parse(entry)[0], certificate: "myapp" });
  expect(withEntryText(YML, "aims", next, "octo")).toContain("binaries: [aims]");
  expect(entryWithCertificate(next, "myapp")).toBe(next);
  const literal = '- name: aims\n  repo: octo/aims\n  caveats: |\n    keep this exact text\n';
  expect(parse(entryWithCertificate(literal, "myapp"))[0]).toEqual({ ...parse(literal)[0], certificate: "myapp" });
});

test("inspection offers Apple signing for macOS Go targets, including later builds and implicit defaults", async () => {
  const path = join(home, "Developer", "ebb");
  const file = join(path, ".goreleaser.yaml");
  const original = readFileSync(file, "utf8");
  try {
    for (const [config, macos] of [
      ["builds: [{ goos: [linux, windows] }]", false],
      ["builds: [{ goos: [linux] }, { goos: [darwin] }]", true],
      ["builds: [{ binary: ebb }]", true],
      ["builds: [{ goos: ['{{ .Env.GOOS }}'] }]", null],
      ["builds: [", null],
    ] as const) {
      writeFileSync(file, config);
      const result = await call("POST", "/api/projects/inspect", { hub: HUB, path });
      expect(result.status).toBe(200);
      expect(result.data.macos).toBe(macos);
    }
  } finally { writeFileSync(file, original); }
});

test("inspection distinguishes a new Bun CLI, a macOS build and an explicit Linux/Windows-only workflow", async () => {
  const path = join(home, "Developer", "hafifpix");
  const file = join(path, ".github", "workflows", "release.yml");
  expect(existsSync(file)).toBe(false);
  expect((await call("POST", "/api/projects/inspect", { hub: HUB, path })).data.macos).toBe(true);
  mkdirSync(join(file, ".."), { recursive: true });
  try {
    for (const macos of [true, false]) {
      writeFileSync(file, bunWorkflow("hafifpix", "src/cli.ts", pins, macos));
      const result = await call("POST", "/api/projects/inspect", { hub: HUB, path });
      expect(result.status).toBe(200);
      expect(result.data.macos).toBe(macos);
    }
  } finally { rmSync(file, { force: true }); }
});

test("a new project can use a labeled certificate without requiring the hub's default credentials", async () => {
  const gh = new GitHub("fixture", fake.fetch, async () => {}, "user");
  const result = await addProject(gh, join(home, "Developer", "ebb"), "octo/ebb", HUB, { slug: "tapster-octo-tap", apple: false }, addOptions(["--certificate", "myapp"]), () => {});
  expect(result.entry).toContain("certificate: myapp");
  expect(result.entry).toContain("darwin-arm64");
  expect(result.pr).not.toBeNull();
  const branch = repo.branches.get("tapster-add-ebb")!;
  expect(parseHub(branch.get("tapster.yml")!, "octo").invalid).toEqual([]);
  // Re-running a release-settings change cannot silently change its certificate.
  const before = readFileSync(join(home, "Developer", "ebb", ".goreleaser.yaml"), "utf8");
  await expect(addProject(gh, join(home, "Developer", "ebb"), "octo/ebb", HUB, { slug: "tapster-octo-tap", apple: false }, addOptions(["--certificate", "other"]), () => {})).rejects.toThrow("already has a hub entry");
  expect(readFileSync(join(home, "Developer", "ebb", ".goreleaser.yaml"), "utf8")).toBe(before);
});

test("an existing Mac app with its own certificate can switch to Auto without hub default credentials", async () => {
  const dir = join(home, "Developer", "pix");
  mkdirSync(dir, { recursive: true });
  const publicKey = Buffer.alloc(32, 1).toString("base64");
  writeFileSync(join(dir, "project.yml"), `name: Pix\ntargets:\n  Pix:\n    type: application\n    info:\n      properties:\n        CFBundleIdentifier: com.octo.Pix\n        SUFeedURL: https://github.com/octo/pix/releases/latest/download/appcast.xml\n        SUPublicEDKey: ${publicKey}\n`);
  await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await run("git", ["-C", dir, "remote", "add", "origin", "git@github.com:octo/pix.git"]);
  fake.repo("pix");
  const config = repo.files!.get("tapster.yml")! + `  - name: pix\n    repo: octo/pix\n    kind: app\n    app: Pix.app\n    bundle_id: com.octo.Pix\n    certificate: client\n    assets: { darwin-arm64: 'Pix-{version}.app.tar.gz' }\n    dmg: { name: 'Pix-{version}.dmg' }\n    sparkle: { key: pix, public_key: '${publicKey}' }\n`;
  expect(parseHub(config, "octo").invalid).toEqual([]);
  repo.files!.set("tapster.yml", config);
  fake.track(HUB);
  const inspected = await call("POST", "/api/projects/inspect", { hub: HUB, path: dir });
  expect(inspected.status).toBe(200);
  expect(inspected.data.apple).toBe(true);
  expect(inspected.data.macos).toBe(true);
  const added = await call("POST", "/api/projects/add", { hub: HUB, path: dir, options: { workflow: "release.yml", autoTag: true, auto: "daily", dependabot: false, force: false } });
  expect(added.status).toBe(200);
  expect(autoMode(readFileSync(join(dir, AUTO_FILE), "utf8"))).toBe("daily");
  expect(repo.files!.get("tapster.yml")).toBe(config);
  expect(repo.env!.vars.has("TAPSTER_TEAM_ID")).toBe(false);
});
