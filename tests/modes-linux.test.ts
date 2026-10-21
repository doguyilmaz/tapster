import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { linuxNeeded } from "../src/action/check";
import { linuxCheck } from "../src/cli/doctor";
import { fillWorkflow } from "../src/cli/hubfiles";
import { linuxKeyAllowed } from "../src/cli/linuxkey";
import { parseConfig } from "../src/config";
import pins from "../templates/pins.json";

const cfg = (linux: boolean) =>
  parseConfig(
    `version: 1
tap: o/tap
${linux ? 'linux: { maintainer: "D <d@x.yz>" }\n' : ""}packages:
  - { name: aims, repo: o/aims, binaries: [aims], linux: ${linux}, assets: { linux-amd64: "aims_{version}_linux_amd64.tar.gz" } }
  - { name: ebb, repo: o/ebb, binaries: [ebb], assets: { darwin-arm64: "ebb_{version}_darwin_arm64.tar.gz" } }
`,
    "o",
  );
const item = (name: string) => ({ package: name, tag: "v1.0.0", releaseId: 1, resume: false });

test("the Linux jobs run for a Linux package's release or when asked, and never without Linux packages", () => {
  expect(linuxNeeded(cfg(true), [item("aims")], false)).toBe(true);
  expect(linuxNeeded(cfg(true), [item("ebb")], false)).toBe(false);
  expect(linuxNeeded(cfg(true), [], true)).toBe(true);
  expect(linuxNeeded(cfg(false), [item("aims")], true)).toBe(false);
});

type Job = { needs?: string | string[]; if?: string; environment?: { name: string } | string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: { uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string>; id?: string }[] };
const flow = parse(fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" })) as { on: { workflow_dispatch: { inputs: Record<string, { type?: string }> } }; jobs: Record<string, Job> };

test("the hub workflow builds, signs and deploys the Linux repositories in separate jobs", () => {
  const { check, "linux-build": build, "linux-sign": sign, "linux-pages": pages } = flow.jobs;
  expect(flow.on.workflow_dispatch.inputs.linux!.type).toBe("boolean");
  expect(check!.outputs!.linux).toBe("${{ steps.check.outputs.linux }}");
  expect(build!.if).toContain("needs.check.outputs.linux == 'true'");
  expect(build!.permissions).toEqual({ contents: "read" });
  expect(build!.environment).toBeUndefined();
  expect(sign!.needs).toBe("linux-build");
  expect(sign!.if).toContain("needs.linux-build.result == 'success'");
  expect(sign!.if).toContain("needs.linux-build.outputs.changed == 'true'");
  expect(sign!.permissions).toEqual({ contents: "read" });
  expect((sign!.environment as { name: string }).name).toBe("tapster");
  expect(pages!.if).toContain("needs.linux-sign.result == 'success'");
  expect(pages!.permissions).toEqual({ pages: "write", "id-token": "write" });
  expect((pages!.environment as { name: string }).name).toBe("github-pages");
  const keyed = Object.values(flow.jobs).flatMap((j) => j.steps).filter((s) => JSON.stringify(s.env ?? {}).includes("TAPSTER_LINUX_KEY"));
  expect(keyed.length).toBe(1);
  expect(keyed[0]!.with!.mode).toBe("linux-sign");
  const signSteps = sign!.steps;
  expect(signSteps.findIndex((s) => (s.run ?? "").includes("createrepo-c"))).toBeLessThan(signSteps.findIndex((s) => s.with?.mode === "linux-sign"));
  expect(JSON.stringify(flow)).not.toContain("__");
});

test("doctor checks the Linux key, the Pages source and its address", () => {
  const c = cfg(true);
  const pages = { build_type: "workflow", html_url: "https://o.github.io/homebrew-tap/" };
  expect(linuxCheck(c, "o/homebrew-tap", ["TAPSTER_LINUX_KEY"], pages).ok).toBe(true);
  expect(linuxCheck(c, "o/homebrew-tap", [], pages).fix).toContain("tapster init --linux");
  expect(linuxCheck(c, "o/homebrew-tap", ["TAPSTER_LINUX_KEY"], null).fix).toContain("Pages");
  expect(linuxCheck(c, "o/homebrew-tap", ["TAPSTER_LINUX_KEY"], { ...pages, build_type: "legacy" }).fix).toContain("GitHub Actions");
  expect(linuxCheck(c, "o/homebrew-tap", ["TAPSTER_LINUX_KEY"], { ...pages, html_url: "https://apt.o.dev/" }).fix).toContain("linux.url");
});

test("init --linux never replaces a live key unless asked to rotate", () => {
  expect(() => linuxKeyAllowed([], false)).not.toThrow();
  let fix = "";
  try {
    linuxKeyAllowed(["TAPSTER_LINUX_KEY"], false);
  } catch (e) {
    fix = (e as { fix: string }).fix;
  }
  expect(fix).toContain("tapster init --rotate linux");
  expect(() => linuxKeyAllowed(["TAPSTER_LINUX_KEY"], true)).not.toThrow();
});
