import { TapsterError } from "../errors";
import { register, scrub } from "../mask";
import * as jwtText from "../doorbell/jwt.ts" with { type: "text" };
import * as workerText from "../doorbell/worker.ts" with { type: "text" };

const API = "https://api.cloudflare.com/client/v4";
export const SCRIPT = "tapster-doorbell";
export const COMPATIBILITY_DATE = "2026-10-01";
export const TOKEN_PERMISSIONS = [{ key: "workers_scripts", type: "edit" }];
export const TOKEN_PAGE = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}&name=tapster-doorbell&accountId=*&zoneId=all`;

const NEW_TOKEN = "Create a new token from Cloudflare's token page that tapster opens. It asks for Workers Scripts: Edit; keep your account under Account Resources.";

export class CloudflareError extends TapsterError {
  constructor(reason: string, fix: string, readonly status: number, readonly codes: number[]) {
    super(reason, fix);
    this.name = "CloudflareError";
  }
}

type Envelope<T> = { success?: boolean; errors?: { code?: unknown; message?: unknown }[]; result?: T };

export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    register(token);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const form = body instanceof FormData;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, "user-agent": "tapster" };
    if (body !== undefined && !form) headers["content-type"] = "application/json";
    const where = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, { method, headers, body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new CloudflareError(`Cloudflare did not answer ${where}`, "Check your connection and try again.", 0, []);
    }
    const data = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (res.ok && data.success !== false) return data.result as T;
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const codes = errors.map((e) => Number(e.code)).filter(Number.isFinite);
    if (codes.includes(10000) || res.status === 403) throw new CloudflareError("the Cloudflare token lacks the Workers Scripts edit permission", NEW_TOKEN, res.status, codes);
    const said = scrub(errors.map((e) => String(e.message ?? "")).filter(Boolean).join("; "))
      .replace(/[^\x20-\x7e]/g, "")
      .slice(0, 200);
    throw new CloudflareError(`Cloudflare refused ${where} (${res.status}${said ? `: ${said}` : ""})`, "Try again. If it repeats, the Cloudflare status page may say more.", res.status, codes);
  }
}

export type CloudflareTarget = { account: { id: string; name: string }; subdomain: string };

export async function checkCloudflare(cf: Cloudflare): Promise<CloudflareTarget> {
  let verified: { status?: string };
  try {
    verified = await cf.call<{ status?: string }>("GET", "/user/tokens/verify");
  } catch (e) {
    if (e instanceof CloudflareError && e.status >= 400 && e.status < 500) throw new TapsterError("Cloudflare did not accept that token", `Copy the token again. Cloudflare shows it once, so create a new one if it is gone. ${NEW_TOKEN}`);
    throw e;
  }
  if (verified?.status !== "active") throw new TapsterError(`that Cloudflare token is ${verified?.status ?? "not active"}`, NEW_TOKEN);
  const accounts = (await cf.call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50")) ?? [];
  if (accounts.length === 0) throw new TapsterError("Cloudflare shows the token no account", NEW_TOKEN);
  if (accounts.length > 1) throw new TapsterError(`the token reaches ${accounts.length} Cloudflare accounts`, "Create it again with only the account the doorbell should use under Account Resources.");
  const account = accounts[0]!;
  if (!/^[0-9a-f]{32}$/.test(account.id)) throw new TapsterError("Cloudflare named an account tapster cannot read", "Try again. If it repeats, report it at https://github.com/doguyilmaz/tapster/issues.");
  let subdomain = "";
  try {
    subdomain = (await cf.call<{ subdomain?: string }>("GET", `/accounts/${account.id}/workers/subdomain`))?.subdomain ?? "";
  } catch (e) {
    if (!(e instanceof CloudflareError) || !e.codes.includes(10007)) throw e;
  }
  if (!/^[a-z0-9-]{1,63}$/.test(subdomain)) {
    throw new TapsterError(`the Cloudflare account ${account.name} has no workers.dev subdomain yet`, `Pick one at https://dash.cloudflare.com/${account.id}/workers/onboarding, then try again.`);
  }
  return { account: { id: account.id, name: account.name }, subdomain };
}

const text = (m: unknown) => (m as { default: string }).default;

export async function bundleWorker(): Promise<string> {
  const out = await Bun.build({
    entrypoints: ["/tapster-doorbell/worker.ts"],
    files: { "/tapster-doorbell/worker.ts": text(workerText), "/tapster-doorbell/jwt.ts": text(jwtText) },
    target: "browser",
    format: "esm",
  });
  if (!out.success || !out.outputs[0]) throw new TapsterError("the doorbell Worker did not build", "Report this at https://github.com/doguyilmaz/tapster/issues.");
  return out.outputs[0].text();
}

export async function deployWorker(cf: Cloudflare, target: CloudflareTarget, vars: Record<string, string>, key: string, cron: string): Promise<string> {
  const base = `/accounts/${target.account.id}/workers/scripts/${SCRIPT}`;
  const form = new FormData();
  const bindings = Object.entries(vars).map(([name, value]) => ({ type: "plain_text", name, text: value }));
  form.set("metadata", JSON.stringify({ main_module: "worker.js", compatibility_date: COMPATIBILITY_DATE, bindings, keep_bindings: ["secret_text"] }));
  form.set("worker.js", new File([await bundleWorker()], "worker.js", { type: "application/javascript+module" }));
  await cf.call("PUT", base, form);
  await cf.call("PUT", `${base}/secrets`, { name: "APP_KEY", text: key, type: "secret_text" });
  await cf.call("PUT", `${base}/schedules`, [{ cron }]);
  await cf.call("POST", `${base}/subdomain`, { enabled: true, previews_enabled: false });
  return `https://${SCRIPT}.${target.subdomain}.workers.dev`;
}
