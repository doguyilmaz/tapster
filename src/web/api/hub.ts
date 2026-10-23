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
import { installLink } from "../../cli/hubpr";
import { appInstallation, appManifest, storeApp } from "../../cli/hubapp";
import { FLOW, PIN, hubFiles, patchSparkleEnv, pinState, sparkleLabels, starterFiles } from "../../cli/hubfiles";
import { keyPins } from "../../cli/init";
import { setEnvSecret } from "../../cli/gh";
import { decodeSparkleKey } from "../../sparkle-key";
import { protectHub } from "../../cli/init";
import { everyFromFlow } from "../../cli/schedule";
import type { AccountView, AppStart, FilePlan, FilesView, HealthView, HubCode, HubChoice, HubView, InstallView, OtherWorkflow } from "../contract";
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

type OwnedRepo = { full_name: string; name: string; private: boolean; html_url: string; owner: { login: string } };

const PAGE = 50;
const PAGES = 10;

// The first page's Link header says how many pages follow; those load at once. Each tap's environment is checked as
// soon as its page arrives.
export async function hubChoices(gh: GitHub, owner: string): Promise<HubChoice[]> {
  const page = (n: number) => gh.request("GET", `/user/repos?affiliation=owner&sort=updated&per_page=${PAGE}&page=${n}`);
  const first = await page(1);
  const last = Math.min(PAGES, Number(/[?&]page=(\d+)>; rel="last"/.exec(first.headers.get("link") ?? "")?.[1] ?? 1));
  const seen = new Set<string>();
  const taps = (repos: OwnedRepo[]) =>
    repos.filter((r) => {
      const key = r.full_name.toLowerCase();
      if (!r.name.startsWith("homebrew-") || r.owner.login.toLowerCase() !== owner.toLowerCase() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const choice = async (r: OwnedRepo): Promise<HubChoice> => ({ name: r.full_name, private: r.private, url: r.html_url, tapster: (await or404(gh.json("GET", `/repos/${r.full_name}/environments/tapster`))) !== null });
  const pages = [Promise.resolve(first), ...Array.from({ length: last - 1 }, (_, i) => page(i + 2))];
  const lists = await Promise.all(pages.map((p) => p.then((res) => res.json() as Promise<OwnedRepo[]>).then((repos) => Promise.all(taps(repos).map(choice)))));
  return lists.flat();
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

const quiet = (...ps: Promise<unknown>[]) => ps.forEach((p) => p.catch(() => undefined));

const repoIds = (s: Session, gh: GitHub, repos: string[]) =>
  Promise.all(
    repos.map((r) => {
      const key = `repo-id:${r.toLowerCase()}`;
      const known = s.memo.get(key) as Promise<number> | undefined;
      if (known) return known;
      const id = gh.getRepo(r).then((x) => x.id);
      s.memo.set(key, id);
      id.catch(() => s.memo.delete(key));
      return id;
    }),
  );

// The hub App must never reach the hub, so its install page preselects the hub's projects and nothing else.
async function appInstall(s: Session, gh: GitHub, hub: string, slug: string, ownerId: number, packages: { repo: string }[]): Promise<string> {
  const owner = hub.split("/")[0]!.toLowerCase();
  const repos = [...new Set(packages.map((p) => p.repo).filter((r) => r.split("/")[0]!.toLowerCase() === owner && r.toLowerCase() !== hub.toLowerCase()))];
  if (!repos.length) return `https://github.com/apps/${slug}/installations/new`;
  const ids = await repoIds(s, gh, repos).catch(() => null);
  return ids ? installLink(slug, ownerId, ...ids) : `https://github.com/apps/${slug}/installations/new`;
}

const parsedHub = (config: string | null, hub: string) => {
  if (config === null) return null;
  try {
    return parseHub(config, hub.split("/")[0]!);
  } catch {
    return null;
  }
};

// Each call starts as soon as what it needs is in. Reads of main and of the tapster environment start at once too; an
// empty hub or one without the environment drops their answers.
export async function hubView(s: Session, gh: GitHub, hub: string): Promise<HubView> {
  const get = <T>(path: string) => gh.json<T>("GET", `/repos/${hub}${path}`);
  const repoP = get<{ id: number; private: boolean; html_url: string; owner: { id: number } }>("");
  const emptyP = mainRef(gh, hub).then((sha) => sha === null);
  const envP = or404(get<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("/environments/tapster"));
  const unless = <T>(skip: Promise<boolean>, p: Promise<T>, none: T) => {
    quiet(p);
    return skip.then((x) => (x ? none : p));
  };
  const noEnvP = envP.then((env) => env === null);
  const inEnv = <T>(p: Promise<T>, none: T) => unless(noEnvP, p, none);
  const onMain = <T>(p: Promise<T>, none: T) => unless(emptyP, p, none);
  const list = (kind: "variables" | "secrets") => inEnv(get<Record<string, Named[]>>(`/environments/tapster/${kind}?per_page=100`).then((r) => r[kind] ?? []), []);
  const read = (path: string) => onMain(readHubFile(gh, hub, path, "main"), null);
  const varsP = list("variables");
  const secretsP = list("secrets");
  const policiesP = inEnv(get<{ branch_policies: { name: string; type?: string }[] }>("/environments/tapster/deployment-branch-policies"), { branch_policies: [] });
  const rulesetsP = get<{ id: number }[]>("/rulesets")
    .catch(() => [])
    .then((ids) => Promise.all(ids.map((r) => get<Parameters<typeof hubRulesetCheck>[0][number]>(`/rulesets/${r.id}`))));
  const actionsP = get<{ allowed_actions?: string; sha_pinning_required?: boolean }>("/actions/permissions");
  const selectedP = get<{ github_owned_allowed?: boolean; verified_allowed?: boolean; patterns_allowed?: string[] }>("/actions/permissions/selected-actions");
  quiet(selectedP);
  const tokenPermsP = get<{ default_workflow_permissions: string }>("/actions/permissions/workflow");
  const issuesP = get<{ title: string; html_url: string; number: number; updated_at: string; body: string | null; user: { login: string } | null }[]>(`/issues?state=open&creator=${encodeURIComponent("github-actions[bot]")}&per_page=100`).catch(() => []);
  const configP = read("tapster.yml");
  const stateP = read(".tapster/state.json");
  const readmeP = read("README.md");
  const flowP = read(FLOW);
  const flowsP = onMain(get<{ name: string; type: string }[]>("/contents/.github/workflows?ref=main").catch(() => []), []).then(async (dir) => {
    const others = dir.filter((x) => x.type === "file" && /\.ya?ml$/.test(x.name) && x.name !== "tapster.yml");
    return Object.fromEntries(await Promise.all(others.map(async (f) => [f.name, (await read(`.github/workflows/${f.name}`)) ?? ""] as const)));
  });
  const parsedP = configP.then((config) => parsedHub(config, hub));
  const installP = Promise.all([repoP, varsP, parsedP]).then(([repo, vars, parsed]) => {
    const slug = vars.find((x) => x.name === "TAPSTER_APP_SLUG")?.value ?? null;
    return slug ? appInstall(s, gh, hub, slug, repo.owner.id, parsed?.config.packages ?? []) : null;
  });
  const linuxP = Promise.all([configP, parsedP, secretsP]).then(([config, parsed, secrets]) => linuxView(s, hub, config, parsed?.config ?? null, secrets.map((x) => x.name)));
  const selectedFor = actionsP.then((a) => (a.allowed_actions === "selected" ? selectedP : null));
  quiet(emptyP, envP, varsP, secretsP, policiesP, rulesetsP, actionsP, selectedFor, tokenPermsP, configP, stateP, readmeP, flowP, flowsP, installP, linuxP);
  const repo = await repoP;
  const [empty, env, vars, secrets, policies, rulesets, actions, selected, tokenPerms, issues, config, state, readme, flow, flows, install, linux] = await Promise.all([
    emptyP,
    envP,
    varsP,
    secretsP,
    policiesP,
    rulesetsP,
    actionsP,
    selectedFor,
    tokenPermsP,
    issuesP,
    configP,
    stateP,
    readmeP,
    flowP,
    flowsP,
    installP,
    linuxP,
  ]);
  const parsed = await parsedP;
  const names = (xs: Named[]) => xs.map((x) => x.name);
  const v = (n: string) => vars.find((x) => x.name === n)?.value ?? null;
  const appSlug = v("TAPSTER_APP_SLUG");
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
  const workflow = pinState(flow, TAPSTER, s.deps.pin);
  const code = workflow === "older" ? await hubCode(gh, flow, s.deps.pin ?? TAPSTER.sha) : null;
  const issue = issues.find((i) => i.title === ISSUE_TITLE && i.user?.login === "github-actions[bot]");
  return {
    name: hub,
    url: repo.html_url,
    private: repo.private,
    empty,
    protect: { done: checks.every((x) => x.ok), environment: policyOk, checks, others: otherWorkflows(flows) },
    app: { id: appId, slug: appSlug, key: names(secrets).includes("TAPSTER_APP_PRIVATE_KEY"), held: Boolean(held), install },
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
      workflow,
      pinned: pinned ? `${pinned[2]} (${pinned[1]!.slice(0, 7)})` : null,
      update: code ? (code.changed.length ? "needed" : "optional") : null,
      every: flow ? everyFromFlow(flow) : null,
    },
    packages: (parsed?.config.packages ?? []).map((p) => ({ name: p.name, repo: p.repo, kind: isApp(p) ? "app" : p.kind })),
    invalid: (parsed?.invalid ?? []).map((i) => ({ name: i.name, reason: i.reason })),
    issue: issue ? { url: issue.html_url, number: issue.number, updated: issue.updated_at, body: issue.body ?? "" } : null,
    extras: {
      doorbell: doorbellView(s, hub, v, { owner: repo.owner.id, hub: repo.id }),
      linux,
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
  const locked = c.s.deps.github().then((gh) => lockedEnvironment(gh, pending.hub));
  quiet(locked);
  let created: Awaited<ReturnType<typeof convertManifest>>;
  try {
    created = await convertManifest(code, pending.owner, "If GitHub created the App anyway, delete it at https://github.com/settings/apps first, because its name would block a new one. Then create it again.", c.s.deps.fetch);
  } catch (e) {
    const p = e instanceof TapsterError ? e : new TapsterError("GitHub did not hand over the new App", "Try again from Setup.");
    return back({ app: "failed", hub: pending.hub, reason: p.reason, fix: p.fix });
  }
  c.s.apps.set(pending.hub, { id: String(created.id), pem: created.pem, slug: created.slug, at: Date.now() });
  try {
    await locked;
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

// Code that runs in the hub: the bundled Action, its metadata and the hub's workflow template.
const HUB_CODE = /^(dist\/|action\.yml$|templates\/hub\/)/;
export const hubCodeFiles = (files: string[]) => files.filter((f) => HUB_CODE.test(f));

async function hubCode(gh: GitHub, flow: string | null, target: string | null): Promise<HubCode | null> {
  const pinned = flow ? PIN.exec(flow) : null;
  if (!pinned || !target || pinned[1] === target) return null;
  try {
    const cmp = await gh.json<{ status: string; files?: { filename: string }[] }>("GET", `/repos/doguyilmaz/tapster/compare/${pinned[1]}...${target}`);
    if (cmp.status !== "ahead") return null;
    const files = (cmp.files ?? []).map((f) => f.filename);
    return { from: pinned[2]!, to: `v${TAPSTER.version}`, changed: files.length >= 300 ? ["dist/index.js"] : hubCodeFiles(files), compare: `https://github.com/doguyilmaz/tapster/compare/${pinned[1]!.slice(0, 12)}...${target.slice(0, 12)}` };
  } catch {
    return null;
  }
}

async function filePlan(c: Ctx, gh: GitHub, hub: string, every: number | null, remove: string[], readme: boolean, read: (p: string) => Promise<string | null>): Promise<FilesView> {
  const repo = await gh.json<{ private: boolean }>("GET", `/repos/${hub}`);
  const plan = await hubFiles(gh, hub, read, c.s.deps.pin, { every, isPrivate: repo.private });
  const flow = await read(FLOW);
  const newer = pinState(flow, TAPSTER, c.s.deps.pin) === "newer";
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
  return { files, kept: plan.kept, pin: newer ? "kept: the hub runs a newer tapster than this one" : plan.change, notes: newer ? [] : plan.notes, foreign: [], readme: current !== null && current !== ours.content, hubCode: newer ? null : await hubCode(gh, flow, c.s.deps.pin ?? TAPSTER.sha) };
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

const WARM_TTL = 20_000;

const warmed = (s: Session, key: string, value: Promise<unknown>) => {
  quiet(value);
  s.warm.set(key, { at: Date.now(), value });
};

// The first read joins what setup started at launch. The handler clears every warm start on a write.
function takeWarm<T>(s: Session, key: string): Promise<T | null> {
  const w = s.warm.get(key);
  s.warm.delete(key);
  if (!w || Date.now() - w.at > WARM_TTL) return Promise.resolve(null);
  return (w.value as Promise<T>).catch(() => null);
}

export function warmStart(s: Session, hub: Promise<string | null>): void {
  warmed(s, "account", account(s));
  void hub.then((name) => {
    if (name) warmed(s, `hub:${name}`, s.deps.github().then((gh) => hubView(s, gh, name)));
  });
}

export const hubRoutes: Routes = {
  "GET /api/account": async (c) => (await takeWarm<AccountView>(c.s, "account")) ?? account(c.s),
  "GET /api/hubs": async (c) => {
    const { gh, login } = await me(c.s);
    return { hubs: await hubChoices(gh, login) };
  },
  "POST /api/hubs": createHub,
  "GET /api/hub": async (c) => {
    const asked = c.url.searchParams.get("hub");
    const early = takeWarm<HubView>(c.s, `hub:${asked}`);
    const { gh, hub } = await hubFrom(c, asked);
    return (await early) ?? hubView(c.s, gh, hub);
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

