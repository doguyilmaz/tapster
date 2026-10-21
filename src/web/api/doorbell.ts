import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseHub } from "../../config";
import { TapsterError } from "../../errors";
import { readHubFile } from "../../hubcommit";
import { register } from "../../mask";
import { type CreatedApp, convertManifest, permissionLines } from "../../cli/appflow";
import { Cloudflare, TOKEN_PAGE, checkCloudflare } from "../../cli/cloudflare";
import { checkDoorbellKey, deployDoorbell, doorbellManifest, doorbellStage, hubInstallation, onlyHub, ringProjects } from "../../cli/doorbell";
import { hubEnv, setEnvVariable } from "../../cli/gh";
import { FLOW } from "../../cli/hubfiles";
import { everyFromFlow } from "../../cli/schedule";
import type { AppStart, BellInstallView, DoorbellDone, DoorbellView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { hubFrom, lockedEnvironment } from "./access";

const HOLD = 3_600_000;
const PEM_LIMIT = 16 * 1024;
const ORPHAN = "If GitHub created the App anyway, delete it at https://github.com/settings/apps first, because its name would block a new one. Then create it again.";

const hubBody = z.object({ hub: z.string() }).strict();

function heldCloudflare(s: Session, hub: string) {
  const held = s.cloudflare.get(hub);
  if (held && Date.now() - held.at > HOLD) s.cloudflare.delete(hub);
  return s.cloudflare.get(hub) ?? null;
}

export function doorbellView(s: Session, hub: string, v: (name: string) => string | null): DoorbellView {
  const bell = s.bells.get(hub);
  const id = v("TAPSTER_DOORBELL_APP_ID");
  const slug = v("TAPSTER_DOORBELL_APP_SLUG");
  const cloud = heldCloudflare(s, hub);
  return {
    on: v("TAPSTER_DOORBELL") !== null,
    origin: v("TAPSTER_DOORBELL"),
    app: id && slug ? { id, slug } : bell ? { id: bell.id, slug: bell.slug } : null,
    key: Boolean(bell),
    cloudflare: cloud ? { account: cloud.target.account.name, subdomain: cloud.target.subdomain } : null,
    tokenPage: TOKEN_PAGE,
  };
}

const storeBell = async (hub: string, app: { id: string; slug: string }) => {
  await setEnvVariable(hub, "TAPSTER_DOORBELL_APP_ID", app.id);
  await setEnvVariable(hub, "TAPSTER_DOORBELL_APP_SLUG", app.slug);
};

export async function bellCallback(c: Ctx, pending: { hub: string; owner: string }, code: string, back: (q: Record<string, string>) => Response): Promise<Response> {
  let created: CreatedApp;
  try {
    created = await convertManifest(code, pending.owner, ORPHAN, c.s.deps.fetch);
  } catch (e) {
    const p = e instanceof TapsterError ? e : new TapsterError("GitHub did not hand over the doorbell App", "Try again from Setup.");
    return back({ doorbell: "failed", hub: pending.hub, reason: p.reason, fix: p.fix });
  }
  register(created.pem);
  const app = { id: String(created.id), pem: created.pem, slug: created.slug };
  c.s.bells.set(pending.hub, app);
  try {
    await storeBell(pending.hub, app);
  } catch {
    return back({ doorbell: "unstored", hub: pending.hub, reason: "the hub did not take the doorbell App's ID", fix: "This setup still holds the App. Deploy the doorbell here; tapster stores the ID again first." });
  }
  return back({ doorbell: "created", hub: pending.hub });
}

const vars = async (gh: Parameters<typeof hubEnv>[0], hub: string) => ({ variables: (await hubEnv(gh, hub, "variables")).map((x) => ({ name: x.name, value: x.value ?? "" })) });

async function cloudflare(c: Ctx) {
  const body = await readJson(c.req, z.object({ hub: z.string(), token: z.string().max(400) }).strict());
  const { hub } = await hubFrom(c, body.hub);
  const token = body.token.trim();
  if (!/^[A-Za-z0-9._-]{20,400}$/.test(token)) throw new TapsterError("that is not a Cloudflare API token", "Paste the token Cloudflare showed after Create Token. Cloudflare shows it once; create a new one if it is gone.");
  const target = await checkCloudflare(new Cloudflare(token, c.s.deps.fetch));
  c.s.cloudflare.set(hub, { token, target, at: Date.now() });
  return { account: target.account.name, subdomain: target.subdomain };
}

async function appStart(c: Ctx): Promise<AppStart> {
  const { hub } = await readJson(c.req, hubBody);
  const { gh, login } = await hubFrom(c, hub);
  await lockedEnvironment(gh, hub);
  if (doorbellStage(await vars(gh, hub)) !== "new") throw new TapsterError("the hub already has a doorbell App", "Reload the page; it continues with that App.");
  const state = randomBytes(16).toString("hex");
  for (const [k, p] of c.s.pending) if (Date.now() - p.at > HOLD) c.s.pending.delete(k);
  c.s.pending.set(state, { hub, owner: login, at: Date.now(), kind: "doorbell" });
  const manifest = doorbellManifest(login, hub, `http://127.0.0.1:${c.s.port}/app/callback`) as { name: string };
  return { action: `https://github.com/settings/apps/new?state=${state}`, manifest: JSON.stringify(manifest), permissions: permissionLines(manifest), name: manifest.name };
}

async function key(c: Ctx) {
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await c.req.formData();
  } catch {
    throw new TapsterError("the form could not be read", "Reload the page and try again.");
  }
  const { gh, hub } = await hubFrom(c, form.get("hub"));
  const file = form.get("pem");
  if (!(file instanceof File) || file.size === 0) throw new TapsterError("no .pem file was attached", "Drop the .pem file GitHub downloaded and try again.");
  if (file.size > PEM_LIMIT) throw new TapsterError("that .pem file is too large", "Drop the .pem file GitHub downloaded for the doorbell App.");
  const v = await vars(gh, hub);
  if (doorbellStage(v) !== "resume") throw new TapsterError("the hub has no doorbell App waiting for a key", "Reload the page.");
  const id = v.variables.find((x) => x.name === "TAPSTER_DOORBELL_APP_ID")!.value;
  const slug = v.variables.find((x) => x.name === "TAPSTER_DOORBELL_APP_SLUG")!.value;
  const pem = await file.text();
  await checkDoorbellKey(id, slug, pem, c.s.deps.fetch);
  c.s.bells.set(hub, { id, pem, slug });
  return { held: true };
}

