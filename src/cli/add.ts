import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { basename, join } from "node:path";
import { isMap, isSeq, parse, parseDocument, type Scalar, YAMLMap } from "yaml";
import { appFromProjectYml, bundleIdOf, feedName, helpersOf, literal } from "../appsource";
import { type EntrySources, deriveUpdate, refusedDraftApp } from "../entryupdate";
import { readHubFile } from "../hubcommit";
import { entryText } from "../hubentry";
import { changeText } from "../web/steps";
import { openPull } from "../web/api/entry";
import { BUNDLE_ID } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { readGit } from "../clone";
import { run, runPath } from "../run";
import type { GitHub } from "../github";
import { parsePlist } from "../plist";
import { descProblems } from "../render";
import { createProtection } from "../rulesets";
import { ringStep } from "./doorbell";
import pinsJson from "../../templates/pins.json";
import appTemplate from "../../templates/project/app-release.yml" with { type: "text" };
import bunTemplate from "../../templates/project/bun-release.yml" with { type: "text" };
import { currentRepo, setEnvSecret, setRepoVariable, userGitHub } from "./gh";
import { removeTemp, tempDir } from "./temp";
import { highestTag, nextTag, releasableParent, tagCommand } from "../web/status";
import { headOf, releaseTriggers, withParentTag } from "../web/api/status";
import { YAML_OUT, appInstallUrl, autoTagSteps, goreleaserCask, hasHomebrew, keepStyle, binName, bunEntry, descriptionNote, entryExtras, goEntry, hubEntries, hubFacts, hubName, installSentence, proposeEntry, proposeUpdate, releaseEntry, releaseSecrets, repoTags, tagRefs, withoutMac } from "./hubpr";
import { ask } from "./prompt";
import { mustRead, readRegular, readSmall, writeInside } from "./paths";

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
  return { text: keepStyle(text, doc.toString(YAML_OUT)), notes };
}

const jobMap = (job: { value: unknown }) => job.value as YAMLMap;
const RING_NAME = "Ring the tapster hub";
const MOVES = /git\/refs\/heads\/|git push\b[^\n]*refs\/heads\//;

function branchMoves(jobs: YAMLMap): string[] {
  const found: string[] = [];
  for (const job of jobs.items) {
    const steps = jobMap(job).get("steps");
    if (!isSeq(steps)) continue;
    for (const st of steps.items) {
      const run = isMap(st) ? String(st.get("run") ?? "") : "";
      if (MOVES.test(run)) found.push(String((st as YAMLMap).get("name") ?? run.trim().split("\n")[0]));
    }
  }
  return found.map((s) => `the step "${s}" moves a branch, which the branch rules now refuse to the workflow's token; see "A branch that follows releases" in the GoReleaser guide`);
}

export function adaptReleaseWorkflow(text: string, attestSha: string, attestTag: string): { text: string; notes: string[] } {
  const doc = parseDocument(text);
  const notes: string[] = [];
  const jobs = doc.get("jobs");
  if (!isMap(jobs)) throw new TapsterError("the release workflow has no jobs", "Add the GoReleaser job first.");
  notes.push(...branchMoves(jobs));
  const triggers = releaseTriggers(text);
  if (triggers.length) notes.push(`the release workflow also starts on ${triggers.join(" and ")}, so merging such a change starts a release; merge those only once the hub entry is merged and the App reaches the project`);
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
      const attest = doc.createNode({ name: "Attest the archives for tapster", uses: `actions/attest-build-provenance@${attestSha}`, if: "${{ !github.event.repository.private }}", with: { "subject-checksums": "dist/checksums.txt" } });
      (attest.get("uses", true) as Scalar).comment = ` ${attestTag}`;
      steps.items.splice(index + 1, 0, attest as never);
      notes.push(`added the attestation step (actions/attest-build-provenance ${attestTag}) and its permissions`);
    }
    if (!steps.items.some((st) => isMap(st) && st.get("name") === RING_NAME)) {
      steps.items.push(doc.createNode((parse(ringStep(0)) as unknown[])[0]) as never);
      notes.push("added the step that rings the hub's doorbell after the draft is open");
    }
    return { text: keepStyle(text, doc.toString(YAML_OUT)), notes };
  }
  throw new TapsterError("no GoReleaser step found in the release workflow", "tapster add edits the job that runs goreleaser/goreleaser-action.");
}


