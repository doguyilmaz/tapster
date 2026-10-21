import { expect, test } from "bun:test";
import { releaseTriggers } from "../src/web/api/status";

test("a workflow that releases from tags only has no other trigger", () => {
  expect(releaseTriggers('on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:\n')).toEqual([]);
  expect(releaseTriggers("on: workflow_dispatch\n")).toEqual([]);
});

test("pushes to a branch, schedules and other workflows are named", () => {
  expect(releaseTriggers("on:\n  push:\n    branches: [main]\n    paths: [CHANGELOG.md]\n    tags: ['v*']\n")).toEqual(["pushes to main that change CHANGELOG.md"]);
  expect(releaseTriggers("on:\n  push:\n    branches: [main, release]\n")).toEqual(["pushes to main or release"]);
  expect(releaseTriggers("on: [push]\n")).toEqual(["every push"]);
  expect(releaseTriggers("on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_run:\n    workflows: [CI]\n")).toEqual(["a schedule", "another workflow finishing"]);
  expect(releaseTriggers("on:\n  release:\n    types: [published]\n")).toEqual([]);
  expect(releaseTriggers("not: [valid")).toEqual([]);
});
