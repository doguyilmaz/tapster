import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HubConfig, isApp, parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { GitHub } from "../github";
import { decodeSparkleKey } from "../sparkle-key";
import { appJwt } from "../token";
import { TAPSTER } from "../version";
import { TOOLS, run, runPath } from "../run";
import { parseNotary } from "../sign";
import hubReadme from "../../templates/hub/README.md" with { type: "text" };
import hubWorkflow from "../../templates/hub/tapster.yml" with { type: "text" };
import pinsJson from "../../templates/pins.json";
import { appFromManifest, openUrl } from "./appflow";
import { rotateDoorbell, setupDoorbell } from "./doorbell";
import { currentRepo, deleteEnvSecret, setEnvSecret, setEnvVariable, setRepoVariable, userGitHub } from "./gh";
import { type KeyRef, type Store, localStore, newSparkleKey, previousKey, requireStore } from "./keystore";
import { cleanPath, readInput } from "./paths";
import { waitFor } from "./poll";
import { removeTemp, tempDir } from "./temp";
import { cronFor, everyFromFlow } from "./schedule";
import { ask } from "./prompt";

type Pins = typeof pinsJson;

export function appManifest(owner: string, hub: string, redirect: string): object {
  return {
    name: `tapster-${owner}-${hub.split("/")[1]!.replace(/^homebrew-/, "")}`.toLowerCase().slice(0, 34),
    url: `https://github.com/${hub}`,
    redirect_url: redirect,
    public: false,
    default_permissions: { contents: "write", attestations: "read", metadata: "read" },
    default_events: [],
    hook_attributes: { url: "https://example.com/tapster-has-no-webhook", active: false },
  };
}

export function teamIdFromSubject(subject: string): string | null {
  return /(?:^|[,/]\s*)OU=([A-Z0-9]{10})(?:[,/]|$)/.exec(subject)?.[1] ?? null;
}

const DAY = 86_400_000;

export function checkCertificate(subject: string, notAfter: string, now = Date.now()): { team: string; expires: string } {
  const cn = /(?:^|,)CN=((?:[^,\\]|\\.)*)/.exec(subject)?.[1] ?? "";
  if (!cn.startsWith("Developer ID Application:")) {
    throw new TapsterError(`the certificate is "${cn || "unnamed"}", not a Developer ID Application certificate`, "Create a Developer ID Application certificate at developer.apple.com, export it with its key from Keychain Access as .p12, then run this again.");
  }
  const team = teamIdFromSubject(subject);
  if (!team) throw new TapsterError("the certificate has no team ID", "Export the Developer ID Application certificate from Keychain Access.");
  const end = Date.parse(notAfter);
  if (Number.isNaN(end)) throw new TapsterError("the certificate's expiry date cannot be read", "Export the certificate again from Keychain Access.");
  const expires = new Date(end).toISOString().slice(0, 10);
  if (end < now) throw new TapsterError(`the certificate expired on ${expires}`, "Create a new Developer ID Application certificate at developer.apple.com.");
  return { team, expires };
}

export function initSteps(have: { vars: string[]; secrets: string[] }, mac: boolean): string[] {
  const v = new Set(have.vars);
  const s = new Set(have.secrets);
  const steps = ["protect"];
  if (!(v.has("TAPSTER_APP_ID") && v.has("TAPSTER_APP_SLUG"))) steps.push("app");
  else if (!s.has("TAPSTER_APP_PRIVATE_KEY")) steps.push("app-key");
  if (mac && !(v.has("TAPSTER_TEAM_ID") && s.has("MACOS_SIGN_P12") && s.has("MACOS_SIGN_PASSWORD"))) steps.push("certificate");
  if (mac && !["MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"].every((n) => s.has(n))) steps.push("notary");
  steps.push("files");
  return steps;
}

export const notaryArgs = (keyPath: string, keyId: string, issuer: string) => ["notarytool", "history", "--key", keyPath, "--key-id", keyId, "--issuer", issuer, "--output-format", "json"];

export function privateHubError<T>(e: T, isPrivate: boolean): T | TapsterError {
  if (!(e instanceof GitHubError) || !isPrivate || ![403, 404, 422].includes(e.status)) return e;
  return new TapsterError(
    "GitHub refused environments on this private hub",
    "Environments and their secrets need a public hub or GitHub Pro. Make the hub public or upgrade at https://github.com/settings/billing, then run tapster init again.",
  );
}

