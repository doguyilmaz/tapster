import { expect, test } from "bun:test";
import { parse } from "yaml";
import { add, adaptGoreleaser, adaptReleaseWorkflow, bunWorkflow, inferEntry } from "../src/cli/add";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapsterError } from "../src/errors";
import pins from "../templates/pins.json";

test("goreleaser config hands signing and casks to the hub", () => {
  const before = `# keep me
version: 2
release:
  github: { owner: o, name: aims }
checksum:
  name_template: "{{ .ProjectName }}_checksums.txt"
notarize:
  macos: [{}]
homebrew_casks: [{ name: aims }]
scoops: [{ name: aims }]
`;
  const { text, notes } = adaptGoreleaser(before);
  const y = parse(text);
  expect(text.startsWith("# keep me")).toBe(true);
  expect(y.release.draft).toBe(true);
  expect(y.checksum.name_template).toBe("checksums.txt");
  expect(y.notarize).toBeUndefined();
  expect(y.homebrew_casks).toBeUndefined();
  expect(y.scoops).toBeUndefined();
  expect(notes.length).toBeGreaterThan(0);
});

test("release workflow drops release secrets and attests", () => {
  const before = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: goreleaser/goreleaser-action@abc
        with: { args: release --clean }
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_GITHUB_TOKEN: \${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}
          MACOS_SIGN_P12: \${{ secrets.MACOS_SIGN_P12 }}
`;
  const { text } = adaptReleaseWorkflow(before, pins["actions/attest-build-provenance"].sha, "v3");
  const y = parse(text);
  const steps = y.jobs.release.steps;
  expect(Object.keys(steps[0].env)).toEqual(["GITHUB_TOKEN"]);
  expect(steps[1].uses).toBe(`actions/attest-build-provenance@${pins["actions/attest-build-provenance"].sha}`);
  expect(steps[1].with).toEqual({ "subject-checksums": "dist/checksums.txt" });
  expect(steps[1]["continue-on-error"]).toBe("${{ github.event.repository.private }}");
  expect(text).toContain(`actions/attest-build-provenance@${pins["actions/attest-build-provenance"].sha} # v3`);
  expect(y.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
});

test("bun workflow builds every target and drafts the release", () => {
  const flow = bunWorkflow("konvoy", "src/cli.ts", pins);
  expect(flow).toContain("--draft");
  expect(flow).toContain('tags: ["v[0-9]+.[0-9]+.[0-9]+", "v[0-9]+.[0-9]+.[0-9]+-*"]');
  expect(flow).toContain("bun build src/cli.ts --compile");
  expect(flow).not.toContain("__");
  expect(flow).not.toContain("secrets.");
  expect(flow).toContain("subject-checksums: dist/checksums.txt");
  expect(flow).toContain("continue-on-error: ${{ github.event.repository.private }}");
  expect(flow).toContain('tar -C "$t" -czf "konvoy_${v}_${p/-/_}.tar.gz" konvoy');
});

test("the hub entry is inferred from the latest release", () => {
  const entry = inferEntry("aims", "o/aims", ["aims_1.2.3_darwin_arm64.tar.gz", "aims_1.2.3_linux_amd64.tar.gz", "aims_1.2.3_windows_amd64.zip", "checksums.txt"], "1.2.3", "go");
  expect(entry).toContain('darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"');
  expect(entry).toContain('windows-amd64: "aims_{version}_windows_amd64.zip"');
  expect(entry).toContain("scoop: true");
});

const goFlow = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-latest
    permissions: { contents: write, packages: write }
    steps:
      - uses: goreleaser/goreleaser-action@abc
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

test("existing job permissions are kept", () => {
  const y = parse(adaptReleaseWorkflow(goFlow, "a".repeat(40), "v4").text);
  expect(y.jobs.release.permissions).toEqual({ contents: "write", packages: "write", "id-token": "write", attestations: "write" });
});

test("running add twice adds one attestation step", () => {
  const once = adaptReleaseWorkflow(goFlow, "a".repeat(40), "v4").text;
  const twice = adaptReleaseWorkflow(once, "a".repeat(40), "v4");
  expect(parse(twice.text).jobs.release.steps.length).toBe(2);
  expect(twice.notes.join(" ")).toContain("already");
});

test("an existing Bun release workflow is not overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "add-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/o/tool.git"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tool", bin: "./src/cli.ts" }));
  writeFileSync(join(dir, "bun.lock"), "{}");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/release.yml"), "mine\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await expect(add([])).rejects.toBeInstanceOf(TapsterError);
  } finally {
    process.chdir(cwd);
  }
  expect(readFileSync(join(dir, ".github/workflows/release.yml"), "utf8")).toBe("mine\n");
});

test("workflow-level and write-all permissions are respected", () => {
  const top = goFlow.replace("    permissions: { contents: write, packages: write }\n", "").replace("jobs:", "permissions: { contents: write, pages: write }\njobs:");
  expect(parse(adaptReleaseWorkflow(top, "a".repeat(40), "v4").text).jobs.release.permissions).toEqual({ contents: "write", pages: "write", "id-token": "write", attestations: "write" });
  const all = goFlow.replace("permissions: { contents: write, packages: write }", "permissions: write-all");
  expect(parse(adaptReleaseWorkflow(all, "a".repeat(40), "v4").text).jobs.release.permissions).toBe("write-all");
});
