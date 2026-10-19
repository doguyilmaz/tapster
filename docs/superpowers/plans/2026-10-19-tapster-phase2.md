# tapster phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub signs, packages, notarizes and publishes Sparkle apps (battistics, hafifpix, recesso) from their
ad-hoc drafts, with hub-chosen identifiers and entitlements, signed feeds and app casks.

**Architecture:** New pure modules (plist, bundle, identity, entitlements, appcast, Sparkle keys, `.DS_Store`) feed new
action steps (`package`, `seal`, `sparkle`) and extend `fetch`, `sign`, `publish` and `render`. CLI packages stay as in
phase 1. Each step keeps its own credentials.

**Tech Stack:** as phase 1 (TypeScript, Bun for tests, Node 24 bundle, `@actions/core`, `yaml`, `zod`); Apple
`codesign`, `hdiutil`, `xcrun notarytool`, `xcrun stapler`, `spctl`, `plutil`, `xattr`.

**Spec:** `docs/superpowers/specs/2026-10-19-tapster-phase2-design.md` (binding), with the phase 1 spec underneath.

**How this plan is written:** the executor is the session that wrote it. Each task gives the exact interface, the full
test file (the contract) and the implementation approach. Implementation code is written test first during execution,
not copied from this file. Tasks 2 to 5 were built test first during the phase 2 research and are recorded as done.

## Global Constraints

- Everything in the phase 1 plan's Global Constraints holds (runtime dependencies, Node-only code under `src/` except
  `src/cli/`, absolute tool paths, allowlisted child environment, `readSecret`/`register`, no `console.*` in action
  code, `TapsterError` with reason and fix, pinned actions, one-line commits).
- New tool paths: `/usr/bin/hdiutil`, `/usr/bin/xattr`, `/usr/bin/plutil`, `/usr/sbin/spctl` (`spctl` lives in sbin).
- Identifiers: the hub chooses every `--identifier` (spec §5.2). Entitlements come only from `code` (spec §5.3).
- Sparkle keys never reach argv, a file or a log. Feeds and DMGs are signed in tapster's code.
- No Finder, no AppleScript, no browsable mounts.
- Public text follows the writing rules: no em dashes, no comma before "and" or "or", no exaggeration.

## Review Focus

1. **A framework whose links chain** (`Sparkle -> Versions/Current/Sparkle`, `Current -> B`) must unpack and sign; a
   chain that leaves the archive or loops must not. Task 6.
2. **An ad-hoc helper with an embedded Info.plist** keeps the identifier tapster assigns. A tool claiming another
   app's identifier is refused. Task 8.
3. **Interrupted publish of an app** (DMG renamed, app archive not yet deleted) resumes to the same final asset set.
   Task 13.
4. **A feed signed by tapster** is accepted by Sparkle's own extraction rule (content before the last
   `<!-- sparkle-signatures:\n`, `length` equal to that content). Task 10.
5. **A Linux-only or app-only hub** renders casks that pass `brew audit` for exactly the shipped platforms. Task 15.

---

### Task 1: App packages in `tapster.yml`

**Files:** Modify `src/config.ts`; Test `tests/config-app.test.ts`.

**Interfaces:**
- `type CliPackage` (phase 1 fields, `kind: "go" | "bun"`), `type AppPackage` (spec §3 fields, `kind: "app"`),
  `type PackageConfig = CliPackage | AppPackage`, `isApp(p): p is AppPackage`.
- `parseConfig` adds the cross-package rules of spec §3.
- Every phase 1 caller that reads `binaries`, `completions`, `scoop` or `entitlements` narrows with `isApp`.

- [ ] **Step 1: Failing tests** (`tests/config-app.test.ts`)

```ts
import { expect, test } from "bun:test";
import { isApp, parseConfig } from "../src/config";
import { TapsterError } from "../src/errors";

const app = `version: 1
tap: o/tap
packages:
  - name: hafifpix
    repo: o/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.o.HafifPix
    assets:
      darwin-arm64: "HafifPix-{version}.app.tar.gz"
    dmg: { name: "HafifPix-{version}.dmg", volume: HafifPix }
    sparkle: { key: shared, public_key: "${"A".repeat(43)}=" }
    code:
      Contents/MacOS/Helper:
        identifier: com.o.HafifPix.Helper
        entitlements: { com.apple.application-identifier: "{team}.com.o.HafifPix.Helper" }
    cask: { binaries: [Contents/Resources/bin/hafif] }
