import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { fillWorkflow, flowCertificateLabels, patchCertificateEnv } from "../src/cli/hubfiles";
import pins from "../templates/pins.json";

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
  expect(linux.if).toContain("needs.check.outputs.linux == 'true'");
  expect(linux.if).not.toContain("needs.check.result");
});

test("check gets a read-only token to see who changed the hub and whether its health issue is open", () => {
  const check = flow.jobs.check as unknown as { permissions: Record<string, string>; outputs: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] };
  expect(check.permissions).toEqual({ contents: "read", issues: "read" });
  expect(check.steps.find((s) => s.id === "check")!.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
  expect(check.outputs.findings).toBe("${{ steps.check.outputs.findings }}");
  expect(check.outputs.report).toBe("${{ steps.check.outputs.report }}");
});

test("the report job can write issues and nothing else, holds no keys and gets the findings as an input", () => {
  type Job = { needs: string; if: string; "runs-on": string; environment?: unknown; permissions: Record<string, string>; steps: (Step & { name: string; run?: string; env?: Record<string, string> })[] };
  const report = flow.jobs.report as unknown as Job;
  expect(report.needs).toBe("check");
  expect(report.if).toBe("${{ !cancelled() && (needs.check.outputs.report == 'true' || (needs.check.result == 'failure' && needs.check.outputs.findings == '')) }}");
  expect(report["runs-on"]).toBe("ubuntu-24.04");
  expect(report.permissions).toEqual({ issues: "write" });
  expect(report.environment).toBeUndefined();
  expect(report.steps).toHaveLength(1);
  const [step] = report.steps;
  expect(step!.name).toBe("Update the hub's health issue");
  expect(step!.uses).toBe("doguyilmaz/tapster@__TAPSTER_SHA__");
  expect(step!.run).toBeUndefined();
  expect(step!.with).toEqual({ mode: "report", template: 2, findings: "${{ needs.check.outputs.findings }}", check: "${{ needs.check.result }}" });
  expect(step!.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
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

test("sign runs on macOS only when check says this run signs macOS code", () => {
  const check = flow.jobs.check as unknown as { outputs: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] };
  expect(check.outputs.macos).toBe("${{ steps.check.outputs.macos }}");
  const env = check.steps.find((s) => s.id === "check")!.env!;
  expect(env.TAPSTER_TEAM_ID).toBe("${{ vars.TAPSTER_TEAM_ID }}");
  expect(env.TAPSTER_CERT_EXPIRES).toBe("${{ vars.TAPSTER_CERT_EXPIRES }}");
  expect((flow.jobs.sign as unknown as { "runs-on": string })["runs-on"]).toBe("${{ needs.check.outputs.macos == 'false' && 'ubuntu-24.04' || 'macos-15' }}");
});

test("every step in the hub workflow says what it does", () => {
  for (const [job, def] of Object.entries(flow.jobs)) {
    for (const step of def.steps) expect((step as { name?: string }).name, `${job}: ${JSON.stringify(step).slice(0, 80)}`).toBeTruthy();
  }
});

test("tapster's own release builds without write access and attests in a job that runs no dependencies", () => {
  type Job = { permissions: Record<string, string>; steps: { uses?: string; run?: string }[] };
  const own = parse(readFileSync(".github/workflows/release.yml", "utf8")) as { jobs: { build: Job; release: Job } };
  expect(own.jobs.build.permissions).toEqual({ contents: "read" });
  expect(own.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  for (const s of own.jobs.release.steps) {
    expect(s.run ?? "").not.toMatch(/\bbun\b/);
    if (s.uses) expect(s.uses).toMatch(/^actions\/(checkout|download-artifact|attest-build-provenance)@/);
  }
});

const template = readFileSync("templates/hub/tapster.yml", "utf8");
const fill = (certificates: string[]) => fillWorkflow(template, pins, { sha: "f".repeat(40), tag: "v1.0.0" }, { sparkle: ["shared"], certificates });
type EnvStep = { id?: string; with?: { mode?: string }; env?: Record<string, string> | string };

test("without certificate labels the workflow is what the template wrote before labels existed", () => {
  const before = template.replace("          #__CERTIFICATE_CHECK_ENV__\n", "").replaceAll("          #__CERTIFICATE_ENV__\n", "");
  expect(before).not.toContain("CERTIFICATE");
  expect(fill([])).toBe(fillWorkflow(before, pins, { sha: "f".repeat(40), tag: "v1.0.0" }, { sparkle: ["shared"] }));
  for (const labels of [[], ["acme"], ["acme", "beta"]]) expect(fill(labels)).not.toContain("__");
});

test("each certificate label reaches the check, sign and seal steps and no other step", () => {
  const parsed = parse(fill(["acme", "beta"])) as { jobs: Record<string, { steps: EnvStep[] }> };
  const plain = parse(fill([])) as { jobs: Record<string, { steps: EnvStep[] }> };
  const extra = (job: string, i: number) => {
    const env = parsed.jobs[job]!.steps[i]!.env;
    const was = plain.jobs[job]!.steps[i]!.env;
    if (typeof env !== "object") return {};
    return Object.fromEntries(Object.entries(env).filter(([k]) => typeof was !== "object" || !(k in was)));
  };
  const v = (n: string) => `\${{ vars.${n} }}`;
  const s = (n: string) => `\${{ secrets.${n} }}`;
  const signEnv = (L: string) => ({
    [`TAPSTER_TEAM_ID_${L}`]: v(`TAPSTER_TEAM_ID_${L}`),
    [`MACOS_SIGN_P12_${L}`]: s(`MACOS_SIGN_P12_${L}`),
    [`MACOS_SIGN_PASSWORD_${L}`]: s(`MACOS_SIGN_PASSWORD_${L}`),
    [`MACOS_NOTARY_KEY_${L}`]: s(`MACOS_NOTARY_KEY_${L}`),
    [`MACOS_NOTARY_KEY_ID_${L}`]: s(`MACOS_NOTARY_KEY_ID_${L}`),
    [`MACOS_NOTARY_ISSUER_ID_${L}`]: s(`MACOS_NOTARY_ISSUER_ID_${L}`),
  });
  for (const [job, def] of Object.entries(parsed.jobs)) {
    def.steps.forEach((step, i) => {
      const got = extra(job, i);
      if (job === "check" && step.id === "check") {
        expect(got).toEqual({ TAPSTER_TEAM_ID_ACME: v("TAPSTER_TEAM_ID_ACME"), TAPSTER_CERT_EXPIRES_ACME: v("TAPSTER_CERT_EXPIRES_ACME"), TAPSTER_TEAM_ID_BETA: v("TAPSTER_TEAM_ID_BETA"), TAPSTER_CERT_EXPIRES_BETA: v("TAPSTER_CERT_EXPIRES_BETA") });
      } else if (job === "sign" && (step.with?.mode === "sign" || step.with?.mode === "seal")) {
        expect(got).toEqual({ ...signEnv("ACME"), ...signEnv("BETA") });
      } else {
        expect(got, `${job} ${step.with?.mode ?? i}`).toEqual({});
      }
    });
  }
});

test("patching the certificate lines gives what the template writes for those labels", () => {
  expect(patchCertificateEnv(fill([]), ["acme"])).toBe(fill(["acme"]));
  expect(patchCertificateEnv(fill(["acme", "beta"]), ["beta"])).toBe(fill(["beta"]));
  expect(patchCertificateEnv(fill(["acme", "beta"]), [])).toBe(fill([]));
  expect(patchCertificateEnv(fill(["beta"]), ["beta"])).toBe(fill(["beta"]));
  expect(flowCertificateLabels(fill(["beta", "acme"]))).toEqual(["beta", "acme"]);
  expect(flowCertificateLabels(fill([]))).toEqual([]);
  const fix = expect.objectContaining({ fix: "Run tapster init --workflow to rewrite it from the template." });
  expect(() => patchCertificateEnv("jobs: {}\n", ["acme"])).toThrow(fix);
  const noSeal = fill([]).replace(/(mode: seal, template: 2 \}\n\s+env:\n(?:.*\n){5}).*MACOS_NOTARY_ISSUER_ID.*\n/, "$1");
  expect(noSeal).not.toBe(fill([]));
  expect(() => patchCertificateEnv(noSeal, ["acme"])).toThrow("the hub workflow has no sign step");
});
