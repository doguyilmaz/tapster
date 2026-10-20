import { expect, test } from "bun:test";
import { parse } from "yaml";
import { adaptGoreleaser, adaptReleaseWorkflow, addOptions, appEntry, appWorkflow, bunWorkflow, findApp, prepare } from "../src/cli/add";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  expect(steps[1].if).toBe("${{ !github.event.repository.private }}");
  expect(steps[1]["continue-on-error"]).toBeUndefined();
  expect(text).toContain(`actions/attest-build-provenance@${pins["actions/attest-build-provenance"].sha} # v3`);
  expect(y.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
});

test("bun workflow builds every target and drafts the release", () => {
  const flow = bunWorkflow("konvoy", "src/cli.ts", pins);
  expect(flow).toContain("--draft");
  expect(flow).toContain('$( [ "${TAG#*-}" != "$TAG" ] && echo --prerelease )');
  expect(flow).toContain('tags: ["v[0-9]+.[0-9]+.[0-9]+", "v[0-9]+.[0-9]+.[0-9]+-*"]');
  expect(flow).toContain("bun build src/cli.ts --compile");
  expect(flow).not.toContain("__");
  expect(flow).not.toContain("secrets.");
  expect(flow).toContain("subject-checksums: dist/checksums.txt");
  type Job = { permissions: Record<string, string>; steps: { uses?: string; run?: string; if?: string; "continue-on-error"?: string }[] };
  const jobs = (parse(flow) as { jobs: { build: Job; release: Job } }).jobs;
  expect(jobs.build.permissions).toEqual({ contents: "read" });
  expect(jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  expect(jobs.build.steps.some((s) => (s.run ?? "").includes("bun install"))).toBe(true);
  for (const s of jobs.release.steps) {
    expect(s.run ?? "").not.toContain("bun ");
    if (s.uses) expect(s.uses).toMatch(/^actions\/(checkout|download-artifact|attest-build-provenance)@/);
  }
  const attest = jobs.release.steps.find((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@"))!;
  expect(attest.if).toBe("${{ !github.event.repository.private }}");
  expect(attest["continue-on-error"]).toBeUndefined();
  expect(flow).toContain('tar -C "dist/$t" -czf "out/konvoy_${v}_${p/-/_}.tar.gz" konvoy');
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

test("running add twice adds one attestation step and one ring step", () => {
  const once = adaptReleaseWorkflow(goFlow, "a".repeat(40), "v4").text;
  const twice = adaptReleaseWorkflow(once, "a".repeat(40), "v4");
  expect(parse(twice.text).jobs.release.steps.length).toBe(3);
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
  await expect(prepare(dir, "o/tool", "tool", addOptions([]))).rejects.toBeInstanceOf(TapsterError);
  expect(readFileSync(join(dir, ".github/workflows/release.yml"), "utf8")).toBe("mine\n");
});

test("workflow-level and write-all permissions are respected", () => {
  const top = goFlow.replace("    permissions: { contents: write, packages: write }\n", "").replace("jobs:", "permissions: { contents: write, pages: write }\njobs:");
  expect(parse(adaptReleaseWorkflow(top, "a".repeat(40), "v4").text).jobs.release.permissions).toEqual({ contents: "write", pages: "write", "id-token": "write", attestations: "write" });
  const all = goFlow.replace("permissions: { contents: write, packages: write }", "permissions: write-all");
  expect(parse(adaptReleaseWorkflow(all, "a".repeat(40), "v4").text).jobs.release.permissions).toBe("write-all");
});

test("the app template builds without write access and only the release job writes", () => {
  const text = appWorkflow({ build: "make app", appPath: "dist/Battistics.app", runner: "macos-26", carry: ["scripts/legacy-appcast.xml:appcast.xml"] }, pins);
  expect(text).not.toContain("__");
  const flow = parse(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { permissions: Record<string, string>; "runs-on": string; steps: { uses?: string; run?: string; if?: string }[] }> };
  expect(Object.keys(flow.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(flow.permissions).toEqual({});
  expect(flow.jobs.build!.permissions).toEqual({ contents: "read" });
  expect(flow.jobs.build!["runs-on"]).toBe("macos-26");
  expect(flow.jobs.release!.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  expect(flow.jobs.build!.steps[0]!.if).toContain("github.ref_type != 'tag'");
  expect(JSON.stringify(flow.jobs.build)).not.toContain("secrets.");
  expect(flow.jobs.build!.steps.map((s) => s.run ?? "").join("\n")).toContain("make app");
  const release = flow.jobs.release!.steps.map((s) => `${s.uses ?? ""} ${s.run ?? ""}`).join("\n");
  expect(release).toContain('cp "scripts/legacy-appcast.xml" "dist/appcast.xml"');
  expect(release).toContain(`actions/attest-build-provenance@${pins["actions/attest-build-provenance"].sha}`);
  expect(release).not.toContain("make app");
  const attest = flow.jobs.release!.steps.find((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@")) as { if?: string; "continue-on-error"?: string };
  expect(attest.if).toBe("${{ !github.event.repository.private }}");
  expect(attest["continue-on-error"]).toBeUndefined();
});

test("add finds an XcodeGen app with Sparkle and prints its hub entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  writeFileSync(
    join(dir, "project.yml"),
    `name: Battistics
settings: { base: { ARCHS: arm64 } }
targets:
  BattisticsCLI: { type: tool, settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: com.o.Battistics.CLI } } }
  Battistics:
    type: application
    info:
      path: Sources/Info.plist
      properties:
        SUFeedURL: https://github.com/o/battistics/releases/latest/download/appcast-2.xml
        SUPublicEDKey: ${"A".repeat(43)}=
    settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: com.o.Battistics, PRODUCT_NAME: Battistics } }
`,
  );
  writeFileSync(join(dir, "Makefile"), "APP = dist/Battistics.app\n\napp: gen\n\txcodebuild\n");
  const found = findApp(dir)!;
  expect(found).toEqual({ name: "Battistics", bundleId: "com.o.Battistics", feed: "appcast-2.xml", publicKey: `${"A".repeat(43)}=`, universal: false, build: "make app", appPath: "dist/Battistics.app" });
  const entry = appEntry("battistics", "o/battistics", found);
  expect(entry).toContain("    kind: app\n    app: Battistics.app\n    bundle_id: com.o.Battistics\n");
  expect(entry).toContain('      darwin-arm64: "Battistics-{version}.app.tar.gz"');
  expect(entry).toContain("      feed: appcast-2.xml\n");
  expect(entry).toContain(`      public_key: "${"A".repeat(43)}="`);
  expect(findApp(mkdtempSync(join(tmpdir(), "none-")))).toBeNull();
  writeFileSync(join(dir, "Makefile"), "APP = dist/Battistics Pro.app\n\napp: gen\n\txcodebuild\n");
  const renamed = appEntry("battistics", "o/battistics", findApp(dir)!);
  expect(renamed).toContain("    app: Battistics Pro.app\n");
  expect(renamed).toContain('"Battistics Pro-{version}.app.tar.gz"');
});

test("an Info.plist with a feed is not an app project without a project file", () => {
  const dir = mkdtempSync(join(tmpdir(), "loose-"));
  mkdirSync(join(dir, "fixtures"));
  writeFileSync(join(dir, "fixtures", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>SUFeedURL</key><string>https://github.com/o/x/releases/latest/download/appcast.xml</string></dict></plist>`);
  expect(findApp(dir)).toBeNull();
});

test("add finds a plain Info.plist with a feed when there is no project.yml", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  mkdirSync(join(dir, "Recesso.xcodeproj"));
  mkdirSync(join(dir, "Recesso"));
  writeFileSync(
    join(dir, "Recesso", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string><key>SUFeedURL</key><string>https://github.com/o/recesso/releases/latest/download/appcast.xml</string><key>SUPublicEDKey</key><string>${"B".repeat(43)}=</string></dict></plist>`,
  );
  writeFileSync(join(dir, "Recesso.xcodeproj", "project.pbxproj"), "PRODUCT_BUNDLE_IDENTIFIER = com.o.Recesso;\nPRODUCT_BUNDLE_IDENTIFIER = com.o.RecessoTests;\n");
  const found = findApp(dir)!;
  expect(found.name).toBe("Recesso");
  expect(found.bundleId).toBe("com.o.Recesso");
  expect(found.feed).toBe("appcast.xml");
  expect(found.build).toBeNull();
  expect(appEntry("recesso", "o/recesso", found)).not.toContain("feed:");
});

test("a release workflow missing only the ring step gets it without --force", async () => {
  const { addRingStep } = await import("../src/cli/add");
  const full = bunWorkflow("tool", "src/cli.ts", pins);
  const withoutRing = full.slice(0, full.indexOf("      - name: Ring the tapster hub"));
  const fixed = addRingStep(withoutRing)!;
  expect(fixed).not.toBeNull();
  expect(parse(fixed).jobs.release.steps.at(-1).name).toBe("Ring the tapster hub");
  expect(addRingStep(full)).toBe(full);
  expect(addRingStep("mine\n")).toBeNull();
});

test("a hub without Apple credentials gets a Bun workflow without macOS builds", () => {
  const flow = bunWorkflow("tool", "src/cli.ts", pins, false);
  expect(flow).not.toContain("darwin");
  expect(flow).toContain("for t in linux-arm64 linux-x64 windows-x64; do");
  expect(bunWorkflow("tool", "src/cli.ts", pins)).toContain("darwin-arm64 darwin-x64");
});

test("a Mac app is refused before anything changes when the hub has no Apple credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "add-"));
  mkdirSync(join(dir, "App"), { recursive: true });
  writeFileSync(join(dir, "project.yml"), "name: App\ntargets:\n  App:\n    type: application\n    info:\n      properties:\n        SUFeedURL: https://github.com/o/app/releases/latest/download/appcast.xml\n");
  await expect(prepare(dir, "o/app", "app", addOptions([]), false)).rejects.toThrow("has no Apple credentials, which a Mac app needs");
  expect(existsSync(join(dir, ".github"))).toBe(false);
});
