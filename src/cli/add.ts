import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isMap, isSeq, parse, parseDocument, type Scalar, YAMLMap } from "yaml";
import { BUNDLE_ID } from "../config";
import { TapsterError } from "../errors";
import { parsePlist } from "../plist";
import { ringStep } from "./doorbell";
import pinsJson from "../../templates/pins.json";
import appTemplate from "../../templates/project/app-release.yml" with { type: "text" };
import bunTemplate from "../../templates/project/bun-release.yml" with { type: "text" };
import { currentRepo, userGitHub } from "./gh";

type Pins = typeof pinsJson;

export function adaptGoreleaser(text: string): { text: string; notes: string[] } {
  const doc = parseDocument(text);
  const notes: string[] = [];
  doc.setIn(["release", "draft"], true);
  notes.push("release.draft: true; the tapster hub publishes after signing");
  doc.setIn(["checksum", "name_template"], "checksums.txt");
  notes.push("checksum.name_template: checksums.txt; the hub reads this name");
  for (const key of ["notarize", "homebrew_casks", "brews", "scoops"]) {
    if (doc.has(key)) {
      doc.delete(key);
      notes.push(`removed ${key}; the hub does this now`);
    }
  }
  return { text: doc.toString(), notes };
}

const jobMap = (job: { value: unknown }) => job.value as YAMLMap;
const RING_NAME = "Ring the tapster hub";

export function adaptReleaseWorkflow(text: string, attestSha: string, attestTag: string): { text: string; notes: string[] } {
  const doc = parseDocument(text);
  const notes: string[] = [];
  const jobs = doc.get("jobs");
  if (!isMap(jobs)) throw new TapsterError("the release workflow has no jobs", "Add the GoReleaser job first.");
  for (const job of jobs.items) {
    const steps = (job.value as YAMLMap).get("steps");
    if (!isSeq(steps)) continue;
    const index = steps.items.findIndex((s) => isMap(s) && String(s.get("uses") ?? "").startsWith("goreleaser/goreleaser-action"));
    if (index === -1) continue;
    const step = steps.items[index] as YAMLMap;
    const env = step.get("env");
    if (isMap(env)) {
      for (const item of [...env.items]) {
        const key = String((item.key as { value?: unknown }).value ?? item.key);
        if (/^(MACOS_|HOMEBREW_TAP_)/.test(key)) {
          env.delete(key);
          notes.push(`removed ${key} from the GoReleaser step`);
        }
      }
    }
    const already = steps.items.some((st) => isMap(st) && String(st.get("uses") ?? "").startsWith("actions/attest-build-provenance@"));
    const map = jobMap(job);
    const own = map.get("permissions");
    const top = doc.get("permissions");
    const base = own ?? top;
    if (base !== "write-all") {
      const merged: Record<string, string> = isMap(base) ? (base.toJSON() as Record<string, string>) : {};
      map.set("permissions", doc.createNode({ ...merged, contents: "write", "id-token": "write", attestations: "write" }));
    }
    if (already) notes.push("the attestation step is already there; permissions checked");
    else {
      const attest = doc.createNode({ name: "Attest the archives for tapster", uses: `actions/attest-build-provenance@${attestSha}`, "continue-on-error": "${{ github.event.repository.private }}", with: { "subject-checksums": "dist/checksums.txt" } });
      (attest.get("uses", true) as Scalar).comment = ` ${attestTag}`;
      steps.items.splice(index + 1, 0, attest as never);
      notes.push(`added the attestation step (actions/attest-build-provenance ${attestTag}) and its permissions`);
    }
    if (!steps.items.some((st) => isMap(st) && st.get("name") === RING_NAME)) {
      steps.items.push(doc.createNode((parse(ringStep(0)) as unknown[])[0]) as never);
      notes.push("added the step that rings the hub's doorbell after the draft is open");
    }
    return { text: doc.toString(), notes };
  }
  throw new TapsterError("no GoReleaser step found in the release workflow", "tapster add edits the job that runs goreleaser/goreleaser-action.");
}


