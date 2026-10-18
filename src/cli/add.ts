import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";
import { TapsterError } from "../errors";
import pinsJson from "../../templates/pins.json";
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
    steps.items.splice(index + 1, 0, doc.createNode({ name: "Attest the archives for tapster", uses: `actions/attest-build-provenance@${attestSha}`, with: { "subject-checksums": "dist/checksums.txt" } }) as never);
    (job.value as YAMLMap).set("permissions", doc.createNode({ contents: "write", "id-token": "write", attestations: "write" }));
    notes.push(`added the attestation step (actions/attest-build-provenance ${attestTag}) and its permissions`);
    return { text: doc.toString(), notes };
  }
  throw new TapsterError("no GoReleaser step found in the release workflow", "tapster add edits the job that runs goreleaser/goreleaser-action.");
}

const bunTemplate = await readFile(new URL("../../templates/project/bun-release.yml", import.meta.url), "utf8");

export function bunWorkflow(name: string, entry: string, pins: Pins): string {
  return bunTemplate
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__SETUP_BUN_SHA__", pins["oven-sh/setup-bun"].sha)
    .replaceAll("__SETUP_BUN_TAG__", pins["oven-sh/setup-bun"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__NAME__", name)
    .replaceAll("__ENTRY__", entry);
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

export async function add(_args: string[]): Promise<void> {
  const dir = process.cwd();
  const repo = await currentRepo(dir);
  const name = repo.split("/")[1]!.toLowerCase();
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
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(join(dir, ".github/workflows/release.yml"), bunWorkflow(name, entry.replace(/^\.\//, ""), pinsJson));
    console.log("- wrote .github/workflows/release.yml (build, attest, draft)");
  } else {
    throw new TapsterError("this project is neither GoReleaser-based Go nor Bun", "tapster add supports those two in phase 1.");
  }
  const gh = await userGitHub();
  const latest = await gh.json<{ tag_name: string; assets: { name: string }[] }>("GET", `/repos/${repo}/releases/latest`).catch(() => null);
  console.log("\nAdd this to the hub's tapster.yml under packages:\n");
  console.log(latest ? inferEntry(name, repo, latest.assets.map((a) => a.name), latest.tag_name.slice(1), kind) : `  - name: ${name}\n    repo: ${repo}\n    binaries: [${name}]\n    assets: {}   # fill after the first release`);
  console.log("\nReview the changes with git diff, commit them, then tag a release.");
}