`;

test("an app package parses with defaults", () => {
  const p = parseConfig(app, "o").packages[0]!;
  expect(isApp(p)).toBe(true);
  if (!isApp(p)) return;
  expect(p.sparkle!.feed).toBe("appcast.xml");
  expect(p.dmg.volume).toBe("HafifPix");
  expect(p.carry).toEqual({});
});

test.each([
  ["a Linux asset", app.replace('darwin-arm64: "HafifPix-{version}.app.tar.gz"', 'darwin-arm64: "HafifPix-{version}.app.tar.gz"\n      linux-amd64: "x.tar.gz"')],
  ["two darwin assets", app.replace('darwin-arm64: "HafifPix-{version}.app.tar.gz"', 'darwin-arm64: "a.tar.gz"\n      darwin-amd64: "b.tar.gz"')],
  ["binaries on an app", app.replace("    kind: app\n", "    kind: app\n    binaries: [x]\n")],
  ["a bad bundle id", app.replace("bundle_id: com.o.HafifPix", "bundle_id: HafifPix")],
  ["a dmg not ending in .dmg", app.replace('name: "HafifPix-{version}.dmg"', 'name: "HafifPix-{version}.zip"')],
  ["a short public key", app.replace(`"${"A".repeat(43)}="`, '"AAAA"')],
  ["a carry digest that is not sha256", app.replace("    kind: app\n", "    kind: app\n    carry: { appcast.xml: md5 }\n")],
  ["a code path that leaves the app", app.replace("Contents/MacOS/Helper:", "../Helper:")],
])("refuses %s", (_, text) => {
  expect(() => parseConfig(text, "o")).toThrow(TapsterError);
});

test("identities cannot overlap across packages", () => {
  const second = (id: string) => `${app}  - name: other
    repo: o/other
    kind: app
    app: Other.app
    bundle_id: ${id}
    assets:
      darwin-arm64: "Other-{version}.app.tar.gz"
    dmg: { name: "Other-{version}.dmg" }
`;
  expect(() => parseConfig(second("com.o.HafifPix"), "o")).toThrow(TapsterError);
  expect(() => parseConfig(second("com.o.HafifPix.Sub"), "o")).toThrow(TapsterError);
  expect(() => parseConfig(second("com.o.HafifPixel"), "o")).not.toThrow();
  const cli = `${app}  - name: tool
    repo: o/tool
    binaries: [com.o.HafifPix.Helper]
    assets:
      linux-amd64: "t.tar.gz"
`;
  expect(() => parseConfig(cli, "o")).toThrow(TapsterError);
});
```

- [ ] **Step 2:** run, see the import or assertion failures.
- [ ] **Step 3: Implement.** Zod `union` of the CLI schema (kind optional, defaulted to `go` in a `preprocess`) and the
  app schema; `superRefine` for one darwin asset and no Linux or Windows assets; cross-package rules after parsing.
  Narrow phase 1 callers (`src/action/fetch.ts`, `sign.ts`, `publish.ts`, `render.ts`, `src/render.ts`,
  `src/attest.ts`, `src/plan.ts`) with `isApp`; app packages are skipped by phase 1 code paths until later tasks.
- [ ] **Step 4:** `bun test && bun run typecheck` all green.
- [ ] **Step 5:** commit "Describe app packages in tapster.yml".

### Task 2: Property lists (done, commit "Read XML and binary property lists in tapster's own code")

`parsePlist(data: Buffer): PlistValue`; XML and binary; duplicate keys, deep nesting, self references and over 1 MiB
refused; checked against `plutil` on 415 of 416 installed bundles (the other has a duplicate key, refused on purpose).

### Task 3: Sparkle keys (done, commit "Sign Sparkle updates with either Sparkle key format")

