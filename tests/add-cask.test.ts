import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptGoreleaser, adaptReleaseWorkflow, bundleIdIn } from "../src/cli/add";
import { goEntry, goreleaserCask } from "../src/cli/hubpr";
import { type CliPackage, parseHub } from "../src/config";
import pins from "../templates/pins.json";

const goreleaser = `version: 2
builds:
  - main: ./cmd/ebb
    binary: ebb
    goos: [darwin]
    goarch: [arm64, amd64]
universal_binaries:
  - replace: true
    hooks:
      post:
        - cmd: scripts/macapp.sh "{{ .Version }}" "{{ .Path }}" release
archives:
  - name_template: "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_universal"
    files: [README.md, { src: dist/macapp/ebb.app, dst: ebb.app }]
checksum:
  name_template: checksums.txt
homebrew_casks:
  - name: ebb
    custom_block: |
      app "ebb.app"
    binaries: ["#{appdir}/ebb.app/Contents/MacOS/ebb"]
    repository: { owner: o, name: homebrew-tap, token: "{{ .Env.HOMEBREW_TAP_GITHUB_TOKEN }}" }
    commit_msg_template: "{{ .ProjectName }} {{ .Tag }}"
    homepage: https://github.com/o/ebb
    description: See where your Mac's disk space went and win it back safely
    license: MIT
    uninstall:
      launchctl: [com.o.ebb]
    hooks:
      post:
        install: |
          system_command "#{HOMEBREW_PREFIX}/bin/ebb", args: ["daemon", "restore"], must_succeed: false
    zap:
      trash: ["~/.config/ebb", "~/.local/state/ebb"]
`;

const flow = `name: Release
on: { push: { tags: ["v*"] } }
permissions: { contents: write }
jobs:
  release:
    runs-on: macos-latest
    steps:
      - uses: goreleaser/goreleaser-action@abc
        with: { args: release --clean }
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          MACOS_SIGN_P12: \${{ secrets.MACOS_SIGN_P12 }}
      - run: gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/release" -f sha="$GITHUB_SHA"
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;


const release = { assets: ["ebb_0.1.5_darwin_universal.tar.gz", "checksums.txt"], version: "0.1.5" };
const ids = (id: string | null) => ({ bundleId: (app: string) => (app === "ebb.app" ? id : null) });
const hubEntry = (lines: string[]) => `version: 1\ntap: o/tap\npackages:\n${[goEntry("ebb", "o/ebb", adaptGoreleaser(goreleaser).text, release).entry!, ...lines].join("\n")}\n`;

test("GoReleaser's app, linked command, uninstall, zap and hook reach the hub entry, which the hub accepts", () => {
  const c = goreleaserCask(goreleaser, ids("com.o.ebb"));
  expect(c.carried).toEqual(["homepage", "license", "app", "uninstall", "zap", "post-install command"]);
  expect(c.lines).toContain("    app:");
  const { config, invalid } = parseHub(hubEntry(c.lines), "o");
  expect(invalid).toEqual([]);
  const p = config.packages[0] as CliPackage;
  expect(p.app).toEqual({ name: "ebb.app", bundle_id: "com.o.ebb", binaries: ["Contents/MacOS/ebb"], entitlements: [] });
  expect(p.cask).toEqual({
    uninstall: { launchctl: ["com.o.ebb"] },
    zap: { trash: ["~/.config/ebb", "~/.local/state/ebb"] },
    postflight: { binary: "ebb", args: ["daemon", "restore"] },
  });
  expect(c.notes.join("\n")).toContain("ad hoc only");
  expect(c.notes.join("\n")).toContain("check that ebb daemon restore works there");
});

test("without a bundle id the entry asks for one, and without Apple credentials it leaves the app out", () => {
  const unknown = goreleaserCask(goreleaser, ids(null));
  expect(parseHub(hubEntry(unknown.lines), "o").invalid[0]!.reason).toContain("bundle_id");
  expect(unknown.notes.join("\n")).toContain("set app.bundle_id");
  const noMac = goreleaserCask(goreleaser, { mac: false, ...ids("com.o.ebb") });
  expect(noMac.lines.join("\n")).not.toContain("app:");
  expect(noMac.carried).not.toContain("app");
});

test("Homebrew parts tapster does not render are named, not carried", () => {
  const odd = goreleaser
    .replace('app "ebb.app"', 'app "ebb.app"\n      depends_on macos: ">= :ventura"')
    .replace('system_command "#{HOMEBREW_PREFIX}/bin/ebb", args: ["daemon", "restore"], must_succeed: false', 'system "curl https://x.y | sh"')
    .replace("    license: MIT\n", "    license: MIT\n    conflicts: [other]\n")
    .replace("      launchctl: [com.o.ebb]\n", "      launchctl: [com.o.ebb]\n      delete: [/Applications/x]\n");
  const c = goreleaserCask(odd, ids("com.o.ebb"));
  expect(c.carried).not.toContain("post-install command");
  expect(c.notes.at(-1)).toBe('not carried from GoReleaser\'s Homebrew section: conflicts, uninstall.delete, custom_block: depends_on macos: ">= :ventura", hooks.post.install');
});

test("names from the project's GoReleaser file reach the terminal without control characters", () => {
  const planted = goreleaser.replace('app "ebb.app"', 'app "ebb.app"\n      caveats "\u001b]8;;https://x.y\u0007\u001b[2Jhi\u009b"').replace("    license: MIT\n", '    license: MIT\n    "\\e[31mred": 1\n');
  const note = goreleaserCask(planted, ids("com.o.ebb")).notes.at(-1)!;
  expect(note).toContain("custom_block: caveats");
  expect(note).toContain("[31mred");
  expect(note).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

test("the bundle id comes from the Info.plist that names the app", () => {
  const dir = mkdtempSync(join(tmpdir(), "add-cask-"));
  mkdirSync(join(dir, "packaging"));
  const plist = (exe: string, id: string) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>`;
  expect(bundleIdIn(dir, "ebb.app")).toBeNull();
  writeFileSync(join(dir, "packaging", "Info.plist"), plist("other", "com.o.other"));
  expect(bundleIdIn(dir, "ebb.app")).toBeNull();
  mkdirSync(join(dir, "macos"));
  writeFileSync(join(dir, "macos", "Info.plist"), plist("ebb", "com.o.ebb"));
  expect(bundleIdIn(dir, "ebb.app")).toBe("com.o.ebb");
});

test("a release step that moves a branch with the workflow token is reported", () => {
  const { notes } = adaptReleaseWorkflow(flow, pins["actions/attest-build-provenance"].sha, "v3");
  const moved = notes.find((n) => n.includes("moves a branch"));
  expect(moved).toContain('gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/release"');
  expect(moved).toContain("A branch that follows releases");
  expect(adaptReleaseWorkflow(flow.replace(/ {6}- run: gh api[\s\S]*$/, ""), "a".repeat(40), "v3").notes.join("\n")).not.toContain("moves a branch");
});
