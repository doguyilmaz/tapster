import { type HubConfig, compareSemver, isApp, parseHub, parseTag } from "../config";
import { TapsterError } from "../errors";
import type { GitHub } from "../github";
import { TAPSTER } from "../version";
import hubReadme from "../../templates/hub/README.md" with { type: "text" };
import hubWorkflow from "../../templates/hub/tapster.yml" with { type: "text" };
import pinsJson from "../../templates/pins.json";
import { cronFor, everyFromFlow } from "./schedule";

type Pins = typeof pinsJson;

export const FLOW = ".github/workflows/tapster.yml";

export function sparkleLabels(config: HubConfig): string[] {
  const labels = config.packages.filter(isApp).flatMap((p) => (p.sparkle ? [p.sparkle.key, ...(p.sparkle.next_key ? [p.sparkle.next_key] : [])] : []));
  return [...new Set(labels)];
}

export function sparkleEnv(labels: string[]): string {
  const lines = labels.map((l) => `SPARKLE_KEY_${l.toUpperCase()}: "\${{ secrets.SPARKLE_KEY_${l.toUpperCase()} }}"`);
  return lines.length ? `{ ${lines.join(", ")} }` : "{}";
}

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }, labels: string[] = [], every = 10): string {
  return template
    .replaceAll("__CRON__", cronFor(every))
    .replaceAll("__SPARKLE_ENV__", sparkleEnv(labels))
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__UPLOAD_SHA__", pins["actions/upload-artifact"].sha)
    .replaceAll("__UPLOAD_TAG__", pins["actions/upload-artifact"].tag)
    .replaceAll("__DOWNLOAD_SHA__", pins["actions/download-artifact"].sha)
    .replaceAll("__DOWNLOAD_TAG__", pins["actions/download-artifact"].tag)
    .replaceAll("__PAGES_UPLOAD_SHA__", pins["actions/upload-pages-artifact"].sha)
    .replaceAll("__PAGES_UPLOAD_TAG__", pins["actions/upload-pages-artifact"].tag)
    .replaceAll("__PAGES_DEPLOY_SHA__", pins["actions/deploy-pages"].sha)
    .replaceAll("__PAGES_DEPLOY_TAG__", pins["actions/deploy-pages"].tag)
    .replaceAll("__TAPSTER_SHA__", tapster.sha)
    .replaceAll("__TAPSTER_TAG__", tapster.tag);
}