`decodeSparkleKey(text): { publicKey: string; sign(data: Buffer): Buffer }` and `signExpanded`. RFC 8032 vectors for
both formats, a damaged 96-byte key, masking of derived forms.

### Task 4: Code discovery (done, commit "Find every piece of code inside an app in signing order"; revised in Task 7)

### Task 5: Entitlement parsing and writing (done, commit "Check and write app entitlements"; policy revised in Task 8)

### Task 6: Symlink chains and writing an app to disk

**Files:** Modify `src/archive.ts`; Create `src/extract.ts`; Test `tests/archive.test.ts`, `tests/extract.test.ts`.

**Interfaces:**
- `readTarGz` resolves symlink targets through other symlinks inside the archive (at most 40 links); rejects escapes,
  loops and entries whose own path passes through a symlink (unchanged).
- `writeTree(entries: TarEntry[], root: string): Promise<void>`: directories, then files (`flag: "wx"`, mode masked to
  `0o755`), then symlinks.

- [ ] **Step 1: Failing tests**

```ts
// tests/archive.test.ts (additions)
test("framework links that chain through other links are fine", () => {
  const entries = readTarGz(
    rawTarGz([
      { name: "S.framework/Versions/B/S", data: "x" },
      { name: "S.framework/Versions/B/Resources/Info.plist", data: "p" },
      { name: "S.framework/Versions/Current", type: "2", linkname: "B" },
      { name: "S.framework/S", type: "2", linkname: "Versions/Current/S" },
      { name: "S.framework/Resources", type: "2", linkname: "Versions/Current/Resources" },
    ]),
  );
  expect(entries.filter((e) => e.type === "symlink").length).toBe(3);
});

test.each([
  ["a chain that leaves", [{ name: "a", type: "2", linkname: "." }, { name: "b", type: "2", linkname: "a/.." }]],
  ["a loop", [{ name: "a", type: "2", linkname: "b" }, { name: "b", type: "2", linkname: "a" }, { name: "c", type: "2", linkname: "a/x" }]],
])("still rejects %s", (_, entries) => {
  expect(() => readTarGz(rawTarGz(entries))).toThrow(TapsterError);
});
```

The existing test "link target through a symlink" (`l -> s/..` with `s -> .`) keeps failing as it must, because the
resolved target leaves the archive.

```ts
// tests/extract.test.ts
import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTree } from "../src/extract";

test("writes folders, files and links, with safe modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  await writeTree(
    [
      { name: "A.app/Contents/MacOS/A", type: "file", mode: 0o4777, data: Buffer.from("x") },
      { name: "A.app/Contents", type: "dir", mode: 0o777, data: Buffer.alloc(0) },
      { name: "A.app/Contents/Link", type: "symlink", mode: 0o777, data: Buffer.alloc(0), linkname: "MacOS/A" },
    ],
    root,
  );
  expect(readFileSync(join(root, "A.app/Contents/MacOS/A"), "utf8")).toBe("x");
  expect(lstatSync(join(root, "A.app/Contents/MacOS/A")).mode & 0o7777).toBe(0o755);
  expect(readlinkSync(join(root, "A.app/Contents/Link"))).toBe("MacOS/A");
});

test("never writes into an existing file", async () => {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  const entry = { name: "x", type: "file" as const, mode: 0o644, data: Buffer.from("1") };
  await writeTree([entry], root);
  await expect(writeTree([entry], root)).rejects.toThrow();
});
```

- [ ] **Step 2–4:** red, implement (resolution walks components from the link's directory; each component that names
  a symlink of the archive is replaced by its target, counting hops), green, full suite.
- [ ] **Step 5:** commit "Resolve framework link chains and write apps to disk safely".

### Task 7: Code discovery by structure

**Files:** Modify `src/bundle.ts`; Test `tests/bundle.test.ts`.

**Interfaces:** `type CodeItem = { path: string; kind: "bundle" | "file"; bundleId: string | null }`;
`findCode(appDir)` recognizes bundles by structure (spec §5.1), returns `bundleId` from each bundle's Info.plist,
throws for `embedded.provisionprofile` anywhere and for any nested bundle whose Info.plist has `SUFeedURL` or
`SUPublicEDKey`.

