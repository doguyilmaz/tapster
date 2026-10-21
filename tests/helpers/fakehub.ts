import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { parse } from "yaml";
import { TapsterError } from "../../src/errors";
import { REACH_TITLE, reachNote } from "../../src/reachnote";

type Ruleset = { id: number; name: string; target: string; enforcement: string; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: { type: string }[]; bypass_actors?: unknown[] };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; assets: { id: number; name: string; size?: number; digest?: string | null }[]; body: string; html_url?: string };

export type FakeJob = { id: number; name: string; status: string; conclusion: string | null; completed_at: string | null; html_url: string; annotations: { annotation_level: string; title: string; message: string }[] };
export type FakeRun = { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string; head_branch?: string; head_sha?: string; jobs?: FakeJob[]; listedAt?: number };

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
  pulls: { number: number; head: string; html_url: string; title: string; state?: "open" | "closed"; merged?: string; fork?: string; base?: string }[];
  issues: { number: number; title: string; body: string; html_url: string; updated_at: string; user: { login: string } }[];
  keys: { title: string; read_only: boolean }[];
  repoVars: Map<string, string>;
  actionSecrets: string[];
  runs: FakeRun[];
  dispatches: number;
  tags: Map<string, string>;
  annotated: Map<string, string>;
  branches: Map<string, Map<string, string>>;
  bases: Map<string, Map<string, string>>;
  commit: { message: string; date: string; parent?: { sha: string; message: string }; merge?: string; files?: string[] };
  history: { activity: { actor: string; after: string; type: string }[]; commits: { sha: string; files: Map<string, string>; message: string }[] } | null;
  merges: string[];
  pages: string | null;
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  installation: { id: number; repos: string[] } | null = null;
  bell: { id: number; slug: string; pem: string; installation: { id: number; repos: string[] } | null } | null = null;
  manifestApp: { id: number; slug: string; pem: string } | null = null;
  runDelay: number | null = null;
  listDelay = 0;
  appKeyWorks = true;
  failWrites = false;
  calls: string[] = [];
  readonly blobs = new Map<number, Buffer>();
  downloads = 0;
  actor: string;
  private nextId = 100;

  constructor(readonly login = "octo") {
    this.actor = login;
  }

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
      annotated: new Map(),
      branches: new Map(),
      bases: new Map(),
      commit: { message: "Start", date: "2026-10-01T09:00:00Z" },
      history: null,
      merges: ["merge", "squash", "rebase"],
      pages: null,
      ...o,
    };
    this.repos.set(full.toLowerCase(), r);
    return r;
  }

  get(full: string): FakeRepo | undefined {
    return this.repos.get(full.toLowerCase());
  }

  // Untracked repositories answer as before: /activity names the owner at every head and every compare is identical.
  track(full: string): void {
    const r = this.get(full)!;
    r.history = { activity: [{ actor: this.login, after: r.head, type: "push" }], commits: [{ sha: r.head, files: new Map(r.files ?? []), message: "Start" }] };
  }

  branchHead(full: string, branch: string): string {
    return sha(`${full}${branch}${JSON.stringify([...(this.get(full)!.branches.get(branch) ?? [])])}`);
  }

  private readonly trees = new Map<string, Map<string, string>>();
  private readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();

  private filesAt(r: FakeRepo, full: string, at: string): Map<string, string> {
    if (at === r.head) return new Map(r.files ?? []);
    const made = this.commits.get(at);
    const branch = [...r.branches.keys()].find((b) => this.branchHead(full, b) === at);
    return new Map((made && this.trees.get(made.tree)) ?? (branch !== undefined ? r.branches.get(branch) : undefined) ?? r.history?.commits.findLast((c) => c.sha === at)?.files ?? r.files ?? []);
  }

  private wrote(r: FakeRepo, type: string, message = ""): void {
    if (!r.history) return;
    r.history.commits.push({ sha: r.head, files: new Map(r.files ?? []), message });
    r.history.activity.unshift({ actor: this.actor, after: r.head, type });
  }

  // GitHub moves a ref with force: false whenever the new commit descends from the current one, over any number of commits.
  private descends(r: FakeRepo, from: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const at = queue.shift()!;
      if (at === ancestor) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      const made = this.commits.get(at);
      const pushed = r.history?.commits.findIndex((c) => c.sha === at) ?? -1;
      queue.push(...(made?.parents ?? (pushed > 0 ? [r.history!.commits[pushed - 1]!.sha] : [])));
    }
    return false;
  }

  private changedIn(r: FakeRepo, branch: string): { filename: string; status: string; previous_filename?: string }[] {
    const before = r.bases.get(branch) ?? new Map<string, string>();
    const after = r.branches.get(branch) ?? new Map<string, string>();
    const files = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort();
    const removed = files.filter((f) => !after.has(f));
    const out: { filename: string; status: string; previous_filename?: string }[] = [];
    for (const f of files.filter((x) => after.has(x))) {
      const from = before.has(f) ? undefined : removed.find((x) => before.get(x) === after.get(f));
      if (from) removed.splice(removed.indexOf(from), 1);
      out.push({ filename: f, status: from ? "renamed" : before.has(f) ? "modified" : "added", ...(from ? { previous_filename: from } : {}) });
    }
    return [...out, ...removed.map((filename) => ({ filename, status: "removed" }))];
  }

  private pullView(r: FakeRepo, full: string, p: FakeRepo["pulls"][number]) {
    return {
      number: p.number,
      html_url: p.html_url,
      title: p.title,
      state: p.state ?? "open",
      merged: Boolean(p.merged),
      head: { ref: p.head, sha: this.branchHead(full, p.head), repo: { full_name: p.fork ?? full } },
      base: { ref: p.base ?? "main", sha: r.head },
    };
  }

  private merge(r: FakeRepo, full: string, pr: FakeRepo["pulls"][number], body: Record<string, unknown>): Response {
    if ((pr.state ?? "open") !== "open") return json({ message: "Pull Request is not mergeable" }, 405);
    if (!r.merges.includes(String(body.merge_method ?? "merge"))) return json({ message: "That merge method is not allowed on this repository." }, 405);
    if (body.sha && body.sha !== this.branchHead(full, pr.head)) return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
    const base = r.bases.get(pr.head) ?? new Map<string, string>();
    const head = r.branches.get(pr.head) ?? new Map<string, string>();
    const files = this.changedIn(r, pr.head).flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
    if (files.some((f) => r.files?.get(f) !== base.get(f))) return json({ message: "Pull Request is not mergeable" }, 405);
    r.files ??= new Map();
    for (const f of files) {
      if (head.has(f)) r.files.set(f, head.get(f)!);
      else r.files.delete(f);
    }
    r.head = sha(`${r.head}merge${pr.number}`);
    this.wrote(r, "pr_merge", pr.title);
    Object.assign(pr, { state: "closed", merged: String(body.merge_method ?? "merge") });
    return json({ sha: r.head, merged: true, message: "Pull Request successfully merged" });
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
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? "";
    return this.asBell(auth, method, url.pathname) ?? this.route(method, url, body);
  };

  // The doorbell App signs with its own key; its installation is separate from the hub App's.
  private appOf(auth: string): number | null {
    const jwt = auth.replace(/^Bearer /, "").split(".");
    if (jwt.length !== 3) return null;
    let iss: number;
    try {
      iss = Number((JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()) as { iss: string }).iss);
    } catch {
      return null;
    }
    const pem = iss === this.bell?.id ? this.bell.pem : iss === 777 ? this.pem : null;
    if (!pem || !createVerify("RSA-SHA256").update(`${jwt[0]}.${jwt[1]}`).verify(pem, Buffer.from(jwt[2]!, "base64url"))) return -1;
    return iss;
  }

  private asBell(auth: string, method: string, p: string): Response | null {
    const app = this.appOf(auth);
    if (p === "/app" && app !== null) return app > 0 ? json({ id: app }) : json({ message: "A JSON web token could not be decoded" }, 401);
    const bell = this.bell;
    if (!bell) return null;
    if (auth === "Bearer ghs_bell") {
      if (p === "/installation/repositories") return json({ total_count: bell.installation?.repos.length ?? 0, repositories: (bell.installation?.repos ?? []).map((full_name) => ({ full_name })) });
      if (p === "/installation/token") return json({}, 204);
      return json({ message: "Resource not accessible by integration" }, 403);
    }
    if (app !== bell.id) return null;
    const hubInstall = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(p);
    if (hubInstall) return bell.installation?.repos.some((r) => r.toLowerCase() === hubInstall[1]!.toLowerCase()) ? json({ id: bell.installation.id }) : json({ message: "Not Found" }, 404);
    if (p === `/app/installations/${bell.installation?.id}/access_tokens` && method === "POST") return json({ token: "ghs_bell" }, 201);
    return json({ message: `fake doorbell App has no ${method} ${p}` }, 404);
  }

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
    if (manifest && method === "POST") return json({ ...(this.manifestApp ?? { id: 777, slug: `tapster-${this.login}-tap`, pem: this.pem }), owner: { login: this.login } }, 201);
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
    if (rest === "") return json({ id: r.id, private: r.private, description: r.description, html_url: `https://github.com/${full}`, default_branch: "main", allow_merge_commit: r.merges.includes("merge"), allow_squash_merge: r.merges.includes("squash"), allow_rebase_merge: r.merges.includes("rebase") });
    if (rest === "/installation") return this.installation?.repos.some((x) => x.toLowerCase() === full.toLowerCase()) ? json({ id: this.installation.id }) : json({}, 404);
    if (rest === "/git/ref/heads/main") return r.files ? json({ object: { sha: r.head } }) : json({}, 409);
    const headRef = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    const dropRef = method === "DELETE" ? /^\/git\/refs\/heads\/(.+)$/.exec(rest) : null;
    if (dropRef) {
      const branch = decodeURIComponent(dropRef[1]!);
      if (!r.branches.delete(branch)) return json({ message: "Reference does not exist" }, 422);
      r.bases.delete(branch);
      return json({}, 204);
    }
    if (headRef) return r.branches.has(decodeURIComponent(headRef[1]!)) ? json({ object: { sha: this.branchHead(full, decodeURIComponent(headRef[1]!)) } }) : json({}, 404);
    const tagRef = /^\/git\/ref\/tags\/(.+)$/.exec(rest);
    if (tagRef) {
      const tag = decodeURIComponent(tagRef[1]!);
      const at = r.tags.get(tag);
      return at ? json({ ref: `refs/tags/${tag}`, object: { sha: at, type: r.annotated.has(at) ? "tag" : "commit" } }) : json({}, 404);
    }
    const matching = /^\/git\/matching-refs\/tags\/?(.*)$/.exec(rest);
    if (matching) return json([...r.tags].filter(([t]) => t.startsWith(decodeURIComponent(matching[1]!))).map(([t, at]) => ({ ref: `refs/tags/${t}`, object: { sha: at, type: r.annotated.has(at) ? "tag" : "commit" } })));
    const tagObject = /^\/git\/tags\/([0-9a-f]+)$/.exec(rest);
    if (tagObject) return r.annotated.has(tagObject[1]!) ? json({ sha: tagObject[1], object: { sha: r.annotated.get(tagObject[1]!), type: "commit" } }) : json({}, 404);
    const commit = /^\/commits\/([^/]+)$/.exec(rest);
    if (commit) {
      const at = commit[1] === "main" ? r.head : commit[1]!;
      const parent = r.commit.parent;
      const tip = !parent || at !== parent.sha;
      const parents = tip && parent ? [parent.sha, ...(r.commit.merge ? [r.commit.merge] : [])].map((p) => ({ sha: p })) : [];
      return json({ sha: at, html_url: `https://github.com/${full}/commit/${at}`, commit: { message: tip ? r.commit.message : parent!.message, committer: { date: r.commit.date } }, parents, files: (tip ? (r.commit.files ?? []) : []).map((filename) => ({ filename })) });
    }
    if (rest === "/commits" && r.history) {
      const path = q.get("path") ?? "";
      const list = r.history.commits.filter((c, i) => c.files.get(path) !== r.history!.commits[i - 1]?.files.get(path)).reverse();
      return json(list.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
    }
    const gitCommit = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
    if (gitCommit) {
      const at = gitCommit[1]!;
      const tree = `tree${sha(`${at}${Math.random()}`)}`;
      this.trees.set(tree, this.filesAt(r, full, at));
      return json({ sha: at, tree: { sha: tree }, parents: (this.commits.get(at)?.parents ?? []).map((p) => ({ sha: p })) });
    }
    if (rest === "/git/trees" && method === "POST") {
      const files = new Map(this.trees.get(String(body.base_tree)) ?? r.files ?? []);
      for (const t of body.tree as { path: string; content?: string; sha?: null }[]) {
        if (t.sha === null) files.delete(t.path);
        else files.set(t.path, t.content ?? "");
      }
      const id = `tree${sha(`${Math.random()}`)}`;
      this.trees.set(id, files);
      return json({ sha: id }, 201);
    }
    if (rest === "/git/commits" && method === "POST") {
      const id = sha(`${r.head}${Math.random()}`);
      this.commits.set(id, { tree: String(body.tree), parents: (body.parents as string[]) ?? [], message: String(body.message ?? "") });
      return json({ sha: id }, 201);
    }
    if (rest === "/git/refs/heads/main" && method === "PATCH") {
      const made = this.commits.get(String(body.sha));
      if (made && body.force === false && !this.descends(r, String(body.sha), r.head)) return json({ message: "Update is not a fast forward" }, 422);
      if (made) r.files = new Map(this.trees.get(made.tree) ?? []);
      r.head = String(body.sha);
      this.wrote(r, "push", made?.message);
      for (const p of r.pulls) if ((p.state ?? "open") === "open" && made?.parents.includes(this.branchHead(full, p.head))) Object.assign(p, { state: "closed", merged: "merge" });
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
      r.bases.set(branch, new Map(r.files ?? []));
      return json({ ref, object: { sha: body.sha } }, 201);
    }
    if (rest === "/activity") {
      if (!r.history) return json([{ after: r.head }]);
      const who = q.get("actor")?.toLowerCase();
      const list = r.history.activity.filter((a) => !who || a.actor.toLowerCase() === who).slice(0, Number(q.get("per_page") ?? 30));
      return json(list.map((a) => ({ before: "", after: a.after, ref: "refs/heads/main", activity_type: a.type, actor: { login: a.actor, type: "User" } })));
    }
    const cmp = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
    if (cmp && r.history) {
      const at = (x: string) => r.history!.commits.findIndex((c) => c.sha === x);
      const [i, j] = [at(cmp[1]!), at(cmp[2]!)];
      if (i < 0 || j < 0) return json({ message: "Not Found" }, 404);
      if (i >= j) return json({ status: i === j ? "identical" : "behind", files: [] });
      const [a, b] = [r.history.commits[i]!.files, r.history.commits[j]!.files];
      const commits = r.history.commits.slice(i + 1, j + 1).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
      return json({ status: "ahead", commits, files: [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f) !== b.get(f)).map((filename) => ({ filename })) });
    }
    if (rest.startsWith("/compare/")) return json({ status: "identical", files: [] });
    const content = /^\/contents\/(.+)$/.exec(rest);
    if (content) {
      const path = decodeURIComponent(content[1]!);
      if (method === "PUT") {
        if (body.branch && body.branch !== "main") {
          r.branches.get(String(body.branch))?.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
          return json({ commit: { sha: this.branchHead(full, String(body.branch)) } }, 201);
        }
        r.files ??= new Map();
        r.files.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
        r.head = sha(`${r.head}${path}`);
        this.wrote(r, "push", String(body.message ?? ""));
        return json({ commit: { sha: r.head } }, 201);
      }
      const ref = q.get("ref");
      const atBranch = ref ? [...r.branches.keys()].find((b) => this.branchHead(full, b) === ref) : undefined;
      const atCommit = ref ? r.history?.commits.findLast((c) => c.sha === ref)?.files : undefined;
      const files = (ref && (r.branches.get(ref) ?? (atBranch !== undefined ? r.branches.get(atBranch) : atCommit))) || (r.files ?? new Map<string, string>());
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
    const asset = /^\/releases\/assets\/(\d+)$/.exec(rest);
    if (asset && this.blobs.has(Number(asset[1]))) {
      this.downloads++;
      return new Response(new Uint8Array(this.blobs.get(Number(asset[1]))!), { headers: { "content-type": "application/octet-stream" } });
    }
    if (rest.startsWith("/releases")) return json(r.releases);
    if (rest === "/pulls" && method === "POST") {
      const pr = { number: this.nextId++, head: String(body.head), html_url: `https://github.com/${full}/pull/${this.nextId}`, title: String(body.title) };
      r.pulls.push(pr);
      return json(pr, 201);
    }
    if (rest === "/pulls") return json(r.pulls.filter((x) => (q.get("state") !== "open" || (x.state ?? "open") === "open") && (!q.get("head") || q.get("head")!.toLowerCase() === `${(x.fork ?? full).split("/")[0]}:${x.head}`.toLowerCase())).map((x) => this.pullView(r, full, x)));
    const pull = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
    if (pull) {
      const pr = r.pulls.find((x) => x.number === Number(pull[1]));
      if (!pr) return json({ message: "Not Found" }, 404);
      if (pull[2] === "/merge" && method === "PUT") return this.merge(r, full, pr, body);
      if (!pull[2] && method === "PATCH" && body.state === "closed") pr.state = "closed";
      return json(pull[2] === "/files" ? this.changedIn(r, pr.head) : this.pullView(r, full, pr));
    }
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
    if (rest.startsWith("/actions/workflows/tapster.yml/runs")) return json({ workflow_runs: r.runs.filter((x) => !x.head_branch && (x.listedAt ?? 0) <= Date.now()).map(({ listedAt: _, ...x }) => x) });
    if (rest === "/actions/runs") return json({ workflow_runs: r.runs.filter((x) => x.head_branch !== undefined && (!q.get("branch") || x.head_branch === q.get("branch"))) });
    if (rest === "/actions/workflows/tapster.yml/dispatches") {
      r.dispatches++;
      const id = this.nextId++;
      r.runs.unshift({ id, event: "workflow_dispatch", status: "queued", conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/${full}/actions/runs/${id}`, head_sha: r.head, listedAt: Date.now() + this.listDelay });
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
    if (rest === "/pages") {
      if (method === "POST") {
        if (r.pages) return json({ message: "GitHub Pages is already enabled." }, 409);
        r.pages = String(body.build_type);
        return json({ build_type: r.pages }, 201);
      }
      if (method === "PUT") {
        r.pages = String(body.build_type);
        return json({}, 204);
      }
      return r.pages ? json({ build_type: r.pages, html_url: `https://${this.login.toLowerCase()}.github.io/${r.name}/` }) : json({}, 404);
    }
    return json({ message: `fake has no ${method} ${rest}` }, 404);
  }
}
