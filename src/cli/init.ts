import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { appJwt } from "../token";
import { run, runPath } from "../run";
import hubReadme from "../../templates/hub/README.md" with { type: "text" };
import hubWorkflow from "../../templates/hub/tapster.yml" with { type: "text" };
import pinsJson from "../../templates/pins.json";
import { currentRepo, setEnvSecret, setEnvVariable, userGitHub } from "./gh";
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

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }): string {
  return template
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__TAPSTER_SHA__", tapster.sha)
    .replaceAll("__TAPSTER_TAG__", tapster.tag);
}

function openUrl(url: string): void {
  console.log(`  ${url}`);
  void runPath(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", "open", [url], { allowFail: true }).catch(() => undefined);
}

async function createApp(owner: string, hub: string): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/start") {
        const manifest = JSON.stringify(appManifest(owner, hub, `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`)).replaceAll('"', "&quot;");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${manifest}"></form><script>document.getElementById("f").submit()</script>`);
        return;
      }
      if (url.pathname === "/callback") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("tapster: the App was created. You can close this tab.");
        server.close();
        if (url.searchParams.get("state") !== state) reject(new TapsterError("the App creation answer did not match", "Run tapster init again."));
        else resolve(url.searchParams.get("code") ?? "");
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      console.log("Opening GitHub to create your tapster App. Click \"Create GitHub App\".");
      openUrl(`http://127.0.0.1:${p}/start`);
    });
  });
  const app = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
  if (!app.ok) throw new TapsterError(`GitHub did not convert the App (status ${app.status})`, "Run tapster init again within an hour of creating the App.");
  const created = (await app.json()) as { id: number; slug: string; pem: string };
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
  console.log(`Now delete every other key on that page, so the old one stops working, and delete ${path}.`);
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
  const flow = fillWorkflow(hubWorkflow, pinsJson, await tapsterRef(gh));
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  await writeFile(join(dir, ".github/workflows/tapster.yml"), flow);
  console.log("wrote .github/workflows/tapster.yml");
}

export async function init(args: string[]): Promise<void> {
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const gh = await userGitHub();
  const rotate = args[0] === "--rotate" ? args[1] : null;
  if (rotate === "app") return rotateAppKey(gh, hub);
  if (rotate === "certificate") return storeCertificate(hub);
  if (rotate === "notary") return storeNotary(hub);
  if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "Use tapster init or tapster init --rotate app|certificate|notary.");
  await protectHub(gh, hub);
  await createApp(hub.split("/")[0]!, hub);
  await storeCertificate(hub);
  await storeNotary(hub);
  await writeFiles(gh, dir, hub);
  console.log("\nDone. Review and commit the new files, push, then run tapster add in each project.");
}
