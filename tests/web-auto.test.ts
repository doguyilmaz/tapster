import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AUTO_FILE, autoMode } from "../src/cli/auto";
import type { DiffView, InspectView } from "../src/web/contract";
import { listAims, sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const fake = new FakeHub("octo");
const HUB = "octo/homebrew-tap";
let home = "";
let path = "";
let call: Call;

beforeAll(async () => {
  fake.repo("homebrew-tap", { env: { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set() }, files: new Map([["tapster.yml", "version: 1\ntap: octo/tap\npackages: []\n"]]) });
  home = await sampleHome(fake);
  listAims(fake);
  path = join(home, "Developer", "aims");
  const repo = fake.get("octo/aims")!;
  repo.keys.push({ title: "tapster tags", read_only: false });
  repo.env = { policies: ["main"], custom: true, vars: new Map(), secrets: new Set(["TAPSTER_TAG_KEY"]) };
  ({ call } = webApp(fake, home));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
const options = { workflow: "release.yml", autoTag: false, dependabot: false, force: false };

test("automatic mode can be previewed in the browser without writing a workflow or changing keys", async () => {
  const res = await call("POST", "/api/projects/preview", { hub: HUB, path, options: { ...options, auto: "push" } });
  expect(res.status).toBe(200);
  const file = (res.data as unknown as DiffView).files.find((f) => f.path === AUTO_FILE)!;
  expect(autoMode(file.after)).toBe("push");
  expect(existsSync(join(path, AUTO_FILE))).toBe(false);
  expect(fake.get("octo/aims")!.keys).toHaveLength(1);
});

test("the browser enables and disables automatic releases and detects the changed workflow", async () => {
  for (const auto of ["daily", "off"] as const) {
    const res = await call("POST", "/api/projects/add", { hub: HUB, path, options: { ...options, auto } });
    expect(res.status).toBe(200);
    expect(autoMode(readFileSync(join(path, AUTO_FILE), "utf8"))).toBe(auto);
    const info = (await call("POST", "/api/projects/inspect", { hub: HUB, path })).data as unknown as InspectView;
    expect(info.auto).toBe(auto);
    expect(info.dirty).toContain(AUTO_FILE);
  }
  expect(fake.get("octo/aims")!.keys).toHaveLength(1);
});
