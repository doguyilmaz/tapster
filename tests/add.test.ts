import { expect, test } from "bun:test";
import { parse } from "yaml";
import { adaptGoreleaser, adaptReleaseWorkflow, bunWorkflow, inferEntry } from "../src/cli/add";
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
  expect(y.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
});

test("bun workflow builds every target and drafts the release", () => {
  const flow = bunWorkflow("konvoy", "src/cli.ts", pins);
  expect(flow).toContain("--draft");
  expect(flow).toContain("bun build src/cli.ts --compile");
  expect(flow).not.toContain("__");
  expect(flow).not.toContain("secrets.");
  expect(flow).toContain("subject-checksums: dist/checksums.txt");
  expect(flow).toContain('tar -C "$t" -czf "konvoy_${v}_${p/-/_}.tar.gz" konvoy');
});

test("the hub entry is inferred from the latest release", () => {
  const entry = inferEntry("aims", "o/aims", ["aims_1.2.3_darwin_arm64.tar.gz", "aims_1.2.3_linux_amd64.tar.gz", "aims_1.2.3_windows_amd64.zip", "checksums.txt"], "1.2.3", "go");
  expect(entry).toContain('darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"');
  expect(entry).toContain('windows-amd64: "aims_{version}_windows_amd64.zip"');
  expect(entry).toContain("scoop: true");
});
