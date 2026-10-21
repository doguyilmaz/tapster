import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run";
import { warmStart } from "../src/web/api/hub";
import type { HubChoice, HubView } from "../src/web/contract";
import { knownHub } from "../src/web/start";
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

test("the first reads join setup's warm start and a write drops it, so the next read sees the write", async () => {
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap");
  const { s, call } = webApp(fake, home);
  warmStart(s, Promise.resolve("octo/homebrew-tap"));
  await Bun.sleep(0);
  await s.warm.get("hub:octo/homebrew-tap")!.value;
  const before = fake.calls.length;
  expect((await call("GET", "/api/account")).data).toEqual({ state: "ok", login: "octo", missing: [] });
  const warm = (await call("GET", "/api/hub?hub=octo/homebrew-tap")).data as unknown as HubView;
  expect(warm.protect.done).toBe(false);
  expect(fake.calls.length).toBe(before);
  expect((await call("GET", "/api/hub?hub=octo/homebrew-tap")).status).toBe(200);
  expect(fake.calls.length).toBeGreaterThan(before);

  warmStart(s, Promise.resolve("octo/homebrew-tap"));
  await Bun.sleep(0);
  await s.warm.get("hub:octo/homebrew-tap")!.value;
  expect((await call("POST", "/api/hub/protect", { hub: "octo/homebrew-tap" })).status).toBe(200);
  expect(s.warm.size).toBe(0);
  const fresh = (await call("GET", "/api/hub?hub=octo/homebrew-tap")).data as unknown as HubView;
  expect(fresh.protect.done).toBe(true);
});

test("a warm start past its short life is read again and one for another hub is never served", async () => {
  const fake = new FakeHub("octo");
  fake.repo("homebrew-tap");
  fake.repo("homebrew-other");
  const { s, call } = webApp(fake, home);
  warmStart(s, Promise.resolve("octo/homebrew-tap"));
  await Bun.sleep(0);
  const entry = s.warm.get("hub:octo/homebrew-tap")!;
  await entry.value;
  entry.at -= 60_000;
  const before = fake.calls.length;
  expect((await call("GET", "/api/hub?hub=octo/homebrew-tap")).status).toBe(200);
  expect(fake.calls.slice(before).some((c) => c === "GET /repos/octo/homebrew-tap")).toBe(true);
  warmStart(s, Promise.resolve("octo/homebrew-tap"));
  await Bun.sleep(0);
  await s.warm.get("hub:octo/homebrew-tap")!.value;
  expect(((await call("GET", "/api/hub?hub=octo/homebrew-other")).data as unknown as HubView).name).toBe("octo/homebrew-other");
  expect((await call("GET", "/api/hub?hub=someone/homebrew-tap")).status).toBe(400);
});

test("setup knows the hub from git config tapster.hub, then from the folder's own tap", async () => {
  const dir = join(home, "clone");
  await run("git", ["init", "-q", dir]);
  expect(await knownHub(dir)).toBeNull();
  await run("git", ["-C", dir, "remote", "add", "origin", "https://github.com/octo/homebrew-tap.git"]);
  expect(await knownHub(dir)).toBe("octo/homebrew-tap");
  await run("git", ["-C", dir, "config", "tapster.hub", "octo/homebrew-main"]);
  expect(await knownHub(dir)).toBe("octo/homebrew-main");
  await run("git", ["-C", dir, "config", "tapster.hub", "not a hub"]);
  expect(await knownHub(dir)).toBe("octo/homebrew-tap");
  expect(await knownHub(join(home, "missing"))).toBeNull();
});