- [ ] **Step 1: Failing tests** (additions to `tests/bundle.test.ts`, reusing its `tree` and `plist` helpers, with
  `plist` extended to take extra XML)

```ts
test("a bundle is found by its structure, whatever its name", () => {
  const app = tree({
    "App.app/Contents/Info.plist": plist("App"),
    "App.app/Contents/MacOS/App": MACHO,
    "App.app/Contents/Library/Spotlight/X.mdimporter/Contents/Info.plist": plist("X"),
    "App.app/Contents/Library/Spotlight/X.mdimporter/Contents/MacOS/X": MACHO,
  });
  expect(findCode(app).map((i) => `${i.kind} ${i.path}`)).toContain("bundle Contents/Library/Spotlight/X.mdimporter");
});

test("a provisioning profile or a nested Sparkle feed stops the app", () => {
  const withProfile = tree({ "App.app/Contents/Info.plist": plist("App"), "App.app/Contents/MacOS/App": MACHO, "App.app/Contents/embedded.provisionprofile": "x" });
  expect(() => findCode(withProfile)).toThrow(TapsterError);
  const nestedFeed = tree({
    "App.app/Contents/Info.plist": plist("App"),
    "App.app/Contents/MacOS/App": MACHO,
    "App.app/Contents/Helpers/H.app/Contents/Info.plist": plist("H", "<key>SUFeedURL</key><string>https://x</string>"),
    "App.app/Contents/Helpers/H.app/Contents/MacOS/H": MACHO,
  });
  expect(() => findCode(nestedFeed)).toThrow(TapsterError);
});

test("bundle identifiers come with the items", () => {
  const items = findCode(sparkleLike());
  expect(items.find((i) => i.path.endsWith("Installer.xpc"))!.bundleId).toBe("x");
  expect(items.find((i) => i.kind === "file")!.bundleId).toBeNull();
});
```

- [ ] **Step 2–4:** red, implement, green; re-run discovery on the installed Battistics, HafifPix and Recesso apps
  and compare with the research notes.
- [ ] **Step 5:** commit "Recognize bundles by their structure".

### Task 8: Identifiers and entitlements as hub policy

**Files:** Create `src/identity.ts`; Modify `src/entitlements.ts`; Test `tests/identity.test.ts`,
`tests/entitlements.test.ts`.

**Interfaces:**
- `identifierFor(item: CodeItem, pkg: AppPackage): string` (spec §5.2).
- `entitlementsFor(path: string, found: Entitlements, pkg: AppPackage, team: string): { entitlements: Entitlements;
  dropped: string[] }` (spec §5.3; `dropped` lists `get-task-allow`).

- [ ] **Step 1: Failing tests**

```ts
// tests/identity.test.ts
import { expect, test } from "bun:test";
import { identifierFor } from "../src/identity";
import { parseConfig, isApp, type AppPackage } from "../src/config";
import { TapsterError } from "../src/errors";

const pkg = parseConfig(`version: 1
tap: o/tap
packages:
  - name: b
    repo: o/b
    kind: app
    app: B.app
    bundle_id: com.o.B
    assets: { darwin-arm64: "B-{version}.app.tar.gz" }
    dmg: { name: "B-{version}.dmg" }
    code:
      Contents/MacOS/Helper: { identifier: com.o.B.PowerHelper }
`, "o").packages[0] as AppPackage;

test("the app, nested bundles and loose code get hub identifiers", () => {
  expect(identifierFor({ path: ".", kind: "bundle", bundleId: "com.o.B" }, pkg)).toBe("com.o.B");
  expect(identifierFor({ path: "Contents/PlugIns/X.appex", kind: "bundle", bundleId: "com.o.B.X" }, pkg)).toBe("com.o.B.X");
  expect(identifierFor({ path: "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc", kind: "bundle", bundleId: "org.sparkle-project.InstallerLauncher" }, pkg)).toBe("org.sparkle-project.InstallerLauncher");
  expect(identifierFor({ path: "Contents/MacOS/Helper", kind: "file", bundleId: null }, pkg)).toBe("com.o.B.PowerHelper");
  expect(identifierFor({ path: "Contents/Resources/bin/hafif", kind: "file", bundleId: null }, pkg)).toBe("com.o.B.hafif");
});

test.each([
  ["another app's id on a nested bundle", { path: "Contents/PlugIns/X.appex", kind: "bundle" as const, bundleId: "com.o.Other" }],
  ["Sparkle's prefix outside Sparkle", { path: "Contents/PlugIns/X.appex", kind: "bundle" as const, bundleId: "org.sparkle-project.X" }],
  ["an app whose id is not bundle_id", { path: ".", kind: "bundle" as const, bundleId: "com.o.Other" }],
])("refuses %s", (_, item) => {
  expect(() => identifierFor(item, pkg)).toThrow(TapsterError);
});
```

