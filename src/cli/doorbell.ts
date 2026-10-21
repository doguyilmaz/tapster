import { createPrivateKey } from "node:crypto";
import { parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { GitHub } from "../github";
import { register } from "../mask";
import { appJwt } from "../token";
import ringYaml from "../../templates/project/ring.yml" with { type: "text" };
import { appFromManifest, openUrl } from "./appflow";
import { Cloudflare, type CloudflareAccount, type CloudflareTarget, TOKEN_PAGE, accountTarget, deployWorker, pickAccount, tokenAccounts } from "./cloudflare";
import { hubEnv, setEnvVariable, setRepoVariable } from "./gh";
import { appInstallUrl } from "./hubpr";
import { cleanPath, readInput } from "./paths";
import { waitFor } from "./poll";
import { ask } from "./prompt";
import { workerCron } from "./schedule";

export const ringStep = (indent: number) =>
  ringYaml
    .trimEnd()
    .split("\n")
    .map((l: string) => `${" ".repeat(indent)}${l}`)
    .join("\n");

export function doorbellManifest(owner: string, hub: string, redirect: string): object {
  return {
    name: `tapster-doorbell-${owner}-${hub.split("/")[1]!.replace(/^homebrew-/, "")}`.toLowerCase().slice(0, 34),
    url: `https://github.com/${hub}`,
    redirect_url: redirect,
    public: false,
    default_permissions: { actions: "write", metadata: "read" },
    default_events: [],
    hook_attributes: { url: "https://example.com/tapster-has-no-webhook", active: false },
  };
}

export function doorbellRepos(text: string, owner: string): string[] {
  const { config, invalid } = parseHub(text, owner);
  const repos = [...config.packages.map((p) => p.repo), ...invalid.flatMap((i) => (i.repo && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(i.repo) ? [i.repo] : []))];
  return repos.filter((r, at) => repos.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === at);
}

export type DoorbellVars = { APP_ID: string; INSTALLATION_ID: string; HUB: string; HUB_ID: string; OWNER_ID: string; INTERVAL: string };

export function checkVars(vars: DoorbellVars): DoorbellVars {
  for (const k of ["APP_ID", "INSTALLATION_ID", "HUB_ID", "OWNER_ID", "INTERVAL"] as const) {
    if (!/^[0-9]+$/.test(vars[k])) throw new TapsterError(`${k} must be a number`, "Run tapster init --doorbell again.");
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(vars.HUB)) throw new TapsterError("the hub name is not owner/repo", "Run it in the hub clone.");
  return vars;
}

type Vars = { variables: { name: string; value: string }[] };

export function doorbellStage(vars: Vars): "new" | "resume" | "done" {
  const has = (n: string) => vars.variables.some((v) => v.name === n);
  if (has("TAPSTER_DOORBELL")) return "done";
  return has("TAPSTER_DOORBELL_APP_ID") && has("TAPSTER_DOORBELL_APP_SLUG") ? "resume" : "new";
}

export async function checkDoorbellKey(appId: string, slug: string, pem: string, fetchImpl?: typeof fetch): Promise<void> {
  try {
    createPrivateKey(pem);
  } catch {
    throw new TapsterError("that file is not a private key", `Use the .pem file GitHub downloaded from https://github.com/settings/apps/${slug}.`);
  }
  register(pem);
  const app = await new GitHub(appJwt(appId, pem), fetchImpl).json<{ id: number }>("GET", "/app").catch(() => null);
  if (String(app?.id) !== appId) throw new TapsterError("that key does not belong to the doorbell App", `Generate the key on https://github.com/settings/apps/${slug}.`);
}

export type BellInstall = { id: number | null; others: string[] };

export async function hubInstallation(appId: string, pem: string, hub: string, fetchImpl?: typeof fetch): Promise<BellInstall> {
  const app = new GitHub(appJwt(appId, pem), fetchImpl);
  let id: number;
  try {
    id = (await app.json<{ id: number }>("GET", `/repos/${hub}/installation`)).id;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return { id: null, others: [] };
    throw e;
  }
  const { token } = await app.json<{ token: string }>("POST", `/app/installations/${id}/access_tokens`, { permissions: { metadata: "read" } });
  register(token);
  const gh = new GitHub(token, fetchImpl);
  try {
    const list = await gh.json<{ total_count?: number; repositories: { full_name: string }[] }>("GET", "/installation/repositories?per_page=100");
    const others = list.repositories.map((r) => r.full_name).filter((r) => r.toLowerCase() !== hub.toLowerCase());
    const unseen = (list.total_count ?? list.repositories.length) - list.repositories.length;
    return { id, others: unseen > 0 ? [...others, `${unseen} more`] : others };
  } finally {
    await gh.request("DELETE", "/installation/token").catch(() => undefined);
  }
}

export function onlyHub(hub: string, found: BellInstall): number {
  if (found.id === null) throw new TapsterError(`the doorbell App is not installed on ${hub}`, `Install it on ${hub} only, then try again.`);
  if (found.others.length) {
    throw new TapsterError(
      `the doorbell App reaches ${found.others.join(", ")} besides ${hub}`,
      `It may start workflows only in the hub. Open https://github.com/settings/installations/${found.id}, choose "Only select repositories" and keep only ${hub}.`,
    );
  }
  return found.id;
}

export async function deployDoorbell(gh: GitHub, cf: Cloudflare, target: CloudflareTarget, o: { hub: string; appId: string; pem: string; installation: number; every: number }): Promise<string> {
  const ownerId = (await gh.json<{ id: number }>("GET", `/users/${o.hub.split("/")[0]}`)).id;
  const hubId = (await gh.getRepo(o.hub)).id;
  const vars = checkVars({ APP_ID: o.appId, INSTALLATION_ID: String(o.installation), HUB: o.hub, HUB_ID: String(hubId), OWNER_ID: String(ownerId), INTERVAL: String(o.every) });
  const key = createPrivateKey(o.pem).export({ type: "pkcs8", format: "pem" }).toString();
  register(key);
  const origin = await deployWorker(cf, target, vars, key, workerCron(o.every));
  await setEnvVariable(o.hub, "TAPSTER_DOORBELL_EVERY", String(o.every));
  return origin;
}

export async function ringProjects(hub: string, repos: string[], origin: string): Promise<{ rung: string[]; missed: string[] }> {
  const rung: string[] = [];
  const missed: string[] = [];
  for (const repo of repos) {
    try {
      await setRepoVariable(repo, "TAPSTER_DOORBELL", origin);
      rung.push(repo);
    } catch {
      missed.push(repo);
    }
  }
  await setEnvVariable(hub, "TAPSTER_DOORBELL", origin);
  return { rung, missed };
}

export type DoorbellIO = {
  fetch: typeof fetch;
  ask: (question: string, hidden?: boolean) => Promise<string>;
  log: (line: string) => void;
  open: (url: string) => void;
  env: Record<string, string | undefined>;
};

const cli: DoorbellIO = { fetch, ask, log: (line) => console.log(line), open: openUrl, env: process.env };

const AGAIN = "Run tapster init --doorbell again; it continues with the App it already created.";

async function chooseAccount(accounts: CloudflareAccount[], io: DoorbellIO): Promise<CloudflareAccount> {
  const named = io.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (named || accounts.length === 1) return pickAccount(accounts, named);
  io.log("The token reaches several Cloudflare accounts. On Cloudflare's token page you can narrow it to one under Account Resources.");
  accounts.forEach((a, i) => io.log(`  ${i + 1}. ${a.name}`));
  const answer = Number((await io.ask("Number of the account for the doorbell: ")).trim());
  const picked = accounts[answer - 1];
  if (!Number.isInteger(answer) || !picked) throw new TapsterError("that is not one of the listed accounts", `Run this again and type a number from 1 to ${accounts.length}. Setting CLOUDFLARE_ACCOUNT_ID works too.`);
  return picked;
}

async function cloudflareFor(io: DoorbellIO, hub: string): Promise<{ cf: Cloudflare; target: CloudflareTarget }> {
  let token = io.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (token) io.log("Using the Cloudflare token in CLOUDFLARE_API_TOKEN.");
  else {
    io.log('The doorbell needs a Cloudflare API token that may edit Workers. Cloudflare\'s page opens with that filled in: click "Continue to summary", then "Create Token" and copy the token.');
    io.open(TOKEN_PAGE);
    token = (await io.ask("Cloudflare token (hidden; tapster uses it for this run only): ", true)).trim();
  }
  if (!token) throw new TapsterError("no Cloudflare token was given", "Paste the token Cloudflare showed after Create Token. Setting CLOUDFLARE_API_TOKEN works too.");
  const cf = new Cloudflare(token, io.fetch);
  const target = await accountTarget(cf, await chooseAccount(await tokenAccounts(cf), io), hub);
  io.log(`Cloudflare account ${target.account.name}, workers.dev subdomain ${target.subdomain}.`);
  return { cf, target };
}

async function askKey(appId: string, slug: string, io: DoorbellIO): Promise<string> {
  io.log(`Open the doorbell App's settings, scroll to "Private keys" and click "Generate a private key":`);
  io.open(`https://github.com/settings/apps/${slug}`);
  const path = cleanPath(await io.ask("Path of the downloaded .pem file (drag it here): "));
  const pem = (await readInput(path, "the .pem file")).toString("utf8");
  await checkDoorbellKey(appId, slug, pem, io.fetch);
  io.log(`Once tapster is done, delete ${path} and every older key on that page.`);
  return pem;
}

async function waitForInstall(appId: string, pem: string, hub: string, io: DoorbellIO): Promise<number> {
  io.log(`Waiting until the App is installed on ${hub} (only that repository); tapster continues by itself.`);
  let last: BellInstall = { id: null, others: [] };
  let warned = false;
  const found = await waitFor(async () => {
    last = await hubInstallation(appId, pem, hub, io.fetch).catch(() => last);
    if (last.others.length && !warned) {
      warned = true;
      io.log(`The App also reaches ${last.others.join(", ")}. Keep only ${hub} at https://github.com/settings/installations/${last.id}; tapster waits.`);
    }
    return last.id !== null && last.others.length === 0 ? last.id : null;
  });
  if (found !== null) return found;
  if (last.others.length) onlyHub(hub, last);
  throw new TapsterError(`the doorbell App was not installed on ${hub} within 10 minutes`, `Install it on ${hub}, then ${AGAIN.charAt(0).toLowerCase()}${AGAIN.slice(1)}`);
}

export async function setupDoorbell(gh: GitHub, hub: string, repos: string[], every: number, io: DoorbellIO = cli): Promise<void> {
  const vars: Vars = { variables: (await hubEnv(gh, hub, "variables")).map((v) => ({ name: v.name, value: v.value ?? "" })) };
  const stage = doorbellStage(vars);
  if (stage === "done") {
    throw new TapsterError("the hub already has a doorbell", "Run tapster init --rotate doorbell to replace its key. To start over, delete the App and the TAPSTER_DOORBELL variables.");
  }
  const { cf, target } = await cloudflareFor(io, hub);
  const [owner] = hub.split("/") as [string];
  let appId: string;
  let pem: string;
  if (stage === "resume") {
    appId = vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_ID")!.value;
    io.log("Continuing with the doorbell App created earlier.");
    pem = await askKey(appId, vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_SLUG")!.value, io);
  } else {
    const app = await appFromManifest((redirect) => doorbellManifest(owner, hub, redirect), {
      what: "the doorbell App",
      title: "Create the doorbell App",
      lead: `GitHub asks you to confirm a second private App. The doorbell uses it only to start ${hub}'s workflow when a project releases.`,
      key: "GitHub hands the App's private key to tapster in your terminal, once. tapster stores it as a secret of the doorbell Worker in your Cloudflare account. It goes nowhere else and no one else receives it.",
      done: "The doorbell App is created",
      next: [
        "tapster opens the App's install page in a new tab.",
        `It opens with "Only select repositories" and ${hub} picked. Keep only ${hub}.`,
        'Click "Install". tapster notices within seconds and deploys the Worker.',
      ],
      again: "tapster init --doorbell",
    }, owner);
    appId = String(app.id);
    pem = app.pem;
    register(pem);
    await Promise.all([setEnvVariable(hub, "TAPSTER_DOORBELL_APP_ID", appId), setEnvVariable(hub, "TAPSTER_DOORBELL_APP_SLUG", app.slug)]);
    io.open(await appInstallUrl(gh, app.slug, hub));
  }
  const installation = await waitForInstall(appId, pem, hub, io);
  const origin = await deployDoorbell(gh, cf, target, { hub, appId, pem, installation, every });
  const { missed } = await ringProjects(hub, repos, origin);
  for (const repo of missed) io.log(`Could not give ${repo} the doorbell's address. Run: gh variable set TAPSTER_DOORBELL --repo ${repo} --body ${origin}`);
  io.log(`The doorbell answers at ${origin}. Projects ring it after opening a draft.`);
}

export async function rotateDoorbell(gh: GitHub, hub: string, every: number, io: DoorbellIO = cli): Promise<void> {
  const vars = await gh.json<Vars>("GET", `/repos/${hub}/environments/tapster/variables`);
  if (doorbellStage(vars) !== "done") throw new TapsterError("the hub has no working doorbell yet", "Run tapster init --doorbell.");
  const appId = vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_ID")!.value;
  const pem = await askKey(appId, vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_SLUG")!.value, io);
  const { cf, target } = await cloudflareFor(io, hub);
  const stored = vars.variables.find((v) => v.name === "TAPSTER_DOORBELL")!.value;
  if (target.origin !== stored) {
    throw new TapsterError(`this token would deploy the doorbell to ${target.origin}, but your projects ring ${stored}`, "Use a token of the Cloudflare account that runs the doorbell now. Nothing was changed.");
  }
  const installation = await waitForInstall(appId, pem, hub, io);
  await deployDoorbell(gh, cf, target, { hub, appId, pem, installation, every });
  io.log(`Deployed the doorbell again with the new key; it starts the hub every ${every} minutes. Now delete every other key on the App's settings page.`);
}
