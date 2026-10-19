import { expect, test } from "bun:test";
import { autoTagSteps, binName, bunEntry, goEntry, hubName, installLink, withEntry } from "../src/cli/hubpr";
import { parseHub } from "../src/config";
import { rulesetBodies } from "../src/rulesets";

const valid = (hub: string, owner = "o") => {
  const { config, invalid } = parseHub(hub, owner);
  expect(invalid).toEqual([]);
  return config;
};

test("the Bun binary is named by package.json bin", () => {
  expect(binName({ name: "@o/tool", bin: { tl: "./src/cli.ts" } }, "tool")).toEqual({ bin: "tl", entry: "src/cli.ts" });
  expect(binName({ name: "@o/tool", bin: "./src/cli.ts" }, "tool")).toEqual({ bin: "tool", entry: "src/cli.ts" });
  expect(binName({ name: "plain", bin: "cli.ts" }, "repo")).toEqual({ bin: "plain", entry: "cli.ts" });
  expect(binName({ name: "x" }, "repo")).toBeNull();
});

test("a Bun entry names the template's assets and passes the hub's checks", () => {
  const entry = bunEntry("tool", "o/tool", "tl");
  const p = valid(`version: 1\ntap: o/tap\npackages:\n${entry}\n`).packages[0]!;
  expect(p.kind).toBe("bun");
  expect(p).toMatchObject({ binaries: ["tl"], scoop: true });
  expect(p.assets).toEqual({
    "darwin-arm64": "tl_{version}_darwin_arm64.tar.gz",
    "darwin-amd64": "tl_{version}_darwin_amd64.tar.gz",
    "linux-arm64": "tl_{version}_linux_arm64.tar.gz",
    "linux-amd64": "tl_{version}_linux_amd64.tar.gz",
    "windows-amd64": "tl_{version}_windows_amd64.zip",
  });
});

test("a Go entry comes from the release assets, with kind and the GoReleaser binary name", () => {
  const assets = ["aims_1.2.0_darwin_arm64.tar.gz", "aims_1.2.0_linux_amd64.tar.gz", "aims_1.2.0_windows_amd64.zip", "checksums.txt"];
  const g = goEntry("aims", "o/aims", "builds:\n  - binary: aimsctl\n", { assets, version: "1.2.0" });
  expect(g.reason).toBeNull();
  const p = valid(`version: 1\ntap: o/tap\npackages:\n${g.entry}\n`).packages[0]!;
  expect(p).toMatchObject({ kind: "go", binaries: ["aimsctl"], scoop: true });
  expect(p.assets["linux-amd64"]).toBe("aims_{version}_linux_amd64.tar.gz");
});

test("a Go project with no release yet uses GoReleaser's default archive names", () => {
  const zip = "project_name: aims\narchives:\n  - format_overrides:\n      - goos: windows\n        formats: [zip]\n";
  const p = valid(`version: 1\ntap: o/tap\npackages:\n${goEntry("aims", "o/aims", zip, null).entry}\n`).packages[0]!;
  expect(p.assets["darwin-arm64"]).toBe("aims_{version}_darwin_arm64.tar.gz");
  expect(p.assets["windows-amd64"]).toBe("aims_{version}_windows_amd64.zip");
  expect(p).toMatchObject({ scoop: true });
  const plain = valid(`version: 1\ntap: o/tap\npackages:\n${goEntry("aims", "o/aims", "builds:\n  - goos: [darwin, linux]\n    goarch: [arm64]\n", null).entry}\n`).packages[0]!;
  expect(plain.assets).toEqual({ "darwin-arm64": "aims_{version}_darwin_arm64.tar.gz", "linux-arm64": "aims_{version}_linux_arm64.tar.gz" });
  expect(plain).toMatchObject({ scoop: false });
});

test("a Go project with its own archive template and no release yet is not guessed", () => {
  const g = goEntry("aims", "o/aims", 'archives:\n  - name_template: "{{ .ProjectName }}-{{ .Os }}"\n', null);
  expect(g.entry).toBeNull();
  expect(g.reason).toContain("first draft");
});

test("the entry joins the hub's list, an empty one included, and a second add is refused", () => {
  const entry = bunEntry("tool", "o/tool", "tool");
  const empty = withEntry("version: 1\ntap: o/tap\npackages: []\n", entry, "tool");
  expect(valid(empty).packages.map((p) => p.name)).toEqual(["tool"]);
  const one = withEntry(`version: 1\ntap: o/tap\npackages:\n${bunEntry("other", "o/other", "other")}\n`, entry, "tool");
  expect(valid(one).packages.map((p) => p.name)).toEqual(["other", "tool"]);
  expect(() => withEntry(one, entry, "tool")).toThrow(/already/);
});

test("the hub is named owner/repo", () => {
  expect(hubName("o/homebrew-tap")).toBe("o/homebrew-tap");
  expect(() => hubName("homebrew-tap")).toThrow();
  expect(() => hubName("o/tap; rm -rf /")).toThrow();
});

test("the install link preselects the project", () => {
  expect(installLink("tapster-o-tap", 11, 22)).toBe("https://github.com/apps/tapster-o-tap/installations/new/permissions?suggested_target_id=11&repository_ids[]=22");
});

test("automatic tags add deploy keys to the bypass list and keep the admin", () => {
  const [tags, branches] = rulesetBodies(true);
  for (const r of [tags!, branches!]) {
    expect(r.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
    ]);
  }
  expect(rulesetBodies(false)[0]!.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]);
});

test("the automatic tag step pushes with the deploy key from the release environment", () => {
  const text = autoTagSteps({ sha: "c".repeat(40), tag: "v7.0.1" });
  expect(text).toContain(`actions/checkout@${"c".repeat(40)} # v7.0.1`);
  expect(text).toContain("environment: release");
  expect(text).toContain('ssh-key: "${{ secrets.TAPSTER_TAG_KEY }}"');
  expect(text).toContain("git push origin");
});
