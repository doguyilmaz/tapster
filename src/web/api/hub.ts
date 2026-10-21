import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { type HubConfig, isApp, macosCode, parseHub } from "../../config";
import { GitHubError, TapsterError } from "../../errors";
import { foreignWrites } from "../../foreign";
import { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { appJwt, installationRepos } from "../../token";
import { TAPSTER } from "../../version";
import { P12_LIMIT, P8_LIMIT, inspectP12, notaryKey, saveCertificate, saveNotary } from "../../cli/apple";
import { convertManifest, permissionLines } from "../../cli/appflow";
import { doctorChecks, hubRulesetCheck, policyCheck } from "../../cli/doctor";
import { appInstallation, appManifest, storeApp } from "../../cli/hubapp";
import { FLOW, PIN, hubFiles, patchSparkleEnv, pinState, sparkleLabels, starterFiles } from "../../cli/hubfiles";
import { keyPins } from "../../cli/init";
import { setEnvSecret } from "../../cli/gh";
import { decodeSparkleKey } from "../../sparkle-key";
import { protectHub } from "../../cli/init";
import { everyFromFlow } from "../../cli/schedule";
import type { AccountView, AppStart, FilePlan, FilesView, HealthView, HubChoice, HubView, InstallView, OtherWorkflow } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { checkHub, checkedMain, hubFrom, lockedEnvironment, me, or404, writeMain } from "./access";
import { bellCallback, doorbellView } from "./doorbell";
import { linuxView } from "./linux";

export { checkHub, me };

const ISSUE_TITLE = "tapster: the hub needs attention";

export async function account(s: Session): Promise<AccountView> {
  let gh: GitHub;
  try {
    gh = await s.deps.github();
  } catch (e) {
    if (e instanceof TapsterError && /not installed/.test(e.reason)) return { state: "no-gh" };
    return { state: "signed-out" };
  }
  let res: Response;
  try {
    res = await gh.request("GET", "/user");
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) return { state: "signed-out" };
    throw e;
  }
  const user = (await res.json()) as { login: string };
  s.login = user.login;
  const header = res.headers.get("x-oauth-scopes");
  const scopes = header === null ? null : header.split(",").map((x) => x.trim());
  return { state: "ok", login: user.login, missing: scopes === null ? [] : ["repo", "workflow"].filter((x) => !scopes.includes(x)) };
}