export function bunWorkflow(name: string, entry: string, pins: Pins): string {
  return bunTemplate
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__SETUP_BUN_SHA__", pins["oven-sh/setup-bun"].sha)
    .replaceAll("__SETUP_BUN_TAG__", pins["oven-sh/setup-bun"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__NAME__", name)
    .replaceAll("__ENTRY__", entry)
    .replace("__RING__\n", `${ringStep(6)}\n`);
}

const PLATFORM: Record<string, string> = {
  darwin_universal: "darwin-universal",
  darwin_all: "darwin-universal",
  darwin_arm64: "darwin-arm64",
  darwin_amd64: "darwin-amd64",
  linux_arm64: "linux-arm64",
  linux_amd64: "linux-amd64",
  windows_amd64: "windows-amd64",
  windows_arm64: "windows-arm64",
};

export function inferEntry(name: string, repo: string, assets: string[], version: string, kind: "go" | "bun"): string {
  const lines = [`  - name: ${name}`, `    repo: ${repo}`, ...(kind === "bun" ? ["    kind: bun"] : []), `    binaries: [${name}]`, "    assets:"];
  let windows = false;
  for (const a of assets) {
    const key = Object.keys(PLATFORM).find((k) => a.includes(k));
    if (!key) continue;
    lines.push(`      ${PLATFORM[key]}: "${a.replaceAll(version, "{version}")}"`);
    if (key.startsWith("windows")) windows = true;
  }
  if (windows) lines.push("    scoop: true");
  return lines.join("\n");
}

export type FoundApp = { name: string; bundleId: string | null; feed: string; publicKey: string | null; universal: boolean; build: string | null; appPath: string | null };

const SKIP = new Set([".git", ".build", "build", "dist", "DerivedData", "node_modules", "Pods", "Carthage"]);
const literal = (v: unknown) => (typeof v === "string" && !v.includes("$(") ? v : null);
const feedName = (url: unknown) => (typeof url === "string" ? /\/releases\/latest\/download\/([A-Za-z0-9._-]+\.xml)$/.exec(url)?.[1] ?? null : null);

function infoPlists(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink() || SKIP.has(e.name) || e.name.endsWith(".app") || e.name.endsWith(".xcodeproj")) continue;
    if (e.isDirectory()) out.push(...infoPlists(join(dir, e.name), depth + 1));
    else if (e.name === "Info.plist") out.push(join(dir, e.name));
  }
  return out;
}

function makeTarget(dir: string): { build: string | null; appPath: string | null } {
  const make = existsSync(join(dir, "Makefile")) ? readFileSync(join(dir, "Makefile"), "utf8") : "";
  return { build: /^app:/m.test(make) ? "make app" : null, appPath: /^APP\s*:?=\s*([^\s].*?\.app)\s*$/m.exec(make)?.[1] ?? null };
}

