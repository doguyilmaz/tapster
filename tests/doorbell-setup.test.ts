import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { appWorkflow, bunWorkflow, adaptReleaseWorkflow } from "../src/cli/add";
import { doorbellCheck } from "../src/cli/doctor";
import { doorbellConfig, doorbellManifest, ringStep, workerOrigin } from "../src/cli/doorbell";
import pins from "../templates/pins.json";

test("the dispatch App is private and can only start workflows", () => {
  const m = doorbellManifest("o", "o/homebrew-tap", "http://127.0.0.1:5000/callback") as Record<string, unknown>;
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({ actions: "write", metadata: "read" });
  expect(m.default_events).toEqual([]);
  expect((m.name as string).length).toBeLessThanOrEqual(34);
  expect(m.name).toBe("tapster-doorbell-o-tap");
});

test("the Worker config holds the variables and no secret", () => {
  const text = doorbellConfig({ APP_ID: "1001", INSTALLATION_ID: "77", HUB: "o/homebrew-tap", HUB_ID: "555", OWNER_ID: "42" });
  const c = JSON.parse(text) as { name: string; main: string; vars: Record<string, string>; workers_dev: boolean };
  expect(c.name).toBe("tapster-doorbell");
  expect(c.main).toBe("worker.ts");
  expect(c.workers_dev).toBe(true);
  expect(c.vars).toEqual({ APP_ID: "1001", INSTALLATION_ID: "77", HUB: "o/homebrew-tap", HUB_ID: "555", OWNER_ID: "42" });
  expect(text).not.toContain("APP_KEY");
  expect(() => doorbellConfig({ APP_ID: "x", INSTALLATION_ID: "77", HUB: "o/homebrew-tap", HUB_ID: "555", OWNER_ID: "42" })).toThrow();
});

test("the Worker address comes from Wrangler's output file", () => {
  const out = [
    JSON.stringify({ version: 1, type: "wrangler-session", wrangler_version: "4.151.1" }),
    JSON.stringify({ version: 1, type: "deploy", worker_name: "tapster-doorbell", targets: ["https://tapster-doorbell.dogu.workers.dev"] }),
  ].join("\n");
  expect(workerOrigin(out)).toBe("https://tapster-doorbell.dogu.workers.dev");
  expect(workerOrigin(JSON.stringify({ version: 1, type: "deploy", targets: [] }))).toBeNull();
  expect(workerOrigin("not json")).toBeNull();
});

const RING = "Ring the tapster hub";
const steps = (text: string, job: string) => (parse(text) as { jobs: Record<string, { steps: { name?: string }[] }> }).jobs[job]!.steps;

test("every project template and tapster's own release end with the ring step", () => {
  expect(steps(bunWorkflow("aims", "src/cli.ts", pins), "build").at(-1)!.name).toBe(RING);
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
