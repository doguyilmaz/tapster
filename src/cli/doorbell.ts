import { createPrivateKey } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type HubConfig } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { runPath } from "../run";
import { appJwt } from "../token";
import ringYaml from "../../templates/project/ring.yml" with { type: "text" };
import wranglerLock from "../../templates/wrangler/bun.lock" with { type: "text" };
import wranglerPackage from "../../templates/wrangler/package.json";
import * as jwtText from "../doorbell/jwt.ts" with { type: "text" };
import * as workerText from "../doorbell/worker.ts" with { type: "text" };
import { appFromManifest, openUrl } from "./appflow";
import { setEnvVariable } from "./gh";
import { ask } from "./prompt";

const source = (m: unknown) => (m as { default: string }).default;

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

export type DoorbellVars = { APP_ID: string; INSTALLATION_ID: string; HUB: string; HUB_ID: string; OWNER_ID: string };

export function doorbellConfig(vars: DoorbellVars): string {
  for (const k of ["APP_ID", "INSTALLATION_ID", "HUB_ID", "OWNER_ID"] as const) {
    if (!/^[0-9]+$/.test(vars[k])) throw new TapsterError(`${k} must be a number`, "Run tapster init --doorbell again.");
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(vars.HUB)) throw new TapsterError("the hub name is not owner/repo", "Run it in the hub clone.");
  return `${JSON.stringify({ name: "tapster-doorbell", main: "worker.ts", compatibility_date: "2026-10-01", workers_dev: true, vars }, null, 2)}\n`;
}

export function workerOrigin(output: string): string | null {
  for (const line of output.split("\n")) {
    let entry: { type?: unknown; targets?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "deploy" || !Array.isArray(entry.targets)) continue;
    for (const t of entry.targets) {
      if (typeof t === "string" && /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?$/.test(t)) return new URL(t).origin;
    }
  }
  return null;
}

export const bunEnv = (path: string) => ({ PATH: path, BUN_BE_BUN: "1" });

type Vars = { variables: { name: string; value: string }[] };

export function doorbellStage(vars: Vars): "new" | "resume" | "done" {
  const has = (n: string) => vars.variables.some((v) => v.name === n);
  if (has("TAPSTER_DOORBELL")) return "done";
  return has("TAPSTER_DOORBELL_APP_ID") && has("TAPSTER_DOORBELL_APP_SLUG") ? "resume" : "new";
}

const AGAIN = "Run tapster init --doorbell again; it continues with the App it already created.";

async function askKey(appId: string, slug: string): Promise<string> {
  console.log(`Open the doorbell App's settings, scroll to "Private keys" and click "Generate a private key":`);
  openUrl(`https://github.com/settings/apps/${slug}`);
  const path = (await ask("Path of the downloaded .pem file: ")).replace(/^~(?=\/)/, process.env.HOME ?? "~");
  const pem = await readFile(path, "utf8");
  await new GitHub(appJwt(appId, pem)).json("GET", "/app").catch(() => {
    throw new TapsterError("that key does not belong to the doorbell App", `Generate the key on https://github.com/settings/apps/${slug}.`);
  });
  console.log(`Delete ${path} once tapster is done, and every older key on that page.`);
  return pem;
}

function findNode(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "node"))) return join(dir, "node");
  }
  throw new TapsterError("Wrangler needs Node.js, which is not on PATH", "Install Node.js 20 or newer, then run this again.");
}

type Wrangler = { dir: string; run(args: string[], opts?: { stdin?: string; env?: Record<string, string>; interactive?: boolean }): Promise<{ code: number; stdout: string }> };