export function findApp(dir: string): FoundApp | null {
  const top = readdirSync(dir);
  if (!top.some((f) => f === "project.yml" || f === "Package.swift" || f.endsWith(".xcodeproj"))) return null;
  const make = makeTarget(dir);
  if (existsSync(join(dir, "project.yml"))) {
    const project = parse(readFileSync(join(dir, "project.yml"), "utf8")) as { settings?: { base?: Record<string, unknown> }; targets?: Record<string, Record<string, unknown>> };
    for (const [target, t] of Object.entries(project?.targets ?? {})) {
      if (t.type !== "application") continue;
      const props = ((t.info as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>;
      const feed = feedName(props.SUFeedURL);
      if (!feed) continue;
      const base = { ...(project.settings?.base ?? {}), ...((t.settings as { base?: Record<string, unknown> } | undefined)?.base ?? {}) };
      return {
        name: literal(base.PRODUCT_NAME) ?? target,
        bundleId: literal(base.PRODUCT_BUNDLE_IDENTIFIER),
        feed,
        publicKey: literal(props.SUPublicEDKey),
        universal: String(base.ARCHS ?? "").includes("x86_64"),
        ...make,
      };
    }
  }
  const xcodeproj = top.find((f) => f.endsWith(".xcodeproj"));
  for (const path of infoPlists(dir)) {
    let info: Record<string, unknown>;
    try {
      info = parsePlist(readFileSync(path)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const feed = feedName(info.SUFeedURL);
    if (!feed) continue;
    const pbx = xcodeproj && existsSync(join(dir, xcodeproj, "project.pbxproj")) ? readFileSync(join(dir, xcodeproj, "project.pbxproj"), "utf8") : "";
    const fromPbx = /PRODUCT_BUNDLE_IDENTIFIER = "?([A-Za-z0-9.-]+)"?;/.exec(pbx)?.[1] ?? null;
    return {
      name: literal(info.CFBundleName) ?? (xcodeproj ? basename(xcodeproj, ".xcodeproj") : basename(dir)),
      bundleId: literal(info.CFBundleIdentifier) ?? fromPbx,
      feed,
      publicKey: literal(info.SUPublicEDKey),
      universal: /ARCHS = [^;]*x86_64/.test(pbx),
      ...make,
    };
  }
  return null;
}

export function appEntry(name: string, repo: string, found: FoundApp): string {
  const app = { ...found, name: found.appPath ? basename(found.appPath, ".app") : found.name };
  const lines = [
    `  - name: ${name}`,
    `    repo: ${repo}`,
    "    kind: app",
    `    app: ${app.name}.app`,
    `    bundle_id: ${app.bundleId && BUNDLE_ID.test(app.bundleId) ? app.bundleId : "<bundle id>"}`,
    "    assets:",
    `      ${app.universal ? "darwin-universal" : "darwin-arm64"}: "${app.name}-{version}.app.tar.gz"`,
    "    dmg:",
    `      name: "${app.name}-{version}.dmg"`,
    "    sparkle:",
    `      key: ${name.replace(/[^a-z0-9]/g, "")}`,
    ...(app.feed === "appcast.xml" ? [] : [`      feed: ${app.feed}`]),
    `      public_key: "${app.publicKey ?? "<SUPublicEDKey>"}"`,
  ];
  return lines.join("\n");
}

export type AppBuild = { build: string; appPath: string; runner: string; carry: string[] };

export function appWorkflow(b: AppBuild, pins: Pins): string {
  if (/[\r\n]/.test(b.build)) throw new TapsterError("the build command must be one line", "Wrap several steps in a make target or a script.");
  if (!/^[A-Za-z0-9 ._\/-]+\.app$/.test(b.appPath)) throw new TapsterError(`${b.appPath} is not a path to an .app`, "Pass the path the build writes the app to.");
  if (!/^macos-[0-9a-z.-]+$/.test(b.runner)) throw new TapsterError(`${b.runner} is not a macOS runner`, "Use a runner like macos-15.");
  const carry = b.carry.map((c) => {
    const [from, to] = c.split(":");
    if (!from || !to || !/^[A-Za-z0-9._\/-]+$/.test(from) || !/^[A-Za-z0-9._-]+$/.test(to)) throw new TapsterError(`${c} is not <path>:<asset name>`, "Name each carried file as path:name.");
    return `          cp "${from}" "dist/${to}"`;
  });
  return appTemplate
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__UPLOAD_SHA__", pins["actions/upload-artifact"].sha)
    .replaceAll("__UPLOAD_TAG__", pins["actions/upload-artifact"].tag)
    .replaceAll("__DOWNLOAD_SHA__", pins["actions/download-artifact"].sha)
    .replaceAll("__DOWNLOAD_TAG__", pins["actions/download-artifact"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__RUNNER__", b.runner)
    .replaceAll("__BUILD__", b.build)
    .replaceAll("__APP_PATH__", b.appPath)
    .replaceAll("__APP_NAME__", basename(b.appPath, ".app"))
    .replace("__CARRY__\n", carry.map((l) => `${l}\n`).join(""))
    .replace("__RING__\n", `${ringStep(6)}\n`);
}

async function addApp(dir: string, repo: string, name: string, app: FoundApp, force: boolean): Promise<void> {
  const flow = join(dir, ".github/workflows/release.yml");
  if (existsSync(flow) && !force) {
    throw new TapsterError(".github/workflows/release.yml already exists", "Move it aside and run tapster add again. To replace it, run tapster add --force.");
  }
  const build = app.build ?? `echo "Set the build command in .github/workflows/release.yml" && exit 1`;
  const appPath = app.appPath ?? `build/${app.name}.app`;
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  await writeFile(flow, appWorkflow({ build, appPath, runner: "macos-15", carry: [] }, pinsJson));
  console.log(`- wrote .github/workflows/release.yml (build with "${build}", pack ${appPath}, attest, draft)`);
  if (!app.build || !app.appPath) console.log("- set the build command and the app path in that file; the build must sign the app ad hoc");
  console.log("- the app must set SURequireSignedFeed and SUVerifyUpdateBeforeExtraction to true and stamp both version keys with the tag");
  console.log("- to attach files the hub carries unchanged, add cp lines to the release job and list them under carry in tapster.yml");
  console.log("\nAdd this to the hub's tapster.yml under packages:\n");
  console.log(appEntry(name, repo, app));
  console.log(`\nThen store the Sparkle key in the hub with tapster init --sparkle ${name.replace(/[^a-z0-9]/g, "")}.`);
}

export async function add(args: string[]): Promise<void> {
  const dir = process.cwd();
  const repo = await currentRepo(dir);
  const name = repo.split("/")[1]!.toLowerCase();
  const app = findApp(dir);
  if (app) return addApp(dir, repo, name, app, args.includes("--force"));
  const goreleaser = [".goreleaser.yaml", ".goreleaser.yml"].find((f) => existsSync(join(dir, f)));
  const isBun = existsSync(join(dir, "package.json")) && (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")));
  let kind: "go" | "bun";
  if (goreleaser && existsSync(join(dir, "go.mod"))) {
    kind = "go";
    const g = adaptGoreleaser(await readFile(join(dir, goreleaser), "utf8"));
    await writeFile(join(dir, goreleaser), g.text);
    const flowPath = join(dir, ".github/workflows/release.yml");
    if (!existsSync(flowPath)) throw new TapsterError("no .github/workflows/release.yml found", "tapster expects the release workflow at that path. For another file, set workflow: in the hub entry.");
    const w = adaptReleaseWorkflow(await readFile(flowPath, "utf8"), pinsJson["actions/attest-build-provenance"].sha, pinsJson["actions/attest-build-provenance"].tag);
    await writeFile(flowPath, w.text);
    for (const n of [...g.notes, ...w.notes]) console.log(`- ${n}`);
  } else if (isBun) {
    kind = "bun";
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!entry) throw new TapsterError("package.json has no bin entry", "Add the CLI entry file to bin in package.json.");
    const flow = join(dir, ".github/workflows/release.yml");
    if (existsSync(flow) && !args.includes("--force")) {
      throw new TapsterError(".github/workflows/release.yml already exists", "Move it aside and run tapster add again. To replace it, run tapster add --force.");
    }
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(flow, bunWorkflow(name, entry.replace(/^\.\//, ""), pinsJson));
    console.log("- wrote .github/workflows/release.yml (build, attest, draft)");
  } else {
    throw new TapsterError("this project is not a GoReleaser-based Go CLI, a Bun CLI or an app with a Sparkle feed", "tapster add supports those three.");
  }
  const gh = await userGitHub();
  const latest = await gh.json<{ tag_name: string; assets: { name: string }[] }>("GET", `/repos/${repo}/releases/latest`).catch(() => null);
  console.log("\nAdd this to the hub's tapster.yml under packages:\n");
  console.log(latest ? inferEntry(name, repo, latest.assets.map((a) => a.name), latest.tag_name.slice(1), kind) : `  - name: ${name}\n    repo: ${repo}\n    binaries: [${name}]\n    assets: {}   # fill after the first release`);
  console.log("\nReview the changes with git diff, commit them, then tag a release.");
}
