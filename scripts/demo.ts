import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../src/github";
import { useGhWrite } from "../src/cli/gh";
import { newSparkleKey } from "../src/cli/keystore";
import { run } from "../src/run";
import { setup } from "../src/web/start";
import { FakeHub } from "../tests/helpers/fakehub";

export async function sampleHome(fake: FakeHub): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "tapster-demo-"));
  const clone = async (name: string, files: Record<string, string>, owner = fake.login) => {
    const dir = join(home, "Developer", name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
    await run("git", ["-C", dir, "remote", "add", "origin", `git@github.com:${owner}/${name}.git`]);
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Start"]);
    if (owner === fake.login) fake.repo(name, { description: `${name}, a sample project` });
  };
  await clone("ebb", {
    "go.mod": "module github.com/octo/ebb\n\ngo 1.25\n",
    "main.go": "package main\n\nfunc main() {}\n",
    ".goreleaser.yaml": "version: 2\nbuilds:\n  - binary: ebb\n    goos: [darwin, linux]\n    goarch: [amd64, arm64]\nbrews:\n  - repository: { owner: octo, name: homebrew-tap }\n",
    ".github/workflows/release.yml": "name: release\non:\n  push:\n    tags: [\"v*\"]\njobs:\n  release:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: goreleaser/goreleaser-action@v6\n        with: { args: release --clean }\n        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          HOMEBREW_TAP_GITHUB_TOKEN: ${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}\n",
    ".github/dependabot.yml": "version: 2\nupdates: []\n",
  });
  await clone("hafifpix", { "package.json": JSON.stringify({ name: "hafifpix", bin: { hafifpix: "./src/cli.ts" } }, null, 2), "bun.lock": "{}\n", "src/cli.ts": "console.log('hi');\n" });
  await clone("lockstep", { "go.mod": "module github.com/octo/lockstep\n", ".goreleaser.yaml": "version: 2\n" });
  await clone("notes", { "README.md": "# notes\n" });
  await clone("website", { "package.json": "{}\n", "package-lock.json": "{}\n" });
  await clone("borrowed", { "go.mod": "module x\n" }, "someone");
  return home;
}

export async function demo(port: number, log: (line: string) => void): Promise<{ fake: FakeHub; home: string; done: Promise<void>; sparkle: { seed: string; publicKey: string } }> {
  const sparkle = newSparkleKey();
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap", { files: new Map([["README.md", "# octo/tap\n"], [".github/workflows/tests.yml", "jobs:\n  t:\n    steps:\n      - uses: Homebrew/actions/setup-homebrew@master\n"]]) });
  const home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  const pin = "0123456789abcdef0123456789abcdef01234567";
  const done = setup(["--port", String(port), "--no-open"], {
    github: async () => new GitHub("demo", fake.fetch, async () => {}, "user"),
    fetch: fake.fetch as typeof fetch,
    home,
    cwd: join(home, "Developer", "ebb"),
    pin,
    log,
    open: () => {},
    notary: async () => true,
    keychain: async (account) => (account === "ed25519" ? sparkle.seed : null),
  });
  return { fake, home, done, sparkle };
}

if (import.meta.main) {
  const { done } = await demo(Number(process.argv[2] ?? 8288), (line) => console.log(line));
  await done;
}
