import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isMap, isSeq, parse, parseDocument, type Scalar, YAMLMap } from "yaml";
import { BUNDLE_ID } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { run, runPath } from "../run";
import type { GitHub } from "../github";
import { parsePlist } from "../plist";
import { createProtection } from "../rulesets";
import { ringStep } from "./doorbell";
import pinsJson from "../../templates/pins.json";
import appTemplate from "../../templates/project/app-release.yml" with { type: "text" };
import bunTemplate from "../../templates/project/bun-release.yml" with { type: "text" };
import { currentRepo, setEnvSecret, setRepoVariable, userGitHub } from "./gh";
import { autoTagSteps, binName, bunEntry, goEntry, hubName, installOnProject, proposeEntry } from "./hubpr";
import { ask } from "./prompt";

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
      const attest = doc.createNode({ name: "Attest the archives for tapster", uses: `actions/attest-build-provenance@${attestSha}`, if: "${{ !github.event.repository.private }}", with: { "subject-checksums": "dist/checksums.txt" } });
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
    return doc.toString();
  }
  return null;
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

export async function protectProject(gh: GitHub, repo: string, deployKeys = false): Promise<string> {
  const branch = (await gh.getRepo(repo)).default_branch;
  const result = await createProtection(gh, repo, branch, deployKeys);
  if (result === "exists") return `- ${repo} is already protected: only an admin can create, move or delete its branches and tags`;
  if (result === "created") {
    return [
      `- protected ${repo}: only you can create, move or delete branches and tags; workflows and Apps, the hub's included, cannot. Push release tags yourself.`,
      "  Bots that open pull requests from their own branches here (Dependabot) need to be added as bypass actors to the ruleset \"tapster branches\" in the repository settings.",
    ].join("\n");
  }
  return `- GitHub does not enforce rulesets on ${repo} (private repositories need a paid plan for them), so a stolen App key could tag code the hub would sign. Make it public, use a paid plan, or set protection: off for this package in the hub's tapster.yml to accept that; until then the hub refuses it.`;
}

type AddOptions = { hub: string | null; force: boolean; workflow: string; autoTag: boolean };

export function addOptions(args: string[]): AddOptions {
  const opts: AddOptions = { hub: null, force: false, workflow: "release.yml", autoTag: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") opts.force = true;
    else if (a === "--auto-tag") opts.autoTag = true;
    else if (a === "--hub" && args[i + 1]) opts.hub = hubName(args[++i]!);
    else if (a === "--workflow" && args[i + 1] && /^[A-Za-z0-9._-]+\.ya?ml$/.test(args[i + 1]!)) opts.workflow = args[++i]!;
    else throw new TapsterError(`unknown option ${a}`, "Use tapster add [--hub owner/repo] [--workflow file.yml] [--auto-tag] [--force].");
  }
  return opts;
}

async function writeTemplate(dir: string, file: string, text: string, force: boolean): Promise<string> {
  const flow = join(dir, ".github/workflows", file);
  if (existsSync(flow) && !force) {
    const ringed = addRingStep(await readFile(flow, "utf8"));
    if (ringed === null) throw new TapsterError(`.github/workflows/${file} already exists`, "Move it aside and run tapster add again. To replace it, run tapster add --force.");
    await writeFile(flow, ringed);
    return `- kept .github/workflows/${file}; it rings the hub after opening the draft`;
  }
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  await writeFile(flow, text);
  return `- wrote .github/workflows/${file} (build, attest, draft, ring the hub)`;
}

type Prepared = { kind: "go" | "bun" | "app"; entry: string | null; reason: string | null; notes: string[]; goreleaser: string | null };

