import { z } from "zod";
import { isApp, parseHub } from "../../config";
import { TapsterError } from "../../errors";
import { GitHub } from "../../github";
import { readHubFile } from "../../hubcommit";
import { register } from "../../mask";
import { appJwt } from "../../token";
import { hubEnv, setEnvSecret } from "../../cli/gh";
import { appInstallation } from "../../cli/hubapp";
import { appKeyFingerprint } from "../../cli/init";
import { newSparkleKey } from "../../cli/keystore";
import { type Ctx, type Routes, readJson } from "../server";
import { hubFrom, keyOperation, lockedEnvironment } from "./access";

async function appKey(c: Ctx) {
  let form: Awaited<ReturnType<Request["formData"]>>;
  try { form = await c.req.formData(); }
  catch { throw new TapsterError("the form could not be read", "Choose the .pem file and try again."); }
  const { gh, hub } = await hubFrom(c, form.get("hub"));
  return keyOperation(c.s, hub, async () => {
    await lockedEnvironment(gh, hub);
    const file = form.get("pem");
    if (!(file instanceof File) || file.size === 0 || file.size > 16 * 1024) throw new TapsterError("attach the GitHub App's .pem file", "Choose the private key downloaded from the hub App's settings; it must be at most 16 KB.");
    const vars = await hubEnv(gh, hub, "variables");
    const id = vars.find((v) => v.name === "TAPSTER_APP_ID")?.value;
    const slug = vars.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
    if (!id || !slug) throw new TapsterError("the hub has no App yet", "Create its GitHub App first.");
    const pem = await file.text();
    register(pem);
    const fingerprint = appKeyFingerprint(pem);
    const app = await new GitHub(appJwt(id, pem), c.s.deps.fetch).json<{ id: number }>("GET", "/app").catch(() => null);
    if (String(app?.id) !== id) throw new TapsterError("that key does not belong to the hub's App", `Generate the key on https://github.com/settings/apps/${slug}.`);
    const install = await appInstallation(id, pem, hub.split("/")[0]!, hub, new GitHub(appJwt(id, pem), c.s.deps.fetch));
    if (install.onHub) throw new TapsterError("the signing App is installed on the hub", "Remove the hub from the App's installation before storing the replacement key.");
    await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", pem);
    c.s.apps.set(hub, { id, slug, pem, at: Date.now() });
    return { fingerprint };
  });
}

async function sparkleNew(c: Ctx) {
  const { hub: asked, label } = await readJson(c.req, z.object({ hub: z.string(), label: z.string().regex(/^[a-z0-9]{1,40}$/) }).strict());
  const { gh, hub } = await hubFrom(c, asked);
  return keyOperation(c.s, hub, async () => {
    await lockedEnvironment(gh, hub);
    const text = await readHubFile(gh, hub, "tapster.yml", "main");
    const config = text === null ? null : parseHub(text, hub.split("/")[0]!).config;
    if (config?.packages.filter(isApp).some((p) => p.sparkle?.key === label || p.sparkle?.next_key === label)) throw new TapsterError(`an app already uses Sparkle key ${label}`, "Use a new label when generating a new key. Existing keys can be read from the keychain.");
    if ((await hubEnv(gh, hub, "secrets")).some((s) => s.name === `SPARKLE_KEY_${label.toUpperCase()}`)) throw new TapsterError(`the hub already holds Sparkle key ${label}`, "Choose a new label; generating a key never replaces an existing one.");
    const store = c.s.deps.store();
    if (!store) throw new TapsterError("this computer has no keychain tapster can use", "Use macOS or Linux with secret-tool installed.");
    const ref = { service: "https://sparkle-project.org", account: label, label: "Private key for signing Sparkle updates" };
    if (await store.exists(ref)) throw new TapsterError(`your keychain already has a Sparkle key for ${label}`, "Read the existing key using that keychain account or choose another label.");
    const key = newSparkleKey();
    register(key.seed);
    await store.save({ ...ref, comment: `Public key (SUPublicEDKey value) for this key is: ${key.publicKey}` }, key.seed);
    return { publicKey: key.publicKey, account: label };
  });
}

export const keyRoutes: Routes = {
  "POST /api/hub/app/key": appKey,
  "POST /api/hub/sparkle/new": sparkleNew,
};