```ts
// tests/entitlements.test.ts (replaces the policy tests of Task 5)
test("entitlements come only from config; the build cannot add one", () => {
  const p = { code: { "Contents/MacOS/Helper": { entitlements: { "com.apple.application-identifier": "{team}.com.o.B.Helper" } } } } as never;
  expect(entitlementsFor("Contents/MacOS/Helper", {}, p, "TEAM000001").entitlements).toEqual({ "com.apple.application-identifier": "TEAM000001.com.o.B.Helper" });
  expect(entitlementsFor("Contents/MacOS/Helper", { "com.apple.application-identifier": "TEAM000001.com.o.B.Helper" }, p, "TEAM000001").dropped).toEqual([]);
  expect(() => entitlementsFor("Contents/MacOS/Helper", { "com.apple.application-identifier": "OTHER.x" }, p, "TEAM000001")).toThrow(TapsterError);
  expect(() => entitlementsFor("Contents/MacOS/App", { "com.apple.security.network.client": true }, p, "TEAM000001")).toThrow(TapsterError);
  expect(entitlementsFor("Contents/MacOS/App", { "com.apple.security.get-task-allow": true }, p, "TEAM000001")).toEqual({ entitlements: {}, dropped: ["com.apple.security.get-task-allow"] });
});
```

- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit "Choose identifiers and entitlements in the hub".

### Task 9: Signing an app

**Files:** Create `src/appsign.ts`; Test `tests/appsign.test.ts` (macOS only).

**Interfaces:**
- `readEntitlements(path: string): Promise<Entitlements>` (`codesign -d --entitlements - --xml`).
- `signApp(kc: Keychain, appDir: string, pkg: AppPackage, team: string, timestamp?: boolean): Promise<{ identifiers:
  string[]; dropped: string[] }>`: discovery, identifiers, entitlements, `codesign` inside out. `timestamp` is true in
  the action; the macOS test passes `false` with an ad-hoc identity, because Apple's timestamp server refuses ad-hoc
  signatures.
- `verifyApp(appDir: string, items: string[], identifiers: string[], team: string): Promise<void>`.

- [ ] **Step 1: Failing test** builds `T.app` with `clang`: `Contents/MacOS/T`, a helper with an embedded Info.plist
  (`-sectcreate __TEXT __info_plist`), `Contents/Frameworks/libz.dylib`, `Contents/Resources/bin/tool`, and
  `Contents/Frameworks/F.framework/Versions/A/{F, Resources/Info.plist, XPCServices/X.xpc}` with `Current -> A` and
  `F -> Versions/Current/F`. It signs ad hoc first (as a project build would), packs it with `writeTarGz`, reads it
  back through `readTarGz` and `writeTree`, then `signApp` with `{ identity: "-" }` and `timestamp: false`. It checks:
  `codesign --verify --strict --deep T.app` succeeds and `codesign -dv` reports the identifiers `com.t.T`,
  `com.t.T.Helper` (from `code`), `com.t.T.libz.dylib`, `com.t.T.tool` and the XPC's bundle id.
- [ ] **Step 2–4:** red, implement, green on this Mac; CI's macOS job runs it.
- [ ] **Step 5:** commit "Sign apps inside out under hub identifiers".

### Task 10: Appcast and signed feed

**Files:** Create `src/appcast.ts`, `tests/golden/hafifpix.appcast.xml`; Test `tests/appcast.test.ts`.

