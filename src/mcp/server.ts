import { createInterface } from "node:readline";
import { z } from "zod";
import { parseHub } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { readHubFile } from "../hubcommit";
import { parseState } from "../state";
import { noteIn } from "../draftnote";
import { TAPSTER } from "../version";
import { doctorChecks } from "../cli/doctor";
import { currentRepo } from "../cli/gh";
import { readGit } from "../clone";
import { hubFacts, tagRefs } from "../cli/hubpr";
import { readConfig } from "../web/api/config";
import { checkHub, hubChoices, hubView } from "../web/api/hub";
import { headOf, withParentTag } from "../web/api/status";
import { releasableParent, skipNote } from "../web/status";
import { changeText } from "../web/steps";
import { defaultRoots, scanClones } from "../web/scan";
import { type Deps, newSession } from "../web/server";
import { realDeps } from "../web/start";
import { stops } from "../web/steps";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// Reads at a commit or of an archive by its digest, kept for the life of this server as the setup page keeps them.
const MEMO = new Map<string, unknown>();
const remembered = () => {
  if (MEMO.size > 500) MEMO.clear();
  return MEMO;
};

export const INSTRUCTIONS = `tapster turns the user's Homebrew tap into a release hub that signs, notarizes and publishes the releases of their projects.
These tools read the hub and the projects through the user's GitHub CLI sign-in and can start a hub run. They cannot set up a hub: creating the GitHub App needs the user's click and the Apple files live on their computer. For setup, tell the user to run "bunx @doguyilmaz/tapster setup", which opens a local page that walks through it. In a project, "bunx @doguyilmaz/tapster add" does the same from a terminal. Docs: https://tapster.doguyilmaz.com/
Releases start only from a version tag (or from the project's own tagging workflow); merging or pushing alone publishes nothing. GitHub runs no push workflow for a commit whose message holds [skip ci], [ci skip], [no ci], [skip actions] or [actions skip]. The same goes for a message that ends with the trailer skip-checks: true. A tag on such a commit may never start the release workflow, so never tag one. When merging several pull requests in a row, put [skip ci] in the merge commit message of all but the last, then tag the last one. Merging docs never releases, so never add push or paths triggers on main to a release workflow. To keep docs-only pull requests off a project's full CI, suggest paths-ignore for the docs folder in its own CI workflow and paths in its docs workflow; tapster does not edit those files.
A project's hub entry lives in the hub's tapster.yml because only the owner may change what the hub signs. release_status reports an update tapster can propose for it; the user proposes and merges it in tapster setup (Projects, the project's Configuration) or with bunx @doguyilmaz/tapster add.`;

type Ctx = { deps: Deps; gh(): Promise<GitHub> };
type Tool = { name: string; title: string; description: string; input: z.ZodObject<z.ZodRawShape>; readOnly: boolean; run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> };

const hubArg = { hub: z.string().optional().describe("The hub as owner/homebrew-name. Leave it out to use the hub of the current folder or the user's only hub.") };

async function resolveHub(ctx: Ctx, given: unknown): Promise<{ gh: GitHub; hub: string; login: string }> {
  const gh = await ctx.gh();
  const login = (await gh.json<{ login: string }>("GET", "/user")).login;
  if (typeof given === "string" && given) return { gh, hub: checkHub(given, login), login };
  const mine = (name: string | null) => (name && name.split("/")[0]!.toLowerCase() === login.toLowerCase() && /\/homebrew-/.test(name) ? name : null);
  const saved = mine((await readGit(ctx.deps.cwd, ["config", "--get", "tapster.hub"])).stdout.trim());
  if (saved) return { gh, hub: checkHub(saved, login), login };
  const here = mine(await currentRepo(ctx.deps.cwd).catch(() => null));
  if (here) return { gh, hub: checkHub(here, login), login };
  const hubs = await hubChoices(gh, login);
  const ours = hubs.filter((h) => h.tapster);
  const only = ours.length === 1 ? ours[0] : hubs.length === 1 ? hubs[0] : null;
  if (only) return { gh, hub: only.name, login };
  throw new TapsterError("there is no single hub to read", hubs.length ? `Pass hub as one of: ${hubs.map((h) => h.name).join(", ")}.` : "The user has no repository named homebrew-...; they can create one with bunx @doguyilmaz/tapster setup.");
}


