import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GitHub } from "../src/github";
import { run } from "../src/run";
import { useGhWrite } from "../src/cli/gh";
import { newSparkleKey } from "../src/cli/keystore";
import { appCallback } from "../src/web/api/hub";
import type { AddView, FilesView, HubView, InspectView, ScanView } from "../src/web/contract";
import { type Deps, handler, newSession } from "../src/web/server";
import { routes } from "../src/web/start";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";

const fake = new FakeHub("octo");
const sparkle = newSparkleKey();
let home = "";
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;
let s: ReturnType<typeof newSession>;

beforeAll(async () => {
  fake.repo("homebrew-tap", { files: new Map([["README.md", "# mine\n"], [".github/workflows/tests.yml", "jobs:\n  t:\n    steps:\n      - uses: Homebrew/actions/setup-homebrew@master\n"]]) });
  home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  const deps: Deps = {
    github: async () => new GitHub("t", fake.fetch, async () => {}, "user"),
    fetch: fake.fetch as typeof fetch,
    home,
    cwd: join(home, "Developer", "ebb"),
    pin: "0123456789abcdef0123456789abcdef01234567",
    log: () => {},
    open: () => {},
    notary: async () => false,
    keychain: async (account) => (account === "ed25519" ? sparkle.seed : null),
  };
  s = newSession(deps, 8277);
  const handle = handler(s, routes(s, () => {}), (c) => appCallback(c));
  call = async (method, path, body) => {
    const headers: Record<string, string> = { host: "127.0.0.1:8277", authorization: `Bearer ${s.token}` };
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await handle(new Request(`http://127.0.0.1:8277${path}`, { method, headers, body: payload }));
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const hubView = async () => (await call("GET", "/api/hub?hub=octo/homebrew-tap")).data as unknown as HubView;

test("the account and the hub list come from the signed-in user, never other owners", async () => {
  expect((await call("GET", "/api/account")).data).toEqual({ state: "ok", login: "octo", missing: [] });
  const hubs = (await call("GET", "/api/hubs")).data.hubs as { name: string }[];
  expect(hubs.map((h) => h.name)).toEqual(["octo/homebrew-tap"]);
  expect((await call("GET", "/api/hub?hub=someone/homebrew-tap")).status).toBe(400);
  expect((await call("GET", "/api/hub?hub=octo/not-a-tap")).status).toBe(400);
});

test("a fresh tap shows every step open and warns about its old workflows", async () => {
  const h = await hubView();
  expect(h.protect.done).toBe(false);
  expect(h.protect.others).toEqual([{ file: "tests.yml", actions: ["Homebrew/actions/setup-homebrew@master"] }]);
  expect(h.app).toEqual({ id: null, slug: null, key: false, held: false, installed: null });
  expect(h.files.workflow).toBe("missing");
});

test("the App waits for the protection, which creates the environment its key goes into", async () => {
  const early = await call("POST", "/api/hub/app", { hub: "octo/homebrew-tap" });
  expect(early.status).toBe(400);
  expect((early.data.error as { reason: string }).reason).toBe("octo/homebrew-tap's tapster environment is not locked to main");
});

test("protecting the hub turns every protection on", async () => {
  expect((await call("POST", "/api/hub/protect", { hub: "octo/homebrew-tap" })).status).toBe(200);
  const h = await hubView();
  expect(h.protect.checks.every((c) => c.ok)).toBe(true);
});

test("the App goes through GitHub and back with a single-use state, and its key lands in the hub only", async () => {
  const start = (await call("POST", "/api/hub/app", { hub: "octo/homebrew-tap" })).data as { action: string; manifest: string };
  const state = new URL(start.action).searchParams.get("state")!;
  expect(JSON.parse(start.manifest).redirect_url).toBe("http://127.0.0.1:8277/app/callback");
  fake.failWrites = true;
  const back = await handler(s, routes(s, () => {}), (c) => appCallback(c))(new Request(`http://127.0.0.1:8277/app/callback?code=abc&state=${state}`, { headers: { host: "127.0.0.1:8277" } }));
  expect(back.headers.get("location")).toStartWith("/setup?app=unstored&hub=octo%2Fhomebrew-tap");
  fake.failWrites = false;
  const waiting = await hubView();
  expect([waiting.app.held, waiting.app.key]).toEqual([true, false]);
  expect((await call("POST", "/api/hub/app/store", { hub: "octo/homebrew-tap" })).data).toEqual({ stored: true });
  const again = await handler(s, routes(s, () => {}), (c) => appCallback(c))(new Request(`http://127.0.0.1:8277/app/callback?code=abc&state=${state}`, { headers: { host: "127.0.0.1:8277" } }));
  expect(again.headers.get("location")).toBe("/setup?app=unknown");
  const repo = fake.get("octo/homebrew-tap")!;
  expect([...repo.env!.secrets]).toContain("TAPSTER_APP_PRIVATE_KEY");
  expect(repo.env!.vars.get("TAPSTER_APP_SLUG")).toBe("tapster-octo-tap");
  const h = await hubView();
  expect(h.app.key).toBe(true);
  expect(h.app.installed).toEqual({ checked: true, id: null, onHub: false, repos: [] });
  fake.installation = { id: 5, repos: ["octo/ebb", "octo/homebrew-tap"] };
  expect((await call("GET", "/api/hub/installation?hub=octo/homebrew-tap")).data).toEqual({ checked: true, id: 5, onHub: true, repos: ["octo/ebb", "octo/homebrew-tap"] });
  fake.installation = { id: 5, repos: ["octo/ebb"] };
});

test("a .p12 is checked before it is stored, and a wrong password stores nothing", async () => {
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home, "k.pem"), "-out", join(home, "c.pem"), "-days", "30", "-subj", "/CN=Developer ID Application: Octo (ABCDE12345)/OU=ABCDE12345"]);
  await run("openssl", ["pkcs12", "-export", "-in", join(home, "c.pem"), "-inkey", join(home, "k.pem"), "-out", join(home, "t.p12"), "-passout", "pass:right"]);
  const form = (password: string) => {
    const f = new FormData();
    f.set("hub", "octo/homebrew-tap");
    f.set("password", password);
    f.set("p12", new File([readFileSync(join(home, "t.p12"))], "cert.p12"));
    return f;
  };
  const wrong = await call("POST", "/api/hub/certificate", form("wrong"));
  expect(wrong.status).toBe(400);
  expect(fake.get("octo/homebrew-tap")!.env!.secrets.has("MACOS_SIGN_P12")).toBe(false);
  const ok = await call("POST", "/api/hub/certificate", form("right"));
  expect(ok.data.team).toBe("ABCDE12345");
  expect((await hubView()).apple.certificate?.team).toBe("ABCDE12345");
});

