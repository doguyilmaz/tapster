import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { TapsterError } from "../errors";
import { runPath } from "../run";

export function openUrl(url: string): void {
  console.log(`  ${url}`);
  void runPath(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", "open", [url], { allowFail: true }).catch(() => undefined);
}

export type CreatedApp = { id: number; slug: string; pem: string };

export async function appFromManifest(manifest: (redirect: string) => object, what: string): Promise<CreatedApp> {
  const state = randomBytes(16).toString("hex");
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/start") {
        const body = JSON.stringify(manifest(`http://127.0.0.1:${(server.address() as { port: number }).port}/callback`)).replaceAll('"', "&quot;");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${body}"></form><script>document.getElementById("f").submit()</script>`);
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
      console.log(`Opening GitHub to create ${what}. Click "Create GitHub App".`);
      openUrl(`http://127.0.0.1:${p}/start`);
    });
  });
  const app = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
  if (!app.ok) throw new TapsterError(`GitHub did not convert the App (status ${app.status})`, "Run tapster init again within an hour of creating the App.");
  return (await app.json()) as CreatedApp;
}
