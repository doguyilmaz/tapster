import { expect, test } from "bun:test";
import { linuxUrl, parseConfig } from "../src/config";

const base = (linux: string, pkg: string) => `version: 1
tap: o/tap
${linux}packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
${pkg}`;
const assets = `    assets: { darwin-arm64: "aims_{version}_darwin_arm64.tar.gz", linux-amd64: "aims_{version}_linux_amd64.tar.gz" }
`;

test("a package may ship Linux packages when the hub names a maintainer", () => {
  const cfg = parseConfig(base('linux: { maintainer: "Dogu Yilmaz <dogu@example.com>" }\n', `    linux: true\n${assets}`), "o");
  expect(cfg.packages[0]!.kind !== "app" && cfg.packages[0]!.linux).toBe(true);
  expect(linuxUrl(cfg, "o/homebrew-tap")).toBe("https://o.github.io/homebrew-tap");
  const custom = parseConfig(base('linux: { maintainer: "D <d@x.yz>", url: "https://apt.example.com" }\n', `    linux: true\n${assets}`), "o");
  expect(linuxUrl(custom, "o/homebrew-tap")).toBe("https://apt.example.com");
});

test("Linux packages need a Linux build, a maintainer and a CLI", () => {
  expect(() => parseConfig(base('linux: { maintainer: "D <d@x.yz>" }\n', `    linux: true\n    assets: { darwin-arm64: "a_{version}.tar.gz" }\n`), "o")).toThrow(/Linux asset/);
  expect(() => parseConfig(base("", `    linux: true\n${assets}`), "o")).toThrow(/maintainer/);
  expect(() => parseConfig(base('linux: { maintainer: "Dogu" }\n', `    linux: true\n${assets}`), "o")).toThrow(/maintainer/);
  expect(() => parseConfig(base('linux: { maintainer: "D <d@x.yz>", url: "http://plain.example.com" }\n', `    linux: true\n${assets}`), "o")).toThrow(/url/);
  const app = `version: 1
tap: o/tap
linux: { maintainer: "D <d@x.yz>" }
packages:
  - { name: a, repo: o/a, kind: app, app: A.app, bundle_id: com.o.A, linux: true, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" } }
`;
  expect(() => parseConfig(app, "o")).toThrow(/linux/);
});