export function addRingStep(text: string): string | null {
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return null;
  }
  const jobs = doc.get("jobs");
  if (!isMap(jobs)) return null;
  for (const job of jobs.items) {
    const steps = jobMap(job).get("steps");
    if (!isSeq(steps)) continue;
    const drafts = steps.items.some((st) => isMap(st) && /gh release create[^\n]*--draft/.test(String(st.get("run") ?? "")));
    if (!drafts) continue;
    if (steps.items.some((st) => isMap(st) && st.get("name") === RING_NAME)) return text;
    steps.items.push(doc.createNode((parse(ringStep(0)) as unknown[])[0]) as never);
    return keepStyle(text, doc.toString(YAML_OUT));
  }
  return null;
}

export const localPlists = (dir: string): Buffer[] => infoPlists(dir).flatMap((path) => readRegular(path) ?? []);

export const bundleIdIn = (dir: string, app: string): string | null => bundleIdOf(localPlists(dir), app);

export function bunWorkflow(name: string, entry: string, pins: Pins, mac = true): string {
  const template = mac ? bunTemplate : bunTemplate.replaceAll("darwin-arm64 darwin-x64 ", "");
  return template
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__SETUP_BUN_SHA__", pins["oven-sh/setup-bun"].sha)
    .replaceAll("__SETUP_BUN_TAG__", pins["oven-sh/setup-bun"].tag)
    .replaceAll("__UPLOAD_SHA__", pins["actions/upload-artifact"].sha)
    .replaceAll("__UPLOAD_TAG__", pins["actions/upload-artifact"].tag)
    .replaceAll("__DOWNLOAD_SHA__", pins["actions/download-artifact"].sha)
    .replaceAll("__DOWNLOAD_TAG__", pins["actions/download-artifact"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__NAME__", name)
    .replaceAll("__ENTRY__", entry)
    .replace("__RING__\n", `${ringStep(6)}\n`);
}

export type FoundApp = { name: string; bundleId: string | null; feed: string; publicKey: string | null; universal: boolean; build: string | null; appPath: string | null };

export const SKIP = new Set([".git", ".build", "build", "dist", "DerivedData", "node_modules", "Pods", "Carthage"]);

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
  const make = readSmall(join(dir, "Makefile")) ?? "";
  return { build: /^app:/m.test(make) ? "make app" : null, appPath: /^APP\s*:?=\s*([^\s].*?\.app)\s*$/m.exec(make)?.[1] ?? null };
}

export function findApp(dir: string): FoundApp | null {
  const top = readdirSync(dir);
  if (!top.some((f) => f === "project.yml" || f === "Package.swift" || f.endsWith(".xcodeproj"))) return null;
  const make = makeTarget(dir);
  const yml = readSmall(join(dir, "project.yml"));
  const fromYml = yml === null ? null : appFromProjectYml(yml);
  if (fromYml) return { ...fromYml, ...make };
  const xcodeproj = top.find((f) => f.endsWith(".xcodeproj"));
  for (const path of infoPlists(dir)) {
    let info: Record<string, unknown>;
    try {
      const bytes = readRegular(path);
      if (!bytes) continue;
      info = parsePlist(bytes) as Record<string, unknown>;
    } catch {
      continue;
    }
    const feed = feedName(info.SUFeedURL);
    if (!feed) continue;
    const pbx = (xcodeproj && readSmall(join(dir, xcodeproj, "project.pbxproj"), 16 << 20)) || "";
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

export async function protectProject(gh: GitHub, repo: string, deployKeys = false, dependabot = false): Promise<string> {
  const branch = (await gh.getRepo(repo)).default_branch;
  const done = await createProtection(gh, repo, branch, deployKeys, dependabot);
  const kept = [done.deployKeys && !deployKeys ? "--auto-tag" : "", done.dependabot && !dependabot ? "--allow-dependabot" : ""].filter(Boolean);
  const keptNote = kept.length ? ` It keeps what an earlier ${kept.join(" and ")} opened.` : "";
  if (done.status === "exists") return `- ${repo} is already protected: only an admin can create, move or delete its branches and tags.${keptNote}`;
  if (done.status === "created") {
    return `- protected ${repo}: only you can create, move or delete branches and tags; workflows and Apps, the hub's included, cannot. Release tags come from you; GitHub then notes "Bypassed rule violations", which is your admin right at work.${done.dependabot ? " Branches named dependabot/... stay open, so Dependabot can open pull requests; the hub accepts that only with protection: dependabot in its entry." : ""}${keptNote}`;
  }
  return `- GitHub does not enforce rulesets on ${repo} (private repositories need a paid plan for them). A stolen App key could tag code the hub would sign. Make it public or use a paid plan. To accept the risk, set protection: off for this package in the hub's tapster.yml; until then the hub refuses it.`;
}

// update: what add does with an update of an entry the hub already has. The terminal proposes it; the setup page shows
// it and leaves the click to the person.
export type AddOptions = { hub: string | null; force: boolean; workflow: string; autoTag: boolean; dependabot: boolean; update: "propose" | "show" };

export function addOptions(args: string[]): AddOptions {
  const opts: AddOptions = { hub: null, force: false, workflow: "release.yml", autoTag: false, dependabot: false, update: "propose" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") opts.force = true;
    else if (a === "--auto-tag") opts.autoTag = true;
    else if (a === "--allow-dependabot") opts.dependabot = true;
    else if (a === "--hub" && args[i + 1]) opts.hub = hubName(args[++i]!);
    else if (a === "--workflow" && args[i + 1] && /^[A-Za-z0-9._-]+\.ya?ml$/.test(args[i + 1]!)) opts.workflow = args[++i]!;
    else throw new TapsterError(`unknown option ${a}`, "Run tapster add --help for the options.");
  }
  return opts;
}

export type Write = (rel: string, content: string) => Promise<void>;

async function writeTemplate(dir: string, file: string, text: string, force: boolean, write: Write): Promise<string> {
  const flow = join(dir, ".github/workflows", file);
  if (existsSync(flow) && !force) {
    const ringed = addRingStep(mustRead(flow, `.github/workflows/${file}`));
    if (ringed === null) throw new TapsterError(`.github/workflows/${file} already exists`, "Move it aside and run tapster add again. To replace it, run tapster add --force.");
    await write(`.github/workflows/${file}`, ringed);
    return `- kept .github/workflows/${file}; it rings the hub after opening the draft`;
  }
  await write(`.github/workflows/${file}`, text);
  return `- wrote .github/workflows/${file} (build, attest, draft, ring the hub)`;
}

const quietGit = (dir: string, args: string[], maxOutput: number) => readGit(dir, args, { timeoutMs: 10_000, maxOutput }).catch(() => null);

// rev-list and cat-file never run the clone's filters, textconv, hooks or fsmonitor; log -S/-G, diff and status can.
export async function homebrewFromHistory(dir: string): Promise<string | null> {
  const files = [".goreleaser.yaml", ".goreleaser.yml"];
  const revs = await quietGit(dir, ["rev-list", "--max-count=50", "HEAD", "--", ...files], 1 << 16);
  for (const sha of revs?.code === 0 ? revs.stdout.split("\n").filter((l) => /^[0-9a-f]{40,64}$/.test(l)) : []) {
    for (const f of files) {
      const blob = await quietGit(dir, ["cat-file", "blob", `${sha}:${f}`], 1 << 20);
      if (blob?.code === 0 && hasHomebrew(blob.stdout)) return blob.stdout;
    }
  }
  return null;
}

type Prepared = { kind: "go" | "bun" | "app"; entry: string | null; reason: string | null; notes: string[]; goreleaser: string | null; original?: string | null; bin?: string | null; files: string[] };

export async function prepare(dir: string, repo: string, name: string, opts: AddOptions, mac = true, write: Write = (rel, content) => writeInside(dir, rel, content)): Promise<Prepared> {
  const app = findApp(dir);
  if (app && !mac) throw new TapsterError("the hub has no Apple credentials, which a Mac app needs", "Run tapster init --rotate certificate and tapster init --rotate notary in the hub clone, then tapster add again.");
  if (app) {
    const build = app.build ?? `echo "Set the build command in .github/workflows/release.yml" && exit 1`;
    const appPath = app.appPath ?? `build/${app.name}.app`;
    const notes = [await writeTemplate(dir, "release.yml", appWorkflow({ build, appPath, runner: "macos-15", carry: [] }, pinsJson), opts.force, write)];
    if (!app.build || !app.appPath) notes.push("- set the build command and the app path in that file; the build must sign the app ad hoc");
    notes.push("- the app must set SURequireSignedFeed and SUVerifyUpdateBeforeExtraction to true and stamp both version keys with the tag");
    notes.push(`- store the Sparkle key in the hub with tapster init --sparkle ${name.replace(/[^a-z0-9]/g, "")} (add --new to create one)`);
    return { kind: "app", entry: appEntry(name, repo, app), reason: null, notes, goreleaser: null, files: [".github/workflows/release.yml"] };
  }
  const goreleaser = [".goreleaser.yaml", ".goreleaser.yml"].find((f) => existsSync(join(dir, f)));
  if (goreleaser && existsSync(join(dir, "go.mod"))) {
    const original = mustRead(join(dir, goreleaser), goreleaser);
    const g = adaptGoreleaser(original);
    await write(goreleaser, g.text);
    const flowPath = join(dir, ".github/workflows", opts.workflow);
    if (!existsSync(flowPath)) throw new TapsterError(`no .github/workflows/${opts.workflow} found`, "Name the workflow that runs GoReleaser with --workflow.");
    const w = adaptReleaseWorkflow(mustRead(flowPath, `.github/workflows/${opts.workflow}`), pinsJson["actions/attest-build-provenance"].sha, pinsJson["actions/attest-build-provenance"].tag);
    await write(`.github/workflows/${opts.workflow}`, w.text);
    const homebrew = hasHomebrew(original) ? original : await homebrewFromHistory(dir);
    return { kind: "go", entry: null, reason: null, notes: [...g.notes, ...w.notes].map((n) => `- ${n}`), goreleaser: g.text, original: homebrew ?? original, files: [goreleaser, `.github/workflows/${opts.workflow}`] };
  }
  if (existsSync(join(dir, "package.json")) && (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")))) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(mustRead(join(dir, "package.json"), "package.json"));
    } catch (e) {
      if (e instanceof TapsterError) throw e;
      throw new TapsterError("package.json is not valid JSON", "Fix package.json, then try again.");
    }
    const found = binName(manifest as Parameters<typeof binName>[0], name);
    if (!found) throw new TapsterError("package.json has no bin entry", "Add the CLI entry file to bin in package.json.");
    const note = await writeTemplate(dir, "release.yml", bunWorkflow(found.bin, found.entry, pinsJson, mac), opts.force, write);
    const own = note.startsWith("- kept");
    return { kind: "bun", entry: own ? null : bunEntry(name, repo, found.bin), reason: null, notes: [note], goreleaser: null, bin: own ? found.bin : null, files: [".github/workflows/release.yml"] };
  }
  throw new TapsterError("this project is not a GoReleaser-based Go CLI, a Bun CLI or an app with a Sparkle feed", "tapster add supports those three.");
}

async function resolveHub(dir: string, flag: string | null): Promise<{ hub: string; remember: () => Promise<void> }> {
  const saved = (await readGit(dir, ["config", "--get", "tapster.hub"])).stdout.trim();
  const hub = flag ?? (saved ? hubName(saved) : hubName(await ask("Which hub publishes this project (owner/repo)? ")));
  return { hub, remember: async () => void (hub !== saved && (await run("git", ["-C", dir, "config", "tapster.hub", hub]))) };
}

async function setupAutoTag(gh: GitHub, repo: string, branch: string): Promise<string> {
  const keys = await gh.json<{ title: string; read_only: boolean }[]>("GET", `/repos/${repo}/keys`);
  if (keys.some((k) => k.title === "tapster tags")) return '- the tag key already exists; to replace it, delete the deploy key "tapster tags" and run this again';
  try {
    await gh.json("PUT", `/repos/${repo}/environments/release`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  } catch (e) {
    if (e instanceof GitHubError && [403, 404, 422].includes(e.status)) {
      throw new TapsterError(`GitHub refused environments on ${repo}`, "Automatic tags keep their key in an environment, which private repositories get with GitHub Pro. Make the project public or upgrade.");
    }
    throw e;
  }
  const policies = await gh.json<{ branch_policies: { name: string }[] }>("GET", `/repos/${repo}/environments/release/deployment-branch-policies`);
  if (!policies.branch_policies.some((p) => p.name === branch)) {
    await gh.json("POST", `/repos/${repo}/environments/release/deployment-branch-policies`, { name: branch, type: "branch" });
  }
  const dir = tempDir("tapster-tag-");
  try {
    await runPath("/usr/bin/ssh-keygen", "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `tapster tags for ${repo}`, "-f", join(dir, "key")]);
    await setEnvSecret(repo, "TAPSTER_TAG_KEY", readFileSync(join(dir, "key"), "utf8"), "release");
    await gh.json("POST", `/repos/${repo}/keys`, { title: "tapster tags", key: readFileSync(join(dir, "key.pub"), "utf8").trim(), read_only: false });
  } finally {
    removeTemp(dir);
  }
  const others = keys.filter((k) => !k.read_only).map((k) => k.title);
  return [
    `- automatic tags: a deploy key for ${repo} lives in its "release" environment, which only ${branch} may use. The rulesets let deploy keys tag.`,
    ...(others.length ? [`  Every deploy key with write access can now tag too: ${others.join(", ")}. Remove the ones you do not need in the repository settings.`] : []),
    "  Push tags from your release workflow like this:",
    autoTagSteps(pinsJson["actions/checkout"]),
  ].join("\n");
}

async function hubDoorbell(gh: GitHub, hub: string): Promise<string | null> {
  try {
    return (await gh.json<{ value: string }>("GET", `/repos/${hub}/environments/tapster/variables/TAPSTER_DOORBELL`)).value;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

async function latestDraftOrRelease(gh: GitHub, repo: string): Promise<{ assets: string[]; version: string } | null> {
  const all = (await gh.listReleases(repo)).filter((r) => /^v\d/.test(r.tag_name)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const r = all[0];
  return r ? { assets: r.assets.map((a) => a.name), version: r.tag_name.slice(1) } : null;
}

// The committed file, as the release workflow's checkout sees it; cat-file runs none of the clone's filters.
async function committedFile(dir: string, rel: string): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.split("/").includes("..") || rel.startsWith("-")) return null;
  const blob = await readGit(dir, ["cat-file", "blob", `HEAD:${rel}`], { timeoutMs: 10_000, maxOutput: 16 << 20 }).catch(() => null);
  return blob?.code === 0 ? blob.bytes : null;
}

function localSources(gh: GitHub, dir: string, repo: string, prepared: Prepared, apple: boolean, opts: AddOptions): EntrySources {
  const flow = `.github/workflows/${prepared.kind === "go" ? opts.workflow : "release.yml"}`;
  const text = readSmall(join(dir, flow));
  return {
    kind: prepared.kind,
    apple,
    goreleaser: async () => prepared.original ?? null,
    plists: async () => localPlists(dir),
    app: async () => {
      const found = findApp(dir);
      const yml = readSmall(join(dir, "project.yml"));
      return found ? { feed: found.feed, helpers: yml === null ? [] : helpersOf(yml) } : null;
    },
    workflow: text === null ? null : { name: flow, text },
    file: (path) => committedFile(dir, path),
    draft: async (assets, commands) => refusedDraftApp(gh, repo, assets, await gh.listReleases(repo).catch(() => []), commands),
  };
}

const byHand = (m: string) => `- write this in the hub entry by hand: ${m.replace(/\n/g, "\n  ")}`;

// An entry the hub already has gains only what it lacks; with nothing missing, add says what it always said.
async function updateExisting(gh: GitHub, hub: string, name: string, sources: EntrySources, opts: AddOptions, say: (line: string) => void): Promise<void> {
  const pull = await openPull(gh, hub, "update", name).catch(() => null);
  if (pull) return say(`- an update of the hub entry for ${name} waits in ${pull.html_url}; merge it to apply it`);
  const text = await readHubFile(gh, hub, "tapster.yml", "main");
  const entry = text === null ? null : entryText(text, name);
  const found = entry === null ? null : await deriveUpdate(entry, sources);
  if (!found?.entry) say(`- ${hub} already has the entry for ${name}; tapster leaves it as it is`);
  else {
    say(`- ${hub} has an entry for ${name} that lacks what the project ships now. tapster read it from ${found.from.join("; ")}. The change to tapster.yml:\n${changeText(entry!, found.entry).replace(/^/gm, "  ")}`);
    if (opts.update === "show") say("  Propose it under Configuration below.");
    else {
      try {
        say(`- proposed the update in ${(await proposeUpdate(gh, hub, name, found.entry, entry!)).url}; merge it on GitHub or under Projects in tapster setup`);
      } catch (e) {
        if (!(e instanceof TapsterError)) throw e;
        say(`- the update was not proposed: ${e.reason}. ${e.fix}`);
      }
    }
  }
  for (const m of found?.manual ?? []) say(byHand(m));
}

export type Added = { pr: string | null; head: string | null; entry: string | null; installUrl: string; files: string[]; kind: Prepared["kind"] };

export async function addProject(gh: GitHub, dir: string, repo: string, hub: string, facts: { slug: string; apple: boolean }, opts: AddOptions, say: (line: string) => void): Promise<Added> {
  const name = projectName(repo);
  const { slug, apple } = facts;
  const prepared = await prepare(dir, repo, name, opts, apple);
  for (const n of prepared.notes) say(n);
  const project = await gh.getRepo(repo);
  say(await protectProject(gh, repo, opts.autoTag, opts.dependabot));
  if (!opts.dependabot && [".github/dependabot.yml", ".github/dependabot.yaml"].some((f) => existsSync(join(dir, f)))) {
    say("- Dependabot cannot open pull requests here now: GitHub does not let personal repositories exempt it from the rules.");
    say("  To keep it, run tapster add --allow-dependabot. Branches named dependabot/... then stay open to anything with write access, the hub's App included, so a stolen App key could run your workflows on its own code there.");
  }
  if (opts.autoTag) say(await setupAutoTag(gh, repo, project.default_branch));
  const existing = (await hubEntries(gh, hub)).find((e) => e.name === name || e.repo.toLowerCase() === repo.toLowerCase());
  let { entry, reason } = prepared;
  const sources = localSources(gh, dir, repo, prepared, apple, opts);
  if (existing) {
    entry = null;
    if (existing.pr) say(`- the hub entry for ${existing.name} waits in ${existing.pr}; merge it to start publishing`);
    else await updateExisting(gh, hub, existing.name, sources, opts, say);
    if (!existing.description) {
      const desc = descriptionNote(project.description, name, true);
      if (desc.line) say(desc.line);
    }
  } else if (prepared.kind === "go") ({ entry, reason } = goEntry(name, repo, prepared.goreleaser, await latestDraftOrRelease(gh, repo)));
  else if (prepared.kind === "bun" && prepared.bin) ({ entry, reason } = releaseEntry(name, repo, "bun", [prepared.bin], await latestDraftOrRelease(gh, repo)));
  if (entry && !apple) {
    entry = withoutMac(entry);
    if (entry) say("- the hub has no Apple credentials, so the entry leaves out the macOS builds");
    else reason = "the hub has no Apple credentials and the project builds only for macOS; run tapster init --rotate certificate and tapster init --rotate notary in the hub, then tapster add again";
    if (prepared.kind === "go" || prepared.bin) say(`  Remove the macOS builds from ${prepared.kind === "go" ? "the GoReleaser builds (goos: darwin)" : ".github/workflows/release.yml"} too: the hub refuses macOS code it cannot sign.`);
  }
  let pr = existing?.pr ?? null;
  let head: string | null = null;
  if (entry) {
    entry = entryExtras(entry, { kind: prepared.kind, workflow: opts.workflow, dependabot: opts.dependabot });
    const cask = goreleaserCask(prepared.original ?? null, { mac: apple, bundleId: (app) => bundleIdIn(dir, app), commands: ((parse(entry) as { binaries?: string[] }[])[0]?.binaries ?? []).map((b) => b.split("/").pop()!) });
    if (cask.lines.length) entry = `${entry}\n${cask.lines.join("\n")}`;
    const own = cask.description && descProblems(cask.description, name).length === 0 ? cask.description : null;
    if (own) {
      entry = `${entry}\n    description: ${JSON.stringify(own)}`;
      cask.carried.unshift("description");
    } else {
      const desc = descriptionNote(project.description, name);
      if (desc.line) say(desc.line);
      if (desc.add) entry = `${entry}\n${desc.add}`;
    }
    if (cask.carried.length) say(`- carried the ${cask.carried.join(", ")} of GoReleaser's Homebrew section into the hub entry`);
    for (const n of cask.notes) say(`- ${n}`);
    if (prepared.kind === "app") {
      const more = await deriveUpdate(entry.replace(/^ {2}/gm, ""), sources);
      if (more.entry) entry = more.entry.replace(/^(?=.)/gm, "  ");
      for (const m of more.manual) say(byHand(m));
    }
    try {
      ({ url: pr, head } = await proposeEntry(gh, hub, name, repo, entry));
      say(`- proposed the hub entry in ${pr}; merge it to start publishing`);
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      say(`- the hub entry was not proposed: ${e.reason}. ${e.fix}\n  The entry for ${hub}'s tapster.yml:\n${entry}`);
      if (opts.dependabot && e.reason.includes("is already in")) say("  Its existing entry needs protection: dependabot, or the hub refuses the project.");
    }
  } else if (!existing) say(`- no hub entry yet: ${reason}`);
  const bell = await hubDoorbell(gh, hub);
  if (bell) {
    await setRepoVariable(repo, "TAPSTER_DOORBELL", bell);
    say("- the release workflow rings the hub's doorbell, so the hub publishes right after the draft opens");
  }
  const secrets = await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${repo}/actions/secrets?per_page=100`).then((r) => releaseSecrets(r.secrets.map((x) => x.name)), () => []);
  if (secrets.length) say(`- ${repo} still holds release secrets that the hub replaces: ${secrets.join(", ")}. Delete them once the hub has published a release: gh secret delete <name> --repo ${repo}`);
  const installUrl = await appInstallUrl(gh, slug, repo);
  say(installSentence(repo, installUrl));
  return { pr, head, entry, installUrl, files: prepared.files, kind: prepared.kind };
}

export const projectName = (repo: string) => repo.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");

export async function add(args: string[]): Promise<void> {
  const opts = addOptions(args);
  const dir = process.cwd();
  const repo = await currentRepo(dir);
  const gh = await userGitHub();
  const { hub, remember } = await resolveHub(dir, opts.hub);
  const facts = await hubFacts(gh, hub);
  await remember();
  await addProject(gh, dir, repo, hub, facts, opts, (line) => console.log(line));
  const hint = await releaseHint(gh, repo).catch(() => "Once they are on the default branch, release from tapster setup, under Projects.");
  console.log(`\nReview the changes with git diff, then commit and push them.\n${hint}`);
}

export async function releaseHint(gh: GitHub, repo: string): Promise<string> {
  const keys = await gh.json<{ title: string }[]>("GET", `/repos/${repo}/keys`).catch(() => []);
  if (keys.some((k) => k.title === "tapster tags")) return "Your release workflow tags each release by itself.";
  const branch = (await gh.getRepo(repo)).default_branch;
  const tag = nextTag(highestTag(await repoTags(gh, repo)));
  const cmd = tagCommand(repo, tag, { branch });
  if (!cmd) return `Once they are on ${branch} and the hub entry is merged, release ${tag} from tapster setup, under Projects.`;
  const tip = await headOf(gh, repo, branch);
  if (tip?.skip) {
    const known = await withParentTag(gh, repo, tip, await tagRefs(gh, repo).catch(() => null));
    const parent = known && releasableParent(known);
    const before = parent ? `\nOr tag the commit before it, which has no skip marker:\n  ${tagCommand(repo, tag, { sha: parent.sha })}` : "";
    return `The latest commit of ${branch} says ${tip.skip}, so GitHub may not start the release workflow for a tag on it. Push a commit without it, then release ${tag} by tagging that one:\n  ${cmd}${before}`;
  }
  return `Once they are on ${branch} and the hub entry is merged, release ${tag} by tagging the latest commit of ${branch} on GitHub:\n  ${cmd}`;
}
