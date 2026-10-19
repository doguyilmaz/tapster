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

test("the hub attests only what publish asks for, so a private hub skips the step instead of failing it", () => {
  const attest = flow.jobs.sign!.steps.find((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@"))!;
  expect(attest.if).toContain("steps.publish.outputs.attest == 'true'");
  expect((attest as { "continue-on-error"?: string })["continue-on-error"]).toBeUndefined();
  const own = (parse(readFileSync(".github/workflows/release.yml", "utf8")) as { jobs: { build: { steps: { uses?: string; if?: string; "continue-on-error"?: unknown }[] } } }).jobs.build.steps.find((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@"))!;
  expect(own.if).toBe("${{ !github.event.repository.private }}");
  expect(own["continue-on-error"]).toBeUndefined();
});

test("a check that fails before writing outputs runs no later job", () => {
  const { sign, render } = flow.jobs;
  const linux = flow.jobs["linux-build"]!;
  expect(sign!.if).toContain("needs.check.outputs.work != ''");
  expect(render!.if).toContain("needs.check.outputs.render == 'true'");
  expect(linux.if).toContain("needs.check.result == 'success'");
  expect(linux.if).toContain("needs.check.outputs.linux == 'true'");
});

test("check gets a read-only token to see who changed the hub", () => {
  const check = flow.jobs.check as unknown as { permissions: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] };
  expect(check.permissions).toEqual({ contents: "read" });
  expect(check.steps.find((s) => s.id === "check")!.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
});