**Interfaces:** `type AppcastInput = { title: string; version: string; shortVersion: string; minimumSystemVersion:
string; arm64Only: boolean; url: string; length: number; edSignature: string; pubDate: Date }`,
`renderAppcast(i: AppcastInput): string`, `signFeed(feed: string, sign: (b: Buffer) => Buffer): string`,
`extractFeed(signed: string): { content: Buffer; signature: string; length: number }` (Sparkle's rule, used by tests
and by the publish check).

- [ ] **Step 1: Failing tests:** golden appcast; hostile values escaped or refused (`<`, `&` in title; version not
  matching `^\d+(\.\d+)*$`); `signFeed` output passes `extractFeed` with `length` equal to the content length and the
  signature verifying against the key's public half; RFC 822 `pubDate` (`Sun, 19 Oct 2026 10:00:00 +0000`).
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit "Render and sign Sparkle feeds".

### Task 11: `.DS_Store` for the DMG window

**Files:** Create `src/dsstore.ts`; Test `tests/dsstore.test.ts`.

**Interfaces:** `type DmgLayout = { window: [number, number, number, number]; icon_size: number; app: [number, number];
applications: [number, number] }`, `dsStore(layout: DmgLayout, appName: string): Buffer` (Buddy allocator file with
one B-tree leaf: `bwsp` and `icvp` binary plists for the root, `Iloc` for the app and `Applications`).

- [ ] **Step 1: Failing tests:** header magic `00 00 00 01 'Bud1'`; the records are sorted by file name then type; a
  round trip through a minimal reader in the test returns the window bounds, icon size and both positions; output is
  deterministic.
- [ ] **Step 2–4:** red, implement, green. Check one generated file with the Python `ds_store` reader in a throwaway
  virtual environment on this Mac.
- [ ] **Step 5:** commit "Write the DMG window layout without Finder".

### Task 12: DMG build and seal

**Files:** Create `src/dmg.ts`; Modify `src/run.ts` (tools); Test `tests/dmg.test.ts` (macOS only).

**Interfaces:** `buildDmg(appDir: string, out: string, opts: { volume: string; volumeIcon: string | null; layout:
DmgLayout | null }): Promise<void>` (spec §4.1) and `sealDmg(kc: Keychain, dmg: string, key: NotaryKey):
Promise<void>` (spec §4.2).

- [ ] **Step 1: Failing test** builds a DMG from the Task 9 test app (ad-hoc), attaches it read-only and checks the
  app, the `Applications` link, `.metadata_never_index`, `.DS_Store` and `.VolumeIcon.icns` exist and that the volume
  root carries the custom-icon flag; `hdiutil imageinfo` reports `UDZO`.
- [ ] **Step 2–4:** red, implement (retry `hdiutil create` three times), green.
- [ ] **Step 5:** commit "Build and seal DMGs without Finder".

### Task 13: Publishing apps

**Files:** Modify `src/publish.ts`, `src/state.ts`; Test `tests/publish.test.ts`, `tests/state.test.ts`.

**Interfaces:** `stageAndSwap(gh, repo, releaseId, files, before, remove: string[] = [])`; the swap order of spec §7;
`resumeSwap` deletes every non-staging asset that is neither listed in the staged `checksums.txt` nor the file itself;
`StateEntry` gains optional `app: { macos: string; identifiers: string[] }`.

- [ ] **Step 1: Failing tests:** the swap order for an app (`upload` ×3, rename DMG, rename feed, delete app archive,
  delete old checksums, rename checksums); resume after the DMG rename removes the archive and finishes; a state entry
  with `app` round-trips and an entry without it still parses.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit "Swap app outputs in and drop the unsigned archive".

### Task 14: Action steps for apps

**Files:** Modify `src/workdir.ts`, `src/action/{fetch,sign,publish,main}.ts`, `action.yml`,
`templates/hub/tapster.yml`; Create `src/action/{package,seal,sparkle}.ts`; Test `tests/modes-app.test.ts`.

