import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { addOptions, prepare, setupAutoTag } from "../src/cli/add";
import { AUTO_FILE, autoMode, autoWorkflow, checkAutoReleaseWorkflow } from "../src/cli/auto";
import { GitHubError } from "../src/errors";
import type { GitHub } from "../src/github";

const base = mkdtempSync(join(tmpdir(), "tapster-auto-workflow-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("auto is opt-in, defaults to daily, includes the tag key and supports disabling", () => {
  expect(addOptions([])).toMatchObject({ auto: null, autoTag: false });
  expect(addOptions(["--auto"])).toMatchObject({ auto: "daily", autoTag: true });
  expect(addOptions(["--auto", "push"])).toMatchObject({ auto: "push", autoTag: true });
  expect(addOptions(["--auto", "off"])).toMatchObject({ auto: "off", autoTag: false });
  expect(addOptions(["--auto", "--auto", "off"])).toMatchObject({ auto: "off", autoTag: false });
  expect(() => addOptions(["--auto", "hourly"])).toThrow("unknown automatic release mode");
  expect(() => addOptions(["--auto", "--workflow", "tapster-auto.yml"])).toThrow("different files");
});

test("generated workflows isolate the key, run on the default branch and pin every action", () => {
  for (const mode of ["daily", "push"] as const) {
    const text = autoWorkflow(mode, "trunk");
    const flow = parse(text);
    expect(autoMode(text)).toBe(mode);
    expect(flow.permissions).toEqual({});
    expect(flow.concurrency).toEqual({ group: "tapster-auto", "cancel-in-progress": false });
    expect(flow.jobs.plan.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(flow.jobs.plan)).not.toContain("secrets.");
    expect(flow.jobs.tag.environment).toBe("release");
    expect(flow.jobs.tag.permissions).toEqual({ contents: "read" });
    expect(flow.jobs.plan.if).toContain("github.event.repository.default_branch");
    expect(flow.jobs.tag.if).toContain("github.event.repository.default_branch");
    expect(Object.keys(flow.on).sort()).toEqual([mode === "daily" ? "schedule" : "push", "workflow_dispatch"].sort());
    if (mode === "push") expect(flow.on.push.branches).toEqual(["trunk"]);
    for (const job of Object.values(flow.jobs) as { steps: { uses?: string; run?: string }[] }[]) {
      for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      const code = job.steps.find((s) => s.run)!.run!;
      expect(code).not.toContain("bun install");
      expect(code).not.toContain("npm install");
      expect(code).toContain("node --input-type=module");
      expect(code.trimEnd().endsWith("\nTAPSTER_AUTO")).toBe(true);
    }
  }
});

test("disabled automation has no key, schedule, push trigger or runnable job", () => {
  const text = autoWorkflow("off", "main");
  expect(autoMode(text)).toBe("off");
  expect(parse(text).on).toEqual({ workflow_dispatch: null });
  expect(parse(text).jobs.disabled.if).toBe(false);
  expect(text).not.toContain("secrets.");
  expect(autoMode("name: custom\non: push\n")).toBeNull();
  expect(() => autoWorkflow("push", "${{secrets.BAD}}" )).toThrow("invalid");
});

test("automatic tags require a build workflow with explicit version tag triggers", () => {
  for (const tags of ['["v*"]', '["v[0-9]+.[0-9]+.[0-9]+"]']) checkAutoReleaseWorkflow(`on:\n  push:\n    tags: ${tags}\n`);
  for (const flow of ["on: push\n", "on: workflow_dispatch\n", 'on: { push: { branches: [main], tags: ["v*"] } }\n', 'on: { push: { paths: [src/**], tags: ["v*"] } }\n']) {
    expect(() => checkAutoReleaseWorkflow(flow)).toThrow();
  }
});

async function project(name: string) {
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"tool","bin":"./src/main.ts"}');
  writeFileSync(join(dir, "bun.lock"), "{}");
  return dir;
}

test("auto setup writes both workflows, a rerun preserves it and off disables it", async () => {
  const dir = await project("rerun");
  const made = await prepare(dir, "o/tool", "tool", addOptions(["--auto"]), true, undefined, "trunk");
  expect(made.files).toContain(AUTO_FILE);
  expect(autoMode(readFileSync(join(dir, AUTO_FILE), "utf8"))).toBe("daily");
  const before = readFileSync(join(dir, AUTO_FILE), "utf8");
  await prepare(dir, "o/tool", "tool", addOptions([]));
  expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe(before);
  await prepare(dir, "o/tool", "tool", addOptions(["--auto", "off"]), true, undefined, "trunk");
  expect(autoMode(readFileSync(join(dir, AUTO_FILE), "utf8"))).toBe("off");
});

test("unsafe existing auto workflows and missing branch information fail before any file is written", async () => {
  const dir = await project("custom");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, AUTO_FILE), "mine\n");
  await expect(prepare(dir, "o/tool", "tool", addOptions(["--auto"]), true, undefined, "main")).rejects.toThrow("not tapster's");
  expect(existsSync(join(dir, ".github/workflows/release.yml"))).toBe(false);
  await expect(prepare(dir, "o/tool", "tool", addOptions(["--auto"]))).rejects.toThrow("default branch");
  expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe("mine\n");
});

function existingKey(policy: unknown, policies: { name: string; type?: string }[], secrets = ["TAPSTER_TAG_KEY"]) {
  const calls: { method: string; path: string }[] = [];
  const gh = { json: async (method: string, path: string) => {
    calls.push({ method, path });
    if (path.endsWith("/keys")) return [{ title: "tapster tags", read_only: false }];
    if (path.endsWith("/environments/release")) return { deployment_branch_policy: policy };
    if (path.includes("/deployment-branch-policies")) return { branch_policies: policies };
    if (path.includes("/secrets")) return { secrets: secrets.map((name) => ({ name })) };
    throw new Error("Unexpected API call");
  } } as unknown as GitHub;
  return { gh, calls };
}
const restricted = { protected_branches: false, custom_branch_policies: true };

test("an existing key is reused only after environment restrictions and the secret are verified", async () => {
  const { gh, calls } = existingKey(restricted, [{ name: "main", type: "branch" }]);
  expect(await setupAutoTag(gh, "o/tool", "main")).toContain("only the default branch");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  for (const policies of [[{ name: "*" }], [{ name: "main", type: "tag" }], [{ name: "main" }, { name: "feature" }]]) {
    await expect(setupAutoTag(existingKey(restricted, policies).gh, "o/tool", "main")).rejects.toThrow("other branches or tags");
  }
  await expect(setupAutoTag(existingKey(null, []).gh, "o/tool", "main")).rejects.toThrow("does not restrict");
  await expect(setupAutoTag(existingKey(restricted, [{ name: "main" }], []).gh, "o/tool", "main")).rejects.toThrow("no TAPSTER_TAG_KEY");
});

test("environment API failures never fall back to an unrestricted repository secret", async () => {
  const calls: string[] = [];
  const gh = { json: async (_method: string, path: string) => {
    calls.push(path);
    if (path.endsWith("/keys")) return [];
    throw new GitHubError("Forbidden", "Check access.", 403);
  } } as unknown as GitHub;
  await expect(setupAutoTag(gh, "o/tool", "main")).rejects.toThrow();
  expect(calls.some((p) => p.includes("/actions/secrets"))).toBe(false);
});