export const TOOLS: Tool[] = [
  {
    name: "hub_status",
    title: "Hub setup status",
    description: "Where the hub's setup stands: each step with its state, the projects it publishes, entries it refuses and the open health issue.",
    input: z.object(hubArg),
    readOnly: true,
    async run(args, ctx) {
      const { gh, hub } = await resolveHub(ctx, args.hub);
      const view = await hubView(newSession(ctx.deps, 0), gh, hub);
      return {
        hub,
        steps: stops(view, null).map((s) => ({ step: s.name, state: s.state, status: s.status.join("; ") })),
        projects: view.packages,
        refused: view.invalid,
        healthIssue: view.issue ? { url: view.issue.url, updated: view.issue.updated, body: view.issue.body } : null,
        extras: view.extras,
      };
    },
  },
  {
    name: "doctor",
    title: "Check the hub",
    description: "Run tapster doctor: every setting the hub's security depends on, each with the fix when it fails.",
    input: z.object(hubArg),
    readOnly: true,
    async run(args, ctx) {
      const { gh, hub } = await resolveHub(ctx, args.hub);
      const { checks, note } = await doctorChecks(gh, hub);
      return { hub, problems: checks.filter((c) => !c.ok), passed: checks.filter((c) => c.ok).map((c) => c.name), note };
    },
  },
  {
    name: "hub_runs",
    title: "Recent hub runs",
    description: "The hub workflow's latest runs with their result and a link to each log.",
    input: z.object(hubArg),
    readOnly: true,
    async run(args, ctx) {
      const { gh, hub } = await resolveHub(ctx, args.hub);
      const runs = await gh.json<{ workflow_runs: { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string }[] }>("GET", `/repos/${hub}/actions/workflows/tapster.yml/runs?per_page=10`);
      return { hub, runs: runs.workflow_runs.map((r) => ({ started: r.created_at, by: r.event, status: r.status, result: r.conclusion, log: r.html_url })) };
    },
  },
  {
    name: "release_status",
    title: "A project's releases",
    description:
      "A project's latest releases and drafts, what the hub wrote on a draft it will not publish and what the hub has published. It also reports when the default branch's latest commit carries a skip marker such as [skip ci], which keeps a tag on it from starting the release workflow. Last, it reports an update of the project's hub entry that tapster can propose or that waits in a pull request.",
    input: z.object({ ...hubArg, repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/).describe("The project as owner/name.") }),
    readOnly: true,
    async run(args, ctx) {
      const { gh, hub, login } = await resolveHub(ctx, args.hub);
      const repo = String(args.repo);
      const all = await gh.listReleases(repo);
      const config = await readHubFile(gh, hub, "tapster.yml", "main");
      const pkg = config ? parseHub(config, login).config.packages.find((p) => p.repo.toLowerCase() === repo.toLowerCase()) : undefined;
      const state = parseState(await readHubFile(gh, hub, ".tapster/state.json", "main"));
      const branch = (await gh.getRepo(repo)).default_branch;
      const tip = await headOf(gh, repo, branch);
      const head = tip?.skip ? await withParentTag(gh, repo, tip, await tagRefs(gh, repo).catch(() => null)) : tip;
      const out: Record<string, unknown> = {
        hub,
        repo,
        inHub: pkg ? pkg.name : null,
        releases: all.slice(0, 8).map((r) => ({ tag: r.tag_name, draft: r.draft, published: r.published_at, files: r.assets.length, hubNote: noteIn(r.body) })),
        publishedByHub: pkg ? (state.packages[pkg.name] ?? []).map((e) => ({ tag: e.tag, status: e.status })) : [],
      };
      if (head?.skip) out.tipSkipsWorkflows = { branch, commit: head.sha, marker: head.skip, commitBeforeWithoutMarker: releasableParent(head)?.sha ?? null, what: skipNote(branch, head) };
      if (pkg) {
        const apple = await hubFacts(gh, hub).then((f) => f.apple, () => false);
        const c = await readConfig(gh, { hub, apple, hubText: config, name: pkg.name, repo: pkg.repo, kind: pkg.kind, ref: head?.sha ?? branch, workflowFile: pkg.workflow, releases: all, memo: remembered() }).catch((e) => (e instanceof GitHubError ? null : Promise.reject(e)));
        if (c?.pending) out.entryUpdate = { waitsIn: c.pending.pr, change: c.pending.entry ? changeText(c.entry, c.pending.entry) : null, blocked: c.pending.blocked };
        else if (c && (c.update || c.manual.length)) {
          out.entryUpdate = { change: c.update ? changeText(c.entry, c.update) : null, readFrom: c.from, byHand: c.manual, how: "The user proposes it in tapster setup (Projects, the project's Configuration) or runs bunx @doguyilmaz/tapster add in the project's clone." };
        }
      }
      return out;
    },
  },
  {
    name: "local_projects",
    title: "Projects on this computer",
    description: "Clones of the user's own repositories on this computer, the kind tapster recognizes and whether the hub publishes them.",
    input: z.object(hubArg),
    readOnly: true,
    async run(args, ctx) {
      const { gh, hub, login } = await resolveHub(ctx, args.hub);
      const config = await readHubFile(gh, hub, "tapster.yml", "main");
      const listed = new Set(config ? parseHub(config, login).config.packages.map((p) => p.repo.toLowerCase()) : []);
      const { found, truncated } = scanClones(defaultRoots(ctx.deps.home, ctx.deps.cwd).filter(Boolean));
      return {
        hub,
        projects: found.filter((f) => f.owner.toLowerCase() === login.toLowerCase()).map((f) => ({ repo: f.repo, path: f.path, kind: f.kind, notSupported: f.why, inHub: listed.has(f.repo.toLowerCase()) })),
        truncated,
        next: "To add one, the user runs bunx @doguyilmaz/tapster setup (Projects) or bunx @doguyilmaz/tapster add in its folder.",
      };
    },
  },
  {
    name: "run_hub",
    title: "Start the hub",
    description: "Start a hub run now instead of waiting for its schedule. The hub then publishes the drafts that are ready.",
    input: z.object(hubArg),
    readOnly: false,
    async run(args, ctx) {
      const { gh, hub } = await resolveHub(ctx, args.hub);
      await gh.json("POST", `/repos/${hub}/actions/workflows/tapster.yml/dispatches`, { ref: "main" });
      return { hub, started: true, runs: `https://github.com/${hub}/actions/workflows/tapster.yml` };
    },
  },
];

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const ok = (id: Message["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handle(msg: Message, ctx: Ctx): Promise<object | null> {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "invalid request: send one JSON-RPC object per line");
  if (msg.id === undefined || msg.id === null) return null;
  if (msg.method === "initialize") {
    const asked = String(msg.params?.protocolVersion ?? "");
    return ok(msg.id, {
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tapster", title: "tapster", version: TAPSTER.version },
      instructions: INSTRUCTIONS,
    });
  }
  if (msg.method === "ping") return ok(msg.id, {});
  if (msg.method === "tools/list") {
    return ok(msg.id, {
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(t.input), annotations: { readOnlyHint: t.readOnly, openWorldHint: true } })),
    });
  }
  if (msg.method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) return fail(msg.id, -32602, `unknown tool ${String(msg.params?.name)}`);
    const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
    if (!parsed.success) return ok(msg.id, { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }], isError: true });
    try {
      const result = await tool.run(parsed.data as Record<string, unknown>, ctx);
      return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
    } catch (e) {
      const text = e instanceof TapsterError ? `${e.reason}. ${e.fix}` : "tapster hit an unexpected error. Try again; if it repeats, the user can run the same check in a terminal.";
      return ok(msg.id, { content: [{ type: "text", text }], isError: true });
    }
  }
  return fail(msg.id, -32601, `unknown method ${String(msg.method)}`);
}

export async function serve(ctx: Ctx, input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      write(JSON.stringify(fail(null, -32700, "parse error")));
      continue;
    }
    const answer = await handle(msg, ctx);
    if (answer) write(JSON.stringify(answer));
  }
}

export async function mcp(args: string[]): Promise<void> {
  if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "tapster mcp takes no options.");
  const deps = { ...realDeps(null), log: (line: string) => process.stderr.write(`${line}\n`) };
  await serve({ deps, gh: () => deps.github() });
}
