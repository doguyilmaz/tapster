import { randomBytes } from "node:crypto";
import { TapsterError } from "../errors";
import { runPath } from "../run";
import { donePage, failPage, startPage } from "../ui/setup";

export function openUrl(url: string): void {
  console.log(`  ${url}`);
  void runPath(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", "open", [url], { allowFail: true }).catch(() => undefined);
}

export type CreatedApp = { id: number; slug: string; pem: string };

export type AppCopy = { what: string; title: string; lead: string; key: string; done: string; next: string[]; again: string };

const PERMISSIONS: Record<string, string> = {
  "contents:write": "Contents, read and write: publish releases and their files in the repositories you install it on. Your rulesets keep it from creating or moving branches and tags.",
  "attestations:read": "Attestations, read: check that each file was built by the project's own workflow.",
  "metadata:read": "Metadata, read: every GitHub App has this. It sees the names of the repositories you install it on.",
  "actions:write": "Actions, read and write, on the hub only: start the tapster workflow and turn it back on when GitHub pauses it.",
};

export function permissionLines(manifest: object): string[] {
  const asked = (manifest as { default_permissions?: Record<string, string> }).default_permissions ?? {};
  return Object.entries(asked).map(([name, level]) => {
    const line = PERMISSIONS[`${name}:${level}`];
    if (!line) throw new TapsterError(`the App asks for ${name}: ${level}, which tapster cannot explain`, "Report this at https://github.com/doguyilmaz/tapster/issues.");
    return line;
  });
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

type Settle = (r: { code: string } | { error: TapsterError }) => void;

export function appRoutes(o: { manifest: (redirect: string) => object; copy: AppCopy; state: string; port: number; settle: Settle }): (req: Request) => Response {
  const origin = `http://127.0.0.1:${o.port}`;
  let settled = false;
  const html = (body: string, status = 200) => new Response(body, { status, headers: HEADERS });
  return (req) => {
    if (req.headers.get("host") !== `127.0.0.1:${o.port}`) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/start") {
      const manifest = o.manifest(`${origin}/callback`);
      return html(startPage({ ...o.copy, permissions: permissionLines(manifest), action: `https://github.com/settings/apps/new?state=${o.state}`, manifest: JSON.stringify(manifest) }));
    }
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    if (settled) return html(failPage({ reason: "This App was already handled.", again: o.copy.again }), 409);
    settled = true;
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== o.state || !code || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
      const error = new TapsterError("the App creation answer did not match", `Run ${o.copy.again} again.`);
      o.settle({ error });
      return html(failPage({ reason: "GitHub's answer did not belong to the App this terminal started, so tapster ignored it.", again: o.copy.again }), 400);
    }
    o.settle({ code });
    return html(donePage({ title: o.copy.done, next: o.copy.next }));
  };
}

export async function appFromManifest(manifest: (redirect: string) => object, copy: AppCopy): Promise<CreatedApp> {
  const state = randomBytes(16).toString("hex");
  let settle: Settle = () => {};
  const answer = new Promise<{ code: string } | { error: TapsterError }>((resolve) => (settle = resolve));
  let handle: (req: Request) => Response = () => new Response(null, { status: 503 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handle(req) });
  handle = appRoutes({ manifest, copy, state, port: server.port!, settle });
  console.log(`Opening GitHub to create ${copy.what}. Read the page, then click "Continue to GitHub" and "Create GitHub App".`);
  openUrl(`http://127.0.0.1:${server.port}/start`);
  const result = await answer;
  setTimeout(() => server.stop(), 1000);
  if ("error" in result) throw result.error;
  const app = await fetch(`https://api.github.com/app-manifests/${result.code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
  if (!app.ok) throw new TapsterError(`GitHub did not convert the App (status ${app.status})`, `Run ${copy.again} again within an hour of creating the App.`);
  return (await app.json()) as CreatedApp;
}
