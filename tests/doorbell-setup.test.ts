import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { appWorkflow, bunWorkflow, adaptReleaseWorkflow } from "../src/cli/add";
import { doorbellCheck } from "../src/cli/doctor";
import { checkVars, doorbellManifest, doorbellStage, ringStep } from "../src/cli/doorbell";
import pins from "../templates/pins.json";

test("the dispatch App is private and can only start workflows", () => {
  const m = doorbellManifest("o", "o/homebrew-tap", "http://127.0.0.1:5000/callback") as Record<string, unknown>;
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({ actions: "write", metadata: "read" });
  expect(m.default_events).toEqual([]);
  expect((m.name as string).length).toBeLessThanOrEqual(34);
  expect(m.name).toBe("tapster-doorbell-o-tap");
});

test("the Worker's variables are numbers and the hub name, nothing else", () => {
  const vars = { APP_ID: "1001", INSTALLATION_ID: "77", HUB: "o/homebrew-tap", HUB_ID: "555", OWNER_ID: "42", INTERVAL: "10" };
  expect(checkVars(vars)).toEqual(vars);
  expect(() => checkVars({ ...vars, APP_ID: "x" })).toThrow("APP_ID must be a number");
  expect(() => checkVars({ ...vars, HUB: "o/h\nx" })).toThrow("the hub name is not owner/repo");
});

const RING = "Ring the tapster hub";
const steps = (text: string, job: string) => (parse(text) as { jobs: Record<string, { steps: { name?: string }[] }> }).jobs[job]!.steps;

test("every project template and tapster's own release end with the ring step", () => {
  expect(steps(bunWorkflow("aims", "src/cli.ts", pins), "release").at(-1)!.name).toBe(RING);
  expect(steps(appWorkflow({ build: "make app", appPath: "dist/A.app", runner: "macos-15", carry: [] }, pins), "release").at(-1)!.name).toBe(RING);
  const own = readFileSync(".github/workflows/release.yml", "utf8");
  expect(own).toContain(ringStep(6));
  expect(ringStep(6)).toContain("--data-urlencode \"audience=$DOORBELL\"");
  expect(ringStep(6)).toContain('echo "::add-mask::$token"');
});

test("an adapted GoReleaser workflow gets the ring step once", () => {
  const flow = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: goreleaser/goreleaser-action@v6
        with: { args: release }
`;
  const once = adaptReleaseWorkflow(flow, pins["actions/attest-build-provenance"].sha, pins["actions/attest-build-provenance"].tag).text;
  expect(steps(once, "release").at(-1)!.name).toBe(RING);
  const twice = adaptReleaseWorkflow(once, pins["actions/attest-build-provenance"].sha, pins["actions/attest-build-provenance"].tag).text;
  expect(steps(twice, "release").filter((s) => s.name === RING).length).toBe(1);
});

test("doctor names projects that ring another doorbell or none", () => {
  const url = "https://tapster-doorbell.o.workers.dev";
  expect(doorbellCheck(url, { "o/a": url, "o/b": url }).ok).toBe(true);
  const c = doorbellCheck(url, { "o/a": url, "o/b": null, "o/c": "https://elsewhere" });
  expect(c.ok).toBe(false);
  expect(c.fix).toContain("o/b");
  expect(c.fix).toContain("o/c");
  expect(c.fix).not.toContain("o/a");
});

test("a doorbell setup that stopped after creating its App continues with that App", () => {
  const v = (names: string[]) => ({ variables: names.map((name) => ({ name, value: "1" })) });
  expect(doorbellStage(v([]))).toBe("new");
  expect(doorbellStage(v(["TAPSTER_DOORBELL_APP_ID", "TAPSTER_DOORBELL_APP_SLUG"]))).toBe("resume");
  expect(doorbellStage(v(["TAPSTER_DOORBELL_APP_ID", "TAPSTER_DOORBELL_APP_SLUG", "TAPSTER_DOORBELL"]))).toBe("done");
});

test("a doorbell or Linux key before init says to run init first", async () => {
  const { hubEnv } = await import("../src/cli/gh");
  const { GitHubError } = await import("../src/errors");
  const missing = { json: async () => { throw new GitHubError("not found", "check it", 404); } } as never;
  await expect(hubEnv(missing, "o/hub", "variables")).rejects.toThrow("o/hub has no tapster environment yet");
  const some = { json: async () => ({ variables: [{ name: "A", value: "1" }] }) } as never;
  expect(await hubEnv(some, "o/hub", "variables")).toEqual([{ name: "A", value: "1" }]);
});

test("the doorbell rings every repository tapster.yml names once, invalid entries included", async () => {
  const { doorbellRepos } = await import("../src/cli/doorbell");
  const yml = "version: 1\ntap: o/tap\npackages:\n  - { name: a, repo: o/a, binaries: [a], assets: { linux-amd64: a.tgz } }\n  - { name: a2, repo: O/A, binaries: [a2], assets: { linux-amd64: a2.tgz } }\n  - { name: b, repo: o/b, binaries: [b], assets: { linux-amd64: b.tgz }, linux: true }\n";
  expect(doorbellRepos(yml, "o")).toEqual(["o/a", "o/b"]);
});
