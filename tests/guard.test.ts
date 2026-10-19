import { expect, test } from "bun:test";
import { TEMPLATE, guardRun } from "../src/action/guard";

const hub = {
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: "o/homebrew-tap",
  GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/tapster.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "schedule",
};

test("the hub workflow on main runs on schedule and on dispatch", () => {
  expect(() => guardRun(hub, TEMPLATE)).not.toThrow();
  expect(() => guardRun({ ...hub, GITHUB_EVENT_NAME: "workflow_dispatch" }, TEMPLATE)).not.toThrow();
});

test.each([
  ["another workflow file", { GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/other.yml@refs/heads/main" }, /tapster\.yml on the hub's main/],
  ["another branch", { GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/tapster.yml@refs/heads/evil" }, /tapster\.yml on the hub's main/],
  ["a tag", { GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/tapster.yml@refs/tags/v1.0.0" }, /tapster\.yml on the hub's main/],
  ["a workflow from another repository", { GITHUB_WORKFLOW_REF: "o/other/.github/workflows/tapster.yml@refs/heads/main" }, /tapster\.yml on the hub's main/],
  ["a pull request", { GITHUB_EVENT_NAME: "pull_request_target" }, /schedule or a manual start/],
  ["a push", { GITHUB_EVENT_NAME: "push" }, /schedule or a manual start/],
  ["workflow_run", { GITHUB_EVENT_NAME: "workflow_run" }, /schedule or a manual start/],
  ["a self-hosted runner", { RUNNER_ENVIRONMENT: "self-hosted" }, /GitHub-hosted/],
])("%s is refused", (_, change, reason) => {
  expect(() => guardRun({ ...hub, ...change }, TEMPLATE)).toThrow(reason);
});

test("a workflow written for another tapster is refused with the command that rewrites it", () => {
  for (const t of ["", "1", "3"]) {
    expect(() => guardRun(hub, t)).toThrow(expect.objectContaining({ fix: expect.stringContaining("tapster init --workflow") }));
  }
});

test("tapster's own leak test may drive the modes, nothing else in tapster's repository may", () => {
  const own = { ...hub, GITHUB_REPOSITORY: "doguyilmaz/tapster", GITHUB_EVENT_NAME: "pull_request" };
  expect(() => guardRun({ ...own, GITHUB_WORKFLOW_REF: "doguyilmaz/tapster/.github/workflows/leak.yml@refs/pull/7/merge" }, TEMPLATE)).not.toThrow();
  expect(() => guardRun({ ...own, GITHUB_WORKFLOW_REF: "doguyilmaz/tapster/.github/workflows/ci.yml@refs/heads/main" }, TEMPLATE)).toThrow();
  expect(() => guardRun({ ...hub, GITHUB_WORKFLOW_REF: "o/homebrew-tap/.github/workflows/leak.yml@refs/heads/main" }, TEMPLATE)).toThrow();
});

test("every tapster step in the hub template and the leak test passes the template version", async () => {
  for (const file of ["templates/hub/tapster.yml", ".github/workflows/leak.yml"]) {
    const text = await Bun.file(file).text();
    const steps = text.match(/with: \{ mode: [a-z-]+[^}]*\}/g) ?? [];
    expect(steps.length).toBeGreaterThan(5);
    for (const s of steps) expect(s).toContain(`template: ${TEMPLATE}`);
  }
});