export async function tapsterPin(gh: GitHub, build: typeof TAPSTER, flag: string | null): Promise<{ sha: string; tag: string }> {
  if (flag === null) {
    if (build.sha) return { sha: build.sha, tag: `v${build.version}` };
    throw new TapsterError("this tapster was built from a checkout, so it does not know which tapster the hub should run", "Pass --tapster <commit> with a full commit SHA from tapster's main or use a released tapster.");
  }
  if (!/^[0-9a-f]{40}$/.test(flag)) throw new TapsterError(`${flag} is not a full commit SHA`, "Pass all 40 characters of the commit.");
  const cmp = await gh.json<{ status: string }>("GET", `/repos/doguyilmaz/tapster/compare/${flag}...main`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") throw new TapsterError(`${flag} is not on tapster's main`, "Pin a commit that is on main.");
  return { sha: flag, tag: "main" };
}

const PIN = /doguyilmaz\/tapster@([0-9a-f]{40}) # (\S+)/;

export function pinChange(before: string | null, after: string): string {
  const show = (m: RegExpExecArray) => `${m[2]} (${m[1]!.slice(0, 7)})`;
  const next = PIN.exec(after)!;
  const prev = before === null ? null : PIN.exec(before);
  if (!prev) return `tapster ${show(next)}`;
  return prev[1] === next[1] && prev[2] === next[2] ? `tapster ${show(prev)}, unchanged` : `tapster ${show(prev)} -> ${show(next)}`;
}

export type PinState = "missing" | "current" | "older" | "newer" | "other";

export function pinState(flow: string | null, me: { version: string; sha: string | null }, pin: string | null): PinState {
  if (flow === null) return "missing";
  const hub = PIN.exec(flow);
  const sha = pin ?? me.sha;
  if (!hub) return "other";
  if (hub[1] === sha) return "current";
  if (pin !== null || !me.sha) return "other";
  const theirs = parseTag(hub[2]!);
  const ours = parseTag(`v${me.version}`);
  if (!theirs || !ours) return "other";
  const order = compareSemver(theirs, ours);
  return order < 0 ? "older" : order > 0 ? "newer" : "other";
}

export function patchSparkleEnv(flow: string, labels: string[]): string {
  const step = /(\n\s+with: \{ mode: sparkle(?:, template: \d+)? \}\n\s+env: ).*\n/;
  if (!step.test(flow)) throw new TapsterError("the hub workflow has no sparkle step", "Run tapster init --workflow to rewrite it from the template.");
  return flow.replace(step, (_, head: string) => `${head}${sparkleEnv(labels)}\n`);
}


export type Schedule = { every: number | null; isPrivate: boolean };
export type HubFile = { path: string; content: string; before: string | null };
export type Read = (path: string) => Promise<string | null>;

export function scheduleNotes(every: number, kept: number | null, schedule: Schedule): string[] {
  if (every === kept) return [];
  const notes = [`The hub looks for new drafts every ${every} minutes; change it with tapster init --workflow --every <minutes>.`];
  if (kept !== null) notes.push("If the hub has a doorbell, run tapster init --rotate doorbell after you push, so it keeps the same schedule.");
  if (schedule.isPrivate && every >= 60 && schedule.every === null) {
    notes.push("GitHub bills every run of a private hub as at least one minute: every 10 minutes would use about 4,300 of the 2,000 free minutes a month. The doorbell (tapster init --doorbell) still publishes right after each release.");
  }
  return notes;
}

export async function workflowFile(gh: GitHub, before: string | null, labels: string[], flag: string | null, schedule: Schedule): Promise<{ file: HubFile; change: string; notes: string[] }> {
  const ref = await tapsterPin(gh, TAPSTER, flag);
  const kept = before === null ? null : everyFromFlow(before);
  const every = schedule.every ?? kept ?? (schedule.isPrivate ? 60 : 10);
  const content = fillWorkflow(hubWorkflow, pinsJson, ref, labels, every);
  return { file: { path: FLOW, content, before }, change: pinChange(before, content), notes: scheduleNotes(every, kept, schedule) };
}

export function starterFiles(hub: string): HubFile[] {
  const [owner, repo] = hub.split("/") as [string, string];
  const tap = `${owner}/${repo.replace(/^homebrew-/, "")}`;
  return [
    { path: "tapster.yml", content: `version: 1\ntap: ${tap}\npackages: []\n`, before: null },
    { path: ".tapster/state.json", content: `${JSON.stringify({ version: 1, packages: {} }, null, 2)}\n`, before: null },
    { path: "README.md", content: hubReadme.replaceAll("__TAP__", tap).replaceAll("__OWNER__", owner).replaceAll("__HUB__", hub), before: null },
  ];
}

export type HubFilesPlan = { files: HubFile[]; kept: string[]; change: string; notes: string[] };

export async function hubFiles(gh: GitHub, hub: string, read: Read, flag: string | null, schedule: Schedule): Promise<HubFilesPlan> {
  const files: HubFile[] = [];
  const kept: string[] = [];
  for (const f of starterFiles(hub)) {
    const before = await read(f.path);
    if (before === null) files.push(f);
    else kept.push(f.path);
  }
  const config = await read("tapster.yml");
  const labels = config === null ? [] : sparkleLabels(parseHub(config, hub.split("/")[0]!).config);
  const flow = await workflowFile(gh, await read(FLOW), labels, flag, schedule);
  files.push(flow.file);
  return { files, kept, change: flow.change, notes: flow.notes };
}
