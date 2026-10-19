import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { descProblems, downloadUrl, renderAppCask, renderCask, renderScoop, rubyString } from "../src/render";
import { type AppPackage, type CliPackage, parseConfig } from "../src/config";

const golden = (n: string) => readFileSync(new URL(`./golden/${n}`, import.meta.url), "utf8");
const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      darwin-amd64: "aims_{version}_darwin_amd64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
      windows-amd64: "aims_{version}_windows_amd64.zip"
    completions: { bash: completions/aims.bash, zsh: completions/aims.zsh }
    scoop: true
  - name: ebb
    repo: o/ebb
    binaries: [ebb]
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    cask:
      uninstall: { launchctl: [com.doguyilmaz.ebb] }
      zap: { trash: ["~/.config/ebb", "~/.local/state/ebb"] }
`,
  "o",
);
const [aims, ebb] = cfg.packages as [CliPackage, CliPackage];
const d = (platform: string, asset: string, n: string) => ({ platform: platform as never, url: downloadUrl("o/aims", "v0.1.5", asset), sha256: n.repeat(64) });
const aimsInput = {
  pkg: aims,
  version: "0.1.5",
  description: "Several Claude Code and Codex accounts on one machine",
  homepage: "https://doguyilmaz.github.io/aims/",
  license: "MIT",
  downloads: [
    d("darwin-arm64", "aims_0.1.5_darwin_arm64.tar.gz", "1"),
    d("darwin-amd64", "aims_0.1.5_darwin_amd64.tar.gz", "2"),
    d("linux-amd64", "aims_0.1.5_linux_amd64.tar.gz", "3"),
    d("windows-amd64", "aims_0.1.5_windows_amd64.zip", "5"),
  ],
};

test("cask with per-arch macOS and Linux blocks", () => {
  expect(renderCask(aimsInput)).toBe(golden("aims.rb"));
});

test("universal cask with uninstall and zap, hostile description escaped", () => {
  const out = renderCask({
    pkg: ebb,
    version: "0.1.1",
    description: 'Shows where disk space went #{and} "wins".',
    homepage: "https://github.com/o/ebb",
    license: null,
    downloads: [{ platform: "darwin-universal", url: downloadUrl("o/ebb", "v0.1.1", "ebb_0.1.1_darwin_universal.tar.gz"), sha256: "4".repeat(64) }],
  });
  expect(out).toBe(golden("ebb.rb"));
});

test("scoop manifest", () => {
  expect(renderScoop(aimsInput)).toBe(golden("aims.json"));
  expect(renderScoop({ ...aimsInput, downloads: aimsInput.downloads.slice(0, 3) })).toBeNull();
});

test("ruby strings cannot interpolate or break out", () => {
  expect(rubyString('a"b\\c#{x}\n\u0001')).toBe('"a\\"b\\\\c\\#{x}\\n\\u{1}"');
});

test("descriptions follow Homebrew's rules", () => {
  expect(descProblems("Several Claude Code and Codex accounts on one machine", "aims")).toEqual([]);
  expect(descProblems("macOS menu bar for battery stats", "x")).not.toEqual([]);
  expect(descProblems("iPhone backups made simple", "x")).toEqual([]);
  for (const bad of ["A tool", "the tool", "tool for things", "Aims manages accounts", "Command line tool", "Works on the Mac", "Tool.", "Tool ★", "x".repeat(81), " Tool", ""]) {
    expect(descProblems(bad, "aims"), bad).not.toEqual([]);
  }
  expect(descProblems("Lists files, dirs etc.", "x")).toEqual([]);
});

const apps = parseConfig(
  `version: 1
tap: doguyilmaz/tap
packages:
  - name: hafifpix
    repo: doguyilmaz/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.doguyilmaz.HafifPix
    assets: { darwin-arm64: "HafifPix-{version}.app.tar.gz" }
    dmg: { name: "HafifPix-{version}.dmg" }
    sparkle: { key: shared, public_key: "${"A".repeat(43)}=" }
    cask:
      binaries: [Contents/Resources/bin/hafif]
      zap: { trash: ["~/Library/Preferences/com.doguyilmaz.HafifPix.plist"] }
  - name: battistics
    repo: doguyilmaz/battistics
    kind: app
    app: Battistics.app
    bundle_id: com.doguyilmaz.Battistics
    assets: { darwin-universal: "Battistics-{version}.app.tar.gz" }
    dmg: { name: "Battistics-{version}.dmg" }
    cask:
      uninstall: { launchctl: [com.doguyilmaz.Battistics.PowerHelper], quit: [com.doguyilmaz.Battistics] }
`,
  "doguyilmaz",
).packages as [AppPackage, AppPackage];

test("app cask with a linked command and the macOS floor from the state", () => {
  const out = renderAppCask({
    pkg: apps[0],
    version: "1.3.1",
    sha256: "5".repeat(64),
    macos: "sequoia",
    description: "Image compressor that keeps quality",
    homepage: "https://github.com/doguyilmaz/hafifpix",
  });
  expect(out).toBe(golden("hafifpix.rb"));
});

test("a universal app without Sparkle has no arch floor and no auto_updates", () => {
  const out = renderAppCask({ pkg: apps[1], version: "1.4.1", sha256: "6".repeat(64), macos: "sonoma", description: "Battery details", homepage: "https://github.com/doguyilmaz/battistics" });
  expect(out).not.toContain("depends_on arch");
  expect(out).not.toContain("auto_updates");
  expect(out).toContain("  depends_on macos: :sonoma\n");
  expect(out).toContain('  uninstall launchctl: "com.doguyilmaz.Battistics.PowerHelper",\n            quit:      "com.doguyilmaz.Battistics"\n');
  expect(() => renderAppCask({ pkg: apps[1], version: "1.4.1", sha256: "6".repeat(64), macos: "leopard", description: "x", homepage: "https://x.y" })).toThrow(/leopard/);
});
