import { expect, test } from "bun:test";
import { otherWorkflowsCheck, workflowTriggerCheck } from "../src/cli/doctor";

test("the hub workflow may only run on schedule and dispatch", () => {
  expect(workflowTriggerCheck("on:\n  schedule: [{cron: '7-59/10 * * * *'}]\n  workflow_dispatch: {}\n").ok).toBe(true);
  expect(workflowTriggerCheck("on:\n  schedule: []\n  pull_request_target: {}\n").ok).toBe(false);
  expect(workflowTriggerCheck("on: [push]\n").ok).toBe(false);
});

test("no other workflow may use the tapster environment", () => {
  expect(otherWorkflowsCheck({ "ci.yml": "jobs:\n  a:\n    runs-on: ubuntu-24.04\n" }).ok).toBe(true);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: tapster\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: { name: tapster }\n" }).ok).toBe(false);
});
