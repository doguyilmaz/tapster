import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type HubConfig, parseConfig } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { currentRepo, userGitHub } from "./gh";
import { sparkleLabels } from "./init";

export type Check = { name: string; ok: boolean; fix: string };
const ok = (name: string): Check => ({ name, ok: true, fix: "" });
const bad = (name: string, fix: string): Check => ({ name, ok: false, fix });

export function workflowTriggerCheck(yaml: string): Check {
  const name = "the hub workflow runs only on schedule and manual dispatch";
  const on = (parse(yaml) as { on?: unknown })?.on;
  const keys = on && typeof on === "object" && !Array.isArray(on) ? Object.keys(on) : [];
  return keys.length > 0 && keys.every((k) => k === "schedule" || k === "workflow_dispatch")
    ? ok(name)
    : bad(name, "Other triggers (pull_request_target, issue_comment, workflow_run) would reach the credentials. Restore .github/workflows/tapster.yml with tapster init.");
}

export function otherWorkflowsCheck(files: Record<string, string>): Check {
  const name = "no other workflow uses the tapster environment";
  const usesTapster = (text: string): boolean => {
    let flow: unknown;
    try {
      flow = parse(text);
    } catch {
      return true;
    }
    const jobs = (flow as { jobs?: unknown } | null)?.jobs;
    if (!jobs || typeof jobs !== "object") return false;
    return Object.values(jobs as Record<string, unknown>).some((job) => {
      const env = (job as { environment?: unknown } | null)?.environment;
      const name = typeof env === "object" && env !== null ? (env as { name?: unknown }).name : env;
      return typeof name === "string" && (name.trim() === "tapster" || name.includes("${{"));
    });
  };
  const offenders = Object.entries(files).filter(([, text]) => usesTapster(text)).map(([f]) => f);
  return offenders.length === 0 ? ok(name) : bad(name, `Remove the tapster environment from ${offenders.join(", ")}.`);
}

export function sparkleCheck(config: HubConfig, secrets: string[], workflow: string): Check {
  const name = "every Sparkle key is stored and passed to the sparkle step";
  const labels = sparkleLabels(config);
  const unstored = labels.filter((l) => !secrets.includes(`SPARKLE_KEY_${l.toUpperCase()}`));
  if (unstored.length) return bad(name, unstored.map((l) => `Run tapster init --sparkle ${l}.`).join(" "));
  const unwired = labels.filter((l) => !workflow.includes(`SPARKLE_KEY_${l.toUpperCase()}: "\${{ secrets.SPARKLE_KEY_${l.toUpperCase()} }}"`));
  if (unwired.length) return bad(name, `The workflow does not pass ${unwired.map((l) => `SPARKLE_KEY_${l.toUpperCase()}`).join(", ")}. Run tapster init --workflow.`);
  return ok(name);
}

export function doorbellCheck(hub: string, projects: Record<string, string | null>): Check {
  const name = "every project rings the hub's doorbell";
  const off = Object.entries(projects).filter(([, v]) => v !== hub).map(([repo]) => repo);
  return off.length ? bad(name, off.map((r) => `gh variable set TAPSTER_DOORBELL --repo ${r} --body ${hub}`).join("; ")) : ok(name);
}

const SECRETS = ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID", "TAPSTER_APP_PRIVATE_KEY"];
const VARIABLES = ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG", "TAPSTER_TEAM_ID"];

