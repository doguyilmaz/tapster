import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HubConfig, isApp, parseConfig } from "../config";
import { GitHubError, TapsterError } from "../errors";
import { GitHub } from "../github";
import { decodeSparkleKey } from "../sparkle-key";
import { appJwt } from "../token";
import { run, runPath } from "../run";
import hubReadme from "../../templates/hub/README.md" with { type: "text" };
import hubWorkflow from "../../templates/hub/tapster.yml" with { type: "text" };
import pinsJson from "../../templates/pins.json";
import { appFromManifest, openUrl } from "./appflow";
import { rotateDoorbell, setupDoorbell } from "./doorbell";
import { currentRepo, setEnvSecret, setEnvVariable, setRepoVariable, userGitHub } from "./gh";
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

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }, labels: string[] = []): string {
  return template
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

async function createApp(owner: string, hub: string): Promise<void> {
  const created = await appFromManifest((redirect) => appManifest(owner, hub, redirect), "your tapster App");
  await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", created.pem);
  await setEnvVariable(hub, "TAPSTER_APP_ID", String(created.id));
  await setEnvVariable(hub, "TAPSTER_APP_SLUG", created.slug);
  console.log(`Install the App on the projects tapster should publish (not on ${hub}):`);
  openUrl(`https://github.com/apps/${created.slug}/installations/new`);
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
  const path = (await ask("Path of the downloaded .pem file: ")).replace(/^~(?=\/)/, process.env.HOME ?? "~");
  const pem = await readFile(path, "utf8");
  const fingerprint = appKeyFingerprint(pem);
  await new GitHub(appJwt(appId, pem)).json("GET", "/app").catch(() => {
    throw new TapsterError("that key does not belong to the hub's App", `Generate the key on https://github.com/settings/apps/${slug}.`);
  });
  await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", pem);
  console.log(`Stored the new key (${fingerprint}).`);
  console.log(`Now delete every other key on that page so the old one stops working. Then delete ${path}.`);
}

async function storeCertificate(hub: string): Promise<void> {
  const path = await ask("Developer ID Application .p12 file: ");
  const password = await ask(".p12 password: ", true);
  const data = await readFile(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const certs = await run("openssl", ["pkcs12", "-in", path.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "-passin", "env:TAPSTER_P12", "-nokeys", "-clcerts"], { env: { TAPSTER_P12: password } });
  const subject = (await run("openssl", ["x509", "-noout", "-subject", "-nameopt", "RFC2253"], { stdin: certs.stdout })).stdout.replace(/^subject=\s*/, "").trim();
  const team = teamIdFromSubject(subject);
  if (!team) throw new TapsterError("the certificate has no team ID", "Export the Developer ID Application certificate from Keychain Access.");
  await setEnvSecret(hub, "MACOS_SIGN_P12", data.toString("base64"));
  await setEnvSecret(hub, "MACOS_SIGN_PASSWORD", password);
  await setEnvVariable(hub, "TAPSTER_TEAM_ID", team);
  console.log(`Certificate stored for team ${team}.`);
}

async function storeNotary(hub: string): Promise<void> {
  const path = await ask("App Store Connect API key (.p8) file: ");
  const keyId = await ask("Key ID: ");
  const issuer = await ask("Issuer ID: ");
  const p8 = await readFile(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!p8.toString("utf8").includes("BEGIN PRIVATE KEY")) throw new TapsterError("that file is not an App Store Connect key", "Download the .p8 from App Store Connect, Users and Access, Integrations.");
  await setEnvSecret(hub, "MACOS_NOTARY_KEY", p8.toString("base64"));
  await setEnvSecret(hub, "MACOS_NOTARY_KEY_ID", keyId);
  await setEnvSecret(hub, "MACOS_NOTARY_ISSUER_ID", issuer);
  console.log("Notarization key stored.");
}

async function protectHub(gh: GitHub, hub: string): Promise<void> {
  await gh.json("PUT", `/repos/${hub}/environments/tapster`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  const policies = await gh.json<{ branch_policies: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  if (!policies.branch_policies.some((p) => p.name === "main")) {
    await gh.json("POST", `/repos/${hub}/environments/tapster/deployment-branch-policies`, { name: "main", type: "branch" });
  }
  await gh.json("PUT", `/repos/${hub}/actions/permissions/workflow`, { default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  const rules = await gh.json<{ name: string }[]>("GET", `/repos/${hub}/rulesets`);
  if (!rules.some((r) => r.name === "tapster main")) {
    await gh.json("POST", `/repos/${hub}/rulesets`, {
      name: "tapster main",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    });
  }
}

async function tapsterRef(gh: GitHub): Promise<{ sha: string; tag: string }> {
  const latest = await gh.json<{ tag_name: string }>("GET", "/repos/doguyilmaz/tapster/releases/latest");
  const ref = await gh.json<{ object: { sha: string; type: string } }>("GET", `/repos/doguyilmaz/tapster/git/ref/tags/${latest.tag_name}`);
  const sha = ref.object.type === "tag" ? (await gh.json<{ object: { sha: string } }>("GET", `/repos/doguyilmaz/tapster/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha;
  return { sha, tag: latest.tag_name };
}

function hubConfig(dir: string, hub: string): HubConfig {
  const path = join(dir, "tapster.yml");
  if (!existsSync(path)) throw new TapsterError("tapster.yml is missing", "Run tapster init in the hub first.");
  return parseConfig(readFileSync(path, "utf8"), hub.split("/")[0]!);
}

async function writeWorkflow(gh: GitHub, dir: string, labels: string[]): Promise<void> {
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  const ref = await tapsterRef(gh);
  await writeFile(join(dir, ".github/workflows/tapster.yml"), fillWorkflow(hubWorkflow, pinsJson, ref, labels));
  console.log(`wrote .github/workflows/tapster.yml from the template, pinned to tapster ${ref.tag}; hand edits in it are replaced`);
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
  await writeWorkflow(gh, dir, sparkleLabels(config));
  console.log("Review and commit the workflow change, then push.");
}

async function setupLinux(gh: GitHub, dir: string, hub: string): Promise<void> {
  const config = hubConfig(dir, hub);
  const gpg = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg"].find((p) => existsSync(p));
  if (!gpg) throw new TapsterError("gpg is not installed", "Install it with brew install gnupg, then run this again.");
  const home = mkdtempSync("/tmp/tl-");
  const env = { GNUPGHOME: home };
  try {
    await runPath(gpg, "gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", `${hub.split("/")[0]} tapster (${hub})`, "rsa4096", "sign", "never"], { env });
    const key = (await runPath(gpg, "gpg", ["--batch", "--armor", "--export-secret-keys"], { env })).stdout;
    const fingerprint = (await runPath(gpg, "gpg", ["--batch", "--with-colons", "--list-secret-keys"], { env })).stdout.split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9];
    await setEnvSecret(hub, "TAPSTER_LINUX_KEY", key);
    console.log(`Stored TAPSTER_LINUX_KEY, fingerprint ${fingerprint}. It is kept nowhere else; if it is lost, run this again and users fetch the new key.`);
  } finally {
    await runPath(join(gpg, "..", "gpgconf"), "gpgconf", ["--kill", "all"], { env, allowFail: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
  await gh.json("POST", `/repos/${hub}/pages`, { build_type: "workflow" }).catch(async (e) => {
    if (!(e instanceof GitHubError) || e.status !== 409) throw new TapsterError("GitHub Pages could not be turned on for the hub", "A private hub needs a paid plan for Pages; make the hub public or turn Pages on by hand with GitHub Actions as the source.");
    await gh.json("PUT", `/repos/${hub}/pages`, { build_type: "workflow" });
  });
  console.log("GitHub Pages serves the hub from GitHub Actions.");
  if (!config.packages.some((p) => !isApp(p) && p.linux)) console.log("No package sets linux: true yet; add it to the CLI packages that should ship to apt and dnf.");
  await writeWorkflow(gh, dir, sparkleLabels(config));
}

async function writeFiles(gh: GitHub, dir: string, hub: string): Promise<void> {
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
  await writeWorkflow(gh, dir, []);
}

export async function init(args: string[]): Promise<void> {
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const gh = await userGitHub();
  const rotate = args[0] === "--rotate" ? args[1] : null;
  if (rotate === "app") return rotateAppKey(gh, hub);
  if (rotate === "certificate") return storeCertificate(hub);
  if (rotate === "notary") return storeNotary(hub);
  if (rotate === "doorbell") return rotateDoorbell(gh, hub);
  if (args[0] === "--doorbell" && args.length === 1) return setupDoorbell(gh, hub, hubConfig(dir, hub), setRepoVariable);
  if (args[0] === "--linux" && args.length === 1) return setupLinux(gh, dir, hub);
  if (args[0] === "--sparkle" && args[1]) {
    const account = args[2] === "--account" && args[3] ? args[3] : args.length === 2 ? "ed25519" : null;
    if (account) return storeSparkleKey(gh, dir, hub, args[1], account);
  }
  if (args[0] === "--workflow" && args.length === 1) return writeWorkflow(gh, dir, sparkleLabels(hubConfig(dir, hub)));
  if (args.length) {
    throw new TapsterError(`unknown option ${args.join(" ")}`, "Use tapster init, init --rotate app|certificate|notary|doorbell, init --sparkle <label> [--account <account>], init --doorbell, init --linux or init --workflow.");
  }
  await protectHub(gh, hub);
  await createApp(hub.split("/")[0]!, hub);
  await storeCertificate(hub);
  await storeNotary(hub);
  await writeFiles(gh, dir, hub);
  console.log("\nDone. Review and commit the new files, push, then run tapster add in each project.");
}
