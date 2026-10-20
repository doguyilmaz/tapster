import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TITLE, checkOutputs, healthBody, healthIssue, needsReport, normalize, parseFindings, updateIssue } from "../src/action/health";
import { GitHubError } from "../src/errors";
import type { GitHub } from "../src/github";

const f = (item: string, reason = "something is wrong", fix = "Fix it.") => ({ item, reason, fix });
const outside = (body: string) => body.replace(/```text\n[\s\S]*?\n```/g, "");

test("the body lists each finding with its fix in a code block and ends with the hash of the findings", () => {
  const { body, hash } = healthBody([f("aims", "v1.0.0: a.tar.gz does not match checksums.txt", "Build the release again.")]);
  expect(body).toContain("```text\naims: v1.0.0: a.tar.gz does not match checksums.txt\nFix: Build the release again.\n```");
  expect(body).toContain("bunx @doguyilmaz/tapster setup");
  expect(body).toContain("tapster doctor");
  expect(body).toContain("https://tapster.doguyilmaz.com/reference/troubleshooting/");
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(body.endsWith(`<!-- tapster-health: ${hash} -->\n`)).toBe(true);
});

test("the hash depends on the findings, not on their order or repeats", () => {
  const a = healthBody([f("a"), f("b")]).hash;
  expect(healthBody([f("b"), f("a"), f("b")]).hash).toBe(a);
  expect(healthBody([f("a"), f("b", "something else")]).hash).not.toBe(a);
  expect(healthBody([]).hash).not.toBe(a);
});

test("text a project controls cannot leave its code block, mention people, link or add HTML", () => {
  const hostile = [
    f("evil", "```\n@octocat <img src=x onerror=alert(1)> [x](http://evil) #1\n```", "~~~ `rm -rf` @everyone"),
    f("`@octocat`", "<!-- tapster-health: " + "0".repeat(64) + " -->", "```text"),
  ];
  const { body, hash } = healthBody(hostile);
  const fences = body.split("\n").filter((l) => l.includes("```"));
  expect(fences).toEqual(["```text", "```", "```text", "```"]);
  for (const bad of ["@octocat", "@everyone", "<img", "](http://evil)", "#1", "rm -rf"]) expect(outside(body)).not.toContain(bad);
  expect(body).toContain("@octocat <img src=x onerror=alert(1)> [x](http://evil) #1");
  expect(body.match(/<!-- tapster-health: [0-9a-f]{64} -->\n$/)![0]).toBe(`<!-- tapster-health: ${hash} -->\n`);
});

test("long findings are capped and the body stays within GitHub's limit", () => {
  const long = "x".repeat(10_000);
  const [one] = normalize([f(long, long, long)]);
  expect(one!.item.length).toBe(500);
  expect(one!.item.endsWith("...")).toBe(true);
  expect(normalize([one!])).toEqual([one!]);
  const many = Array.from({ length: 80 }, (_, i) => f(`p${i}${long}`, long, long));
  expect(normalize(many)).toHaveLength(50);
  const { body } = healthBody(many);
  expect(body.length).toBeLessThan(65_536);
  expect(body).toContain("more are listed in the hub's latest tapster run");
});

test("findings reach the report as validated JSON; an empty list after a failed check says so", () => {
  expect(parseFindings(JSON.stringify([f("a")]), "success")).toEqual([f("a")]);
  expect(parseFindings("[]", "success")).toEqual([]);
  expect(parseFindings("", "failure")).toEqual([
    { item: "hub", reason: "the check job failed before it could report", fix: "Open the hub's latest tapster run in the Actions tab; its check job shows the error." },
  ]);
  expect(() => parseFindings("{", "success")).toThrow(/not valid JSON/);
  expect(() => parseFindings(JSON.stringify([{ item: "a", reason: "b" }]), "success")).toThrow(/invalid/);
  expect(() => parseFindings(JSON.stringify([{ ...f("a"), extra: 1 }]), "success")).toThrow(/invalid/);
  expect(() => parseFindings(JSON.stringify(Array.from({ length: 51 }, (_, i) => f(`p${i}`))), "success")).toThrow(/invalid/);
  expect(() => parseFindings(JSON.stringify([f("x".repeat(501))]), "success")).toThrow(/invalid/);
});

