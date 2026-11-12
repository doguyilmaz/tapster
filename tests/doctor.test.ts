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

test("doctor names each invalid package and keeps the valid ones", async () => {
  const { configChecks } = await import("../src/cli/doctor");
  const text = `version: 1
tap: o/tap
packages:
  - { name: good, repo: o/good, binaries: [good], assets: { darwin-arm64: "g.tar.gz" } }
  - { name: bad, repo: o/bad, binaries: [bad], assets: { darwin-arm64: "b.zip" } }
`;
  const { checks, config } = configChecks(text, "o");
  expect(config!.packages.map((p) => p.name)).toEqual(["good"]);
  expect(checks.map((c) => [c.name, c.ok])).toEqual([["bad in tapster.yml is valid", false]]);
  expect(checks[0]!.fix).toContain(".tar.gz");
  expect(configChecks(text.replace(/  - \{ name: bad.*\n/, ""), "o").checks).toEqual([{ name: "tapster.yml is valid", ok: true, fix: "" }]);
  const broken = configChecks("version: 9\n", "o");
  expect(broken.config).toBeNull();
  expect(broken.checks[0]!.ok).toBe(false);
});

test("an environment named Tapster is the same environment", () => {
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: Tapster\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: { name: TAPSTER }\n" }).ok).toBe(false);
});

test("doctor compares the workflow byte for byte when the hub runs this tapster", async () => {
  const { workflowCheck } = await import("../src/cli/doctor");
  const { fillWorkflow } = await import("../src/cli/hubfiles");
  const pins = (await import("../templates/pins.json")).default;
  const template = await Bun.file("templates/hub/tapster.yml").text();
  const me = { version: "1.0.0", sha: "a".repeat(40) };
  const flow = fillWorkflow(template, pins, { sha: me.sha, tag: "v1.0.0" }, { sparkle: ["shared"] }, 60);
  expect(workflowCheck(flow, me).ok).toBe(true);
  const labeled = fillWorkflow(template, pins, { sha: me.sha, tag: "v1.0.0" }, { sparkle: ["shared"], certificates: ["acme", "beta"] }, 60);
  expect(workflowCheck(labeled, me).ok).toBe(true);
  expect(workflowCheck(fillWorkflow(template, pins, { sha: me.sha, tag: "v1.0.0" }, { certificates: ["acme"] }), me).ok).toBe(true);
  expect(workflowCheck(labeled.replace("          MACOS_SIGN_PASSWORD_BETA: ${{ secrets.MACOS_SIGN_PASSWORD_BETA }}\n", ""), me).ok).toBe(false);
  const edited = workflowCheck(flow.replace("contents: read", "contents: write"), me);
  expect(edited.ok).toBe(false);
  expect(edited.fix).toContain("tapster init --workflow");
  const older = workflowCheck(fillWorkflow(template, pins, { sha: "b".repeat(40), tag: "v0.9.0" }), me);
  expect(older.ok).toBe(true);
  expect(older.note).toContain("v0.9.0");
  expect(older.note).toContain("tapster init --workflow");
});

test("the hub's own ruleset, actions policy and access are checked", async () => {
  const { accessCheck, hubRulesetCheck, policyCheck } = await import("../src/cli/doctor");
  const good = { enforcement: "active", target: "branch", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "non_fast_forward" }], bypass_actors: [] };
  expect(hubRulesetCheck([good]).ok).toBe(true);
  expect(hubRulesetCheck([{ ...good, enforcement: "evaluate" }]).ok).toBe(false);
  expect(hubRulesetCheck([{ ...good, rules: [{ type: "deletion" }] }]).ok).toBe(false);
  expect(hubRulesetCheck([{ ...good, bypass_actors: [{ actor_type: "Integration", actor_id: 9 }] }]).ok).toBe(false);
  const policy = { enabled: true, allowed_actions: "selected", sha_pinning_required: true };
  const selected = { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["doguyilmaz/tapster@*"] };
  expect(policyCheck(policy, selected).ok).toBe(true);
  expect(policyCheck({ ...policy, allowed_actions: "all" }, selected).fix).toContain("tapster init");
  expect(policyCheck(policy, { ...selected, patterns_allowed: ["evil/*"] }).ok).toBe(false);
  expect(accessCheck([{ login: "o" }], [], "o").ok).toBe(true);
  const crowded = accessCheck([{ login: "o" }, { login: "friend" }], [{ title: "ci", read_only: false }], "o");
  expect(crowded.ok).toBe(false);
  expect(crowded.fix).toContain("friend");
  expect(crowded.fix).toContain("ci");
});

