import { expect, test } from "bun:test";
import { assetName, compareSemver, parseConfig, parseTag } from "../src/config";
import { TapsterError } from "../src/errors";

const good = `
version: 1
tap: doguyilmaz/tap
packages:
  - name: aims
    repo: doguyilmaz/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      windows-amd64: "aims_{version}_windows_amd64.zip"
    scoop: true
`;

test("a valid config parses with defaults", () => {
  const c = parseConfig(good, "doguyilmaz");
  const p = c.packages[0]!;
  expect(p.kind).toBe("go");
  expect(p.attestation).toBe("auto");
  expect(p.workflow).toBe("release.yml");
  expect(assetName(p, "darwin-arm64", "1.2.3")).toBe("aims_1.2.3_darwin_arm64.tar.gz");
});

test.each([
  ["unknown key", good.replace("scoop: true", "scoop: true\n    shiny: 1")],
  ["foreign owner", good.replace("repo: doguyilmaz/aims", "repo: someone/aims")],
  ["darwin zip", good.replace("darwin_arm64.tar.gz", "darwin_arm64.zip")],
  ["ruby in asset", good.replace("aims_{version}_darwin", "aims_#{x}_darwin")],
  ["other placeholder", good.replace("{version}_darwin", "{tag}_darwin")],
  ["bad name", good.replace("name: aims", "name: Aims")],
  ["dotdot binary", good.replace("binaries: [aims]", "binaries: [../aims]")],
  ["quote in zap", `${good}\n    cask: { zap: { trash: ["~/x\\"y"] } }`],
  ["description Homebrew rejects", good.replace("scoop: true", "scoop: true\n    description: A tool for macOS")],
])("rejects %s", (_, text) => {
  expect(() => parseConfig(text, "doguyilmaz")).toThrow(TapsterError);
});

test("tags", () => {
  expect(parseTag("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  expect(parseTag("v1.2.3-rc.1")?.pre).toBe("rc.1");
  for (const bad of ["1.2.3", "v1.2", "v1.2.3#{`x`}", "v1.2.3-", "v1.2.3 ", "v01.2.3x"]) expect(parseTag(bad)).toBeNull();
});

test("semver order", () => {
  const s = (t: string) => parseTag(t)!;
  expect(compareSemver(s("v1.10.0"), s("v1.9.9"))).toBeGreaterThan(0);
  expect(compareSemver(s("v1.0.0"), s("v1.0.0-rc.1"))).toBeGreaterThan(0);
  expect(compareSemver(s("v1.0.0-rc.2"), s("v1.0.0-rc.10"))).toBeLessThan(0);
});

test("two packages cannot ship a binary with the same name", () => {
  const twice = `${good}  - name: other
    repo: doguyilmaz/other
    binaries: [aims]
    assets:
      linux-amd64: "o_{version}.tar.gz"
`;
  expect(() => parseConfig(twice, "doguyilmaz")).toThrow(TapsterError);
});
