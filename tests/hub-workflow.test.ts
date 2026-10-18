import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Step = { uses?: string; if?: string; with?: Record<string, unknown> };
const flow = parse(readFileSync("templates/hub/tapster.yml", "utf8")) as {
  jobs: Record<string, { if?: string; steps: Step[] }>;
};

test("one failed item never stops the steps and jobs after it", () => {
  const { sign, render } = flow.jobs;
  expect(sign!.if).toContain("!cancelled()");
  expect(render!.if).toContain("!cancelled()");
  expect(render!.if).not.toContain("needs.check.result == 'success'");
  const later = sign!.steps.slice(2);
  for (const step of later) {
    expect(step.if ?? "", JSON.stringify(step.with)).toMatch(/!cancelled\(\)|always\(\)/);
  }
});