**Interfaces:** manifest items gain `app?: { dir: string; dmg: string | null; feed: string | null; facts: AppFacts }`
and statuses `fetched → signed → packaged → sealed → sparkled`; `AppFacts = { version: string; build: string;
minimumSystemVersion: string; macos: string; publicKey: string | null; feedUrl: string | null; requireSignedFeed:
boolean }`. Modes `package`, `seal` and `sparkle` act only on app items and pass CLI items through. The hub template
gains the three steps with `!cancelled()` and a `__SPARKLE_ENV__` block.

- [ ] **Step 1: Failing tests:** `appFacts(plist, plutilValue)` refuses a version mismatch, a wrong bundle id, a feed
  URL for another repo, a public key differing from the pin, `SURequireSignedFeed` missing and a disagreement with
  `plutil`; `carryCheck(release, pkg)` refuses an unpinned asset, a digest mismatch and a carried Mach-O; the package,
  seal and sparkle modes pass a CLI-only manifest through without reading credentials; the template test of phase 1
  extends to the new steps.
- [ ] **Step 2–4:** red, implement, green; build the bundle and load it in Node.
- [ ] **Step 5:** commit "Run apps through fetch, sign, package, seal, sparkle and publish".

### Task 15: App casks

**Files:** Modify `src/render.ts`, `src/action/render.ts`; Create `tests/golden/hafifpix.rb`; Test
`tests/render.test.ts`.

**Interfaces:** `renderAppCask(i: { pkg: AppPackage; version: string; sha256: string; macos: string; description:
string; homepage: string }): string` (spec §8.1); render uses the state entry's `app.macos`.

- [ ] **Step 1: Failing test:** golden `hafifpix.rb`; `binary "#{appdir}/HafifPix.app/Contents/Resources/bin/hafif"`;
  `depends_on macos: :sequoia`; arm64 only gives `depends_on arch: :arm64`.
- [ ] **Step 2–4:** red, implement, green; `brew style` and `brew audit --arch arm` on the golden in the scratch tap.
- [ ] **Step 5:** commit "Render app casks".

### Task 16: CLI for apps

**Files:** Modify `src/cli/{init,doctor,add}.ts`; Create `templates/project/app-release.yml`; Test
`tests/init.test.ts`, `tests/add.test.ts`, `tests/doctor.test.ts`.

**Interfaces:** `init --sparkle <label> --account <account>`, `init --workflow`; `sparkleEnv(labels: string[]): string`
renders the workflow block; `appWorkflow(build: string, appPath: string, pins): string`; `doctor` checks labels against
secrets and the workflow.

- [ ] **Step 1: Failing tests:** `sparkleEnv(["shared", "recesso"])` gives `SPARKLE_KEY_SHARED: ${{ secrets.SPARKLE_KEY_SHARED }}`
  and the same for `RECESSO`; the app template's build job has `contents: read`, the release job alone writes, and
  both triggers exist; `add` in a directory with `project.yml` and an Info.plist holding `SUFeedURL` prints an app
  entry with the feed and the public key.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit "Set up Sparkle keys and app projects from the CLI".

### Task 17: Feed watch in check

**Files:** Modify `src/action/check.ts`; Test `tests/modes-app.test.ts`.

**Interfaces:** `feedWarning(latest: Release | null, state: State, pkg: AppPackage): string | null`.

- [ ] **Step 1: Failing test:** a latest release that is not a published state entry gives a warning naming it; one
  that is gives none.
- [ ] **Step 2–5:** implement, green, commit "Warn when an app's latest release did not come from the hub".

### Task 18: Leak test for Sparkle keys

**Files:** Modify `.github/workflows/leak.yml`, `tests/leak/*`.

- [ ] Plain run: a generated seed key and a 96-byte key as canaries; a fake app item reaches the sparkle step for a
  key mismatch, a malformed key and success. Masked run: the same with secrets. Stage markers for all three. Prove it
  fails with a deliberate print on a scratch branch.
- [ ] Commit "Cover the Sparkle keys in the leak test".

### Task 19: Documentation

- [ ] README section for apps; `docs/e2e.md` steps for the Sparkle fixture; commit "Explain app releases".

### Task 20 (owner): End to end and migration

As spec §10 (end to end) and §11. Needs the owner's keys, clicks and approval for each release.