const mainRef = async (gh: GitHub, hub: string): Promise<string | null> => {
  try {
    return (await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`)).object.sha;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
    throw e;
  }
};

export async function hubChoices(gh: GitHub, owner: string): Promise<HubChoice[]> {
  const repos: { full_name: string; name: string; private: boolean; html_url: string; owner: { login: string } }[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh.json<typeof repos>("GET", `/user/repos?affiliation=owner&sort=updated&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  const taps = repos.filter((r) => r.name.startsWith("homebrew-") && r.owner.login.toLowerCase() === owner.toLowerCase());
  return Promise.all(
    taps.map(async (r) => ({ name: r.full_name, private: r.private, url: r.html_url, tapster: (await or404(gh.json("GET", `/repos/${r.full_name}/environments/tapster`))) !== null })),
  );
}

export function otherWorkflows(flows: Record<string, string>): OtherWorkflow[] {
  const out: OtherWorkflow[] = [];
  for (const [file, text] of Object.entries(flows)) {
    if (file === "tapster.yml") continue;
    let doc: unknown;
    try {
      doc = parse(text);
    } catch {
      out.push({ file, actions: ["(the file is not valid YAML)"] });
      continue;
    }
    const jobs = (doc as { jobs?: Record<string, { steps?: { uses?: unknown }[]; uses?: unknown }> } | null)?.jobs ?? {};
    const uses = Object.values(jobs).flatMap((j) => [j?.uses, ...(j?.steps ?? []).map((st) => st?.uses)]).filter((u): u is string => typeof u === "string");
    const blocked = uses.filter((u) => {
      if (u.startsWith("./")) return false;
      const [name, ref] = u.split("@");
      const owner = (name ?? "").split("/")[0]!.toLowerCase();
      const allowed = owner === "actions" || owner === "github" || (name ?? "").toLowerCase() === "doguyilmaz/tapster";
      return !allowed || !/^[0-9a-f]{40}$/.test(ref ?? "");
    });
    if (blocked.length) out.push({ file, actions: [...new Set(blocked)] });
  }
  return out;
}

type Named = { name: string; value?: string };

export async function hubView(s: Session, gh: GitHub, hub: string): Promise<HubView> {
  const repo = await gh.json<{ private: boolean; html_url: string }>("GET", `/repos/${hub}`);
  const branch = await mainRef(gh, hub);
  const empty = branch === null;
  const env = await or404(gh.json<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("GET", `/repos/${hub}/environments/tapster`));
  const list = async (kind: "variables" | "secrets") => (env ? ((await gh.json<Record<string, Named[]>>("GET", `/repos/${hub}/environments/tapster/${kind}?per_page=100`))[kind] ?? []) : []);
  const [vars, secrets, policies, rulesetIds, actions, tokenPerms] = await Promise.all([
    list("variables"),
    list("secrets"),
    env ? gh.json<{ branch_policies: { name: string; type?: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`) : Promise.resolve({ branch_policies: [] }),
    gh.json<{ id: number }[]>("GET", `/repos/${hub}/rulesets`).catch(() => []),
    gh.json<{ allowed_actions?: string; sha_pinning_required?: boolean }>("GET", `/repos/${hub}/actions/permissions`),
    gh.json<{ default_workflow_permissions: string }>("GET", `/repos/${hub}/actions/permissions/workflow`),
  ]);
  const rulesets = await Promise.all(rulesetIds.map((r) => gh.json<Parameters<typeof hubRulesetCheck>[0][number]>("GET", `/repos/${hub}/rulesets/${r.id}`)));
  const selected = actions.allowed_actions === "selected" ? await gh.json<{ github_owned_allowed?: boolean; verified_allowed?: boolean; patterns_allowed?: string[] }>("GET", `/repos/${hub}/actions/permissions/selected-actions`) : null;
  const read = (path: string) => (empty ? Promise.resolve(null) : readHubFile(gh, hub, path, "main"));
  const [config, state, readme, flow, flowDir] = await Promise.all([
    read("tapster.yml"),
    read(".tapster/state.json"),
    read("README.md"),
    read(FLOW),
    empty ? Promise.resolve([]) : gh.json<{ name: string; type: string }[]>("GET", `/repos/${hub}/contents/.github/workflows?ref=main`).catch(() => []),
  ]);
  const flows: Record<string, string> = {};
  for (const f of flowDir.filter((x) => x.type === "file" && /\.ya?ml$/.test(x.name))) flows[f.name] = (await read(`.github/workflows/${f.name}`)) ?? "";
  const names = (xs: Named[]) => xs.map((x) => x.name);
  const v = (n: string) => vars.find((x) => x.name === n)?.value ?? null;
  const parsed = config === null ? null : (() => {
    try {
      return parseHub(config, hub.split("/")[0]!);
    } catch {
      return null;
    }
  })();
  const policyOk = Boolean(env?.deployment_branch_policy?.custom_branch_policies) && policies.branch_policies.length === 1 && policies.branch_policies[0]!.name === "main";
  const checks = [
    { label: "a tapster environment that only main may open", ok: policyOk },
    { label: "main cannot be deleted or force-pushed", ok: hubRulesetCheck(rulesets).ok },
    { label: "workflows run only GitHub's and tapster's actions, pinned by commit", ok: policyCheck(actions, selected).ok },
    { label: "the workflows' default token is read-only", ok: tokenPerms.default_workflow_permissions === "read" },
  ];
  const appId = v("TAPSTER_APP_ID");
  const held = s.apps.get(hub);
  const macPackages = parsed?.config.packages.some(macosCode) ?? false;
  const hasApple = Boolean(v("TAPSTER_TEAM_ID")) || names(secrets).includes("MACOS_NOTARY_KEY");
  const pinned = flow ? PIN.exec(flow) : null;
  const issues = await gh.json<{ title: string; html_url: string; number: number; updated_at: string; body: string | null; user: { login: string } | null }[]>("GET", `/repos/${hub}/issues?state=open&creator=${encodeURIComponent("github-actions[bot]")}&per_page=100`).catch(() => []);
  const issue = issues.find((i) => i.title === ISSUE_TITLE && i.user?.login === "github-actions[bot]");
  return {
    name: hub,
    url: repo.html_url,
    private: repo.private,
    empty,
    protect: { done: checks.every((x) => x.ok), environment: policyOk, checks, others: otherWorkflows(flows) },
    app: { id: appId, slug: v("TAPSTER_APP_SLUG"), key: names(secrets).includes("TAPSTER_APP_PRIVATE_KEY"), held: Boolean(held), installed: held ? await installView(s, hub) : null },
    apple: {
      needed: hasApple || macPackages ? true : null,
      certificate: v("TAPSTER_TEAM_ID") ? { team: v("TAPSTER_TEAM_ID")!, expires: v("TAPSTER_CERT_EXPIRES") ?? "" } : null,
      certificateStored: ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD"].every((n) => names(secrets).includes(n)),
      notary: ["MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"].every((n) => names(secrets).includes(n)),
    },
    files: {
      config: config !== null,
      state: state !== null,
      readme: readme !== null,
      workflow: pinState(flow, TAPSTER, s.deps.pin),
      pinned: pinned ? `${pinned[2]} (${pinned[1]!.slice(0, 7)})` : null,
      every: flow ? everyFromFlow(flow) : null,
    },
    packages: (parsed?.config.packages ?? []).map((p) => ({ name: p.name, repo: p.repo, kind: isApp(p) ? "app" : p.kind })),
    invalid: (parsed?.invalid ?? []).map((i) => ({ name: i.name, reason: i.reason })),
    issue: issue ? { url: issue.html_url, number: issue.number, updated: issue.updated_at, body: issue.body ?? "" } : null,
    extras: {
      doorbell: doorbellView(s, hub, v),
      linux: await linuxView(s, hub, config, parsed?.config ?? null, names(secrets)),
      sparkle: (parsed ? sparkleLabels(parsed.config) : []).map((label) => ({ label, stored: names(secrets).includes(`SPARKLE_KEY_${label.toUpperCase()}`) })),
    },
  };
}

async function installView(s: Session, hub: string): Promise<InstallView> {
  const held = s.apps.get(hub);
  if (!held) return { checked: false, id: null, onHub: false, repos: [] };
  const owner = hub.split("/")[0]!;
  const state = await appInstallation(held.id, held.pem, owner, hub, new GitHub(appJwt(held.id, held.pem), s.deps.fetch));
  const repos = state.id === null ? [] : ((await installationRepos(held.id, held.pem, owner, s.deps.fetch)) ?? []);
  return { checked: true, id: state.id, onHub: state.onHub, repos };
}

const hubBody = z.object({ hub: z.string() }).strict();

async function protect(c: Ctx) {
  const { hub } = await readJson(c.req, hubBody);
  const { gh } = await hubFrom(c, hub);
  const repo = await gh.json<{ private: boolean }>("GET", `/repos/${hub}`);
  await protectHub(gh, hub, repo.private);
  return { done: true };
}

async function appStart(c: Ctx): Promise<AppStart> {
  const { hub } = await readJson(c.req, hubBody);
  const { gh, login } = await hubFrom(c, hub);
  await lockedEnvironment(gh, hub);
  const state = randomBytes(16).toString("hex");
  for (const [k, p] of c.s.pending) if (Date.now() - p.at > 3_600_000) c.s.pending.delete(k);
  c.s.pending.set(state, { hub, owner: login, at: Date.now() });
  const manifest = appManifest(login, hub, `http://127.0.0.1:${c.s.port}/app/callback`) as { name: string };
  return { action: `https://github.com/settings/apps/new?state=${state}`, manifest: JSON.stringify(manifest), permissions: permissionLines(manifest), name: manifest.name };
}

export async function appCallback(c: Ctx): Promise<Response> {
  const back = (query: Record<string, string>) => new Response(null, { status: 303, headers: { location: `/setup?${new URLSearchParams(query)}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  const state = c.url.searchParams.get("state") ?? "";
  const code = c.url.searchParams.get("code") ?? "";
  const pending = c.s.pending.get(state);
  if (!pending || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) return back({ app: "unknown" });
  c.s.pending.delete(state);
  if (pending.kind === "doorbell") return bellCallback(c, pending, code, back);
  let created: Awaited<ReturnType<typeof convertManifest>>;
  try {
    created = await convertManifest(code, pending.owner, "If GitHub created the App anyway, delete it at https://github.com/settings/apps first, because its name would block a new one. Then create it again.", c.s.deps.fetch);
  } catch (e) {
    const p = e instanceof TapsterError ? e : new TapsterError("GitHub did not hand over the new App", "Try again from Setup.");
    return back({ app: "failed", hub: pending.hub, reason: p.reason, fix: p.fix });
  }
  c.s.apps.set(pending.hub, { id: String(created.id), pem: created.pem, slug: created.slug });
  try {
    await lockedEnvironment(await c.s.deps.github(), pending.hub);
    await storeApp(pending.hub, created);
    return back({ app: "created", hub: pending.hub });
  } catch (e) {
    const p = e instanceof TapsterError ? e : new TapsterError("the App's key could not be stored", "Try again.");
    return back({ app: "unstored", hub: pending.hub, reason: p.reason, fix: p.fix });
  }
}

async function appStore(c: Ctx) {
  const { hub } = await readJson(c.req, hubBody);
  const { gh } = await hubFrom(c, hub);
  await lockedEnvironment(gh, hub);
  const held = c.s.apps.get(hub);
  if (!held) throw new TapsterError("this setup no longer holds the App's key", "GitHub hands the key over only once. Delete the App at https://github.com/settings/apps, then create it again here.");
  await storeApp(hub, { id: Number(held.id), slug: held.slug, pem: held.pem });
  return { stored: true };
}

async function installation(c: Ctx): Promise<InstallView> {
  const { hub } = await hubFrom(c, c.url.searchParams.get("hub"));
  return installView(c.s, hub);
}

type Form = Awaited<ReturnType<Request["formData"]>>;

const file = (form: Form, name: string, limit: number): Promise<Uint8Array> => {
  const f = form.get(name);
  if (!(f instanceof File) || f.size === 0) throw new TapsterError(`no ${name} file was attached`, "Choose the file and try again.");
  if (f.size > limit) throw new TapsterError(`that ${name} file is too large`, "Choose the file Apple or Keychain Access gave you.");
  return f.arrayBuffer().then((b) => new Uint8Array(b));
};

async function form(c: Ctx): Promise<Form> {
  try {
    return await c.req.formData();
  } catch {
    throw new TapsterError("the form could not be read", "Reload the page and try again.");
  }
}

async function certificate(c: Ctx) {
  const f = await form(c);
  const { gh, hub } = await hubFrom(c, f.get("hub"));
  await lockedEnvironment(gh, hub);
  const data = await file(f, "p12", P12_LIMIT);
  const password = String(f.get("password") ?? "");
  const cert = await inspectP12(data, password);
  await saveCertificate(hub, data, password, cert);
  return cert;
}

async function notary(c: Ctx) {
  const f = await form(c);
  const { gh, hub } = await hubFrom(c, f.get("hub"));
  await lockedEnvironment(gh, hub);
  const key = notaryKey(await file(f, "p8", P8_LIMIT), String(f.get("keyId") ?? ""), String(f.get("issuerId") ?? ""));
  const checked = await c.s.deps.notary(key);
  await saveNotary(hub, key);
  return { checked };
}

const filesQuery = z.object({ hub: z.string(), every: z.number().int().nullable(), remove: z.array(z.string()).max(20), readme: z.boolean() }).strict();

async function filePlan(c: Ctx, gh: GitHub, hub: string, every: number | null, remove: string[], readme: boolean, read: (p: string) => Promise<string | null>): Promise<FilesView> {
  const repo = await gh.json<{ private: boolean }>("GET", `/repos/${hub}`);
  const plan = await hubFiles(gh, hub, read, c.s.deps.pin, { every, isPrivate: repo.private });
  const newer = pinState(await read(FLOW), TAPSTER, c.s.deps.pin) === "newer";
  const files: FilePlan[] = [];
  for (const f of plan.files.filter((x) => !(newer && x.path === FLOW))) files.push({ path: f.path, content: f.content, before: f.before, change: f.before === null ? "create" : f.before === f.content ? "same" : "update" });
  const ours = starterFiles(hub).find((f) => f.path === "README.md")!;
  const current = plan.kept.includes("README.md") ? await read("README.md") : null;
  if (readme && current !== null && current !== ours.content) files.push({ path: "README.md", content: ours.content, before: current, change: "update" });
  const others = remove.filter((r) => /^[A-Za-z0-9._-]+\.ya?ml$/.test(r) && r !== "tapster.yml");
  for (const r of others) {
    const before = await read(`.github/workflows/${r}`);
    if (before !== null) files.push({ path: `.github/workflows/${r}`, content: "", before, change: "remove" });
  }
  return { files, kept: plan.kept, pin: newer ? "kept: the hub runs a newer tapster than this one" : plan.change, notes: newer ? [] : plan.notes, foreign: [], readme: current !== null && current !== ours.content };
}

async function filesPreview(c: Ctx): Promise<FilesView> {
  const q = await readJson(c.req, filesQuery);
  const { gh, hub, login } = await hubFrom(c, q.hub);
  const view = await filePlan(c, gh, hub, q.every, q.remove, q.readme, (p) => readHubFile(gh, hub, p, "main"));
  const foreign = await foreignWrites(gh, hub, login).catch(() => []);
  return { ...view, foreign: foreign.filter((w) => !w.startsWith("GitHub shows no push by")) };
}

async function filesCommit(c: Ctx) {
  const q = await readJson(c.req, filesQuery);
  const { gh, hub, login } = await hubFrom(c, q.hub);
  if ((await mainRef(gh, hub)) === null) {
    const readme = starterFiles(hub).find((f) => f.path === "README.md")!;
    await gh.json("PUT", `/repos/${hub}/contents/README.md`, { message: "Start the tap", content: Buffer.from(readme.content).toString("base64"), branch: "main" });
    if ((await gh.json<{ default_branch: string }>("GET", `/repos/${hub}`)).default_branch !== "main") await gh.json("PATCH", `/repos/${hub}`, { default_branch: "main" });
  }
  const result = await writeMain(gh, hub, login, async (_, read) => {
    const plan = await filePlan(c, gh, hub, q.every, q.remove, q.readme, read);
    return { message: "Set up tapster", files: plan.files.filter((f) => f.change !== "same").map((f) => ({ path: f.path, content: f.change === "remove" ? null : f.content })) };
  });
  return { result };
}

async function createHub(c: Ctx) {
  const body = await readJson(c.req, z.object({ name: z.string().regex(/^homebrew-[A-Za-z0-9._-]{1,80}$/), private: z.boolean() }).strict());
  const { gh, login } = await me(c.s);
  try {
    const r = await gh.json<{ full_name: string }>("POST", "/user/repos", { name: body.name, private: body.private, auto_init: false, description: "Homebrew tap, published by tapster" });
    return { hub: r.full_name };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) throw new TapsterError(`${login}/${body.name} already exists`, "Pick it from the list instead.");
    throw e;
  }
}

const sparkleBody = z.object({ hub: z.string(), label: z.string().regex(/^[a-z0-9]{1,40}$/), account: z.string().regex(/^[A-Za-z0-9 ._@-]{1,64}$/) }).strict();

async function sparkleConfig(gh: GitHub, hub: string, label: string): Promise<HubConfig> {
  const text = await readHubFile(gh, hub, "tapster.yml", "main");
  const config = text === null ? null : parseHub(text, hub.split("/")[0]!).config;
  if (!config || !sparkleLabels(config).includes(label)) throw new TapsterError(`no app in ${hub}'s tapster.yml signs with the Sparkle key ${label}`, "Add the app with its sparkle section first.");
  return config;
}

async function sparkleRead(c: Ctx) {
  const body = await readJson(c.req, sparkleBody);
  const { gh, hub } = await hubFrom(c, body.hub);
  const config = await sparkleConfig(gh, hub, body.label);
  const text = await c.s.deps.keychain(body.account);
  if (text === null) throw new TapsterError(`your keychain gave no Sparkle key for the account ${body.account}`, "Choose Allow when macOS asks. generate_keys uses the account ed25519 unless you passed --account.");
  const key = decodeSparkleKey(text);
  const users = keyPins(config, body.label, key.publicKey);
  c.s.sparkle.set(`${hub} ${body.label}`, { seed: text.trim(), at: Date.now() });
  return { publicKey: key.publicKey, users, key: text.trim() };
}

async function sparkleStore(c: Ctx) {
  const body = await readJson(c.req, z.object({ hub: z.string(), label: z.string().regex(/^[a-z0-9]{1,40}$/), pasted: z.string().max(400) }).strict());
  const { gh, hub, login } = await hubFrom(c, body.hub);
  const held = c.s.sparkle.get(`${hub} ${body.label}`);
  if (!held || Date.now() - held.at > 30 * 60_000) throw new TapsterError("read the key from your keychain first", "Click Read it from my keychain again.");
  if (body.pasted.trim() !== held.seed) throw new TapsterError("that is not the key shown above", "Paste the key itself, so the copy your password manager keeps is the right one.");
  const config = await sparkleConfig(gh, hub, body.label);
  await lockedEnvironment(gh, hub);
  await checkedMain(gh, hub, login);
  await setEnvSecret(hub, `SPARKLE_KEY_${body.label.toUpperCase()}`, held.seed);
  const result = await writeMain(gh, hub, login, async (_, read) => {
    const flow = await read(FLOW);
    const next = flow === null ? null : patchSparkleEnv(flow, sparkleLabels(config));
    return { message: `Pass the Sparkle key ${body.label} to the hub workflow`, files: next === null || next === flow ? [] : [{ path: FLOW, content: next }] };
  });
  c.s.sparkle.delete(`${hub} ${body.label}`);
  return { stored: true, workflow: result };
}

async function health(c: Ctx): Promise<HealthView> {
  const { gh, hub } = await hubFrom(c, c.url.searchParams.get("hub"));
  const [{ checks, note }, runs] = await Promise.all([
    doctorChecks(gh, hub),
    gh.json<{ workflow_runs: { id: number; html_url: string; event: string; status: string; conclusion: string | null; created_at: string }[] }>("GET", `/repos/${hub}/actions/workflows/tapster.yml/runs?per_page=8`).catch(() => ({ workflow_runs: [] })),
  ]);
  return { checks, note, runs: runs.workflow_runs.map((r) => ({ id: r.id, url: r.html_url, event: r.event, status: r.status, conclusion: r.conclusion, created: r.created_at })) };
}

export type HubRunState = { id: number; status: string; conclusion: string | null; created_at: string; updated_at?: string; html_url: string; head_sha: string };

export const hubRunList = (gh: GitHub, hub: string) =>
  gh.json<{ workflow_runs: HubRunState[] }>("GET", `/repos/${hub}/actions/workflows/tapster.yml/runs?per_page=10`).then((r) => r.workflow_runs, () => [] as HubRunState[]);

// A dispatched run takes a few seconds to show in the list, so the session waits up to a minute for a run it has not seen yet.
export async function startHubRun(s: Session, gh: GitHub, hub: string): Promise<{ started: boolean; run: string | null }> {
  const runs = await hubRunList(gh, hub);
  const live = runs.find((r) => r.status !== "completed");
  if (live) return { started: false, run: live.html_url };
  const sent = s.dispatched.get(hub);
  if (sent && Date.now() - sent.at < 60_000 && runs.every((r) => sent.known.includes(r.id))) return { started: false, run: null };
  s.dispatched.set(hub, { at: Date.now(), known: runs.map((r) => r.id) });
  try {
    await gh.json("POST", `/repos/${hub}/actions/workflows/tapster.yml/dispatches`, { ref: "main" });
  } catch (e) {
    if (sent) s.dispatched.set(hub, sent);
    else s.dispatched.delete(hub);
    throw e;
  }
  return { started: true, run: null };
}

async function runHub(c: Ctx) {
  const { hub } = await readJson(c.req, hubBody);
  const { gh } = await hubFrom(c, hub);
  return { started: (await startHubRun(c.s, gh, hub)).started };
}

export const hubRoutes: Routes = {
  "GET /api/account": (c) => account(c.s),
  "GET /api/hubs": async (c) => {
    const { gh, login } = await me(c.s);
    return { hubs: await hubChoices(gh, login) };
  },
  "POST /api/hubs": createHub,
  "GET /api/hub": async (c) => {
    const { gh, hub } = await hubFrom(c, c.url.searchParams.get("hub"));
    return hubView(c.s, gh, hub);
  },
  "POST /api/hub/protect": protect,
  "POST /api/hub/app": appStart,
  "POST /api/hub/app/store": appStore,
  "GET /api/hub/installation": installation,
  "POST /api/hub/certificate": certificate,
  "POST /api/hub/notary": notary,
  "POST /api/hub/files/preview": filesPreview,
  "POST /api/hub/files": filesCommit,
  "GET /api/hub/health": health,
  "POST /api/hub/run": runHub,
  "POST /api/hub/sparkle/read": sparkleRead,
  "POST /api/hub/sparkle/store": sparkleStore,
};

