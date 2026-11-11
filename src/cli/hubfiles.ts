import { certificateLabels, certificateNames } from "../certificates";
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

export type HubLabels = { sparkle: string[]; certificates: string[] };

export function hubLabels(config: HubConfig): HubLabels {
  return { sparkle: sparkleLabels(config), certificates: certificateLabels(config) };
}

const ENV_INDENT = " ".repeat(10);
const envLine = (name: string, from: "vars" | "secrets") => `${ENV_INDENT}${name}: \${{ ${from}.${name} }}\n`;

// The lines the check step gets for each certificate label, after the hub's TAPSTER_CERT_EXPIRES.
export function certificateCheckEnv(labels: string[]): string {
  return labels
    .map((l) => {
      const n = certificateNames(l);
      return envLine(n.team, "vars") + envLine(n.expires, "vars");
    })
    .join("");
}

// The lines the sign and seal steps get for each certificate label, after the hub's MACOS_NOTARY_ISSUER_ID.
export function certificateEnv(labels: string[]): string {
  return labels
    .map((l) => {
      const n = certificateNames(l);
      return [envLine(n.team, "vars"), ...[n.p12, n.password, n.notaryKey, n.notaryKeyId, n.notaryIssuer].map((s) => envLine(s, "secrets"))].join("");
    })
    .join("");
}

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }, labels: Partial<HubLabels> = {}, every = 10): string {
  const certificates = labels.certificates ?? [];
  return template
    .replaceAll(`${ENV_INDENT}#__CERTIFICATE_CHECK_ENV__\n`, () => certificateCheckEnv(certificates))
    .replaceAll(`${ENV_INDENT}#__CERTIFICATE_ENV__\n`, () => certificateEnv(certificates))
    .replaceAll("__CRON__", cronFor(every))
    .replaceAll("__SPARKLE_ENV__", sparkleEnv(labels.sparkle ?? []))
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

export const PIN = /doguyilmaz\/tapster@([0-9a-f]{40}) # (\S+)/;

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

const CHECK_ENV = /(\n {10}TAPSTER_CERT_EXPIRES: \$\{\{ vars\.TAPSTER_CERT_EXPIRES \}\}\n)(?: {10}(?:TAPSTER_TEAM_ID|TAPSTER_CERT_EXPIRES)_[A-Z0-9]+: .*\n)*/;
const SIGN_ENV = /(\n {10}MACOS_NOTARY_ISSUER_ID: \$\{\{ secrets\.MACOS_NOTARY_ISSUER_ID \}\}\n)(?: {10}(?:TAPSTER_TEAM_ID|MACOS_SIGN_P12|MACOS_SIGN_PASSWORD|MACOS_NOTARY_KEY|MACOS_NOTARY_KEY_ID|MACOS_NOTARY_ISSUER_ID)_[A-Z0-9]+: .*\n)*/g;

// Rewrites only the lines of the certificate labels in the check, sign and seal steps; the hub's own lines stay as they are.
export function patchCertificateEnv(flow: string, labels: string[]): string {
  if (!CHECK_ENV.test(flow)) throw new TapsterError("the hub workflow has no check step", "Run tapster init --workflow to rewrite it from the template.");
  if ((flow.match(SIGN_ENV) ?? []).length < 2) throw new TapsterError("the hub workflow has no sign step", "Run tapster init --workflow to rewrite it from the template.");
  return flow.replace(CHECK_ENV, (_, head: string) => head + certificateCheckEnv(labels)).replace(SIGN_ENV, (_, head: string) => head + certificateEnv(labels));
}

// The certificate labels a workflow passes, in order of appearance.
export const flowCertificateLabels = (flow: string): string[] => [...new Set([...flow.matchAll(/MACOS_SIGN_P12_([A-Z0-9]+): /g)].map((m) => m[1]!.toLowerCase()))];


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

export async function workflowFile(gh: GitHub, before: string | null, labels: HubLabels, flag: string | null, schedule: Schedule): Promise<{ file: HubFile; change: string; notes: string[] }> {
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
  const labels = config === null ? { sparkle: [], certificates: [] } : hubLabels(parseHub(config, hub.split("/")[0]!).config);
  const flow = await workflowFile(gh, await read(FLOW), labels, flag, schedule);
  files.push(flow.file);
  return { files, kept, change: flow.change, notes: flow.notes };
}