test("the report runs when the findings changed, when there is no issue for them or when the issue can close", () => {
  expect(needsReport("h1", 1, null)).toBe(true);
  expect(needsReport("h1", 0, null)).toBe(false);
  expect(needsReport("h1", 1, { number: 3, hash: "h1" })).toBe(false);
  expect(needsReport("h2", 1, { number: 3, hash: "h1" })).toBe(true);
  expect(needsReport("h1", 0, { number: 3, hash: "h1" })).toBe(true);
  expect(needsReport("h1", 1, { number: 3, hash: null })).toBe(true);
});

type Call = { method: string; path: string; body?: unknown };

function fake(issues: unknown[] | Error) {
  const calls: Call[] = [];
  const gh = {
    json: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET") {
        if (issues instanceof Error) throw issues;
        return issues;
      }
      return { number: 9 };
    },
  } as unknown as GitHub;
  return { gh, calls };
}

const LIST = "/repos/o/homebrew-tap/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100";
const bot = { login: "github-actions[bot]" };

test("only an open issue that github-actions opened with the exact title is the health issue", async () => {
  const { body, hash } = healthBody([f("a")]);
  const issues = [
    { number: 1, title: TITLE, user: { login: "mallory" }, body },
    { number: 2, title: `${TITLE} ` , user: bot, body },
    { number: 3, title: TITLE, user: bot, body, pull_request: {} },
    { number: 4, title: TITLE, user: bot, body },
  ];
  const { gh, calls } = fake(issues);
  expect(await healthIssue(gh, "o/homebrew-tap")).toEqual({ number: 4, hash });
  expect(calls).toEqual([{ method: "GET", path: LIST, body: undefined }]);
  expect(await healthIssue(fake([{ number: 5, title: TITLE, user: bot, body: "edited by hand" }]).gh, "o/homebrew-tap")).toEqual({ number: 5, hash: null });
  expect(await healthIssue(fake([]).gh, "o/homebrew-tap")).toBeNull();
});

test("the report opens the issue, edits it when the findings change and leaves it alone otherwise", async () => {
  const { body, hash } = healthBody([f("a")]);
  const opened = fake([]);
  expect(await updateIssue(opened.gh, "o/homebrew-tap", [f("a")])).toBe("opened the hub's health issue #9");
  expect(opened.calls[1]).toEqual({ method: "POST", path: "/repos/o/homebrew-tap/issues", body: { title: TITLE, body } });
  const same = fake([{ number: 4, title: TITLE, user: bot, body }]);
  expect(await updateIssue(same.gh, "o/homebrew-tap", [f("a")])).toBe("the hub's health issue #4 is up to date");
  expect(same.calls).toHaveLength(1);
  const changed = fake([{ number: 4, title: TITLE, user: bot, body }]);
  expect(await updateIssue(changed.gh, "o/homebrew-tap", [f("a"), f("b")])).toBe("updated the hub's health issue #4");
  expect(changed.calls[1]).toEqual({ method: "PATCH", path: "/repos/o/homebrew-tap/issues/4", body: { body: healthBody([f("a"), f("b")]).body } });
  expect(hash).not.toBe(healthBody([f("a"), f("b")]).hash);
});

test("with nothing wrong the report comments and closes the issue as completed", async () => {
  const { body } = healthBody([f("a")]);
  const open = fake([{ number: 4, title: TITLE, user: bot, body }]);
  expect(await updateIssue(open.gh, "o/homebrew-tap", [])).toBe("closed the hub's health issue #4");
  expect(open.calls.slice(1)).toEqual([
    { method: "POST", path: "/repos/o/homebrew-tap/issues/4/comments", body: { body: "Everything the hub checks is fine again, so tapster closed this issue." } },
    { method: "PATCH", path: "/repos/o/homebrew-tap/issues/4", body: { state: "closed", state_reason: "completed" } },
  ]);
  const none = fake([]);
  expect(await updateIssue(none.gh, "o/homebrew-tap", [])).toBe("the hub has no open health issue");
  expect(none.calls).toHaveLength(1);
});