export function sparkleLabels(config: HubConfig): string[] {
  const labels = config.packages.filter(isApp).flatMap((p) => (p.sparkle ? [p.sparkle.key, ...(p.sparkle.next_key ? [p.sparkle.next_key] : [])] : []));
  return [...new Set(labels)];
}

export function sparkleEnv(labels: string[]): string {
  const lines = labels.map((l) => `SPARKLE_KEY_${l.toUpperCase()}: "\${{ secrets.SPARKLE_KEY_${l.toUpperCase()} }}"`);
  return lines.length ? `{ ${lines.join(", ")} }` : "{}";
}

export function keyPins(config: HubConfig, label: string, publicKey: string): string[] {
  const users: string[] = [];
  for (const p of config.packages.filter(isApp)) {
    const pinned = p.sparkle?.key === label ? p.sparkle.public_key : p.sparkle?.next_key === label ? p.sparkle.next_public_key : undefined;
    if (pinned === undefined) continue;
    if (pinned !== publicKey) throw new TapsterError(`${p.name} pins ${pinned} for ${label}, but this key's public half is ${publicKey}`, "Pick the keychain account of the key the app ships with or fix tapster.yml.");
    users.push(p.name);
  }
  if (users.length === 0) throw new TapsterError(`no package in tapster.yml uses the Sparkle key ${label}`, "Add the package with its sparkle section first.");
  return users;
}

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }, labels: string[] = [], every = 10): string {
  return template
    .replaceAll("__CRON__", cronFor(every))
    .replaceAll("__SPARKLE_ENV__", sparkleEnv(labels))
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

async function checkInstallation(appId: string, pem: string, owner: string, hub: string, slug: string): Promise<void> {
  const app = new GitHub(appJwt(appId, pem));
  console.log("Waiting until the App is installed; tapster continues by itself once you choose Install.");
  const found = await waitFor(() => app.json<{ id: number }>("GET", `/users/${owner}/installation`).then((r) => r.id, () => null));
  if (found === null) {
    console.log(`The App is not installed yet. Install it at https://github.com/apps/${slug}/installations/new; tapster add links there for each project too.`);
    return;
  }
  const onHub = await app.json("GET", `/repos/${hub}/installation`).then(() => true, () => false);
  if (onHub) console.log(`The App is installed on ${hub}; remove ${hub} from it at https://github.com/settings/installations/${found}, or the hub refuses to run.`);
}

async function createApp(owner: string, hub: string): Promise<void> {
  console.log("GitHub creates a private App for your hub; it lets the hub publish your projects' releases. Confirm it on the page that opens.");
  const created = await appFromManifest((redirect) => appManifest(owner, hub, redirect), {
    what: "your tapster App",
    title: "Create your tapster App",
    lead: `GitHub asks you to confirm a private App on your account. ${hub} uses it to publish the releases of the projects you install it on.`,
    key: `GitHub hands the App's private key to tapster in your terminal, once. tapster stores it as a secret of the tapster environment in ${hub}. It goes nowhere else and no one else receives it.`,
    done: "Your tapster App is created",
    next: [
      `tapster stores the App's ID and key in ${hub} and opens the App's install page in a new tab.`,
      `There, choose "Only select repositories" and pick the projects tapster should publish. Never pick ${hub}: it holds your signing keys.`,
      'Click "Install". tapster notices within seconds and continues.',
    ],
    again: "tapster init",
  });
  await setEnvVariable(hub, "TAPSTER_APP_ID", String(created.id));
  await setEnvVariable(hub, "TAPSTER_APP_SLUG", created.slug);
  await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", created.pem);
  console.log("Stored the App and its key in the hub. Now install it: choose \"Only select repositories\" and pick the projects tapster should publish.");
  console.log(`Never pick ${hub}: the App can write to every repository it is installed on, and the hub holds your signing keys. tapster add can also install it on a project later.`);
  openUrl(`https://github.com/apps/${created.slug}/installations/new`);
  await checkInstallation(String(created.id), created.pem, owner, hub, created.slug);
}

export function appKeyFingerprint(pem: string): string {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new TapsterError("that file is not a private key", "Use the .pem file GitHub downloaded when you generated the key.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new TapsterError("that file is not a GitHub App key", "Use the .pem file GitHub downloaded when you generated the key.");
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

async function rotateAppKey(gh: GitHub, hub: string): Promise<void> {
  const vars = await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`);
  const appId = vars.variables.find((v) => v.name === "TAPSTER_APP_ID")?.value;
  const slug = vars.variables.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  if (!appId || !slug) throw new TapsterError("the hub has no App yet", "Run tapster init first.");
  console.log(`Open the App's settings, scroll to "Private keys" and click "Generate a private key":`);
  openUrl(`https://github.com/settings/apps/${slug}`);
  const path = cleanPath(await ask("Path of the downloaded .pem file (drag it here): "));
  const pem = (await readInput(path, "the .pem file")).toString("utf8");
  const fingerprint = appKeyFingerprint(pem);
  await new GitHub(appJwt(appId, pem)).json("GET", "/app").catch(() => {
    throw new TapsterError("that key does not belong to the hub's App", `Generate the key on https://github.com/settings/apps/${slug}.`);
  });
  await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", pem);
  console.log(`Stored the new key (${fingerprint}).`);
  await checkInstallation(appId, pem, hub.split("/")[0]!, hub, slug);
  console.log(`Now delete every other key on that page so the old one stops working. Then delete ${path}.`);
}

async function storeCertificate(hub: string): Promise<void> {
  console.log("Apple certificate: a Developer ID Application certificate exported as .p12. In Keychain Access, open My Certificates,");
  console.log("right-click \"Developer ID Application: ...\", choose Export and save it as .p12 with a password. Create one at");
  console.log("https://developer.apple.com/account/resources/certificates if you have none. It stays in your hub's secrets only.");
  const path = cleanPath(await ask(".p12 file (drag it here): "));
  const data = await readInput(path, "the .p12 file");
  const password = await ask(".p12 password: ", true);
  const certs = await run("openssl", ["pkcs12", "-in", path, "-passin", "env:TAPSTER_P12", "-nokeys", "-clcerts"], { env: { TAPSTER_P12: password }, allowFail: true });
  if (certs.code !== 0 || !certs.stdout.includes("BEGIN CERTIFICATE")) throw new TapsterError("the .p12 could not be opened with that password", "Check the password you set when exporting it, or export it again.");
  const info = await run("openssl", ["x509", "-noout", "-subject", "-enddate", "-nameopt", "RFC2253"], { stdin: certs.stdout });
  const subject = /^subject=\s*(.*)$/m.exec(info.stdout)?.[1]?.trim() ?? "";
  const notAfter = /^notAfter=(.*)$/m.exec(info.stdout)?.[1]?.trim() ?? "";
  const { team, expires } = checkCertificate(subject, notAfter);
  await setEnvSecret(hub, "MACOS_SIGN_P12", data.toString("base64"));
  await setEnvSecret(hub, "MACOS_SIGN_PASSWORD", password);
  await setEnvVariable(hub, "TAPSTER_TEAM_ID", team);
  await setEnvVariable(hub, "TAPSTER_CERT_EXPIRES", expires);
  console.log(`Certificate stored for team ${team}; it expires on ${expires}, and the hub warns 30 days before.`);
}

async function checkNotary(path: string, keyId: string, issuer: string): Promise<void> {
  if (process.platform !== "darwin" || !existsSync(TOOLS.xcrun)) {
    console.log("Not on macOS, so the key is checked at the first release instead.");
    return;
  }
  const res = await runPath(TOOLS.xcrun, "xcrun", notaryArgs(path, keyId, issuer), { allowFail: true });
  if (res.code !== 0) parseNotary("", res.stderr);
  console.log("Apple accepted the key.");
}

async function storeNotary(hub: string): Promise<void> {
  console.log("Notarization key: an App Store Connect API key. In App Store Connect open Users and Access, Integrations,");
  console.log("App Store Connect API, Team Keys; create a key with Developer access and download AuthKey_<id>.p8 (Apple offers");
  console.log("the download once). The Key ID is in the list and the Issuer ID above it. It stays in your hub's secrets only.");
  const path = cleanPath(await ask(".p8 file (drag it here): "));
  const p8 = await readInput(path, "the .p8 file");
  if (!p8.toString("utf8").includes("BEGIN PRIVATE KEY")) throw new TapsterError("that file is not an App Store Connect key", "Download the .p8 from App Store Connect, Users and Access, Integrations.");
  const keyId = await ask("Key ID: ");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new TapsterError(`${keyId || "an empty Key ID"} is not a Key ID`, "Copy the 10-character Key ID next to the key in App Store Connect.");
  const issuer = (await ask("Issuer ID: ")).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(issuer)) {
    throw new TapsterError("that is not an Issuer ID", "Copy the Issuer ID shown above the key list in App Store Connect.");
  }
  await checkNotary(path, keyId, issuer);
  await setEnvSecret(hub, "MACOS_NOTARY_KEY", p8.toString("base64"));
  await setEnvSecret(hub, "MACOS_NOTARY_KEY_ID", keyId);
  await setEnvSecret(hub, "MACOS_NOTARY_ISSUER_ID", issuer);
  console.log(`Notarization key stored. You may delete ${path} once you keep a backup.`);
}

export const HUB_RULESET = {
  name: "tapster main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [] as { actor_id: number; actor_type: string; bypass_mode: string }[],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] as string[] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};

export async function protectHub(gh: GitHub, hub: string, isPrivate: boolean): Promise<void> {
  try {
    await gh.json("PUT", `/repos/${hub}/environments/tapster`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  } catch (e) {
    throw privateHubError(e, isPrivate);
  }
  const policies = await gh.json<{ branch_policies: { id: number; name: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  for (const p of policies.branch_policies.filter((x) => x.name !== "main")) {
    await gh.json("DELETE", `/repos/${hub}/environments/tapster/deployment-branch-policies/${p.id}`);
  }
  if (!policies.branch_policies.some((p) => p.name === "main")) {
    await gh.json("POST", `/repos/${hub}/environments/tapster/deployment-branch-policies`, { name: "main", type: "branch" });
  }
  await gh.json("PUT", `/repos/${hub}/actions/permissions/workflow`, { default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  await gh.json("PUT", `/repos/${hub}/actions/permissions`, { enabled: true, allowed_actions: "selected", sha_pinning_required: true });
  await gh.json("PUT", `/repos/${hub}/actions/permissions/selected-actions`, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["doguyilmaz/tapster@*"] });
  const existing = (await gh.json<{ id: number; name: string }[]>("GET", `/repos/${hub}/rulesets`)).find((r) => r.name === HUB_RULESET.name);
  if (existing) await gh.json("PUT", `/repos/${hub}/rulesets/${existing.id}`, HUB_RULESET);
  else await gh.json("POST", `/repos/${hub}/rulesets`, HUB_RULESET);
}

export async function tapsterPin(gh: GitHub, build: typeof TAPSTER, flag: string | null): Promise<{ sha: string; tag: string }> {
  if (flag === null) {
    if (build.sha) return { sha: build.sha, tag: `v${build.version}` };
    throw new TapsterError("this tapster was built from a checkout, so it does not know which tapster the hub should run", "Pass --tapster <commit> with a full commit SHA from tapster's main, or use a released tapster.");
  }
  if (!/^[0-9a-f]{40}$/.test(flag)) throw new TapsterError(`${flag} is not a full commit SHA`, "Pass all 40 characters of the commit.");
  const cmp = await gh.json<{ status: string }>("GET", `/repos/doguyilmaz/tapster/compare/${flag}...main`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") throw new TapsterError(`${flag} is not on tapster's main`, "Pin a commit that is on main.");
  return { sha: flag, tag: "main" };
}

const PIN = /doguyilmaz\/tapster@([0-9a-f]{40}) # (\S+)/;

export function pinChange(before: string | null, after: string): string {
  const show = (m: RegExpExecArray) => `${m[2]} (${m[1]!.slice(0, 7)})`;
  const next = PIN.exec(after)!;
  const prev = before === null ? null : PIN.exec(before);
  if (!prev) return `tapster ${show(next)}`;
  return prev[1] === next[1] && prev[2] === next[2] ? `tapster ${show(prev)}, unchanged` : `tapster ${show(prev)} -> ${show(next)}`;
}

export function patchSparkleEnv(flow: string, labels: string[]): string {
  const step = /(\n\s+with: \{ mode: sparkle(?:, template: \d+)? \}\n\s+env: ).*\n/;
  if (!step.test(flow)) throw new TapsterError("the hub workflow has no sparkle step", "Run tapster init --workflow to rewrite it from the template.");
  return flow.replace(step, (_, head: string) => `${head}${sparkleEnv(labels)}\n`);
}

function hubConfig(dir: string, hub: string): HubConfig {
  const path = join(dir, "tapster.yml");
  if (!existsSync(path)) throw new TapsterError("tapster.yml is missing", "Run tapster init in the hub first.");
  const { config, invalid } = parseHub(readFileSync(path, "utf8"), hub.split("/")[0]!);
  for (const i of invalid) console.log(`note: ${i.name} in tapster.yml is invalid and left out: ${i.reason}`);
  return config;
}

export function hubLabels(dir: string, owner: string): string[] {
  const path = join(dir, "tapster.yml");
  return existsSync(path) ? sparkleLabels(parseHub(readFileSync(path, "utf8"), owner).config) : [];
}

const FLOW = ".github/workflows/tapster.yml";

type Schedule = { every: number | null; isPrivate: boolean };

async function writeWorkflow(gh: GitHub, dir: string, labels: string[], flag: string | null, schedule: Schedule): Promise<void> {
  const ref = await tapsterPin(gh, TAPSTER, flag);
  const before = existsSync(join(dir, FLOW)) ? readFileSync(join(dir, FLOW), "utf8") : null;
  const kept = before === null ? null : everyFromFlow(before);
  const every = schedule.every ?? kept ?? (schedule.isPrivate ? 60 : 10);
  const after = fillWorkflow(hubWorkflow, pinsJson, ref, labels, every);
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  await writeFile(join(dir, FLOW), after);
  console.log(`wrote ${FLOW} from the template, ${pinChange(before, after)}; hand edits in it are replaced`);
  if (every === kept) return;
  console.log(`The hub looks for new drafts every ${every} minutes; change it with tapster init --workflow --every <minutes>.`);
  if (kept !== null) console.log("If the hub has a doorbell, run tapster init --rotate doorbell after you push, so it keeps the same schedule.");
  if (schedule.isPrivate && every >= 60 && schedule.every === null) {
    console.log("GitHub bills every run of a private hub as at least one minute: every 10 minutes would use about 4,300 of the 2,000 free minutes a month. The doorbell (tapster init --doorbell) still publishes right after each release.");
  }
}

async function updateSparkleEnv(dir: string, labels: string[]): Promise<void> {
  const path = join(dir, FLOW);
  if (!existsSync(path)) throw new TapsterError(`${FLOW} is missing`, "Run tapster init --workflow first.");
  await writeFile(path, patchSparkleEnv(readFileSync(path, "utf8"), labels));
  console.log(`updated the sparkle step in ${FLOW}`);
}

async function storeSparkleKey(gh: GitHub, dir: string, hub: string, label: string, account: string): Promise<void> {
  if (!/^[a-z0-9]+$/.test(label)) throw new TapsterError(`${label} is not a valid label`, "Use lowercase letters and digits, as in sparkle.key.");
  const config = hubConfig(dir, hub);
  const read = await run("security", ["find-generic-password", "-s", "https://sparkle-project.org", "-a", account, "-w"], { allowFail: true });
  if (read.code !== 0) throw new TapsterError(`the login keychain has no Sparkle key for the account ${account}`, "Pass the account generate_keys used with --account (ed25519 by default).");
  const text = read.stdout.trim();
  const key = decodeSparkleKey(text);
  const users = keyPins(config, label, key.publicKey);
  console.log(`The key ${key.publicKey} signs updates for ${users.join(", ")}.`);
  console.log("If it is lost, installed copies can never update again; if it leaks, anyone can sign updates for them.");
  const backup = await ask("Do you keep an offline backup of this key? Type yes to store it in the hub: ");
  if (backup !== "yes") throw new TapsterError("no offline backup confirmed", "Back the key up first (generate_keys -x exports it), then run this again.");
  await setEnvSecret(hub, `SPARKLE_KEY_${label.toUpperCase()}`, text);
  console.log(`Stored SPARKLE_KEY_${label.toUpperCase()}.`);
  await updateSparkleEnv(dir, sparkleLabels(config));
  console.log("Review and commit the workflow change, then push.");
}

async function createSparkleKey(dir: string, hub: string, label: string): Promise<void> {
  if (!/^[a-z0-9]+$/.test(label)) throw new TapsterError(`${label} is not a valid label`, "Use lowercase letters and digits, as in sparkle.key.");
  const config = hubConfig(dir, hub);
  const users = config.packages.filter(isApp).filter((p) => p.sparkle?.key === label || p.sparkle?.next_key === label);
  if (users.length) {
    throw new TapsterError(`${users.map((p) => p.name).join(", ")} already sign with the Sparkle key ${label}`, "A new key needs a new label. To change an app's key, follow the Sparkle key change in the README.");
  }
  const store = requireStore("the Sparkle key");
  const ref = { service: "https://sparkle-project.org", account: label, label: "Private key for signing Sparkle updates" };
  if (await store.exists(ref)) {
    throw new TapsterError(`your keychain already has a Sparkle key for the account ${label}`, `Store that one with tapster init --sparkle ${label} --account ${label}, or pick another label.`);
  }
  const key = newSparkleKey();
  await store.save({ ...ref, comment: `Public key (SUPublicEDKey value) for this key is: ${key.publicKey}` }, key.seed);
  console.log(`Saved a new Sparkle key in your ${store.kind === "keychain" ? "login keychain" : "keyring"} under the account ${label}; Sparkle's own tools find it there, and macOS asks you before any app reads it.`);
  console.log(`Its public key is ${key.publicKey}. Put it in the app as SUPublicEDKey and in tapster.yml as sparkle.public_key.`);
  console.log("If this key is lost, installed copies can never update again. Keep an offline copy too, for example in your password manager:");
  console.log(store.kind === "keychain" ? `  security find-generic-password -s https://sparkle-project.org -a ${label} -w   (macOS asks you first)` : `  secret-tool lookup service https://sparkle-project.org account ${label}`);
  if ((await ask("Type yes once you keep an offline copy, to store the key in the hub: ")) !== "yes") {
    console.log(`Not stored in the hub yet. Once you keep a copy, run tapster init --sparkle ${label} --account ${label}.`);
    return;
  }
  await setEnvSecret(hub, `SPARKLE_KEY_${label.toUpperCase()}`, key.seed);
  console.log(`Stored SPARKLE_KEY_${label.toUpperCase()} in the hub.`);
  await updateSparkleEnv(dir, [...new Set([...sparkleLabels(config), label])]);
  console.log("Review and commit the workflow change, then push.");
}

async function replaceLocal(store: Store, ref: KeyRef, secret: string): Promise<void> {
  const pending = { ...ref, account: `${ref.account} pending`, label: `${ref.label} (pending)` };
  await store.remove(pending);
  await store.save(pending, secret);
  await store.remove(ref);
  await store.save(ref, secret);
  await store.remove(pending);
}

const linuxRef = (hub: string, previous = false) => ({ service: "tapster-linux-key", account: previous ? `${hub} previous` : hub, label: `tapster Linux key for ${hub}${previous ? " (previous)" : ""}` });

async function finishLinuxRotation(gh: GitHub, hub: string): Promise<void> {
  const secrets = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/secrets`)).secrets.map((x) => x.name);
  if (secrets.includes("TAPSTER_LINUX_KEY_PREVIOUS")) await deleteEnvSecret(hub, "TAPSTER_LINUX_KEY_PREVIOUS");
  await localStore()?.remove(linuxRef(hub, true));
  console.log("The previous Linux key no longer signs; apt and dnf trust only the new one from the next run.");
}

export function linuxKeyAllowed(secrets: string[], rotate: boolean): void {
  if (secrets.includes("TAPSTER_LINUX_KEY") && !rotate) {
    throw new TapsterError("the hub already has a Linux signing key", "Replacing it makes every apt and dnf user fetch the new key. To do that, run tapster init --rotate linux.");
  }
}

async function setupLinux(gh: GitHub, dir: string, hub: string, rotate: boolean): Promise<void> {
  const config = hubConfig(dir, hub);
  const secrets = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/secrets`)).secrets.map((x) => x.name);
  linuxKeyAllowed(secrets, rotate);
  const store = requireStore("the Linux signing key");
  const gpg = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg"].find((p) => existsSync(p));
  if (!gpg) throw new TapsterError("gpg is not installed", "Install it with brew install gnupg, then run this again.");
  await gh.json("POST", `/repos/${hub}/pages`, { build_type: "workflow" }).catch(async (e) => {
    if (!(e instanceof GitHubError) || e.status !== 409) throw new TapsterError("GitHub Pages could not be turned on for the hub", "A private hub needs a paid plan for Pages; make the hub public or turn Pages on by hand with GitHub Actions as the source.");
    await gh.json("PUT", `/repos/${hub}/pages`, { build_type: "workflow" });
  });
  console.log("GitHub Pages serves the hub from GitHub Actions.");
  const home = tempDir("tl-");
  const env = { GNUPGHOME: home };
  try {
    await runPath(gpg, "gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", `${hub.split("/")[0]} tapster (${hub})`, "rsa4096", "sign", "never"], { env });
    const key = (await runPath(gpg, "gpg", ["--batch", "--armor", "--export-secret-keys"], { env })).stdout;
    const fingerprint = (await runPath(gpg, "gpg", ["--batch", "--with-colons", "--list-secret-keys"], { env })).stdout.split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9];
    let old: string | null = null;
    if (rotate) {
      if (store.kind === "keychain") console.log("macOS asks whether tapster may read the previous key from your keychain; choose Allow.");
      old = await previousKey(store, linuxRef(hub));
    }
    const pending = { ...linuxRef(hub), account: `${hub} new`, label: `tapster Linux key for ${hub} (new)` };
    await store.remove(pending);
    await store.save(pending, key);
    await setEnvSecret(hub, "TAPSTER_LINUX_KEY", key);
    if (old) await setEnvSecret(hub, "TAPSTER_LINUX_KEY_PREVIOUS", old);
    if (old) await replaceLocal(store, linuxRef(hub, true), old);
    await replaceLocal(store, linuxRef(hub), key);
    await store.remove(pending);
    console.log(`Stored the Linux key (fingerprint ${fingerprint}) in the hub and in your ${store.kind === "keychain" ? "login keychain" : "keyring"} as "tapster-linux-key".`);
    if (old) console.log("The previous key keeps signing next to the new one, so apt and dnf users can fetch the new key. Once they have, run tapster init --rotate linux --finish.");
    else if (rotate) console.log("The previous key is not in your keychain, so apt and dnf users must fetch the new key before they can update.");
  } finally {
    await runPath(join(gpg, "..", "gpgconf"), "gpgconf", ["--kill", "all"], { env, allowFail: true }).catch(() => undefined);
    removeTemp(home);
  }
  if (!config.packages.some((p) => !isApp(p) && p.linux)) console.log("No package sets linux: true yet; add it to the CLI packages that should ship to apt and dnf.");
}

async function writeFiles(gh: GitHub, dir: string, hub: string, flag: string | null, schedule: Schedule): Promise<void> {
  const [owner, repo] = hub.split("/") as [string, string];
  const tap = `${owner}/${repo.replace(/^homebrew-/, "")}`;
  const write = async (path: string, content: string) => {
    if (existsSync(join(dir, path))) return;
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
    console.log(`wrote ${path}`);
  };
  await write("tapster.yml", `version: 1\ntap: ${tap}\npackages: []\n`);
  await write(".tapster/state.json", `${JSON.stringify({ version: 1, packages: {} }, null, 2)}\n`);
  await write("README.md", hubReadme.replaceAll("__TAP__", tap).replaceAll("__OWNER__", owner).replaceAll("__HUB__", hub));
  await writeWorkflow(gh, dir, hubLabels(dir, owner), flag, schedule);
}

async function askYes(question: string): Promise<boolean> {
  const answer = (await ask(question)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function hubState(gh: GitHub, hub: string): Promise<{ vars: string[]; secrets: string[]; private: boolean }> {
  const names = async (kind: "variables" | "secrets") => {
    try {
      const res = await gh.json<Record<string, { name: string }[]>>("GET", `/repos/${hub}/environments/tapster/${kind}?per_page=100`);
      return (res[kind] ?? []).map((x) => x.name);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return [];
      throw e;
    }
  };
  return { vars: await names("variables"), secrets: await names("secrets"), private: (await gh.getRepo(hub)).private };
}

function takeOption(argv: string[], name: string): { value: string | null; rest: string[] } {
  const at = argv.indexOf(name);
  if (at < 0) return { value: null, rest: argv };
  return { value: argv[at + 1] ?? "", rest: argv.filter((_, i) => i !== at && i !== at + 1) };
}

export type InitAction =
  | { kind: "setup" }
  | { kind: "rotate"; what: "app" | "certificate" | "notary" | "doorbell" | "linux" | "linux-finish" }
  | { kind: "doorbell" }
  | { kind: "linux" }
  | { kind: "sparkle"; label: string; account: string }
  | { kind: "sparkle-new"; label: string }
  | { kind: "workflow" };

const INIT_USAGE = "Run tapster init --help for the options.";

export function initAction(args: string[]): InitAction {
  const [a, b, c, d] = args;
  if (args.length === 0) return { kind: "setup" };
  if (a === "--rotate" && args.length === 2 && ["app", "certificate", "notary", "doorbell", "linux"].includes(b ?? "")) return { kind: "rotate", what: b as "app" };
  if (a === "--rotate" && b === "linux" && c === "--finish" && args.length === 3) return { kind: "rotate", what: "linux-finish" };
  if (a === "--doorbell" && args.length === 1) return { kind: "doorbell" };
  if (a === "--linux" && args.length === 1) return { kind: "linux" };
  if (a === "--workflow" && args.length === 1) return { kind: "workflow" };
  if (a === "--sparkle" && b && !b.startsWith("-")) {
    if (args.length === 2) return { kind: "sparkle", label: b, account: "ed25519" };
    if (c === "--new" && args.length === 3) return { kind: "sparkle-new", label: b };
    if (c === "--account" && d && args.length === 4) return { kind: "sparkle", label: b, account: d };
  }
  throw new TapsterError(`unknown option ${args.join(" ")}`, INIT_USAGE);
}

function flowEvery(dir: string): number {
  const flow = join(dir, FLOW);
  return (existsSync(flow) && everyFromFlow(readFileSync(flow, "utf8"))) || 10;
}

export async function init(argv: string[]): Promise<void> {
  const pinned = takeOption(argv, "--tapster");
  const timed = takeOption(pinned.rest, "--every");
  const flag = pinned.value;
  const every = timed.value === null ? null : Number(timed.value);
  const action = initAction(timed.rest);
  if (every !== null) cronFor(every);
  if ((flag !== null || every !== null) && action.kind !== "setup" && action.kind !== "workflow") {
    throw new TapsterError("--tapster and --every go only with tapster init or init --workflow", "Those are the commands that write the workflow.");
  }
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const gh = await userGitHub();
  if (action.kind === "rotate") {
    if (action.what === "app") return rotateAppKey(gh, hub);
    if (action.what === "certificate") return storeCertificate(hub);
    if (action.what === "notary") return storeNotary(hub);
    if (action.what === "doorbell") return rotateDoorbell(gh, hub, flowEvery(dir));
    if (action.what === "linux-finish") return finishLinuxRotation(gh, hub);
    return setupLinux(gh, dir, hub, true);
  }
  if (action.kind === "doorbell") return setupDoorbell(gh, hub, hubConfig(dir, hub), setRepoVariable, flowEvery(dir));
  if (action.kind === "linux") return setupLinux(gh, dir, hub, false);
  if (action.kind === "sparkle-new") return createSparkleKey(dir, hub, action.label);
  if (action.kind === "sparkle") return storeSparkleKey(gh, dir, hub, action.label, action.account);
  if (action.kind === "workflow") return writeWorkflow(gh, dir, sparkleLabels(hubConfig(dir, hub)), flag, { every, isPrivate: (await gh.getRepo(hub)).private });
  const have = await hubState(gh, hub);
  const hasApple = have.vars.includes("TAPSTER_TEAM_ID") || have.secrets.includes("MACOS_NOTARY_KEY");
  const mac = hasApple || (await askYes("Will this hub sign software for macOS (Mac apps or CLI tools with macOS builds)? [Y/n] "));
  const steps = initSteps(have, mac);
  const done = ["app", "certificate", "notary"].filter((x) => !steps.includes(x) && (x === "app" || mac));
  if (done.length) console.log(`Already done: ${done.join(", ")}. To redo one, run tapster init --rotate <name>.`);
  for (const step of steps) {
    if (step === "protect") await protectHub(gh, hub, have.private);
    if (step === "app") await createApp(hub.split("/")[0]!, hub);
    if (step === "app-key") await rotateAppKey(gh, hub);
    if (step === "certificate") await storeCertificate(hub);
    if (step === "notary") await storeNotary(hub);
    if (step === "files") await writeFiles(gh, dir, hub, flag, { every, isPrivate: have.private });
  }
  if (!mac) console.log("Skipped the Apple credentials. Add them later with tapster init --rotate certificate and tapster init --rotate notary.");
  console.log("\nDone. Review and commit the new files, push, then run tapster add in each project.");
}
