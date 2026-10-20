import { createHash, generateKeyPairSync } from "node:crypto";

type Ruleset = { id: number; name: string; target: string; enforcement: string; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: { type: string }[]; bypass_actors?: unknown[] };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; assets: { id: number; name: string }[]; body: string };

export type FakeRepo = {
  id: number;
  name: string;
  private: boolean;
  description: string | null;
  files: Map<string, string> | null;
  head: string;
  rulesets: Ruleset[];
  env: { policies: string[]; custom: boolean; vars: Map<string, string>; secrets: Set<string> } | null;
  actions: { allowed_actions: string; sha_pinning_required: boolean; selected: { github_owned_allowed: boolean; verified_allowed: boolean; patterns_allowed: string[] } | null };
  workflowPerm: string;
  releases: Release[];
  pulls: { number: number; head: string; html_url: string; title: string }[];
  issues: { number: number; title: string; body: string; html_url: string; updated_at: string; user: { login: string } }[];
  keys: { title: string; read_only: boolean }[];
  repoVars: Map<string, string>;
  actionSecrets: string[];
  runs: { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string }[];
  dispatches: number;
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  installation: { id: number; repos: string[] } | null = null;
  calls: string[] = [];
  private nextId = 100;

  constructor(readonly login = "octo") {}

  repo(name: string, o: Partial<FakeRepo> = {}): FakeRepo {
    const full = `${this.login}/${name}`;
    const r: FakeRepo = {
      id: this.nextId++,
      name,
      private: false,
      description: null,
      files: new Map(),
      head: sha(full),
      rulesets: [],
      env: null,
      actions: { allowed_actions: "all", sha_pinning_required: false, selected: null },
      workflowPerm: "write",
      releases: [],
      pulls: [],
      issues: [],
      keys: [],
      repoVars: new Map(),
      actionSecrets: [],
      runs: [],
      dispatches: 0,
      ...o,
    };
    this.repos.set(full.toLowerCase(), r);
    return r;
  }

  get(full: string): FakeRepo | undefined {
    return this.repos.get(full.toLowerCase());
  }

  ghWrite = async (args: string[], stdin?: string): Promise<void> => {
    const repo = this.get(args[args.indexOf("--repo") + 1]!);
    if (!repo) throw new Error("no such repository");
    const name = args[2]!;
    if (args[0] === "secret" && args[1] === "set") {
      if (args.includes("--env")) (repo.env ??= this.newEnv()).secrets.add(name);
      else repo.actionSecrets.push(name);
      void stdin;
    } else if (args[0] === "secret" && args[1] === "delete") repo.env?.secrets.delete(name);
    else if (args[0] === "variable" && args.includes("--env")) (repo.env ??= this.newEnv()).vars.set(name, args[args.indexOf("--body") + 1]!);
    else if (args[0] === "variable") repo.repoVars.set(name, args[args.indexOf("--body") + 1]!);
  };

  private newEnv() {
    return { policies: [] as string[], custom: false, vars: new Map<string, string>(), secrets: new Set<string>() };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push(`${method} ${url.pathname}`);
    return this.route(method, url, body);
  };

  private route(method: string, url: URL, body: Record<string, unknown>): Response {
    const p = url.pathname;
    const q = url.searchParams;
    if (p === "/user") return json({ login: this.login, type: "User" }, 200, { "x-oauth-scopes": "gist, read:org, repo, workflow" });
    if (p === `/users/${this.login}`) return json({ id: 42, login: this.login });
    if (p === "/user/repos" && method === "GET") return json([...this.repos.entries()].map(([full, r]) => ({ full_name: `${this.login}/${r.name}`, name: r.name, private: r.private, html_url: `https://github.com/${full}`, owner: { login: this.login } })));
    if (p === "/user/repos" && method === "POST") {
      if (this.get(`${this.login}/${body.name}`)) return json({ message: "exists" }, 422);
      const r = this.repo(String(body.name), { private: Boolean(body.private) });
      if (body.auto_init) r.files!.set("README.md", `# ${body.name}\n`);
      else r.files = null;
      return json({ full_name: `${this.login}/${r.name}` }, 201);
    }
    const manifest = /^\/app-manifests\/([^/]+)\/conversions$/.exec(p);
    if (manifest && method === "POST") return json({ id: 777, slug: `tapster-${this.login}-tap`, pem: this.pem, owner: { login: this.login } }, 201);
    if (p === `/users/${this.login}/installation`) return this.installation ? json({ id: this.installation.id }) : json({}, 404);
    const instToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (instToken) return json({ token: "ghs_fake" }, 201);
    if (p === "/installation/repositories") return json({ repositories: (this.installation?.repos ?? []).map((full_name) => ({ full_name })) });
    if (p === "/installation/token") return json({}, 204);
    if (p.startsWith("/repos/doguyilmaz/tapster/compare/")) return json({ status: "identical" });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ message: "not found" }, 404);
    const full = m[1]!;
    const rest = m[2] ?? "";
    const repo = this.get(full);
    if (!repo) return json({ message: "not found" }, 404);
    return this.repoRoute(repo, full, method, rest, q, body);
  }

  private repoRoute(r: FakeRepo, full: string, method: string, rest: string, q: URLSearchParams, body: Record<string, unknown>): Response {
    if (rest === "") return json({ id: r.id, private: r.private, description: r.description, html_url: `https://github.com/${full}`, default_branch: "main" });
    if (rest === "/installation") return this.installation?.repos.some((x) => x.toLowerCase() === full.toLowerCase()) ? json({ id: this.installation.id }) : json({}, 404);
    if (rest === "/git/ref/heads/main") return r.files ? json({ object: { sha: r.head } }) : json({}, 409);
    if (rest.startsWith("/git/commits/")) return json({ tree: { sha: `tree-${r.head}` } });
    if (rest === "/git/trees" && method === "POST") {
      for (const t of body.tree as { path: string; content?: string; sha?: null }[]) {
        if (t.sha === null) r.files!.delete(t.path);
        else r.files!.set(t.path, t.content ?? "");
      }
      return json({ sha: "newtree" }, 201);
    }
    if (rest === "/git/commits" && method === "POST") return json({ sha: sha(`${r.head}${Math.random()}`) }, 201);
    if (rest === "/git/refs/heads/main" && method === "PATCH") {
      r.head = String(body.sha);
      return json({});
    }
    if (rest === "/git/refs" && method === "POST") return json({}, 201);
    if (rest === "/activity") return json([{ after: r.head }]);
    if (rest.startsWith("/compare/")) return json({ status: "identical", files: [] });
    const content = /^\/contents\/(.+)$/.exec(rest);
    if (content) {
      const path = decodeURIComponent(content[1]!);
      if (method === "PUT") {
        if (body.branch && body.branch !== "main") return json({}, 201);
        r.files ??= new Map();
        r.files.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
        r.head = sha(`${r.head}${path}`);
        return json({}, 201);
      }
      const files = r.files ?? new Map<string, string>();
      if (files.has(path)) return json({ content: Buffer.from(files.get(path)!).toString("base64"), sha: sha(files.get(path)!) });
      const dir = [...files.keys()].filter((f) => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes("/"));
      if (dir.length) return json(dir.map((f) => ({ name: f.slice(path.length + 1), type: "file" })));
      return json({ message: "not found" }, 404);
    }
    if (rest === "/environments/tapster" || rest === "/environments/release") {
      if (method === "PUT") {
        r.env ??= this.newEnv();
        r.env.custom = true;
        return json({});
      }
      return r.env ? json({ deployment_branch_policy: r.env.custom ? { custom_branch_policies: true } : null }) : json({}, 404);
    }
    if (/^\/environments\/\w+\/deployment-branch-policies/.test(rest)) {
      if (!r.env) return json({}, 404);
      if (method === "POST") r.env.policies.push(String(body.name));
      return json({ branch_policies: r.env.policies.map((name, id) => ({ id, name, type: "branch" })) });
    }
    const envList = /^\/environments\/tapster\/(variables|secrets)$/.exec(rest);
    if (envList) {
      if (!r.env) return json({}, 404);
      return json(envList[1] === "variables" ? { variables: [...r.env.vars].map(([name, value]) => ({ name, value })) } : { secrets: [...r.env.secrets].map((name) => ({ name })) });
    }
    const envVar = /^\/environments\/tapster\/variables\/(\w+)$/.exec(rest);
    if (envVar) return r.env?.vars.has(envVar[1]!) ? json({ value: r.env.vars.get(envVar[1]!) }) : json({}, 404);
    if (rest === "/actions/permissions/workflow") {
      if (method === "PUT") r.workflowPerm = String(body.default_workflow_permissions);
      return method === "PUT" ? json({}, 204) : json({ default_workflow_permissions: r.workflowPerm });
    }
    if (rest === "/actions/permissions") {
      if (method === "PUT") Object.assign(r.actions, { allowed_actions: body.allowed_actions, sha_pinning_required: body.sha_pinning_required });
      return method === "PUT" ? json({}, 204) : json({ enabled: true, allowed_actions: r.actions.allowed_actions, sha_pinning_required: r.actions.sha_pinning_required });
    }
    if (rest === "/actions/permissions/selected-actions") {
      if (method === "PUT") r.actions.selected = body as never;
      return method === "PUT" ? json({}, 204) : json(r.actions.selected ?? {});
    }
    if (rest.startsWith("/rulesets")) {
      const id = /^\/rulesets\/(\d+)$/.exec(rest)?.[1];
      if (method === "POST") {
        r.rulesets.push({ ...(body as unknown as Ruleset), id: this.nextId++ });
        return json({}, 201);
      }
      if (id && method === "PUT") {
        r.rulesets = r.rulesets.map((x) => (x.id === Number(id) ? { ...(body as unknown as Ruleset), id: x.id } : x));
        return json({});
      }
      if (id) return json(r.rulesets.find((x) => x.id === Number(id)) ?? {});
      const target = q.get("targets");
      return json(r.rulesets.filter((x) => !target || x.target === target).map((x) => ({ id: x.id, name: x.name, target: x.target, enforcement: x.enforcement })));
    }
    if (rest.startsWith("/rules/branches/")) {
      return json(r.rulesets.filter((x) => x.target === "branch" && x.enforcement === "active").flatMap((x) => (x.rules ?? []).map((rule) => ({ type: rule.type }))));
    }
    if (rest.startsWith("/releases")) return json(r.releases);
    if (rest === "/pulls" && method === "POST") {
      const pr = { number: this.nextId++, head: String(body.head), html_url: `https://github.com/${full}/pull/${this.nextId}`, title: String(body.title) };
      r.pulls.push(pr);
      return json(pr, 201);
    }
    if (rest === "/pulls") return json(r.pulls.filter((x) => !q.get("head") || q.get("head")!.endsWith(`:${x.head}`)).map((x) => ({ ...x, head: { ref: x.head } })));
    if (rest === "/issues") return json(r.issues);
    if (rest === "/keys") return json(r.keys);
    if (rest.startsWith("/collaborators")) return json([]);
    if (rest.startsWith("/actions/secrets")) return json({ secrets: r.actionSecrets.map((name) => ({ name })) });
    if (rest.startsWith("/actions/variables")) {
      const name = /^\/actions\/variables\/(\w+)$/.exec(rest)?.[1];
      if (name) return r.repoVars.has(name) ? json({ value: r.repoVars.get(name) }) : json({}, 404);
      return json({ variables: [...r.repoVars].map(([n, value]) => ({ name: n, value })) });
    }
    if (rest === "/actions/workflows/tapster.yml") return r.files?.has(".github/workflows/tapster.yml") ? json({ state: "active" }) : json({}, 404);
    if (rest.startsWith("/actions/workflows/tapster.yml/runs")) return json({ workflow_runs: r.runs });
    if (rest === "/actions/workflows/tapster.yml/dispatches") {
      r.dispatches++;
      r.runs.unshift({ id: this.nextId++, event: "workflow_dispatch", status: "queued", conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/${full}/actions` });
      return json({}, 204);
    }
    if (rest === "/pages") return json({}, 404);
    return json({ message: `fake has no ${method} ${rest}` }, 404);
  }
}
