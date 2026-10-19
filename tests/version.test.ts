import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { patchSparkleEnv, pinChange, tapsterPin } from "../src/cli/hubfiles";
import { TapsterError } from "../src/errors";
import type { GitHub } from "../src/github";

const sha = "a".repeat(40);
const noApi = { json: async () => { throw new Error("no API call expected"); } } as unknown as GitHub;
const compare = (status: string) => {
  const calls: string[] = [];
  const gh = { json: async (_m: string, path: string) => { calls.push(path); return { status }; } } as unknown as GitHub;
  return { gh, calls };
};

test("a released CLI pins the tapster it was built from without asking GitHub", async () => {
  expect(await tapsterPin(noApi, { version: "1.2.3", sha }, null)).toEqual({ sha, tag: "v1.2.3" });
});

test("a development CLI refuses to pin without --tapster", async () => {
  await expect(tapsterPin(noApi, { version: "0.0.0-dev", sha: null }, null)).rejects.toMatchObject({ fix: expect.stringContaining("--tapster") });
});

test("--tapster must name a full commit on tapster's main", async () => {
  await expect(tapsterPin(noApi, { version: "0.0.0-dev", sha: null }, "abc123")).rejects.toThrow(TapsterError);
  for (const status of ["behind", "diverged"]) {
    await expect(tapsterPin(compare(status).gh, { version: "0.0.0-dev", sha: null }, sha)).rejects.toThrow(/not on tapster's main/);
  }
  for (const status of ["ahead", "identical"]) {
    const { gh, calls } = compare(status);
    expect(await tapsterPin(gh, { version: "0.0.0-dev", sha: null }, sha)).toEqual({ sha, tag: "main" });
    expect(calls).toEqual([`/repos/doguyilmaz/tapster/compare/${sha}...main`]);
  }
});

test("nothing asks GitHub for the latest tapster release", () => {
  expect(readFileSync("src/cli/init.ts", "utf8")).not.toContain("releases/latest");
});

const flow = `      - if: \${{ !cancelled() }}
        uses: doguyilmaz/tapster@${sha} # v1.0.0
        with: { mode: sparkle }
        env: {}
      - id: publish
        uses: doguyilmaz/tapster@${sha} # v1.0.0
`;

test("a Sparkle key changes only the sparkle step's env line", () => {
  const out = patchSparkleEnv(flow, ["shared"]);
  expect(out).toBe(flow.replace("        env: {}\n", '        env: { SPARKLE_KEY_SHARED: "${{ secrets.SPARKLE_KEY_SHARED }}" }\n'));
  expect(() => patchSparkleEnv("jobs: {}\n", ["shared"])).toThrow(expect.objectContaining({ fix: expect.stringContaining("tapster init --workflow") }));
});

test("rewriting the workflow names the old and the new pin", () => {
  const next = flow.replaceAll(sha, "b".repeat(40)).replaceAll("v1.0.0", "v1.1.0");
  expect(pinChange(flow, next)).toBe(`tapster v1.0.0 (${sha.slice(0, 7)}) -> v1.1.0 (bbbbbbb)`);
  expect(pinChange(null, next)).toBe("tapster v1.1.0 (bbbbbbb)");
  expect(pinChange(flow, flow)).toBe(`tapster v1.0.0 (${sha.slice(0, 7)}), unchanged`);
});

test("the sparkle step of the real template is found and patched", async () => {
  const { fillWorkflow } = await import("../src/cli/hubfiles");
  const pins = (await import("../templates/pins.json")).default;
  const template = await Bun.file("templates/hub/tapster.yml").text();
  const written = fillWorkflow(template, pins, { sha, tag: "v1.0.0" });
  const patched = patchSparkleEnv(written, ["shared"]);
  expect(patched).toBe(fillWorkflow(template, pins, { sha, tag: "v1.0.0" }, ["shared"]));
});