test("a hub without a run in the last day is reported with the doorbell as the cure", async () => {
  const { scheduleCheck } = await import("../src/cli/doctor");
  const now = Date.parse("2026-10-19T12:00:00Z");
  expect(scheduleCheck([{ event: "schedule", created_at: "2026-10-19T08:00:00Z" }], now, false).ok).toBe(true);
  expect(scheduleCheck([{ event: "workflow_dispatch", created_at: "2026-10-19T08:00:00Z" }], now, true).ok).toBe(true);
  const quiet = scheduleCheck([{ event: "schedule", created_at: "2026-10-17T08:00:00Z" }], now, false);
  expect(quiet.ok).toBe(false);
  expect(quiet.fix).toContain("tapster init --doorbell");
});

test("Apple credentials are asked for only when a package ships macOS code", async () => {
  const { credentialsCheck } = await import("../src/cli/doctor");
  const linux = parseConfig("version: 1\ntap: o/tap\nlinux: { maintainer: \"O <o@x.yz>\" }\npackages:\n  - { name: l, repo: o/l, binaries: [l], linux: true, assets: { linux-amd64: \"l.tar.gz\" } }\n", "o");
  expect(credentialsCheck(linux, ["TAPSTER_APP_PRIVATE_KEY"], ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG"]).ok).toBe(true);
  const mac = parseConfig("version: 1\ntap: o/tap\npackages:\n  - { name: m, repo: o/m, binaries: [m], assets: { darwin-arm64: \"m.tar.gz\" } }\n", "o");
  const missing = credentialsCheck(mac, ["TAPSTER_APP_PRIVATE_KEY"], ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG"]);
  expect(missing.ok).toBe(false);
  expect(missing.fix).toContain("tapster init --rotate certificate");
  expect(missing.fix).toContain("tapster init --rotate notary");
});

const labeled = parseConfig(
  `version: 1
tap: o/tap
packages:
  - { name: a, repo: o/a, binaries: [a], certificate: acme, assets: { darwin-arm64: "a.tar.gz" } }
  - { name: b, repo: o/b, kind: app, app: B.app, bundle_id: com.o.B, certificate: beta, assets: { darwin-arm64: "B-{version}.tar.gz" }, dmg: { name: "B-{version}.dmg" } }
  - { name: l, repo: o/l, binaries: [l], assets: { linux-amd64: "l.tar.gz" } }
`,
  "o",
);
const labelSecrets = (l: string, notary = true) => [`MACOS_SIGN_P12_${l}`, `MACOS_SIGN_PASSWORD_${l}`, ...(notary ? [`MACOS_NOTARY_KEY_${l}`, `MACOS_NOTARY_KEY_ID_${l}`, `MACOS_NOTARY_ISSUER_ID_${l}`] : [])];
const HUB_NOTARY = ["MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID"];

test("every certificate label is stored, has a notary key of its team and is passed to the workflow", async () => {
  const { certificateCheck } = await import("../src/cli/doctor");
  const { fillWorkflow } = await import("../src/cli/hubfiles");
  const pins = (await import("../templates/pins.json")).default;
  const template = await Bun.file("templates/hub/tapster.yml").text();
  const flow = fillWorkflow(template, pins, { sha: "a".repeat(40), tag: "v1.0.0" }, { certificates: ["acme", "beta"] });
  const vars = [
    { name: "TAPSTER_TEAM_ID", value: "HUBTEAM001" },
    { name: "TAPSTER_TEAM_ID_ACME", value: "ACMETEAM01" },
    { name: "TAPSTER_TEAM_ID_BETA", value: "HUBTEAM001" },
  ];
  const all = [...labelSecrets("ACME"), ...labelSecrets("BETA", false), ...HUB_NOTARY];
  const good = certificateCheck(labeled, all, vars, flow);
  expect(good).toEqual({ name: "every certificate the packages name is stored and passed to the workflow", ok: true, fix: "" });
  const unstored = certificateCheck(labeled, all.filter((s) => s !== "MACOS_SIGN_PASSWORD_ACME"), vars, flow);
  expect(unstored.ok).toBe(false);
  expect(unstored.fix).toBe("Run tapster init --certificate acme.");
  expect(certificateCheck(labeled, all, vars.filter((v) => v.name !== "TAPSTER_TEAM_ID_BETA"), flow).fix).toBe("Run tapster init --certificate beta.");
  expect(certificateCheck(labeled, all.filter((s) => s !== "MACOS_NOTARY_KEY_ID_ACME"), vars, flow).fix).toBe("Run tapster init --certificate acme --notary.");
  expect(certificateCheck(labeled, all.filter((s) => !s.startsWith("MACOS_NOTARY_") || !s.endsWith("_ACME")), vars, flow).fix).toBe("Run tapster init --certificate acme --notary.");
  expect(certificateCheck(labeled, all.filter((s) => !HUB_NOTARY.includes(s)), vars, flow).fix).toBe("Run tapster init --rotate notary.");
  expect(certificateCheck(labeled, [...all, "MACOS_NOTARY_KEY_BETA"], vars, flow).fix).toBe("Run tapster init --certificate beta --notary.");
  const unwired = certificateCheck(labeled, all, vars, fillWorkflow(template, pins, { sha: "a".repeat(40), tag: "v1.0.0" }, { certificates: ["acme"] }));
  expect(unwired.fix).toBe("The workflow does not pass MACOS_SIGN_P12_BETA. Run tapster init --certificate beta or tapster init --workflow.");
  const both = certificateCheck(labeled, [], [], "");
  expect(both.fix).toBe(
    "Run tapster init --certificate acme. The workflow does not pass MACOS_SIGN_P12_ACME. Run tapster init --certificate acme or tapster init --workflow. Run tapster init --certificate beta. The workflow does not pass MACOS_SIGN_P12_BETA. Run tapster init --certificate beta or tapster init --workflow.",
  );
});

test("each certificate the packages use is checked for its expiry", async () => {
  const { expiryChecks } = await import("../src/cli/doctor");
  const now = Date.parse("2026-10-19T12:00:00Z");
  const vars = [
    { name: "TAPSTER_CERT_EXPIRES", value: "2027-06-01" },
    { name: "TAPSTER_CERT_EXPIRES_ACME", value: "2026-11-01" },
    { name: "TAPSTER_CERT_EXPIRES_BETA", value: "2027-01-01" },
    { name: "TAPSTER_CERT_EXPIRES_GONE", value: "2026-10-20" },
  ];
  expect(expiryChecks(labeled, vars, now)).toEqual([
    { name: "the Developer ID certificate acme is valid for 30 more days", ok: false, fix: "It expires on 2026-11-01. Renew it at developer.apple.com, then run tapster init --certificate acme." },
  ]);
  expect(expiryChecks(null, [{ name: "TAPSTER_CERT_EXPIRES", value: "2026-11-01" }], now)).toEqual([
    { name: "the Developer ID certificate is valid for 30 more days", ok: false, fix: "It expires on 2026-11-01. Renew it at developer.apple.com, then run tapster init --rotate certificate." },
  ]);
  expect(expiryChecks(labeled, [], now)).toEqual([]);
});

test("the hub's own Apple credentials are asked for only when a macOS package has no certificate label", async () => {
  const { credentialsCheck } = await import("../src/cli/doctor");
  const app = ["TAPSTER_APP_PRIVATE_KEY"];
  const appVars = ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG"];
  expect(credentialsCheck(labeled, app, appVars).ok).toBe(true);
  const mixed = parseConfig(
    `version: 1
tap: o/tap
packages:
  - { name: a, repo: o/a, binaries: [a], certificate: acme, assets: { darwin-arm64: "a.tar.gz" } }
  - { name: c, repo: o/c, binaries: [c], assets: { darwin-arm64: "c.tar.gz" } }
`,
    "o",
  );
  const missing = credentialsCheck(mixed, app, appVars);
  expect(missing.ok).toBe(false);
  expect(missing.fix).toBe("Missing: MACOS_SIGN_P12, MACOS_SIGN_PASSWORD, MACOS_NOTARY_KEY, MACOS_NOTARY_KEY_ID, MACOS_NOTARY_ISSUER_ID, TAPSTER_TEAM_ID. Run tapster init --rotate certificate and tapster init --rotate notary.");
});

test("a certificate secret stored as a variable is flagged, labeled ones too", async () => {
  const { exposedCheck } = await import("../src/cli/doctor");
  expect(exposedCheck(["TAPSTER_APP_ID", "TAPSTER_TEAM_ID_ACME", "TAPSTER_CERT_EXPIRES_ACME"], ["acme"]).ok).toBe(true);
  const labeledOnly = exposedCheck(["TAPSTER_TEAM_ID", "MACOS_SIGN_P12_ACME"], ["acme"]);
  expect(labeledOnly.ok).toBe(false);
  expect(labeledOnly.fix).toBe("Variables are readable by anyone with access; delete MACOS_SIGN_P12_ACME and store them with tapster init --certificate acme.");
  expect(exposedCheck(["MACOS_SIGN_P12", "MACOS_NOTARY_ISSUER_ID_BETA"], ["acme", "beta"]).fix).toBe(
    "Variables are readable by anyone with access; delete MACOS_SIGN_P12, MACOS_NOTARY_ISSUER_ID_BETA and store them with tapster init --rotate and tapster init --certificate beta.",
  );
  expect(exposedCheck(["SPARKLE_KEY_SHARED"], []).fix).toBe("Variables are readable by anyone with access; delete SPARKLE_KEY_SHARED and store them with tapster init --rotate.");
  expect(exposedCheck(["MACOS_SIGN_PASSWORD_GONE"], []).ok).toBe(false);
});

test("the doorbell's clock matches the workflow's schedule", async () => {
  const { doorbellEveryCheck } = await import("../src/cli/doctor");
  expect(doorbellEveryCheck("60", 60).ok).toBe(true);
  const stale = doorbellEveryCheck("10", 60);
  expect(stale.ok).toBe(false);
  expect(stale.fix).toContain("tapster init --rotate doorbell");
  expect(doorbellEveryCheck(undefined, 60).fix).toContain("tapster init --rotate doorbell");
});
