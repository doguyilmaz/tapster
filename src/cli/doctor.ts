import { parse } from "yaml";
import { type HubConfig, isApp, linuxUrl, macosCode, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { readHubFile } from "../hubcommit";
import { protectionProblems } from "../rulesets";
import { TAPSTER } from "../version";
import type { GitHub } from "../github";
import { currentRepo, userGitHub } from "./gh";
import hubWorkflow from "../../templates/hub/tapster.yml" with { type: "text" };
import pinsJson from "../../templates/pins.json";
import { PIN, fillWorkflow, sparkleLabels } from "./hubfiles";
import { releaseSecrets } from "./hubpr";
import { everyFromFlow } from "./schedule";

export type Check = { name: string; ok: boolean; fix: string; note?: string };
const ok = (name: string, note?: string): Check => ({ name, ok: true, fix: "", ...(note ? { note } : {}) });
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
      return typeof name === "string" && (name.trim().toLowerCase() === "tapster" || name.includes("${{"));
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

export function linuxCheck(config: HubConfig, hub: string, secrets: string[], pages: { build_type: string; html_url: string } | null): Check {
  const name = "the Linux repositories can be signed and deployed";
  if (!secrets.includes("TAPSTER_LINUX_KEY")) return bad(name, "Run tapster init --linux to make and store the signing key.");
  if (!pages) return bad(name, "Turn on GitHub Pages for the hub; tapster init --linux does it.");
  if (pages.build_type !== "workflow") return bad(name, "Set the hub's Pages source to GitHub Actions; tapster init --linux does it.");
  const live = pages.html_url.replace(/\/$/, "");
  if (live !== linuxUrl(config, hub)) return bad(name, `Pages serves ${live}; set linux.url in tapster.yml to it.`);
  return ok(name);
}

const APPLE_SECRETS = ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"];
const SECRETS = [...APPLE_SECRETS, "TAPSTER_APP_PRIVATE_KEY"];

export function credentialsCheck(config: HubConfig | null, secrets: string[], vars: string[]): Check {
  const name = "the credentials this hub needs are stored";
  const mac = config?.packages.some(macosCode) ?? false;
  const missing = [
    ...["TAPSTER_APP_PRIVATE_KEY", ...(mac ? APPLE_SECRETS : [])].filter((x) => !secrets.includes(x)),
    ...["TAPSTER_APP_ID", "TAPSTER_APP_SLUG", ...(mac ? ["TAPSTER_TEAM_ID"] : [])].filter((x) => !vars.includes(x)),
  ];
  if (missing.length === 0) return ok(name);
  const fixes = [
    ...(missing.some((m) => m.startsWith("TAPSTER_APP")) ? ["tapster init"] : []),
    ...(missing.some((m) => m.startsWith("MACOS_SIGN") || m === "TAPSTER_TEAM_ID") ? ["tapster init --rotate certificate"] : []),
    ...(missing.some((m) => m.startsWith("MACOS_NOTARY")) ? ["tapster init --rotate notary"] : []),
  ];
  return bad(name, `Missing: ${missing.join(", ")}. Run ${fixes.join(" and ")}.`);
}


export function workflowCheck(text: string, me: { version: string; sha: string | null }): Check {
  const name = "the hub workflow is tapster's template";
  const pin = PIN.exec(text);
  if (!pin) return bad(name, "The workflow does not pin tapster. Run tapster init --workflow.");
  if (pin[1] !== me.sha) {
    return ok(name, `the hub runs tapster ${pin[2]} (${pin[1]!.slice(0, 7)}) and this is tapster ${me.version}; tapster init --workflow moves the hub to this one. The tapster that wrote the workflow checks it byte for byte`);
  }
  const labels = [...text.matchAll(/SPARKLE_KEY_([A-Z0-9]+): "/g)].map((m) => m[1]!.toLowerCase());
  const expected = fillWorkflow(hubWorkflow, pinsJson, { sha: pin[1]!, tag: pin[2]! }, labels, everyFromFlow(text) ?? 10);
  return expected === text ? ok(name) : bad(name, "The workflow differs from the template; hand edits can reach the credentials. Run tapster init --workflow and review the diff.");
}

type RulesetDetail = { enforcement: string; target: string; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: { type: string }[]; bypass_actors?: { actor_type: string; actor_id: number | null }[] };

export function hubRulesetCheck(rulesets: RulesetDetail[]): Check {
  const name = "main cannot be deleted or force-pushed, by anyone";
  const good = rulesets.some(
    (r) =>
      r.enforcement === "active" &&
      r.target === "branch" &&
      (r.conditions?.ref_name?.include ?? []).some((i) => i === "~DEFAULT_BRANCH" || i === "~ALL" || i === "refs/heads/main") &&
      (r.conditions?.ref_name?.exclude ?? []).length === 0 &&
      ["deletion", "non_fast_forward"].every((t) => (r.rules ?? []).some((x) => x.type === t)) &&
      (r.bypass_actors ?? []).every((a) => a.actor_type === "RepositoryRole" && a.actor_id === 5),
  );
  return good ? ok(name) : bad(name, "Run tapster init to restore the ruleset \"tapster main\" (active, deletion and force pushes blocked, no one else may bypass).");
}

export function policyCheck(
  perms: { enabled?: boolean; allowed_actions?: string; sha_pinning_required?: boolean },
  selected: { github_owned_allowed?: boolean; verified_allowed?: boolean; patterns_allowed?: string[] } | null,
): Check {
  const name = "the hub runs only GitHub's and tapster's actions, pinned by commit";
  const fine =
    perms.allowed_actions === "selected" &&
    perms.sha_pinning_required === true &&
    selected?.verified_allowed === false &&
    (selected.patterns_allowed ?? []).every((p) => p === "doguyilmaz/tapster@*");
  return fine ? ok(name) : bad(name, "Run tapster init to restore the hub's Actions policy.");
}

export function accessCheck(collaborators: { login: string }[], keys: { title: string; read_only: boolean }[], owner: string): Check {
  const name = "only you can change the hub";
  const people = collaborators.map((c) => c.login).filter((l) => l.toLowerCase() !== owner.toLowerCase());
  const writers = keys.filter((k) => !k.read_only).map((k) => k.title);
  if (people.length === 0 && writers.length === 0) return ok(name);
  const parts = [
    ...(people.length ? [`collaborators ${people.join(", ")} can push to main and change what the hub signs`] : []),
    ...(writers.length ? [`deploy keys ${writers.join(", ")} can push too`] : []),
  ];
  return bad(name, `${parts.join("; ")}. Remove them in the hub's settings unless you trust them with your signing keys.`);
}

export function doorbellEveryCheck(stored: string | undefined, workflowEvery: number): Check {
  const name = "the doorbell keeps the workflow's schedule";
  if (stored === String(workflowEvery)) return ok(name);
  return bad(name, `The doorbell starts the hub every ${stored ?? "10"} minutes and the workflow every ${workflowEvery}. Run tapster init --rotate doorbell to move the doorbell to the workflow's schedule.`);
}

export function scheduleCheck(runs: { event: string; created_at: string }[], now: number, doorbell: boolean): Check {
  const name = "the hub ran in the last day";
  const recent = runs.some((r) => (r.event === "schedule" || r.event === "workflow_dispatch") && now - Date.parse(r.created_at) < 86_400_000);
  if (recent) return ok(name);
  return bad(name, doorbell ? "Neither GitHub's schedule nor the doorbell started a run. Check the doorbell's live logs in the Cloudflare dashboard (Workers & Pages, tapster-doorbell, Logs) and the workflow in the Actions tab." : "GitHub's schedule did not start a run; it is best effort. tapster init --doorbell adds a second clock that starts the hub on time.");
}



async function list<T>(gh: GitHub, path: string, key?: string): Promise<T[]> {
  try {
    const res = await gh.json<unknown>("GET", path);
    return (key ? (res as Record<string, T[]>)[key] : (res as T[])) ?? [];
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return [];
    throw e;
  }
}

async function apiChecks(gh: GitHub, hub: string, owner: string, config: HubConfig | null, workflow: string): Promise<Check[]> {
  const checks: Check[] = [];
  const env = await gh.json<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("GET", `/repos/${hub}/environments/tapster`).catch(() => null);
  if (!env) return [bad("the tapster environment exists", "Run tapster init.")];
  const policies = await gh.json<{ branch_policies: { name: string; type?: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  checks.push(
    env.deployment_branch_policy?.custom_branch_policies && policies.branch_policies.length === 1 && policies.branch_policies[0]!.name === "main" && (policies.branch_policies[0]!.type ?? "branch") === "branch"
      ? ok("only main may open the tapster environment")
      : bad("only main may open the tapster environment", "Run tapster init to restore the branch rule."),
  );
  const secrets = (await list<{ name: string }>(gh, `/repos/${hub}/environments/tapster/secrets?per_page=100`, "secrets")).map((x) => x.name);
  const vars = await list<{ name: string; value: string }>(gh, `/repos/${hub}/environments/tapster/variables?per_page=100`, "variables");
  checks.push(credentialsCheck(config, secrets, vars.map((v) => v.name)));
  const expires = vars.find((v) => v.name === "TAPSTER_CERT_EXPIRES")?.value;
  if (expires && Date.parse(`${expires}T00:00:00Z`) - Date.now() < 30 * 86_400_000) checks.push(bad("the Developer ID certificate is valid for 30 more days", `It expires on ${expires}. Renew it at developer.apple.com, then run tapster init --rotate certificate.`));
  if (config && sparkleLabels(config).length) checks.push(sparkleCheck(config, secrets, workflow));
  if (config?.packages.some((p) => !isApp(p) && p.linux)) {
    const pages = await gh.json<{ build_type: string; html_url: string }>("GET", `/repos/${hub}/pages`).catch(() => null);
    checks.push(linuxCheck(config, hub, secrets, pages));
    if (secrets.includes("TAPSTER_LINUX_KEY_PREVIOUS")) checks.push(ok("the Linux key rotation is running", "the previous Linux key still signs; once apt and dnf users have the new key, run tapster init --rotate linux --finish"));
  }
  const repoVars = await list<{ name: string }>(gh, `/repos/${hub}/actions/variables?per_page=100`, "variables");
  const exposed = [...vars, ...repoVars].map((v) => v.name).filter((n) => SECRETS.includes(n) || /^SPARKLE_KEY_/.test(n) || n.startsWith("TAPSTER_LINUX_KEY"));
  checks.push(exposed.length ? bad("credentials are secrets, not variables", `Variables are readable by anyone with access; delete ${exposed.join(", ")} and store them with tapster init --rotate.`) : ok("credentials are secrets, not variables"));
  const doorbell = vars.find((v) => v.name === "TAPSTER_DOORBELL")?.value;
  if (doorbell && config) {
    const values: Record<string, string | null> = {};
    for (const p of config.packages) {
      values[p.repo] = await gh.json<{ value: string }>("GET", `/repos/${p.repo}/actions/variables/TAPSTER_DOORBELL`).then((v) => v.value).catch(() => null);
    }
    checks.push(doorbellCheck(doorbell, values));
    checks.push(doorbellEveryCheck(vars.find((v) => v.name === "TAPSTER_DOORBELL_EVERY")?.value, everyFromFlow(workflow) ?? 10));
  }
  const perms = await gh.json<{ default_workflow_permissions: string }>("GET", `/repos/${hub}/actions/permissions/workflow`);
  checks.push(perms.default_workflow_permissions === "read" ? ok("the default workflow token is read-only") : bad("the default workflow token is read-only", "Run tapster init."));
  const rulesets = await Promise.all((await list<{ id: number }>(gh, `/repos/${hub}/rulesets`)).map((r) => gh.json<RulesetDetail>("GET", `/repos/${hub}/rulesets/${r.id}`)));
  checks.push(hubRulesetCheck(rulesets));
  const actions = await gh.json<{ enabled?: boolean; allowed_actions?: string; sha_pinning_required?: boolean }>("GET", `/repos/${hub}/actions/permissions`);
  const selected = actions.allowed_actions === "selected" ? await gh.json<{ github_owned_allowed?: boolean; verified_allowed?: boolean; patterns_allowed?: string[] }>("GET", `/repos/${hub}/actions/permissions/selected-actions`) : null;
  checks.push(policyCheck(actions, selected));
  checks.push(accessCheck(await list<{ login: string }>(gh, `/repos/${hub}/collaborators?affiliation=direct&per_page=100`), await list<{ title: string; read_only: boolean }>(gh, `/repos/${hub}/keys?per_page=100`), owner));
  const flow = await gh.json<{ state: string }>("GET", `/repos/${hub}/actions/workflows/tapster.yml`).catch(() => null);
  checks.push(flow?.state === "active" ? ok("the hub workflow is enabled") : bad("the hub workflow is enabled", "Enable the tapster workflow in the hub's Actions tab (GitHub pauses it after 60 days without activity; the doorbell turns it back on)."));
  const runs = await list<{ event: string; created_at: string }>(gh, `/repos/${hub}/actions/workflows/tapster.yml/runs?per_page=30`, "workflow_runs");
  checks.push(scheduleCheck(runs, Date.now(), Boolean(doorbell)));
  for (const p of config?.packages ?? []) {
    const r = await gh.getRepo(p.repo).catch((e) => (e instanceof GitHubError ? null : Promise.reject(e)));
    if (!r) {
      checks.push(bad(`${p.repo} exists`, "Fix the repo field in tapster.yml."));
      continue;
    }
    if (r.private) checks.push(ok(`${p.repo} is published by the hub`, `${p.repo} is private: the hub publishes its releases, but Homebrew, Scoop, apt and dnf users can only install from public projects`));
    if (p.protection === "off") checks.push(ok(`${p.repo} is protected`, `protection is off for ${p.name}: a stolen App key could tag code there that the hub would sign`));
    else {
      const problems = await protectionProblems(gh, p.repo, r.default_branch, "admin", p.protection === "dependabot");
      const note = p.protection === "dependabot" ? `branches named dependabot/... are open on ${p.repo}, so a stolen App key could run its workflows on code of its own there` : undefined;
      checks.push(problems.length ? bad(`${p.repo} is protected`, `${problems.join("; ")}. Run tapster add in a clone of ${p.repo}.`) : ok(`${p.repo} is protected`, note));
    }
    const names = (await list<{ name: string }>(gh, `/repos/${p.repo}/actions/secrets?per_page=100`, "secrets")).map((x) => x.name);
    const leftovers = releaseSecrets(names);
    checks.push(leftovers.length ? bad(`${p.repo} holds no release secrets`, `Delete ${leftovers.join(", ")}: gh secret delete <name> --repo ${p.repo}`) : ok(`${p.repo} holds no release secrets`));
  }
  return checks;
}

async function appNote(gh: GitHub, hub: string, repos: string[]): Promise<string | null> {
  const vars = await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`).catch(() => null);
  const slug = vars?.variables.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  if (!slug || repos.length === 0) return null;
  return `note: the App must be installed on ${repos.join(", ")} and not on ${hub}; GitHub shows its repositories only to the App itself, so check them at https://github.com/apps/${slug}/installations/new (the hub's check job also reports both)`;
}

export function configChecks(text: string | null, owner: string): { checks: Check[]; config: HubConfig | null } {
  if (text === null) return { checks: [bad("tapster.yml is valid", "Run tapster init.")], config: null };
  try {
    const { config, invalid } = parseHub(text, owner);
    if (invalid.length === 0) return { checks: [ok("tapster.yml is valid")], config };
    return { checks: invalid.map((i) => bad(`${i.name} in tapster.yml is valid`, `${i.reason}. ${i.fix}`)), config };
  } catch (e) {
    return { checks: [bad("tapster.yml is valid", e instanceof TapsterError ? `${e.reason}. ${e.fix}` : "Run tapster init.")], config: null };
  }
}

async function mainFiles(gh: GitHub, hub: string): Promise<{ config: string | null; flows: Record<string, string> }> {
  const names = (await list<{ name: string; type: string }>(gh, `/repos/${hub}/contents/.github/workflows?ref=main`)).filter((f) => f.type === "file").map((f) => f.name);
  const flows: Record<string, string> = {};
  for (const n of names) flows[n] = (await readHubFile(gh, hub, `.github/workflows/${n}`, "main")) ?? "";
  return { config: await readHubFile(gh, hub, "tapster.yml", "main"), flows };
}

export async function doctorChecks(gh: GitHub, hub: string): Promise<{ checks: Check[]; note: string | null }> {
  const owner = hub.split("/")[0]!;
  const files = await mainFiles(gh, hub);
  const checks: Check[] = [];
  const parsed = configChecks(files.config, owner);
  const config = parsed.config;
  checks.push(...parsed.checks);
  const flow = files.flows["tapster.yml"];
  if (flow) checks.push(workflowTriggerCheck(flow), workflowCheck(flow, TAPSTER));
  else checks.push(bad("the hub workflow exists", "Run tapster init, commit and push."));
  const { "tapster.yml": _, ...others } = files.flows;
  checks.push(otherWorkflowsCheck(others));
  checks.push(...(await apiChecks(gh, hub, owner, config, flow ?? "")));
  return { checks, note: await appNote(gh, hub, config?.packages.map((p) => p.repo) ?? []) };
}

export async function doctor(_args: string[]): Promise<number> {
  const hub = await currentRepo(process.cwd());
  const gh = await userGitHub();
  console.log(`Checking ${hub} as it is on GitHub's main branch.`);
  const { checks, note } = await doctorChecks(gh, hub);
  for (const c of checks) {
    console.log(c.ok ? `ok   ${c.name}` : `fix  ${c.name}\n     ${c.fix}`);
    if (c.note) console.log(`     note: ${c.note}`);
  }
  if (note) console.log(note);
  return checks.every((c) => c.ok) ? 0 : 1;
}