async function apiChecks(gh: GitHub, hub: string, repos: string[], config: HubConfig | null, workflow: string): Promise<Check[]> {
  const checks: Check[] = [];
  const env = await gh.json<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("GET", `/repos/${hub}/environments/tapster`).catch(() => null);
  if (!env) return [bad("the tapster environment exists", "Run tapster init.")];
  const policies = await gh.json<{ branch_policies: { name: string; type?: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  checks.push(
    env.deployment_branch_policy?.custom_branch_policies && policies.branch_policies.length === 1 && policies.branch_policies[0]!.name === "main" && (policies.branch_policies[0]!.type ?? "branch") === "branch"
      ? ok("only main may open the tapster environment")
      : bad("only main may open the tapster environment", "Run tapster init to restore the branch rule."),
  );
  const secrets = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/secrets`)).secrets.map((s) => s.name);
  const missing = SECRETS.filter((s) => !secrets.includes(s));
  checks.push(missing.length ? bad("all credentials are stored", `Missing: ${missing.join(", ")}. Run tapster init --rotate for them.`) : ok("all credentials are stored"));
  if (config && sparkleLabels(config).length) checks.push(sparkleCheck(config, secrets, workflow));
  const vars = (await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`)).variables;
  const repoVars = (await gh.json<{ variables: { name: string }[] }>("GET", `/repos/${hub}/actions/variables`)).variables;
  const exposed = [...vars, ...repoVars].map((v) => v.name).filter((n) => SECRETS.includes(n) || /^SPARKLE_KEY_/.test(n));
  checks.push(exposed.length ? bad("credentials are secrets, not variables", `Variables are readable by anyone with access; delete ${exposed.join(", ")} and store them with tapster init --rotate.`) : ok("credentials are secrets, not variables"));
  const missingVars = VARIABLES.filter((v) => !vars.some((x) => x.name === v));
  checks.push(missingVars.length ? bad("the App and team variables are set", `Missing: ${missingVars.join(", ")}. Run tapster init.`) : ok("the App and team variables are set"));
  const doorbell = vars.find((v) => v.name === "TAPSTER_DOORBELL")?.value;
  if (doorbell) {
    const values: Record<string, string | null> = {};
    for (const repo of repos) {
      values[repo] = await gh.json<{ value: string }>("GET", `/repos/${repo}/actions/variables/TAPSTER_DOORBELL`).then((v) => v.value).catch(() => null);
    }
    checks.push(doorbellCheck(doorbell, values));
  }
  const perms = await gh.json<{ default_workflow_permissions: string }>("GET", `/repos/${hub}/actions/permissions/workflow`);
  checks.push(perms.default_workflow_permissions === "read" ? ok("the default workflow token is read-only") : bad("the default workflow token is read-only", "Run tapster init."));
  const rules = await gh.json<{ name: string }[]>("GET", `/repos/${hub}/rulesets`);
  checks.push(rules.some((r) => r.name === "tapster main") ? ok("main cannot be force-pushed or deleted") : bad("main cannot be force-pushed or deleted", "Run tapster init."));
  const flow = await gh.json<{ state: string }>("GET", `/repos/${hub}/actions/workflows/tapster.yml`).catch(() => null);
  checks.push(flow?.state === "active" ? ok("the schedule is enabled") : bad("the schedule is enabled", "Enable the tapster workflow in the hub's Actions tab (GitHub pauses it after 60 days without activity)."));
  for (const repo of repos) {
    const r = await gh.getRepo(repo).catch((e) => (e instanceof GitHubError ? null : Promise.reject(e)));
    if (!r) {
      checks.push(bad(`${repo} exists`, "Fix the repo field in tapster.yml."));
      continue;
    }
    checks.push(r.private ? bad(`${repo} is public`, "Homebrew downloads release files without a token; make the repository public first.") : ok(`${repo} is public`));
    const leftovers = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${repo}/actions/secrets`)).secrets
      .map((s) => s.name)
      .filter((n) => /^(HOMEBREW_TAP_|MACOS_)/.test(n));
    checks.push(leftovers.length ? bad(`${repo} holds no release secrets`, `Delete ${leftovers.join(", ")}: gh secret delete <name> --repo ${repo}`) : ok(`${repo} holds no release secrets`));
  }
  return checks;
}

async function appNote(gh: GitHub, hub: string, repos: string[]): Promise<string | null> {
  const vars = await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`).catch(() => null);
  const slug = vars?.variables.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  if (!slug || repos.length === 0) return null;
  return `note the App must be installed on ${repos.join(", ")} and not on ${hub}; GitHub shows its repositories only to the App itself, so check them at https://github.com/apps/${slug}/installations/new (the hub's check job also reports both)`;
}

export async function doctor(_args: string[]): Promise<number> {
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const checks: Check[] = [];
  let repos: string[] = [];
  let config: HubConfig | null = null;
  try {
    config = parseConfig(readFileSync(join(dir, "tapster.yml"), "utf8"), hub.split("/")[0]!);
    repos = config.packages.map((p) => p.repo);
    checks.push(ok("tapster.yml is valid"));
  } catch (e) {
    checks.push(bad("tapster.yml is valid", e instanceof TapsterError ? `${e.reason}. ${e.fix}` : "Run tapster init."));
  }
  const flowsDir = join(dir, ".github/workflows");
  const flows = existsSync(flowsDir) ? Object.fromEntries(readdirSync(flowsDir).map((f) => [f, readFileSync(join(flowsDir, f), "utf8")])) : {};
  checks.push(flows["tapster.yml"] ? workflowTriggerCheck(flows["tapster.yml"]) : bad("the hub workflow exists", "Run tapster init."));
  const { "tapster.yml": _, ...others } = flows;
  checks.push(otherWorkflowsCheck(others));
  const gh = await userGitHub();
  checks.push(...(await apiChecks(gh, hub, repos, config, flows["tapster.yml"] ?? "")));
  for (const c of checks) console.log(c.ok ? `ok   ${c.name}` : `fix  ${c.name}\n     ${c.fix}`);
  const note = await appNote(gh, hub, repos);
  if (note) console.log(note);
  return checks.every((c) => c.ok) ? 0 : 1;
}
