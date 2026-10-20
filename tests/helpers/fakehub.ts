import { createHash, generateKeyPairSync } from "node:crypto";
import { parse } from "yaml";
import { TapsterError } from "../../src/errors";
import { REACH_TITLE, reachNote } from "../../src/reachnote";

type Ruleset = { id: number; name: string; target: string; enforcement: string; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: { type: string }[]; bypass_actors?: unknown[] };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; assets: { id: number; name: string }[]; body: string; html_url?: string };

export type FakeJob = { id: number; name: string; status: string; conclusion: string | null; completed_at: string | null; html_url: string; annotations: { annotation_level: string; title: string; message: string }[] };
export type FakeRun = { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string; head_branch?: string; head_sha?: string; jobs?: FakeJob[] };

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
  runs: FakeRun[];
  dispatches: number;
  tags: Map<string, string>;
  branches: Map<string, Map<string, string>>;
  commit: { message: string; date: string };
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  installation: { id: number; repos: string[] } | null = null;
  runDelay: number | null = null;
  appKeyWorks = true;
  failWrites = false;
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
      tags: new Map(),
      branches: new Map(),
      commit: { message: "Start", date: "2026-10-01T09:00:00Z" },
      ...o,
    };
    this.repos.set(full.toLowerCase(), r);
    return r;
  }

  get(full: string): FakeRepo | undefined {
    return this.repos.get(full.toLowerCase());
  }

  completeRun(full: string, o: { note?: boolean } = {}): FakeRun {
    const r = this.get(full)!;
    let run = r.runs.find((x) => !x.head_branch && x.status !== "completed");
    if (!run) {
      const id = this.nextId++;
      run = { id, event: "schedule", status: "queued", conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/${full}/actions/runs/${id}`, head_sha: r.head };
      r.runs.unshift(run);
    }
    const listed = ((parse(r.files?.get("tapster.yml") ?? "") as { packages?: { name: string; repo: string }[] } | null)?.packages ?? []).filter((p) => p?.name && p?.repo);
    const reached = new Set((this.installation?.repos ?? []).map((x) => x.toLowerCase()));
    const annotations = !this.installation
      ? [{ annotation_level: "failure", title: "", message: "tapster: the App is not installed on any of your repositories" }]
      : listed.filter((p) => !reached.has(p.repo.toLowerCase())).map((p) => ({ annotation_level: "failure", title: "", message: `${p.name}: the hub's App is not installed on ${p.repo}` }));
    const conclusion = annotations.length ? "failure" : "success";
    if (this.installation && o.note !== false && listed.length) {
      annotations.push({ annotation_level: "notice", title: REACH_TITLE, message: reachNote(listed.map((p) => ({ name: p.name, reached: reached.has(p.repo.toLowerCase()) }))) });
    }
    const id = this.nextId++;
    Object.assign(run, { status: "completed", conclusion, jobs: [{ id, name: "check", status: "completed", conclusion, completed_at: new Date().toISOString(), html_url: `${run.html_url}/job/${id}`, annotations }] });
    return run;
  }

  ghWrite = async (args: string[], stdin?: string): Promise<void> => {
    const repo = this.get(args[args.indexOf("--repo") + 1]!);
    if (!repo) throw new Error("no such repository");
    const name = args[2]!;
    if (this.failWrites) throw new TapsterError("gh exited with 1", "error connecting to api.github.com");
    const env = args.includes("--env");
    if (env && !repo.env) throw new TapsterError("gh exited with 1", "HTTP 404: Not Found (environment)");
    if (args[0] === "secret" && args[1] === "set") {
      if (env) repo.env!.secrets.add(name);
      else repo.actionSecrets.push(name);
      void stdin;
    } else if (args[0] === "secret" && args[1] === "delete") repo.env?.secrets.delete(name);
    else if (args[0] === "variable" && env) repo.env!.vars.set(name, args[args.indexOf("--body") + 1]!);
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
    if (p === `/users/${this.login}/installation`) return !this.appKeyWorks ? json({ message: "Bad credentials" }, 401) : this.installation ? json({ id: this.installation.id }) : json({}, 404);
    const instToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (instToken) return json({ token: "ghs_fake" }, 201);
    if (p === "/installation/repositories") return json({ repositories: (this.installation?.repos ?? []).map((full_name) => ({ full_name })) });
    if (p === "/installation/token") return json({}, 204);
    if (p.startsWith("/user/installations")) return json({ message: "You must authenticate with an access token authorized to a GitHub App in order to list installations" }, 403);
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
    const headRef = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (headRef) return r.branches.has(decodeURIComponent(headRef[1]!)) ? json({ object: { sha: sha(`${full}${headRef[1]}`) } }) : json({}, 404);
    const tagRef = /^\/git\/ref\/tags\/(.+)$/.exec(rest);
    if (tagRef) {
      const tag = decodeURIComponent(tagRef[1]!);
      return r.tags.has(tag) ? json({ ref: `refs/tags/${tag}`, object: { sha: r.tags.get(tag) } }) : json({}, 404);
    }
    const matching = /^\/git\/matching-refs\/tags\/?(.*)$/.exec(rest);
    if (matching) return json([...r.tags].filter(([t]) => t.startsWith(decodeURIComponent(matching[1]!))).map(([t, at]) => ({ ref: `refs/tags/${t}`, object: { sha: at } })));
    const commit = /^\/commits\/([^/]+)$/.exec(rest);
    if (commit) {
      const at = commit[1] === "main" ? r.head : commit[1]!;
      return json({ sha: at, html_url: `https://github.com/${full}/commit/${at}`, commit: { message: r.commit.message, committer: { date: r.commit.date } } });
    }
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
    if (rest === "/git/refs" && method === "POST") {
      const ref = String(body.ref);
      if (ref.startsWith("refs/tags/")) {
        const tag = ref.slice("refs/tags/".length);
        if (r.tags.has(tag)) return json({ message: "Reference already exists" }, 422);
        r.tags.set(tag, String(body.sha));
        r.runs.unshift({ id: this.nextId++, event: "push", status: "queued", conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/${full}/actions/runs/${this.nextId}`, head_branch: tag });
        return json({ ref, object: { sha: body.sha } }, 201);
      }
      const branch = ref.slice("refs/heads/".length);
      if (r.branches.has(branch)) return json({ message: "Reference already exists" }, 422);
      r.branches.set(branch, new Map(r.files ?? []));
      return json({ ref, object: { sha: body.sha } }, 201);
    }
    if (rest === "/activity") return json([{ after: r.head }]);
    if (rest.startsWith("/compare/")) return json({ status: "identical", files: [] });
    const content = /^\/contents\/(.+)$/.exec(rest);
    if (content) {
      const path = decodeURIComponent(content[1]!);
      if (method === "PUT") {
        if (body.branch && body.branch !== "main") {
          r.branches.get(String(body.branch))?.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
          return json({}, 201);
        }
        r.files ??= new Map();
        r.files.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
        r.head = sha(`${r.head}${path}`);
        return json({}, 201);
      }
      const ref = q.get("ref");
      const files = (ref && r.branches.get(ref)) || (r.files ?? new Map<string, string>());
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
    if (rest.startsWith("/actions/workflows/tapster.yml/runs")) return json({ workflow_runs: r.runs.filter((x) => !x.head_branch) });
    if (rest === "/actions/runs") return json({ workflow_runs: r.runs.filter((x) => x.head_branch !== undefined && (!q.get("branch") || x.head_branch === q.get("branch"))) });
    if (rest === "/actions/workflows/tapster.yml/dispatches") {
      r.dispatches++;
      const id = this.nextId++;
      r.runs.unshift({ id, event: "workflow_dispatch", status: "queued", conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/${full}/actions/runs/${id}`, head_sha: r.head });
      if (this.runDelay !== null) setTimeout(() => this.completeRun(full), this.runDelay);
      return json({}, 204);
    }
    const runJobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest);
    if (runJobs) return json({ jobs: (r.runs.find((x) => x.id === Number(runJobs[1]))?.jobs ?? []).map(({ annotations: _, ...j }) => j) });
    const notes = /^\/check-runs\/(\d+)\/annotations$/.exec(rest);
    if (notes) {
      const job = r.runs.flatMap((x) => x.jobs ?? []).find((j) => j.id === Number(notes[1]));
      return job ? json(job.annotations) : json({ message: "not found" }, 404);
    }
    if (rest === "/pages") return json({}, 404);
    return json({ message: `fake has no ${method} ${rest}` }, 404);
  }
}
