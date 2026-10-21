import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOptions, addProject, homebrewFromHistory, prepare, releaseHint } from "../src/cli/add";
import { goreleaserCask } from "../src/cli/hubpr";
import { GitHub } from "../src/github";
import { run } from "../src/run";
import { rulesetBodies } from "../src/rulesets";
import { FakeHub } from "./helpers/fakehub";

const base = mkdtempSync(join(tmpdir(), "rerun-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const BREWS = `version: 2
builds:
  - binary: aims
    goos: [linux, darwin]
    goarch: [amd64, arm64]
brews:
  - repository: { owner: octo, name: homebrew-tap }
    description: "Switch between AI accounts"
    homepage: "https://aims.example.com"
    license: MIT
    completions: { zsh: completions/aims.zsh }
`;
const FLOW = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: goreleaser/goreleaser-action@v6
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

async function commit(dir: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

async function migrated(name: string): Promise<string> {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await run("git", ["-C", dir, "remote", "add", "origin", `git@github.com:octo/${name}.git`]);
  await commit(dir, { "go.mod": `module github.com/octo/${name}\n`, ".goreleaser.yaml": BREWS, ".github/workflows/release.yml": FLOW }, "Start");
  await prepare(dir, `octo/${name}`, name, addOptions([]));
  await commit(dir, {}, "Release through the tapster hub");
  return dir;
}

function trap(dir: string): string {
  const marker = join(base, `${dir.split("/").pop()}-ran`);
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["post-checkout", "pre-commit", "reference-transaction"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  writeFileSync(join(dir, ".gitattributes"), "* filter=trap diff=trap\n");
  return marker;
}

async function arm(dir: string, marker: string) {
  for (const [k, v] of [["filter.trap.clean", `touch ${marker}; cat`], ["filter.trap.smudge", `touch ${marker}; cat`], ["diff.trap.textconv", `touch ${marker}; cat`], ["core.fsmonitor", `touch ${marker}`], ["core.hooksPath", join(dir, "hooks")]]) {
    await run("git", ["-C", dir, "config", k!, v!]);
  }
}

test("a second add finds GoReleaser's Homebrew section in the clone's history and runs nothing from the clone", async () => {
  const dir = await migrated("aims");
  const marker = trap(dir);
  await arm(dir, marker);
  const past = await homebrewFromHistory(dir);
  expect(past).toContain("brews:");
  const again = await prepare(dir, "octo/aims", "aims", addOptions([]));
  const cask = goreleaserCask(again.original ?? null);
  expect(cask.description).toBe("Switch between AI accounts");
  expect(cask.carried).toEqual(["homepage", "license", "completions"]);
  expect(existsSync(marker)).toBe(false);
});

test("reading history never fetches a missing object through the clone's own remote", async () => {
  const dir = await migrated("partial");
  const marker = join(base, "partial-fetched");
  const blob = (await run("git", ["-C", dir, "rev-parse", "HEAD~1:.goreleaser.yaml"])).stdout.trim();
  rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  for (const [k, v] of [["core.repositoryformatversion", "1"], ["extensions.partialClone", "lazy"], ["remote.lazy.promisor", "true"], ["remote.lazy.url", `ext::sh -c touch% ${marker}`], ["protocol.ext.allow", "always"]]) {
    await run("git", ["-C", dir, "config", k!, v!]);
  }
  expect(await homebrewFromHistory(dir)).toBeNull();
  expect(existsSync(marker)).toBe(false);
});

test("a clone without that history has nothing to recover", async () => {
  const dir = join(base, "fresh");
  mkdirSync(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  expect(await homebrewFromHistory(dir)).toBeNull();
  await commit(dir, { "go.mod": "module x\n", ".goreleaser.yaml": "version: 2\n" }, "Start");
  expect(await homebrewFromHistory(dir)).toBeNull();
});

function hubWith(fake: FakeHub, packages: string) {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set<string>() };
  return fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", `version: 1\ntap: octo/tap\npackages:${packages}`]]) });
}

const ENTRY = `
  - name: aims
    repo: octo/aims
    binaries: [aims]
    assets: { linux-amd64: "aims_{version}_linux_amd64.tar.gz" }
`;

test("adding a project the hub already lists keeps its entry and trusts the description it sets", async () => {
  const fake = new FakeHub("octo");
  hubWith(fake, `${ENTRY}    description: "Switch between AI accounts"\n    homepage: "https://aims.example.com"\n    license: MIT\n    completions: { zsh: completions/aims.zsh }\n`);
  fake.repo("aims", { description: "a tool for AI accounts.", rulesets: rulesetBodies(false).map((r, i) => ({ ...r, id: i + 1 })) });
  const lines: string[] = [];
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  const added = await addProject(gh, await migrated("listed"), "octo/aims", "octo/homebrew-tap", { slug: "tapster-octo-tap", apple: true }, addOptions([]), (l) => lines.push(l));
  const said = lines.join("\n");
  expect(said).toContain("octo/homebrew-tap already has the entry for aims; tapster leaves it as it is");
  expect(said).not.toContain("Homebrew would reject");
  expect(said).not.toContain("The entry for");
  expect(said).not.toContain("not proposed");
  expect(added).toMatchObject({ pr: null, entry: null });
  expect(fake.get("octo/homebrew-tap")!.pulls).toEqual([]);
});

test("tapster add ends with one gh command that tags GitHub's default branch with the next patch, not the clone", async () => {
  const fake = new FakeHub("octo");
  const aims = fake.repo("aims", { tags: new Map([["v0.2.0", "a".repeat(40)], ["v0.2.1", "b".repeat(40)]]) });
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  const hint = await releaseHint(gh, "octo/aims");
  expect(hint).toContain("release v0.2.2 by tagging the latest commit of main on GitHub");
  expect(hint).toContain('sha=$(gh api repos/octo/aims/commits/main --jq ');
  expect(hint).toContain(' && gh api --method POST repos/octo/aims/git/refs -f ref=refs/tags/v0.2.2 -f sha="$sha"');
  expect(hint).not.toContain("git tag");
  aims.keys.push({ title: "tapster tags", read_only: false });
  expect(await releaseHint(gh, "octo/aims")).toBe("Your release workflow tags each release by itself.");
});

test("adding a project whose entry waits in a pull request points there and suggests the missing description", async () => {
  const fake = new FakeHub("octo");
  const hub = hubWith(fake, " []\n");
  hub.branches.set("tapster-add-aims", new Map([["tapster.yml", `version: 1\ntap: octo/tap\npackages:${ENTRY}`]]));
  hub.pulls.push({ number: 7, head: "tapster-add-aims", html_url: "https://github.com/octo/homebrew-tap/pull/7", title: "Add aims" });
  fake.repo("aims", { description: "a tool." });
  const lines: string[] = [];
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  const added = await addProject(gh, await migrated("waiting"), "octo/aims", "octo/homebrew-tap", { slug: "tapster-octo-tap", apple: true }, addOptions([]), (l) => lines.push(l));
  const said = lines.join("\n");
  expect(said).toContain("the hub entry for aims waits in https://github.com/octo/homebrew-tap/pull/7");
  expect(said).toContain('add description: "Tool" to the hub entry before the next release');
  expect(said).not.toContain("The entry for");
  expect(added.pr).toBe("https://github.com/octo/homebrew-tap/pull/7");
  expect(hub.pulls).toHaveLength(1);
});
