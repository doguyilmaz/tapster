import { expect, test } from "bun:test";
import { type TarEntry, writeTarGz } from "../src/archive";
import { writeBplist } from "../src/bplist";
import { sha256 } from "../src/checksums";
import { goreleaserCask } from "../src/cli/hubpr";
import { parseHub } from "../src/config";
import { withNote } from "../src/draftnote";
import { type EntrySources, appInArchive, deriveUpdate, refusedDraftApp } from "../src/entryupdate";
import type { GitHub, Release } from "../src/github";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const plist = (d: Record<string, string>) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>`);
const file = (name: string, data: string | Buffer): TarEntry => ({ name, type: "file", mode: 0o755, data: Buffer.from(data) });
const ASSET = "aims_1.0.0_darwin_arm64.tar.gz";
const read = (entries: TarEntry[], commands = ["aims"]) => appInArchive(entries, ASSET, commands);

test("one plain app with a bundle id and a Mach-O executable named like the package's command is read", () => {
  expect(read([file("aims", MACHO), file("aims.app/Contents/Info.plist", plist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims" })), file("aims.app/Contents/MacOS/aims", MACHO)])).toEqual({
    app: { name: "aims.app", bundle_id: "com.o.aims", binaries: ["Contents/MacOS/aims"] },
    manual: [],
  });
  expect(read([file("aims", MACHO)])).toEqual({ app: null, manual: [] });
});

test("a binary Info.plist is read like an XML one", () => {
  const info = writeBplist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims" });
  expect(read([file("aims.app/Contents/Info.plist", info), file("aims.app/Contents/MacOS/aims", MACHO)]).app).toEqual({ name: "aims.app", bundle_id: "com.o.aims", binaries: ["Contents/MacOS/aims"] });
});

test("two apps, a name that is not plain or too long and a missing or bad bundle id are left to the owner", () => {
  const info = (id?: string) => plist({ ...(id ? { CFBundleIdentifier: id } : {}), CFBundleExecutable: "aims" });
  const two = read([file("a.app/Contents/Info.plist", info("com.o.a")), file("b.app/Contents/Info.plist", info("com.o.b"))]);
  expect(two.app).toBeNull();
  expect(two.manual).toEqual([`app: ${ASSET} holds a.app, b.app. The hub signs one app with a plain name; describe it under app by hand.`]);
  expect(read([file("my$app.app/Contents/Info.plist", info("com.o.a"))]).manual[0]).toStartWith(`app: ${ASSET} holds my$app.app.`);
  const long = `${"a".repeat(61)}.app`;
  expect(read([file(`${long}/Contents/Info.plist`, info("com.o.a"))]).app).toBeNull();
  const many = read(["a", "b", "c", "d", "e"].map((n) => file(`${n.repeat(70)}.app/Contents/Info.plist`, info("com.o.a"))));
  expect(many.manual[0]!.length).toBeLessThan(400);
  for (const bad of [read([file("aims.app/Contents/Info.plist", info())]), read([file("aims.app/Contents/Info.plist", info("not an id"))]), read([file("aims.app/Contents/Info.plist", "not a plist")])]) {
    expect(bad.app).toBeNull();
    expect(bad.manual).toEqual([`app: ${ASSET} holds aims.app, but its Info.plist names no bundle id the hub accepts. Write app with the name aims.app and its CFBundleIdentifier by hand.`]);
  }
});

test("update keys the hub refuses for a tool's app are named, and an executable that is not Mach-O is not linked", () => {
  const forbidden = read([file("aims.app/Contents/Info.plist", plist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims", SUFeedURL: "https://x.y/a.xml" })), file("aims.app/Contents/MacOS/aims", MACHO)]);
  expect(forbidden.app?.bundle_id).toBe("com.o.aims");
  expect(forbidden.manual).toEqual(["aims.app sets SUFeedURL in its Info.plist, which the hub refuses for a tool's app. Remove it from the app."]);
  expect(read([file("aims.app/Contents/Info.plist", plist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims" })), file("aims.app/Contents/MacOS/aims", "#!/bin/sh\n")]).app).toEqual({ name: "aims.app", bundle_id: "com.o.aims" });
});

test("an executable whose name is not one of the package's commands is never linked, only named with a warning", () => {
  const sudo = read([file("aims.app/Contents/Info.plist", plist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "sudo" })), file("aims.app/Contents/MacOS/sudo", MACHO)]);
  expect(sudo.app).toEqual({ name: "aims.app", bundle_id: "com.o.aims" });
  expect(sudo.manual).toEqual([
    "app.binaries: aims.app runs Contents/MacOS/sudo, which is not a command this package ships. Linking it would put a second sudo on PATH; add it under app.binaries by hand only if you mean that.",
  ]);
});

const release = (assets: Release["assets"], body = withNote("", "refused")): Release[] => [
  { id: 1, tag_name: "v1.0.0", draft: true, prerelease: false, created_at: "", published_at: null, upload_url: "", body, assets },
];
const counting = (data: Buffer) => {
  const gh = { calls: 0, downloadAsset: async () => (gh.calls++, data) };
  return gh;
};

test("a draft archive over the size cap is not downloaded", async () => {
  const gh = counting(Buffer.alloc(0));
  const big = release([{ id: 7, name: ASSET, size: 129 << 20, state: "uploaded", digest: null, browser_download_url: "" }]);
  const found = await refusedDraftApp(gh as unknown as GitHub, "o/aims", { "darwin-arm64": "aims_{version}_darwin_arm64.tar.gz" }, big, ["aims"]);
  expect(found?.manual).toEqual([`app: ${ASSET} is larger than tapster reads here. If it holds an app, describe it under app by hand.`]);
  expect(gh.calls).toBe(0);
});

test("an archive that differs from its digest or does not unpack is read once per digest, then remembered", async () => {
  const memo = new Map<string, unknown>();
  const broken = Buffer.from("not a tar.gz");
  const gh = counting(broken);
  const assets = { "darwin-arm64": "aims_{version}_darwin_arm64.tar.gz" };
  const wrong = release([{ id: 7, name: ASSET, size: broken.length, state: "uploaded", digest: `sha256:${"0".repeat(64)}`, browser_download_url: "" }]);
  expect(await refusedDraftApp(gh as unknown as GitHub, "o/aims", assets, wrong, ["aims"], memo)).toBeNull();
  expect(await refusedDraftApp(gh as unknown as GitHub, "o/aims", assets, wrong, ["aims"], memo)).toBeNull();
  expect(gh.calls).toBe(1);
  const bad = release([{ id: 8, name: ASSET, size: broken.length, state: "uploaded", digest: `sha256:${sha256(broken)}`, browser_download_url: "" }]);
  expect(await refusedDraftApp(gh as unknown as GitHub, "o/aims", assets, bad, ["aims"], memo)).toBeNull();
  expect(await refusedDraftApp(gh as unknown as GitHub, "o/aims", assets, bad, ["aims"], memo)).toBeNull();
  expect(gh.calls).toBe(2);
});

const stub = (o: Partial<EntrySources>): EntrySources => ({
  kind: "go",
  apple: true,
  goreleaser: async () => null,
  plists: async () => [],
  app: async () => null,
  workflow: null,
  file: async () => null,
  draft: async () => null,
  ...o,
});

test("when tapster cannot write the lines into the entry's text, it lists them for the owner instead", async () => {
  const entry = '- name: t\n  repo: o/t\n  binaries: [t]\n  assets: { linux-amd64: "t.tar.gz" }\n  caveats: |+\n    keep\n\n';
  const found = await deriveUpdate(entry, stub({ goreleaser: async () => 'homebrew_casks:\n  - name: t\n    homepage: "https://t.example.com"\n' }));
  expect(found).toEqual({ entry: null, from: [], manual: ['tapster cannot add these lines to the entry\'s text, so add them by hand:\nhomepage: "https://t.example.com"'] });
});

test("a command GoReleaser links from the app is carried only when it is named like the package's own", async () => {
  const cask = (bin: string) => `homebrew_casks:\n  - name: aims\n    custom_block: |\n      app "aims.app"\n    binaries: ["#{appdir}/aims.app/Contents/MacOS/${bin}"]\n`;
  const entry = '- name: aims\n  repo: o/aims\n  binaries: [aims]\n  assets: { darwin-arm64: "aims_{version}_darwin_arm64.tar.gz" }';
  const plists = async () => [plist({ CFBundleIdentifier: "com.o.aims", CFBundleExecutable: "aims" })];
  expect((await deriveUpdate(entry, stub({ goreleaser: async () => cask("aims"), plists }))).entry).toContain('binaries: ["Contents/MacOS/aims"]');
  const sudo = await deriveUpdate(entry, stub({ goreleaser: async () => cask("sudo"), plists }));
  expect(sudo.entry).not.toContain("sudo");
  expect(sudo.entry).toContain("bundle_id: com.o.aims");
  expect(sudo.manual).toEqual([
    "app.binaries: aims.app runs Contents/MacOS/sudo, which is not a command this package ships. Linking it would put a second sudo on PATH; add it under app.binaries by hand only if you mean that.",
  ]);
  expect(goreleaserCask(cask("sudo"), { bundleId: () => "com.o.aims", commands: ["aims"] }).lines).not.toContain('      binaries: ["Contents/MacOS/sudo"]');
});

const HUB = (extra: string) => `version: 1\ntap: o/tap\npackages:\n  - name: aims\n    repo: o/aims\n    binaries: [aims]\n    assets: { darwin-arm64: "aims_{version}_darwin_arm64.tar.gz" }\n${extra}`;

test("the hub refuses an app name over 64 characters and a zap path that climbs out of home", () => {
  expect(parseHub(HUB(`    app: { name: "${"a".repeat(60)}.app", bundle_id: com.o.aims }\n`), "o").invalid).toEqual([]);
  expect(parseHub(HUB(`    app: { name: "${"a".repeat(61)}.app", bundle_id: com.o.aims }\n`), "o").invalid[0]?.reason).toContain("app.name");
  expect(parseHub(HUB('    cask: { zap: { trash: ["~/../../Users/Shared"] } }\n'), "o").invalid[0]?.reason).toContain("cask.zap.trash.0");
  expect(parseHub(HUB('    cask: { zap: { trash: ["~/Library/x/.."] } }\n'), "o").invalid[0]?.reason).toContain("cask.zap.trash.0");
  expect(parseHub(HUB('    cask: { zap: { trash: ["~/.config/aims", "~/Library/..aims"] } }\n'), "o").invalid).toEqual([]);
  const climbing = goreleaserCask('homebrew_casks:\n  - name: aims\n    zap:\n      trash: ["~/.config/aims", "~/../../Users/Shared"]\n');
  expect(climbing.lines).toContain('        trash: ["~/.config/aims"]');
  expect(climbing.notes.at(-1)).toBe("not carried from GoReleaser's Homebrew section: zap.trash: ~/../../Users/Shared");
});