test("a hub with issues turned off is told so; other errors fail the report", async () => {
  const off = fake(new GitHubError("GitHub GET returned 410", "x", 410));
  expect(await updateIssue(off.gh, "o/homebrew-tap", [f("a")])).toContain("Issues are turned off");
  await expect(updateIssue(fake(new GitHubError("GitHub GET returned 500", "x", 500)).gh, "o/homebrew-tap", [f("a")])).rejects.toThrow(/500/);
});

function runCheck(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const res = Bun.spawnSync(["bun", "src/action/main.ts"], {
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      INPUT_MODE: "check",
      INPUT_TEMPLATE: "2",
      GITHUB_OUTPUT: output,
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_REPOSITORY: "o/homebrew-tap",
      GITHUB_REPOSITORY_OWNER: "o",
      GITHUB_WORKSPACE: dir,
      GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/tapster.yml@refs/heads/main",
      GITHUB_EVENT_NAME: "schedule",
      ...env,
    },
  });
  const text = readFileSync(output, "utf8");
  const out = (name: string) => new RegExp(`^${name}<<(\\S+)\\n([\\s\\S]*?)\\n\\1$`, "m").exec(text)?.[2];
  return { code: res.exitCode, findings: out("findings"), report: out("report") };
}

test("check sets findings and report even when it stops before it starts", () => {
  const early = runCheck({});
  expect(early.code).toBe(1);
  expect(JSON.parse(early.findings!)).toEqual([{ item: "tapster", reason: "tapster.yml is missing in the hub", fix: "Run tapster init in a clone of the hub." }]);
  expect(early.report).toBe("true");
});

test("check outside the hub workflow sets its findings but never asks for a report", () => {
  const outsider = runCheck({ GITHUB_EVENT_NAME: "push" });
  expect(outsider.code).toBe(1);
  expect(JSON.parse(outsider.findings!)[0].reason).toContain("schedule or a manual start");
  expect(outsider.report).toBe("false");
});

async function outputs(answer: () => Response, list = [f("a")]) {
  const dir = mkdtempSync(join(tmpdir(), "outputs-"));
  const paths = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
  for (const p of Object.values(paths)) writeFileSync(p, "");
  const saved = { fetch: globalThis.fetch, output: process.env.GITHUB_OUTPUT, summary: process.env.GITHUB_STEP_SUMMARY };
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return answer();
  }) as unknown as typeof fetch;
  Object.assign(process.env, paths);
  try {
    await checkOutputs(list, { name: "o/homebrew-tap", token: "test-token-value" });
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.GITHUB_OUTPUT = saved.output;
    process.env.GITHUB_STEP_SUMMARY = saved.summary;
    if (saved.output === undefined) delete process.env.GITHUB_OUTPUT;
    if (saved.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  }
  const text = readFileSync(paths.GITHUB_OUTPUT, "utf8");
  return { asked, report: /^report<<(\S+)\n(.*)\n\1$/m.exec(text)?.[2], summary: readFileSync(paths.GITHUB_STEP_SUMMARY, "utf8") };
}

test("check asks GitHub for the issue and skips the report when it already lists these findings", async () => {
  const { body } = healthBody([f("a")]);
  const same = await outputs(() => Response.json([{ number: 4, title: TITLE, user: bot, body }]));
  expect(same.asked).toEqual([`https://api.github.com${LIST}`]);
  expect(same.report).toBe("false");
  expect((await outputs(() => Response.json([]))).report).toBe("true");
  expect((await outputs(() => new Response("{}", { status: 403 }))).report).toBe("true");
  expect((await outputs(() => new Response("{}", { status: 403 }), [])).report).toBe("false");
});

test("a hub with issues turned off gets a line in the run summary instead of a report", async () => {
  const off = await outputs(() => new Response("{}", { status: 410 }));
  expect(off.report).toBe("false");
  expect(off.summary).toContain("Issues are turned off in this hub");
});