test("the notary key needs its IDs and is stored with them", async () => {
  const f = new FormData();
  f.set("hub", "octo/homebrew-tap");
  f.set("keyId", "ABCDE12345");
  f.set("issuerId", "00000000-0000-4000-8000-000000000000");
  f.set("p8", new File(["-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n"], "AuthKey_ABCDE12345.p8"));
  expect((await call("POST", "/api/hub/notary", f)).data).toEqual({ checked: false });
  expect((await hubView()).apple.notary).toBe(true);
  f.set("keyId", "nope");
  expect((await call("POST", "/api/hub/notary", f)).status).toBe(400);
});

test("hub files are previewed, then written in one commit that removes the old workflow and keeps the README", async () => {
  const body = { hub: "octo/homebrew-tap", every: 15, remove: ["tests.yml"], readme: false };
  const view = (await call("POST", "/api/hub/files/preview", body)).data as unknown as FilesView;
  expect(view.files.map((f) => [f.path, f.change])).toEqual([
    ["tapster.yml", "create"],
    [".tapster/state.json", "create"],
    [".github/workflows/tapster.yml", "create"],
    [".github/workflows/tests.yml", "remove"],
  ]);
  expect(view.readme).toBe(true);
  expect(view.foreign).toEqual([]);
  expect((await call("POST", "/api/hub/files", body)).data).toEqual({ result: "committed" });
  const files = fake.get("octo/homebrew-tap")!.files!;
  expect(files.get("README.md")).toBe("# mine\n");
  expect(files.has(".github/workflows/tests.yml")).toBe(false);
  expect(files.get(".github/workflows/tapster.yml")).toContain('cron: "7-59/15 * * * *"');
  expect((await hubView()).files.workflow).toBe("current");
});

test("the scan lists the user's clones with their kind and leaves other owners out", async () => {
  const scan = (await call("POST", "/api/projects/scan", { hub: "octo/homebrew-tap", extra: [] })).data as unknown as ScanView;
  const byRepo = Object.fromEntries(scan.projects.map((p) => [p.repo, p.kind ?? p.why]));
  expect(byRepo).toEqual({
    "octo/ebb": "go",
    "octo/hafifpix": "bun",
    "octo/lockstep": "go",
    "octo/notes": "no build that tapster knows",
    "octo/website": "a JavaScript project without Bun",
  });
  expect(scan.others).toBe(1);
  expect((await call("POST", "/api/projects/scan", { hub: "octo/homebrew-tap", extra: ["/etc"] })).status).toBe(200);
});