async function prepare(dir: string, repo: string, name: string, opts: AddOptions): Promise<Prepared> {
  const app = findApp(dir);
  if (app) {
    const build = app.build ?? `echo "Set the build command in .github/workflows/release.yml" && exit 1`;
    const appPath = app.appPath ?? `build/${app.name}.app`;
    const notes = [await writeTemplate(dir, "release.yml", appWorkflow({ build, appPath, runner: "macos-15", carry: [] }, pinsJson), opts.force)];
    if (!app.build || !app.appPath) notes.push("- set the build command and the app path in that file; the build must sign the app ad hoc");
    notes.push("- the app must set SURequireSignedFeed and SUVerifyUpdateBeforeExtraction to true and stamp both version keys with the tag");
    notes.push(`- store the Sparkle key in the hub with tapster init --sparkle ${name.replace(/[^a-z0-9]/g, "")} (add --new to create one)`);
    return { kind: "app", entry: appEntry(name, repo, app), reason: null, notes, goreleaser: null };
  }
  const goreleaser = [".goreleaser.yaml", ".goreleaser.yml"].find((f) => existsSync(join(dir, f)));
  if (goreleaser && existsSync(join(dir, "go.mod"))) {
    const g = adaptGoreleaser(await readFile(join(dir, goreleaser), "utf8"));
    await writeFile(join(dir, goreleaser), g.text);
    const flowPath = join(dir, ".github/workflows", opts.workflow);
    if (!existsSync(flowPath)) throw new TapsterError(`no .github/workflows/${opts.workflow} found`, "Name the workflow that runs GoReleaser with --workflow.");
    const w = adaptReleaseWorkflow(await readFile(flowPath, "utf8"), pinsJson["actions/attest-build-provenance"].sha, pinsJson["actions/attest-build-provenance"].tag);
    await writeFile(flowPath, w.text);
    return { kind: "go", entry: null, reason: null, notes: [...g.notes, ...w.notes].map((n) => `- ${n}`), goreleaser: g.text };
  }
  if (existsSync(join(dir, "package.json")) && (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")))) {
    const found = binName(JSON.parse(await readFile(join(dir, "package.json"), "utf8")), name);
    if (!found) throw new TapsterError("package.json has no bin entry", "Add the CLI entry file to bin in package.json.");
    const note = await writeTemplate(dir, "release.yml", bunWorkflow(found.bin, found.entry, pinsJson), opts.force);
    return { kind: "bun", entry: bunEntry(name, repo, found.bin), reason: null, notes: [note], goreleaser: null };
  }
  throw new TapsterError("this project is not a GoReleaser-based Go CLI, a Bun CLI or an app with a Sparkle feed", "tapster add supports those three.");
}

async function resolveHub(dir: string, flag: string | null): Promise<string> {
  const saved = (await run("git", ["-C", dir, "config", "--get", "tapster.hub"], { allowFail: true })).stdout.trim();
  const hub = flag ?? (saved ? hubName(saved) : hubName(await ask("Which hub publishes this project (owner/repo)? ")));
  if (hub !== saved) await run("git", ["-C", dir, "config", "tapster.hub", hub]);
  return hub;
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
  const dir = mkdtempSync(join(tmpdir(), "tapster-tag-"));
  try {
    await runPath("/usr/bin/ssh-keygen", "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `tapster tags for ${repo}`, "-f", join(dir, "key")]);
    await setEnvSecret(repo, "TAPSTER_TAG_KEY", readFileSync(join(dir, "key"), "utf8"), "release");
    await gh.json("POST", `/repos/${repo}/keys`, { title: "tapster tags", key: readFileSync(join(dir, "key.pub"), "utf8").trim(), read_only: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const others = keys.filter((k) => !k.read_only).map((k) => k.title);
  return [
    `- automatic tags: a deploy key for ${repo} lives in its "release" environment, which only ${branch} may use, and the rulesets let deploy keys tag.`,
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

export async function add(args: string[]): Promise<void> {
  const opts = addOptions(args);
  const dir = process.cwd();
  const repo = await currentRepo(dir);
  const name = repo.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const prepared = await prepare(dir, repo, name, opts);
  for (const n of prepared.notes) console.log(n);
  const gh = await userGitHub();
  const hub = await resolveHub(dir, opts.hub);
  const branch = (await gh.getRepo(repo)).default_branch;
  console.log(await protectProject(gh, repo, opts.autoTag));
  if (opts.autoTag) console.log(await setupAutoTag(gh, repo, branch));
  let { entry, reason } = prepared;
  if (prepared.kind === "go") ({ entry, reason } = goEntry(name, repo, prepared.goreleaser, await latestDraftOrRelease(gh, repo)));
  if (entry) {
    try {
      console.log(`- proposed the hub entry in ${await proposeEntry(gh, hub, name, repo, entry)}; merge it to start publishing`);
    } catch (e) {
      if (!(e instanceof TapsterError)) throw e;
      console.log(`- the hub entry was not proposed: ${e.reason}. ${e.fix}\n  The entry for ${hub}'s tapster.yml:\n${entry}`);
    }
  } else console.log(`- no hub entry yet: ${reason}`);
  const bell = await hubDoorbell(gh, hub);
  if (bell) {
    await setRepoVariable(repo, "TAPSTER_DOORBELL", bell);
    console.log("- the release workflow rings the hub's doorbell, so the hub publishes right after the draft opens");
  }
  console.log(await installOnProject(gh, hub, repo));
  console.log("\nReview the changes with git diff, commit and push them, then push a tag to release.");
}
