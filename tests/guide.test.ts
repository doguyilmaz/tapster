import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideText } from "../src/action/guide";

const repository = { full_name: "you/homebrew-tap", name: "homebrew-tap", private: false, owner: { type: "User" }, html_url: "https://github.com/you/homebrew-tap" };
const env = { GITHUB_REPOSITORY: "you/homebrew-tap", GITHUB_WORKFLOW_REF: "you/homebrew-tap/.github/workflows/tapster.yml@refs/heads/main" };

test("the guide says what it sees of a public tap of a personal account and gives both ways to set it up", () => {
  const { summary, notice } = guideText({ repository }, env);
  expect(summary).toContain("`you/homebrew-tap` is a tap");
  expect(summary).toContain("It is public");
  expect(summary).toContain("personal account");
  expect(summary).toContain("`.github/workflows/tapster.yml` on `main`");
  expect(summary).toContain("`bunx @doguyilmaz/tapster setup`");
  expect(summary).toContain("`bunx @doguyilmaz/tapster init` in a clone of the tap");
  expect(summary).toContain("needs your click on GitHub");
  expect(summary).toContain("files on your computer");
  expect(summary).toContain("admin rights");
  expect(summary).toContain("replaces this workflow with the hub workflow");
  expect(summary).toContain("your own GitHub account");
  expect(summary).toContain("https://tapster.doguyilmaz.com/tutorial/before/");
  expect(notice).toContain("bunx @doguyilmaz/tapster setup");
  expect(notice).not.toContain("\n");
});

test("the guide names what stands in the way: not a tap, a private repository, an organization", () => {
  const { summary } = guideText(
    { repository: { ...repository, full_name: "acme/tools", name: "tools", private: true, owner: { type: "Organization" } } },
    { GITHUB_REPOSITORY: "acme/tools", GITHUB_WORKFLOW_REF: "acme/tools/.github/workflows/main.yml@refs/heads/dev" },
  );
  expect(summary).toContain("`acme/tools` is not a tap");
  expect(summary).toContain("GitHub Pro");
  expect(summary).toContain("organization");
  expect(summary).toContain("`.github/workflows/main.yml` on `dev`");
  expect(summary).toContain("delete `.github/workflows/main.yml`");
});

test("without an event payload the guide still knows the repository and the workflow", () => {
  const { summary } = guideText(null, env);
  expect(summary).toContain("`you/homebrew-tap` is a tap");
  expect(summary).not.toContain("It is public");
  expect(summary).toContain("bunx @doguyilmaz/tapster setup");
});

test("names from the event cannot break out of their code spans", () => {
  const { summary } = guideText({ repository: { ...repository, full_name: "you/homebrew-`x`\n<img>" } }, { ...env, GITHUB_REPOSITORY: "" });
  expect(summary).toContain("`you/homebrew-x<img>`");
});

test("the guide follows the writing rules", () => {
  for (const event of [{ repository }, { repository: { ...repository, private: true, owner: { type: "Organization" }, name: "x" } }, null]) {
    const { summary, notice } = guideText(event, env);
    for (const text of [summary, notice]) {
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/, (and|or) /);
    }
  }
});

test("the guide reads no secret and makes no request", () => {
  const source = readFileSync("src/action/guide.ts", "utf8");
  expect(source).not.toMatch(/GITHUB_TOKEN|readSecret|fetch|github"|token"/);
});

test("the action without a mode runs the guide in any workflow, before the hub guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-"));
  const event = join(dir, "event.json");
  const summary = join(dir, "summary.md");
  writeFileSync(event, JSON.stringify({ repository }));
  writeFileSync(summary, "");
  const res = Bun.spawnSync(["bun", "src/action/main.ts"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: "you/homebrew-tap", GITHUB_WORKFLOW_REF: "you/homebrew-tap/.github/workflows/main.yml@refs/heads/main", GITHUB_EVENT_NAME: "push" },
  });
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain("::notice");
  expect(readFileSync(summary, "utf8")).toContain("bunx @doguyilmaz/tapster setup");
});
