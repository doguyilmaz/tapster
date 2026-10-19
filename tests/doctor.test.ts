import { expect, test } from "bun:test";
import { otherWorkflowsCheck, sparkleCheck, workflowTriggerCheck } from "../src/cli/doctor";
import { parseConfig } from "../src/config";

test("the hub workflow may only run on schedule and dispatch", () => {
  expect(workflowTriggerCheck("on:\n  schedule: [{cron: '7-59/10 * * * *'}]\n  workflow_dispatch: {}\n").ok).toBe(true);
  expect(workflowTriggerCheck("on:\n  schedule: []\n  pull_request_target: {}\n").ok).toBe(false);
  expect(workflowTriggerCheck("on: [push]\n").ok).toBe(false);
});

test("no other workflow may use the tapster environment", () => {
  expect(otherWorkflowsCheck({ "ci.yml": "jobs:\n  a:\n    runs-on: ubuntu-24.04\n" }).ok).toBe(true);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: tapster\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: { name: tapster }\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment:\n      name: tapster\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: 'tapster'\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: ${{ inputs.env }}\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: production\n" }).ok).toBe(true);
  expect(otherWorkflowsCheck({ "x.yml": "jobs: [unclosed\n" }).ok).toBe(false);
});

test("every Sparkle label has its secret and its line in the workflow", () => {
  const cfg = parseConfig(
    `version: 1
tap: o/tap
packages:
  - { name: a, repo: o/a, kind: app, app: A.app, bundle_id: com.o.A, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" }, sparkle: { key: shared, public_key: "${"A".repeat(43)}=" } }
`,
    "o",
  );
  const flow = 'env: { SPARKLE_KEY_SHARED: "${{ secrets.SPARKLE_KEY_SHARED }}" }';
  expect(sparkleCheck(cfg, ["SPARKLE_KEY_SHARED"], flow).ok).toBe(true);
  expect(sparkleCheck(cfg, [], flow).fix).toContain("tapster init --sparkle shared");
  expect(sparkleCheck(cfg, ["SPARKLE_KEY_SHARED"], "env: {}").fix).toContain("tapster init --workflow");
});
