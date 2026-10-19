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

test("signing holds no attestation rights; a separate job attests what publish lists", () => {
  const sign = flow.jobs.sign as unknown as { permissions: Record<string, string>; outputs: Record<string, string>; steps: Step[] };
  expect(sign.permissions).toEqual({ contents: "write" });
  expect(sign.steps.some((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@"))).toBe(false);
  expect(sign.outputs.checksums).toBe("${{ steps.publish.outputs.attest-checksums }}");
  const attest = flow.jobs.attest as unknown as { needs: string; if: string; "runs-on": string; permissions: Record<string, string>; steps: (Step & { run?: string; env?: Record<string, string> })[] };
  expect(attest.needs).toBe("sign");
  expect(attest.if).toContain("needs.sign.outputs.attest == 'true'");
  expect(attest["runs-on"]).toBe("ubuntu-24.04");
  expect(attest.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" });
  expect(attest.steps.some((s) => (s.uses ?? "").startsWith("actions/checkout@"))).toBe(false);
  for (const s of attest.steps) expect(s.run ?? "").not.toContain("${{");
  expect(attest.steps[0]!.env!.CHECKSUMS).toBe("${{ needs.sign.outputs.checksums }}");
  const step = attest.steps.find((s) => (s.uses ?? "").startsWith("actions/attest-build-provenance@"))!;
  expect(step.with!["subject-checksums"]).toBe("${{ runner.temp }}/checksums.txt");
  expect((step as { "continue-on-error"?: string })["continue-on-error"]).toBeUndefined();
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

test("rendering runs tapster's code only, on ubuntu", () => {
  const render = flow.jobs.render as unknown as { "runs-on": string; permissions: Record<string, string> };
  expect(render["runs-on"]).toBe("ubuntu-24.04");
  expect(render.permissions).toEqual({ contents: "write" });
  expect(readFileSync("src/action/render.ts", "utf8")).not.toMatch(/"brew"|runPath|\/bin\/brew/);
});

test("tapster's CI audits the casks the renderers produce, on every change and weekly", () => {
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { on: { schedule?: { cron: string }[] }; jobs: Record<string, { steps: { run?: string }[] }> };
  expect(ci.on.schedule?.length).toBe(1);
  expect(ci.jobs.macos!.steps.some((s) => s.run === "bun tests/brew/audit.ts")).toBe(true);
  expect(readFileSync("tests/brew/audit.ts", "utf8")).toContain('"brew", "trust"');
});
