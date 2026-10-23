import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../src/github";
import { adaptGoreleaser, adaptReleaseWorkflow } from "../src/cli/add";
import { useGhWrite } from "../src/cli/gh";
import { rulesetBodies } from "../src/rulesets";
import pins from "../templates/pins.json";
import { newSparkleKey } from "../src/cli/keystore";
import { run } from "../src/run";
import { setup } from "../src/web/start";
import { findGpg } from "../src/cli/linuxkey";
import { FakeCloudflare, both } from "../tests/helpers/fakecloudflare";
import { FakeHub } from "../tests/helpers/fakehub";
import { memoryStore } from "../tests/helpers/memstore";

const EBB = {
  "go.mod": "module github.com/octo/ebb\n\ngo 1.25\n",
  "main.go": "package main\n\nfunc main() {}\n",
  ".goreleaser.yaml": "version: 2\nbuilds:\n  - binary: ebb\n    goos: [darwin, linux]\n    goarch: [amd64, arm64]\nbrews:\n  - repository: { owner: octo, name: homebrew-tap }\n",
  ".github/workflows/release.yml": "name: release\non:\n  push:\n    tags: [\"v*\"]\njobs:\n  release:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: goreleaser/goreleaser-action@v6\n        with: { args: release --clean }\n        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          HOMEBREW_TAP_GITHUB_TOKEN: ${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}\n",
  ".github/dependabot.yml": "version: 2\nupdates: []\n",
};

const AIMS_GORELEASER = `version: 2
builds:
  - binary: aims
    goos: [darwin, linux]
    goarch: [amd64, arm64]
brews:
  - repository: { owner: octo, name: homebrew-tap }
    description: "Run several AI coding accounts side by side"
    homepage: "https://aims.example.com"
    license: MIT
    completions: { zsh: completions/aims.zsh }
`;

export const AIMS_ENTRY = `  - name: aims
    repo: octo/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
    description: "Run several AI coding accounts side by side"
    homepage: "https://aims.example.com"
    license: MIT
    completions:
      zsh: completions/aims.zsh
`;

export function listAims(fake: FakeHub): void {
  const hub = fake.get(`${fake.login}/homebrew-tap`)!;
  const now = hub.files!.get("tapster.yml") ?? `version: 1\ntap: ${fake.login}/tap\npackages: []\n`;
  hub.files!.set("tapster.yml", `${now.replace(/packages: \[\]\n?$/, "packages:\n").trimEnd()}\n${AIMS_ENTRY}`);
}

export async function sampleHome(fake: FakeHub): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "tapster-demo-"));
  const git = (dir: string, args: string[]) => run("git", ["-C", dir, ...args]);
  const save = async (dir: string, files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  };
  const clone = async (name: string, files: Record<string, string>, owner = fake.login, at = name) => {
    const dir = join(home, "Developer", at);
    mkdirSync(dir, { recursive: true });
    await git(dir, ["init", "-q", "-b", "main"]);
    await git(dir, ["remote", "add", "origin", `git@github.com:${owner}/${name}.git`]);
    await save(dir, files, "Start");
    if (owner === fake.login && !fake.get(`${owner}/${name}`)) fake.repo(name, { description: `${name}, a sample project` });
    return dir;
  };
  await clone("ebb", EBB);
  const twin = await clone("ebb", EBB, fake.login, "FORK/discain");
  await git(twin, ["checkout", "-q", "-b", "experiment"]);
  const aims = await clone("aims", { "go.mod": "module github.com/octo/aims\n\ngo 1.25\n", "main.go": "package main\n\nfunc main() {}\n", ".goreleaser.yaml": AIMS_GORELEASER, ".github/workflows/release.yml": EBB[".github/workflows/release.yml"] });
  const goreleaser = adaptGoreleaser(AIMS_GORELEASER).text;
  const workflow = adaptReleaseWorkflow(EBB[".github/workflows/release.yml"], pins["actions/attest-build-provenance"].sha, pins["actions/attest-build-provenance"].tag).text;
  await save(aims, { ".goreleaser.yaml": goreleaser, ".github/workflows/release.yml": workflow }, "Release through the tapster hub");
  const released = (tag: string, id: number, day: string) => ({ id, tag_name: tag, draft: false, prerelease: false, created_at: `2026-10-${day}T10:00:00Z`, published_at: `2026-10-${day}T10:05:00Z`, assets: [], body: "", html_url: `https://github.com/${fake.login}/aims/releases/tag/${tag}` });
  Object.assign(fake.get(`${fake.login}/aims`)!, {
    description: "Run several AI coding accounts side by side",
    files: new Map([[".goreleaser.yaml", goreleaser], [".github/workflows/release.yml", workflow]]),
    tags: new Map([["v0.2.0", "1".repeat(40)], ["v0.2.1", "2".repeat(40)]]),
    releases: [released("v0.2.1", 21, "12"), released("v0.2.0", 20, "05")],
    rulesets: rulesetBodies(false).map((r, i) => ({ ...r, id: 900 + i })),
    actionSecrets: ["HOMEBREW_TAP_GITHUB_TOKEN", "MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD"],
    commit: { message: "Release through the tapster hub", date: "2026-10-19T16:20:00Z" },
  });
  await clone("hafifpix", { "package.json": JSON.stringify({ name: "hafifpix", bin: { hafifpix: "./src/cli.ts" } }, null, 2), "bun.lock": "{}\n", "src/cli.ts": "console.log('hi');\n" });
  await clone("lockstep", { "go.mod": "module github.com/octo/lockstep\n", ".goreleaser.yaml": "version: 2\n" });
  await clone("notes", { "README.md": "# notes\n" });
  await clone("website", { "package.json": "{}\n", "package-lock.json": "{}\n" });
  await clone("borrowed", { "go.mod": "module x\n" }, "someone");
  return home;
}

export async function demo(port: number, log: (line: string) => void): Promise<{ fake: FakeHub; cf: FakeCloudflare; home: string; done: Promise<void>; sparkle: { seed: string; publicKey: string } }> {
  const sparkle = newSparkleKey();
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap", { files: new Map([["README.md", "# octo/tap\n"], [".github/workflows/tests.yml", "jobs:\n  t:\n    steps:\n      - uses: Homebrew/actions/setup-homebrew@master\n"]]) });
  const home = await sampleHome(fake);
  fake.runDelay = 2500;
  const cf = new FakeCloudflare();
  const store = memoryStore();
  useGhWrite(fake.ghWrite);
  const pin = "0123456789abcdef0123456789abcdef01234567";
  const done = setup(["--port", String(port), "--no-open"], {
    github: async () => new GitHub("demo", fake.fetch, async () => {}, "user"),
    fetch: both(fake.fetch, cf),
    home,
    cwd: join(home, "Developer", "ebb"),
    pin,
    log,
    open: () => {},
    notary: async () => true,
    keychain: async (account) => (account === "ed25519" ? sparkle.seed : null),
    gpg: () => findGpg(),
    store: () => store,
    platform: process.platform,
    where: { exec: "", script: "", sha: null },
    run: async (argv) => {
      throw new Error(`the demo runs no ${argv[0]}`);
    },
    exit: () => {},
  });
  return { fake, cf, home, done, sparkle };
}

if (import.meta.main) {
  const { done } = await demo(Number(process.argv[2] ?? 8288), (line) => console.log(line));
  await done;
}
