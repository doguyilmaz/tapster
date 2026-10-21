import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubChoice } from "../src/web/contract";
import { FakeHub } from "./helpers/fakehub";
import { webApp } from "./helpers/web";

const home = mkdtempSync(join(tmpdir(), "tapster-load-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("the hub list loads its pages at once, checks each tap and includes a tap created a moment ago", async () => {
  const fake = new FakeHub("octo");
  for (let i = 0; i < 110; i++) fake.repo(`project-${i}`);
  fake.repo("homebrew-tap", { env: { policies: ["main"], custom: true, vars: new Map(), secrets: new Set() } });
  fake.repo("homebrew-tap-notes");
  let open = 0;
  let most = 0;
  const fetchOf = fake.fetch;
  fake.fetch = async (input, init) => {
    const pages = String(input).includes("/user/repos");
    if (pages) most = Math.max(most, ++open);
    try {
      return await fetchOf(input, init);
    } finally {
      if (pages) open--;
    }
  };
  fake.lag = 5;
  const { call } = webApp(fake, home);
  expect((await call("POST", "/api/hubs", { name: "homebrew-fresh", private: true })).status).toBe(200);
  fake.calls = [];
  const hubs = (await call("GET", "/api/hubs")).data.hubs as HubChoice[];
  expect(hubs).toEqual([
    { name: "octo/homebrew-tap", private: false, url: "https://github.com/octo/homebrew-tap", tapster: true },
    { name: "octo/homebrew-tap-notes", private: false, url: "https://github.com/octo/homebrew-tap-notes", tapster: false },
    { name: "octo/homebrew-fresh", private: true, url: "https://github.com/octo/homebrew-fresh", tapster: false },
  ]);
  expect(fake.calls.filter((c) => c.startsWith("GET /user/repos"))).toHaveLength(3);
  expect(most).toBe(2);
});

test("a single page of repositories takes one request", async () => {
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap");
  const { call } = webApp(fake, home);
  expect(((await call("GET", "/api/hubs")).data.hubs as HubChoice[]).map((h) => h.name)).toEqual(["octo/homebrew-tap"]);
  expect(fake.calls.filter((c) => c.startsWith("GET /user/repos"))).toHaveLength(1);
});