const heldBell = (s: Session, hub: string) => {
  const bell = s.bells.get(hub);
  if (!bell) throw new TapsterError("this setup holds no key of the doorbell App", "Create the App here first. If it exists, drop a new private key of it here.");
  return bell;
};

async function installation(c: Ctx): Promise<BellInstallView> {
  const { hub } = await hubFrom(c, c.url.searchParams.get("hub"));
  const bell = heldBell(c.s, hub);
  return hubInstallation(bell.id, bell.pem, hub, c.s.deps.fetch);
}

async function deploy(c: Ctx): Promise<DoorbellDone> {
  const { hub } = await readJson(c.req, hubBody);
  const { gh } = await hubFrom(c, hub);
  const bell = heldBell(c.s, hub);
  const cloud = heldCloudflare(c.s, hub);
  if (!cloud) throw new TapsterError("this setup holds no Cloudflare token", "Paste the token again: tapster keeps it in memory for an hour at most.");
  if (doorbellStage(await vars(gh, hub)) === "done") throw new TapsterError("the hub already has a doorbell", "To give it a new key, run tapster init --rotate doorbell in a clone of the hub.");
  const installed = onlyHub(hub, await hubInstallation(bell.id, bell.pem, hub, c.s.deps.fetch));
  await storeBell(hub, bell);
  const [flow, config] = await Promise.all([readHubFile(gh, hub, FLOW, "main"), readHubFile(gh, hub, "tapster.yml", "main")]);
  const every = (flow && everyFromFlow(flow)) || 10;
  const repos = config === null ? [] : parseHub(config, hub.split("/")[0]!).config.packages.map((p) => p.repo);
  const origin = await deployDoorbell(gh, new Cloudflare(cloud.token, c.s.deps.fetch), cloud.target, { hub, appId: bell.id, pem: bell.pem, installation: installed, every });
  const rung = await ringProjects(hub, repos, origin);
  c.s.cloudflare.delete(hub);
  c.s.bells.delete(hub);
  return { origin, ...rung };
}

export const doorbellRoutes: Routes = {
  "POST /api/hub/doorbell/cloudflare": cloudflare,
  "POST /api/hub/doorbell/app": appStart,
  "POST /api/hub/doorbell/key": key,
  "GET /api/hub/doorbell/installation": installation,
  "POST /api/hub/doorbell/deploy": deploy,
};
