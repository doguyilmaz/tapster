export type FakeScript = { metadata: Record<string, unknown>; module: string; type: string; secrets: Map<string, string>; crons: string[]; workersDev: boolean | null };

const envelope = (result: unknown, status = 200, errors: { code: number; message: string }[] = []) =>
  new Response(JSON.stringify({ success: errors.length === 0, errors, messages: [], result: errors.length ? null : result }), { status, headers: { "content-type": "application/json" } });

export class FakeCloudflare {
  token = "cf_0123456789abcdefghijABCDEFGHIJ0123456789";
  status = "active";
  scope: "edit" | "read" | "none" = "edit";
  rejectWith: { status: number; code: number; message: string } | null = null;
  broken: string | null = null;
  accounts = [{ id: "0123456789abcdef0123456789abcdef", name: "Octo's Account" }];
  subdomain: string | null = "octo";
  scripts = new Map<string, FakeScript>();
  calls: string[] = [];

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    this.calls.push(`${req.method} ${path}`);
    if (req.headers.get("authorization") !== `Bearer ${this.token}`) {
      return path === "/user/tokens/verify" ? envelope(null, 401, [{ code: 1000, message: "Invalid API Token" }]) : envelope(null, 400, [{ code: 6003, message: "Invalid request headers" }]);
    }
    if (path === "/user/tokens/verify") return this.rejectWith ? envelope(null, this.rejectWith.status, [{ code: this.rejectWith.code, message: this.rejectWith.message }]) : envelope({ id: "tok", status: this.status });
    if (this.broken && path.includes("/workers/")) return envelope(null, 500, [{ code: 10013, message: this.broken }]);
    if (path === "/accounts") return envelope(this.scope === "none" ? [] : this.accounts);
    const m = /^\/accounts\/([0-9a-f]{32})\/workers\/(.+)$/.exec(path);
    if (!m || !this.accounts.some((a) => a.id === m[1])) return envelope(null, 404, [{ code: 7003, message: "Could not route to the account" }]);
    const rest = m[2]!;
    const write = req.method !== "GET";
    if (this.scope === "none" || (write && this.scope !== "edit")) return envelope(null, 403, [{ code: 10000, message: "Authentication error" }]);
    if (rest === "subdomain") return this.subdomain ? envelope({ subdomain: this.subdomain }) : envelope(null, 404, [{ code: 10007, message: "This subdomain does not exist" }]);
    const s = /^scripts\/([a-z0-9-]+)(?:\/(secrets|schedules|subdomain|settings))?$/.exec(rest);
    if (!s) return envelope(null, 404, [{ code: 10000, message: "unknown route" }]);
    const name = s[1]!;
    const script = this.scripts.get(name);
    if (!s[2] && req.method === "PUT") {
      const raw = await req.clone().text();
      const form = await req.formData();
      const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
      const main = form.get(String(metadata.main_module));
      if (!(main instanceof File)) return envelope(null, 400, [{ code: 10021, message: "No such module" }]);
      const type = new RegExp(`filename="${metadata.main_module}"\\r?\\nContent-Type: ([^\\r\\n]+)`).exec(raw)?.[1] ?? "";
      const kept = (metadata.keep_bindings as string[] | undefined)?.includes("secret_text") ? (script?.secrets ?? new Map()) : new Map<string, string>();
      this.scripts.set(name, { metadata, module: await main.text(), type, secrets: kept, crons: script?.crons ?? [], workersDev: script?.workersDev ?? null });
      return envelope({ id: name });
    }
    if (!script) return envelope(null, 404, [{ code: 10007, message: "This Worker does not exist on your account." }]);
    if (s[2] === "settings" && req.method === "GET") return envelope({ bindings: [...(script.metadata.bindings as unknown[]), ...[...script.secrets.keys()].map((name) => ({ type: "secret_text", name }))] });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | { cron: string }[] | null;
    if (s[2] === "secrets" && req.method === "PUT") {
      const b = body as { name: string; text: string; type: string };
      if (b.type !== "secret_text") return envelope(null, 400, [{ code: 10021, message: "bad type" }]);
      script.secrets.set(b.name, b.text);
      return envelope({ name: b.name, type: b.type });
    }
    if (s[2] === "schedules" && req.method === "PUT") {
      script.crons = (body as { cron: string }[]).map((x) => x.cron);
      return envelope({ schedules: script.crons.map((cron) => ({ cron })) });
    }
    if (s[2] === "subdomain" && req.method === "POST") {
      script.workersDev = Boolean((body as { enabled: boolean }).enabled);
      return envelope(null);
    }
    return envelope(null, 405, [{ code: 10000, message: "method not allowed" }]);
  };
}

export function both(github: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, cf: FakeCloudflare): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new URL(url).hostname === "api.cloudflare.com" ? cf.fetch(input, init) : github(input, init);
  }) as typeof fetch;
}
