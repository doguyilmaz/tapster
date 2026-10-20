import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { GitHubError, TapsterError } from "../errors";
import { GitHub } from "../github";
import { readSecret } from "../mask";
import { type Finding, info } from "../report";

export const TITLE = "tapster: the hub needs attention";
const BOT = "github-actions[bot]";
const MAX = 50;
const FIELD = 500;
const BUDGET = 60_000;
const MARK = /<!-- tapster-health: ([0-9a-f]{64}) -->\s*$/;
const CLOSING = "Everything the hub checks is fine again, so tapster closed this issue.";
const CHECK_FAILED: Finding = {
  item: "hub",
  reason: "the check job failed before it could report",
  fix: "Open the hub's latest tapster run in the Actions tab; its check job shows the error.",
};
const INTRO = [
  "tapster checks this hub on every run and opened this issue because something needs you. It updates the issue when the findings change and closes it once all is well.",
  "Fix what is listed with the setup app (`bunx @doguyilmaz/tapster setup`, under Health) or with `tapster doctor` in a clone of the hub. [Troubleshooting](https://tapster.doguyilmaz.com/reference/troubleshooting/) explains the messages.",
];

function field(text: string): string {
  const s = text.replace(/`/g, "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim();
  if (s.length <= FIELD) return s;
  const cut = s.slice(0, FIELD - 3);
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}...`;
}

export function normalize(list: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const f of list) {
    const n = { item: field(f.item), reason: field(f.reason), fix: field(f.fix) };
    unique.set(JSON.stringify(n), n);
  }
  return [...unique.keys()].sort().slice(0, MAX).map((k) => unique.get(k)!);
}

export function healthBody(findings: Finding[]): { body: string; hash: string } {
  const list = normalize(findings);
  const hash = createHash("sha256").update(JSON.stringify(list)).digest("hex");
  const parts = [...INTRO];
  let size = parts.join("\n\n").length;
  let shown = 0;
  for (const f of list) {
    const block = `\`\`\`text\n${f.item}: ${f.reason}\nFix: ${f.fix}\n\`\`\``;
    if (size + block.length > BUDGET) break;
    parts.push(block);
    size += block.length + 2;
    shown++;
  }
  if (shown < list.length) parts.push(`${list.length - shown} more are listed in the hub's latest tapster run.`);
  parts.push(`<!-- tapster-health: ${hash} -->`);
  return { body: `${parts.join("\n\n")}\n`, hash };
}

const input = z.array(z.object({ item: z.string().max(FIELD), reason: z.string().max(FIELD), fix: z.string().max(FIELD) }).strict()).max(MAX);

export function parseFindings(text: string, check: string): Finding[] {
  if (text.trim() === "") return check === "failure" ? [CHECK_FAILED] : [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TapsterError("the findings are not valid JSON", "Pass the check job's findings output unchanged.");
  }
  const r = input.safeParse(raw);
  if (!r.success) throw new TapsterError("the findings are invalid", "Pass the check job's findings output unchanged.");
  return r.data;
}

export type HealthIssue = { number: number; hash: string | null } | null;

type Issue = { number: number; title: string; body?: string | null; user?: { login: string } | null; pull_request?: unknown };

export async function healthIssue(gh: GitHub, hub: string): Promise<HealthIssue> {
  const issues = await gh.json<Issue[]>("GET", `/repos/${hub}/issues?state=open&creator=${encodeURIComponent(BOT)}&per_page=100`);
  const issue = issues.find((i) => i.title === TITLE && i.user?.login === BOT && !i.pull_request);
  return issue ? { number: issue.number, hash: MARK.exec(issue.body ?? "")?.[1] ?? null } : null;
}

export const needsReport = (hash: string, count: number, issue: HealthIssue): boolean => (issue ? count === 0 || issue.hash !== hash : count > 0);

const issuesOff = (e: unknown) => e instanceof GitHubError && e.status === 410;
const OFF = "Issues are turned off in this hub, so tapster cannot open the issue that lists what needs you. Turn them on in the hub's settings to get it.";

async function reportNeeded(list: Finding[], hub: { name: string; token: string } | null): Promise<boolean> {
  if (!hub) return false;
  if (!hub.token || !hub.name) return list.length > 0;
  try {
    return needsReport(healthBody(list).hash, list.length, await healthIssue(new GitHub(hub.token), hub.name));
  } catch (e) {
    if (!issuesOff(e)) return list.length > 0;
    if (list.length && process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(OFF, true).write();
    return false;
  }
}

export async function checkOutputs(all: Finding[], hub: { name: string; token: string } | null): Promise<void> {
  const list = normalize(all);
  core.setOutput("findings", JSON.stringify(list));
  core.setOutput("report", String(await reportNeeded(list, hub).catch(() => list.length > 0)));
}

export async function updateIssue(gh: GitHub, hub: string, findings: Finding[]): Promise<string> {
  let issue: HealthIssue;
  try {
    issue = await healthIssue(gh, hub);
  } catch (e) {
    if (issuesOff(e)) return OFF;
    throw e;
  }
  const { body, hash } = healthBody(findings);
  if (normalize(findings).length === 0) {
    if (!issue) return "the hub has no open health issue";
    await gh.json("POST", `/repos/${hub}/issues/${issue.number}/comments`, { body: CLOSING });
    await gh.json("PATCH", `/repos/${hub}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    return `closed the hub's health issue #${issue.number}`;
  }
  if (!issue) {
    const made = await gh.json<{ number: number }>("POST", `/repos/${hub}/issues`, { title: TITLE, body });
    return `opened the hub's health issue #${made.number}`;
  }
  if (issue.hash === hash) return `the hub's health issue #${issue.number} is up to date`;
  await gh.json("PATCH", `/repos/${hub}/issues/${issue.number}`, { body });
  return `updated the hub's health issue #${issue.number}`;
}

export async function reportMode(): Promise<void> {
  const findings = parseFindings(core.getInput("findings"), core.getInput("check"));
  const hub = process.env.GITHUB_REPOSITORY;
  if (!hub) throw new TapsterError("tapster runs inside GitHub Actions only", "Call it from the hub workflow.");
  info(await updateIssue(new GitHub(readSecret("GITHUB_TOKEN")), hub, findings));
}
