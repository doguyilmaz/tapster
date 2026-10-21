import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { useGhWrite } from "../src/cli/gh";
import { sampleHome } from "../scripts/demo";
import { FakeHub } from "./helpers/fakehub";
import { type Call, webApp } from "./helpers/web";

const HUB = "octo/homebrew-tap";
const YML = "version: 1\ntap: octo/tap\npackages:\n  - { name: ebb, repo: octo/ebb, binaries: [ebb], assets: { linux-amd64: ebb.tgz } }\n";
const fake = new FakeHub("octo");
const real = fake.fetch;
let home = "";
let call: Call;

beforeAll(async () => {
  const env = { policies: ["main"], custom: true, vars: new Map([["TAPSTER_APP_SLUG", "tapster-octo-tap"]]), secrets: new Set<string>() };
  fake.repo("homebrew-tap", { env, files: new Map([["tapster.yml", YML]]) });
  fake.track(HUB);
  home = await sampleHome(fake);
  useGhWrite(fake.ghWrite);
  ({ call } = webApp(fake, home));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  useGhWrite(async () => {
    throw new Error("gh is not available in tests");
  });
});

const hub = () => fake.get(HUB)!;
const reason = (r: { data: Record<string, unknown> }) => (r.data.error as { reason: string } | undefined)?.reason;
const push = async (path: string, text: string, actor: string) => {
  fake.actor = actor;
  await real(`https://api.github.com/repos/${HUB}/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Write ${path}`, content: Buffer.from(text).toString("base64"), branch: "main" }) });
  fake.actor = "octo";
};
const between = (act: () => Promise<void>) => {
  let fired = false;
  fake.fetch = async (input, init = {}) => {
    if (!fired && (init.method ?? "GET").toUpperCase() === "POST" && new URL(String(input)).pathname === `/repos/${HUB}/git/trees`) {
      fired = true;
      await act();
    }
    return real(input, init);
  };
};
const since = (from: number, what: string) => fake.calls.slice(from).filter((c) => c === what).length;
const linux = () => call("POST", "/api/hub/linux/config", { hub: HUB, maintainer: "Octo Cat <octo@example.com>", tools: ["ebb"] });

test("a push by someone else between the check and the write is refused, not built on", async () => {
  const before = hub().files!.get("tapster.yml");
  between(() => push("README.md", "mine now\n", "mallory"));
  const at = fake.calls.length;
  const raced = await linux();
  fake.fetch = real;
  expect(raced.status).toBe(400);
  expect(reason(raced)).toStartWith("main changed in ways only you may change it: README.md changed after your last push");
  expect(since(at, `PATCH /repos/${HUB}/git/refs/heads/main`)).toBe(1);
  expect(since(at, `GET /repos/${HUB}/activity`)).toBe(2);
  expect(hub().files!.get("tapster.yml")).toBe(before);
  expect(hub().files!.get("README.md")).toBe("mine now\n");
  expect(reason(await linux())).toStartWith("main changed in ways only you may change it");
  hub().files!.delete("README.md");
  await push("README.md", "reviewed\n", "octo");
});

test("the owner's own push in between gets a fresh check, then the change is planned again on the new main", async () => {
  between(() => push("NOTES.md", "mine\n", "octo"));
  const at = fake.calls.length;
  const done = await linux();
  fake.fetch = real;
  expect(done.data).toEqual({ result: "committed" });
  expect(since(at, `GET /repos/${HUB}/activity`)).toBe(2);
  expect(since(at, `PATCH /repos/${HUB}/git/refs/heads/main`)).toBe(2);
  expect(hub().files!.get("NOTES.md")).toBe("mine\n");
  expect(hub().files!.get("tapster.yml")).toContain('linux: { maintainer: "Octo Cat <octo@example.com>" }');
  expect(hub().history!.activity[0]).toMatchObject({ actor: "octo", after: hub().head });
});

test("the hub files write refuses the same race", async () => {
  between(() => push(".github/workflows/evil.yml", "jobs: {}\n", "mallory"));
  const raced = await call("POST", "/api/hub/files", { hub: HUB, every: null, remove: [], readme: false });
  fake.fetch = real;
  expect(reason(raced)).toStartWith("main changed in ways only you may change it: .github/workflows/evil.yml changed after your last push");
  expect(hub().files!.has(".github/workflows/tapster.yml")).toBe(false);
});
