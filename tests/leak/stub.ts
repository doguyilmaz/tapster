import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { writeTarGz } from "../../src/archive";

type Asset = { id: number; name: string; size: number; state: string; digest: string; browser_download_url: string; data: Buffer };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; assets: Asset[] };

const [certPath, keyPath, portArg] = process.argv.slice(2);
const REPO = "doguyilmaz/tapster-fixture";
const TOKEN = "ghs_CANARYq7Zx81mPkW3vT9yLr2dNf5bHj4";
let mode = "ok";
let nextId = 1000;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function asset(name: string, data: Buffer): Asset {
  const id = nextId++;
  return { id, name, size: data.length, state: "uploaded", digest: `sha256:${sha(data)}`, browser_download_url: `https://github.com/${REPO}/releases/download/v0.0.9/${name}`, data };
}

const archive = writeTarGz([{ name: "fixture", type: "file", mode: 0o755, data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]) }], 1_700_000_000);
const archiveName = "fixture_0.0.9_linux_amd64.tar.gz";
const release: Release = {
  id: 900,
  tag_name: "v0.0.9",
  draft: true,
  prerelease: false,
  created_at: "2026-10-19T00:00:00Z",
  published_at: null,
  assets: [asset(archiveName, archive), asset("checksums.txt", Buffer.from(`${sha(archive)}  ${archiveName}\n`))],
};
const hubFiles = new Map<string, string>();
let hubHead = "c0ffee0000000000000000000000000000000001";

const CI = { login: "github-actions[bot]", type: "Bot" };
const view = (r: Release) => ({
  ...r,
  author: CI,
  upload_url: `https://uploads.github.com/repos/${REPO}/releases/${r.id}/assets{?name,label}`,
  assets: r.assets.map(({ data: _, ...a }) => ({ ...a, uploader: CI })),
});
const ADMIN = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
const rulesets = [
  { id: 1, name: "tapster tags", target: "tag", enforcement: "active", bypass_actors: ADMIN, current_user_can_bypass: "never",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }] },
  { id: 2, name: "tapster branches", target: "branch", enforcement: "active", bypass_actors: ADMIN, current_user_can_bypass: "never",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }] },
];

function send(res: ServerResponse, status: number, body?: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const server = createServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, async (req, res) => {
  const url = new URL(req.url ?? "/", `https://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path.startsWith("/__mode/")) return send(res, 200, { mode: (mode = path.slice(8)) });
  if (mode === "drop") return req.socket.destroy();
  if (mode === "500") return send(res, 500, { message: "stub outage" });
  if (mode === "404") return send(res, 404, { message: "stub not found" });
  if (mode === "422" && method !== "GET") return send(res, 422, { message: "stub rejected" });
  const data = await body(req);
  const repo = `/repos/${REPO}`;
  if (path === `${repo}/installation`) return send(res, 200, { id: 1 });
  if (path === "/users/doguyilmaz/installation") return send(res, 200, { id: 1 });
  if (path === "/installation/repositories") return send(res, 200, { repositories: [{ full_name: REPO }] });
  if (path === `${repo}/rulesets`) return send(res, 200, rulesets.filter((r) => r.target === url.searchParams.get("targets")));
  const ruleset = new RegExp(`^${repo}/rulesets/(\\d+)$`).exec(path);
  if (ruleset) return send(res, 200, rulesets.find((r) => r.id === Number(ruleset[1])));
  if (path === `${repo}/rules/branches/main`) return send(res, 200, rulesets[1]!.rules);
  if (path === `${repo}/git/ref/tags/${release.tag_name}`) return send(res, 200, { object: { sha: "f1x7" } });
  if (path === "/repos/doguyilmaz/tapster/activity") return send(res, 200, [{ before: "0".repeat(40), after: "c0ffee", actor: { login: "doguyilmaz", type: "User" } }]);
  if (path.startsWith("/repos/doguyilmaz/tapster/compare/c0ffee...")) return send(res, 200, { status: "identical", files: [] });
  if (path.endsWith("/installation") && path.startsWith("/repos/")) return send(res, 404, { message: "Not Found" });
  if (path === "/app/installations/1/access_tokens" && method === "POST") return send(res, 201, { token: TOKEN });
  if (path === "/installation/token" && method === "DELETE") return send(res, 204);
  if (path === repo) return send(res, 200, { id: 1, private: true, description: "Leak test fixture", html_url: `https://github.com/${REPO}`, default_branch: "main" });
  if (path === `${repo}/releases`) return send(res, 200, url.searchParams.get("page") === "1" ? [view(release)] : []);
  if (path === `${repo}/releases/${release.id}` && method === "GET") return send(res, 200, view(release));
  if (path === `${repo}/releases/${release.id}` && method === "PATCH") {
    const patch = JSON.parse(data.toString() || "{}") as { draft?: boolean };
    if (patch.draft === false) {
      release.draft = false;
      release.published_at = new Date().toISOString();
    }
    return send(res, 200, view(release));
  }
  if (req.headers.host?.startsWith("uploads.github.com") && path === `${repo}/releases/${release.id}/assets` && method === "POST") {
    const a = asset(url.searchParams.get("name") ?? "unnamed", data);
    release.assets.push(a);
    return send(res, 201, view({ ...release, assets: [a] }).assets[0]);
  }
  const assetMatch = new RegExp(`^${repo}/releases/assets/(\\d+)$`).exec(path);
  if (assetMatch) {
    const a = release.assets.find((x) => x.id === Number(assetMatch[1]));
    if (!a) return send(res, 404, { message: "Not Found" });
    if (method === "GET") return send(res, 200, a.data, "application/octet-stream");
    if (method === "DELETE") {
      release.assets = release.assets.filter((x) => x !== a);
      return send(res, 204);
    }
    if (method === "PATCH") {
      a.name = (JSON.parse(data.toString()) as { name: string }).name;
      return send(res, 200, view({ ...release, assets: [a] }).assets[0]);
    }
  }
  if (path.startsWith(`${repo}/attestations/`)) return send(res, 404, { message: "Not Found" });
  const hub = /^\/repos\/[^/]+\/[^/]+\/(git\/ref\/heads\/main|git\/refs\/heads\/main|git\/commits\/[0-9a-f]+|git\/commits|git\/trees|contents\/(.+))$/.exec(path);
  if (hub) {
    if (hub[1] === "git/ref/heads/main") return send(res, 200, { object: { sha: hubHead } });
    if (hub[1]!.startsWith("git/commits/")) return send(res, 200, { tree: { sha: "7ree" } });
    if (hub[1] === "git/trees") {
      for (const t of (JSON.parse(data.toString()) as { tree: { path: string; content?: string }[] }).tree) if (t.content !== undefined) hubFiles.set(t.path, t.content);
      return send(res, 201, { sha: "7ree2" });
    }
    if (hub[1] === "git/commits") return send(res, 201, { sha: (hubHead = sha(Buffer.from(hubHead)).slice(0, 40)) });
    if (hub[1] === "git/refs/heads/main") return send(res, 200, { object: { sha: hubHead } });
    const file = hubFiles.get(decodeURIComponent(hub[2] ?? ""));
    return file === undefined ? send(res, 404, { message: "Not Found" }) : send(res, 200, { content: Buffer.from(file).toString("base64") });
  }
  return send(res, 404, { message: `stub has no ${method} ${path}` });
});

server.listen(Number(portArg ?? 443), "127.0.0.1");