test("a project is inspected, added, diffed and committed, touching only tapster's files", async () => {
  const path = join(home, "Developer", "ebb");
  const info = (await call("POST", "/api/projects/inspect", { hub: "octo/homebrew-tap", path })).data as unknown as InspectView;
  expect(info).toMatchObject({ repo: "octo/ebb", kind: "go", workflows: ["release.yml"], workflow: "release.yml", dependabot: true, protected: false, inHub: false, apple: true });
  expect((await call("POST", "/api/projects/inspect", { hub: "octo/homebrew-tap", path: "/etc" })).status).toBe(400);
  expect((await call("POST", "/api/projects/inspect", { hub: "octo/homebrew-tap", path: join(home, "Developer", "borrowed") })).status).toBe(400);
  const added = (await call("POST", "/api/projects/add", { hub: "octo/homebrew-tap", path, options: { workflow: "release.yml", autoTag: false, dependabot: true, force: false } })).data as unknown as AddView;
  expect(added.files).toEqual([".goreleaser.yaml", ".github/workflows/release.yml"]);
  expect(added.pr).toContain("/pull/");
  expect(added.entry).toContain("protection: dependabot");
  expect(added.installUrl).toContain("repository_ids[]=");
  const diff = (await call("POST", "/api/projects/diff", { path, files: added.files })).data as { files: { path: string; before: string | null; after: string }[] };
  expect(diff.files[0]!.before).toContain("brews:");
  expect(diff.files[0]!.after).toContain("draft: true");
  expect(diff.files[0]!.after).not.toContain("brews:");
  expect((await call("POST", "/api/projects/diff", { path, files: ["../../etc/passwd"] })).status).toBe(400);
  await run("git", ["-C", path, "config", "user.name", "Test"]);
  await run("git", ["-C", path, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", path, "config", "commit.gpgsign", "false"]);
  await Bun.write(join(path, "unrelated.txt"), "mine");
  await run("git", ["-C", path, "add", "unrelated.txt"]);
  expect((await call("POST", "/api/projects/commit", { path, files: added.files })).data).toEqual({ committed: true });
  const last = (await run("git", ["-C", path, "show", "--name-only", "--format=%s", "HEAD"])).stdout;
  expect(last).toContain("Release through the tapster hub");
  expect(last).toContain(".goreleaser.yaml");
  expect(last).not.toContain("unrelated.txt");
  expect((await run("git", ["-C", path, "config", "--get", "tapster.hub"])).stdout.trim()).toBe("octo/homebrew-tap");
  const scan = (await call("POST", "/api/projects/scan", { hub: "octo/homebrew-tap", extra: [] })).data as unknown as ScanView;
  expect(scan.projects.find((p) => p.repo === "octo/ebb")!.proposed).toBe(added.pr);
  expect(existsSync(join(path, ".github", "workflows", "release.yml"))).toBe(true);
});

test("health runs doctor's checks and starts the hub on request", async () => {
  const health = (await call("GET", "/api/hub/health?hub=octo/homebrew-tap")).data as { checks: { name: string; ok: boolean }[] };
  expect(health.checks.find((c) => c.name === "tapster.yml is valid")?.ok).toBe(true);
  expect((await call("POST", "/api/hub/run", { hub: "octo/homebrew-tap" })).data).toEqual({ started: true });
  expect(fake.get("octo/homebrew-tap")!.dispatches).toBe(1);
});

test("opening a clone never runs commands from its own git config", async () => {
  const path = join(home, "Developer", "hafifpix");
  const marker = join(home, "filter-ran");
  await run("git", ["-C", path, "config", "filter.trap.clean", `touch ${marker}; cat`]);
  await run("git", ["-C", path, "config", "core.fsmonitor", `touch ${marker}`]);
  await Bun.write(join(path, ".gitattributes"), "* filter=trap\n");
  await Bun.write(join(path, "src", "cli.ts"), "console.log('changed');\n");
  await Bun.write(join(path, ".github", "workflows", "release.yml"), "name: mine\n");
  const info = (await call("POST", "/api/projects/inspect", { hub: "octo/homebrew-tap", path })).data as unknown as InspectView;
  expect(info.dirty).toEqual([".github/workflows/release.yml"]);
  expect(info.releaseFlow).toBe("other");
  await call("POST", "/api/projects/diff", { path, files: [".github/workflows/release.yml", "src/cli.ts"] });
  await call("POST", "/api/projects/scan", { hub: "octo/homebrew-tap", extra: [] });
  expect(existsSync(marker)).toBe(false);
});

test("a new tap starts empty, gets protected and receives tapster's README as its first commit", async () => {
  expect((await call("POST", "/api/hubs", { name: "homebrew-fresh", private: false })).data).toEqual({ hub: "octo/homebrew-fresh" });
  const view = (await call("GET", "/api/hub?hub=octo/homebrew-fresh")).data as unknown as HubView;
  expect(view.empty).toBe(true);
  expect(view.files.config).toBe(false);
  expect((await call("POST", "/api/hub/protect", { hub: "octo/homebrew-fresh" })).status).toBe(200);
  const body = { hub: "octo/homebrew-fresh", every: null, remove: [], readme: false };
  const preview = (await call("POST", "/api/hub/files/preview", body)).data as unknown as FilesView;
  expect(preview.files.map((f) => f.path)).toEqual(["tapster.yml", ".tapster/state.json", "README.md", ".github/workflows/tapster.yml"]);
  expect((await call("POST", "/api/hub/files", body)).data).toEqual({ result: "committed" });
  const files = fake.get("octo/homebrew-fresh")!.files!;
  expect(files.get("README.md")).toContain("brew trust octo/fresh");
  expect(files.has(".github/workflows/tapster.yml")).toBe(true);
  fake.get("octo/homebrew-fresh")!.env!.policies.push("dev");
  const notary = new FormData();
  notary.set("hub", "octo/homebrew-fresh");
  notary.set("keyId", "ABCDE12345");
  notary.set("issuerId", "00000000-0000-4000-8000-000000000000");
  notary.set("p8", new File(["-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n"], "AuthKey.p8"));
  const refused = await call("POST", "/api/hub/notary", notary);
  expect((refused.data.error as { reason: string }).reason).toBe("octo/homebrew-fresh's tapster environment is not locked to main");
  expect(fake.get("octo/homebrew-fresh")!.env!.secrets.has("MACOS_NOTARY_KEY")).toBe(false);
  expect(((await call("GET", "/api/hub?hub=octo/homebrew-fresh")).data as unknown as HubView).protect.environment).toBe(false);
});

test("a Sparkle key goes to the hub only after the user pasted the very key the keychain holds", async () => {
  const hub = fake.get("octo/homebrew-tap")!;
  const app = `  - { name: pix, repo: octo/pix, kind: app, app: Pix.app, bundle_id: com.octo.Pix, assets: { darwin-arm64: "Pix-{version}.app.tar.gz" }, dmg: { name: "Pix-{version}.dmg" }, sparkle: { key: pix, public_key: "${sparkle.publicKey}" } }\n`;
  hub.files!.set("tapster.yml", `version: 1\ntap: octo/tap\npackages:\n${app}`);
  const ask = { hub: "octo/homebrew-tap", label: "pix", account: "ed25519" };
  expect((await call("POST", "/api/hub/sparkle/read", { ...ask, label: "other" })).status).toBe(400);
  expect((await call("POST", "/api/hub/sparkle/read", { ...ask, account: "missing" })).status).toBe(400);
  const read = (await call("POST", "/api/hub/sparkle/read", ask)).data as { publicKey: string; users: string[]; key: string };
  expect(read).toEqual({ publicKey: sparkle.publicKey, users: ["pix"], key: sparkle.seed });
  const wrong = await call("POST", "/api/hub/sparkle/store", { hub: "octo/homebrew-tap", label: "pix", pasted: "Z".repeat(44) });
  expect(wrong.status).toBe(400);
  expect(hub.env!.secrets.has("SPARKLE_KEY_PIX")).toBe(false);
  expect((await call("POST", "/api/hub/sparkle/store", { hub: "octo/homebrew-tap", label: "pix", pasted: ` ${sparkle.seed}\n` })).data).toEqual({ stored: true, workflow: "committed" });
  expect(hub.env!.secrets.has("SPARKLE_KEY_PIX")).toBe(true);
  expect(hub.files!.get(".github/workflows/tapster.yml")).toContain('SPARKLE_KEY_PIX: "${{ secrets.SPARKLE_KEY_PIX }}"');
  expect((await call("POST", "/api/hub/sparkle/store", { hub: "octo/homebrew-tap", label: "pix", pasted: sparkle.seed })).status).toBe(400);
});
