import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GitHub } from "../src/github";
import { handle, serve, TOOLS } from "../src/mcp/server";
import type { Deps } from "../src/web/server";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";

const fake = new FakeHub("octo");
let home = "";
let ctx: { deps: Deps; gh: () => Promise<GitHub> };

beforeAll(async () => {
  fake.repo("homebrew-tap", { files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages:\n  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: \"ebb_{version}_linux_amd64.tar.gz\" } }\n"], [".tapster/state.json", '{"version":1,"packages":{"ebb":[{"tag":"v1.0.0","releaseId":3,"checksums":"' + "a".repeat(64) + '","status":"published"}]}}']]) });
  fake.get("octo/homebrew-tap")!.env = { policies: [], custom: false, vars: new Map(), secrets: new Set() };
  home = await sampleHome(fake);
  fake.get("octo/ebb")!.releases = [
    { id: 4, tag_name: "v1.1.0", draft: true, prerelease: false, created_at: "2026-10-20T00:00:00Z", published_at: null, assets: [{ id: 1, name: "checksums.txt" }], body: "<!-- tapster -->\n> **tapster will not publish this draft:** checksums.txt lists a file that is not attached\n<!-- /tapster -->\n\nnotes" },
    { id: 3, tag_name: "v1.0.0", draft: false, prerelease: false, created_at: "2026-10-01T00:00:00Z", published_at: "2026-10-01T01:00:00Z", assets: [], body: "" },
  ];
  const gh = new GitHub("t", fake.fetch, async () => {}, "user");
  ctx = {
    deps: { github: async () => gh, fetch: fake.fetch as typeof fetch, home, cwd: home, pin: null, log: () => {}, open: () => {}, notary: async () => false, keychain: async () => null, gpg: async () => null, store: () => null },
    gh: async () => gh,
  };
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const call = async (name: string, args: Record<string, unknown> = {}) => (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx)) as { result: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } };

test("initialize agrees on a protocol version and says what tapster can and cannot do", async () => {
  const res = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx)) as { result: Record<string, unknown> };
  expect(res.result.protocolVersion).toBe("2025-06-18");
  expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
  expect(String(res.result.instructions)).toContain("bunx @doguyilmaz/tapster setup");
  const other = (await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, ctx)) as { result: { protocolVersion: string } };
  expect(other.result.protocolVersion).toBe("2025-11-25");
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
});

test("tools are listed with JSON schemas and only run_hub writes", async () => {
  const res = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx)) as { result: { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] } };
  expect(res.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  expect(res.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
  expect(res.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["run_hub"]);
});

test("a clone of someone else's tap in the current folder does not stop the tools", async () => {
  const dir = join(home, "Developer", "theirs");
  await Bun.$`git init -q ${dir} && git -C ${dir} remote add origin https://github.com/Homebrew/homebrew-core.git && git -C ${dir} config tapster.hub Homebrew/homebrew-core`.quiet();
  const there = { ...ctx, deps: { ...ctx.deps, cwd: dir } };
  const res = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hub_runs", arguments: {} } }, there)) as { result: { structuredContent?: { hub: string } } };
  expect(res.result.structuredContent?.hub).toBe("octo/homebrew-tap");
});

test("hub_status finds the user's only hub and reports its steps and projects", async () => {
  const res = await call("hub_status");
  expect(res.result.isError).toBeUndefined();
  const s = res.result.structuredContent as { hub: string; steps: { step: string; state: string; status: string }[]; projects: { name: string }[] };
  expect(s.hub).toBe("octo/homebrew-tap");
  expect(s.steps[0]).toEqual({ step: "Protect the hub", state: "now", status: "Not protected yet" });
  expect(s.projects.map((p) => p.name)).toEqual(["ebb"]);
});

test("release_status shows what the hub wrote on a refused draft and what it published", async () => {
  const s = (await call("release_status", { repo: "octo/ebb" })).result.structuredContent as { releases: { tag: string; draft: boolean; hubNote: string | null }[]; publishedByHub: { tag: string; status: string }[]; inHub: string };
  expect(s.inHub).toBe("ebb");
  expect(s.releases[0]).toMatchObject({ tag: "v1.1.0", draft: true, hubNote: "tapster will not publish this draft: checksums.txt lists a file that is not attached" });
  expect(s.publishedByHub).toEqual([{ tag: "v1.0.0", status: "published" }]);
});

test("local_projects, doctor and run_hub work; bad input is an error result, not a crash", async () => {
  const local = (await call("local_projects")).result.structuredContent as { projects: { repo: string; inHub: boolean }[] };
  expect(local.projects.find((p) => p.repo === "octo/ebb")?.inHub).toBe(true);
  expect(((await call("doctor")).result.structuredContent as { problems: unknown[] }).problems.length).toBeGreaterThan(0);
  expect((await call("run_hub")).result.structuredContent).toMatchObject({ started: true });
  expect(fake.get("octo/homebrew-tap")!.dispatches).toBe(1);
  expect((await call("release_status", { repo: "not a repo" })).result.isError).toBe(true);
  expect((await call("hub_status", { hub: "someone/homebrew-x" })).result.isError).toBe(true);
  const unknown = (await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } }, ctx)) as { error: { code: number } };
  expect(unknown.error.code).toBe(-32602);
});

test("the stdio loop answers one JSON line per request and survives garbage", async () => {
  const out: string[] = [];
  const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`, "not json\n", "null\n", "[1, 2]\n", `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope" })}\n`]);
  await serve(ctx, input, (l) => out.push(l));
  expect(out.map((l) => JSON.parse(l))).toEqual([
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: send one JSON-RPC object per line" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: send one JSON-RPC object per line" } },
    { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "unknown method nope" } },
  ]);
});