async function installWrangler(): Promise<Wrangler> {
  const dir = await mkdtemp("/tmp/tapster-doorbell-");
  await writeFile(join(dir, "package.json"), `${JSON.stringify(wranglerPackage, null, 2)}\n`);
  await writeFile(join(dir, "bun.lock"), wranglerLock);
  await runPath(process.execPath, "bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, env: bunEnv(process.env.PATH ?? "") });
  const node = findNode();
  const bin = join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
  const pass = Object.fromEntries(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  const base = { PATH: `${join(node, "..")}${delimiter}/usr/bin${delimiter}/bin`, WRANGLER_SEND_METRICS: "false", ...pass };
  return {
    dir,
    run(args, opts = {}) {
      if (opts.interactive) {
        return new Promise((resolve) => {
          const child = spawn(node, [bin, ...args], { cwd: dir, stdio: "inherit", env: { HOME: process.env.HOME ?? "", ...base, ...opts.env } });
          child.on("close", (code) => resolve({ code: code ?? 1, stdout: "" }));
        });
      }
      return runPath(node, "wrangler", [bin, ...args], { cwd: dir, env: { ...base, ...opts.env }, stdin: opts.stdin, allowFail: true });
    },
  };
}

async function signIn(w: Wrangler): Promise<void> {
  if ((await w.run(["whoami"])).code === 0) return;
  console.log("Sign in to Cloudflare in the browser that opens.");
  if ((await w.run(["login"], { interactive: true })).code !== 0) throw new TapsterError("Wrangler could not sign in to Cloudflare", "Run tapster init --doorbell again.");
}

async function waitForInstall(appId: string, pem: string, hub: string): Promise<number> {
  const gh = new GitHub(appJwt(appId, pem));
  for (let i = 0; i < 5; i++) {
    const res = await gh.json<{ id: number }>("GET", `/repos/${hub}/installation`).catch(() => null);
    if (res) return res.id;
    await ask(`Install the App on ${hub} only, then press Enter. `);
  }
  throw new TapsterError(`the doorbell App was never installed on ${hub}`, `Install it on ${hub}, then ${AGAIN.charAt(0).toLowerCase()}${AGAIN.slice(1)}`);
}

export async function setupDoorbell(gh: GitHub, hub: string, config: HubConfig, setRepoVariable: (repo: string, name: string, value: string) => Promise<void>): Promise<void> {
  const vars = await gh.json<Vars>("GET", `/repos/${hub}/environments/tapster/variables`);
  const stage = doorbellStage(vars);
  if (stage === "done") {
    throw new TapsterError("the hub already has a doorbell", "Run tapster init --rotate doorbell to replace its key. To start over, delete the App and the TAPSTER_DOORBELL variables.");
  }
  const w = await installWrangler();
  try {
    await signIn(w);
    const [owner] = hub.split("/") as [string];
    let appId: string;
    let pem: string;
    if (stage === "resume") {
      appId = vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_ID")!.value;
      console.log("Continuing with the doorbell App created earlier.");
      pem = await askKey(appId, vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_SLUG")!.value);
    } else {
      const app = await appFromManifest((redirect) => doorbellManifest(owner, hub, redirect), "the doorbell App");
      appId = String(app.id);
      pem = app.pem;
      await setEnvVariable(hub, "TAPSTER_DOORBELL_APP_ID", appId);
      await setEnvVariable(hub, "TAPSTER_DOORBELL_APP_SLUG", app.slug);
      openUrl(`https://github.com/apps/${app.slug}/installations/new`);
    }
    const installation = await waitForInstall(appId, pem, hub);
    const ownerId = (await gh.json<{ id: number }>("GET", `/users/${owner}`)).id;
    const hubId = (await gh.getRepo(hub)).id;
    await writeFile(join(w.dir, "worker.ts"), source(workerText));
    await writeFile(join(w.dir, "jwt.ts"), source(jwtText));
    await writeFile(join(w.dir, "wrangler.jsonc"), doorbellConfig({ APP_ID: appId, INSTALLATION_ID: String(installation), HUB: hub, HUB_ID: String(hubId), OWNER_ID: String(ownerId) }));
    const outFile = join(w.dir, "out.ndjson");
    const deployed = await w.run(["deploy"], { env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
    if (deployed.code !== 0) throw new TapsterError("Wrangler could not deploy the doorbell", `${AGAIN} Wrangler's own message is above.`);
    const origin = workerOrigin(existsSync(outFile) ? readFileSync(outFile, "utf8") : "");
    if (!origin) throw new TapsterError("the doorbell has no workers.dev address", `Create your workers.dev subdomain in the Cloudflare dashboard (Workers & Pages). ${AGAIN}`);
    const key = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
    if ((await w.run(["secret", "put", "APP_KEY"], { stdin: key })).code !== 0) throw new TapsterError("Wrangler could not store the doorbell key", AGAIN);
    for (const p of config.packages) await setRepoVariable(p.repo, "TAPSTER_DOORBELL", origin);
    await setEnvVariable(hub, "TAPSTER_DOORBELL", origin);
    console.log(`The doorbell answers at ${origin}. Projects ring it after opening a draft.`);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
}

export async function rotateDoorbell(gh: GitHub, hub: string): Promise<void> {
  const vars = await gh.json<Vars>("GET", `/repos/${hub}/environments/tapster/variables`);
  if (doorbellStage(vars) !== "done") throw new TapsterError("the hub has no working doorbell yet", "Run tapster init --doorbell.");
  const appId = vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_ID")!.value;
  const pem = await askKey(appId, vars.variables.find((v) => v.name === "TAPSTER_DOORBELL_APP_SLUG")!.value);
  const w = await installWrangler();
  try {
    await signIn(w);
    const key = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
    if ((await w.run(["secret", "put", "APP_KEY", "--name", "tapster-doorbell"], { stdin: key })).code !== 0) throw new TapsterError("Wrangler could not store the doorbell key", "Check that the Worker tapster-doorbell exists in your Cloudflare account.");
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
  console.log("Stored the new key. Now delete every other key on the App's settings page.");
}
