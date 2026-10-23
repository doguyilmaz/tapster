import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/cli/runner";
import type { Where } from "../src/cli/upgrade";
import { existsSync, rmSync } from "node:fs";
import { applyUpdate, rememberTeam } from "../src/web/api/update";
import { serviceFiles } from "../src/web/service";
import type { TapsterView } from "../src/web/contract";
import { FakeHub } from "./helpers/fakehub";
import { webApp } from "./helpers/web";

const home = mkdtempSync(join(tmpdir(), "update-"));
const BREW: Where = { exec: "/opt/homebrew/Caskroom/tapster/1.7.4/tapster", script: "/$bunfs/root/tapster", sha: "a" };
const BUN: Where = { exec: "/Users/me/.bun/bin/bun", script: "/Users/me/.bun/install/global/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" };

function setupWith(o: { where?: Where; answers?: Record<string, Ran>; mode?: "once" | "service" } = {}) {
  const fake = new FakeHub("octo");
  fake.tapsterLatest = "v1.7.5";
  const ran: string[] = [];
  const exits: number[] = [];
  const answers: Record<string, Ran> = {
    "/opt/homebrew/bin/tapster --version": { code: 0, stdout: "tapster 1.7.5 (0123456789ab)\n", stderr: "" },
    "/Users/me/.bun/bin/tapster --version": { code: 0, stdout: "tapster 1.7.5 (0123456789ab)\n", stderr: "" },
    "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/Caskroom/tapster/1.7.4/tapster": { code: 0, stdout: "", stderr: "Executable=/opt/homebrew/Caskroom/tapster/1.7.4/tapster\nTeamIdentifier=TEAM123456\n" },
    "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/bin/tapster": { code: 0, stdout: "", stderr: "TeamIdentifier=TEAM123456\n" },
    ...o.answers,
  };
  const app = webApp(
    fake,
    home,
    {
      where: o.where ?? BREW,
      run: async (argv) => {
        ran.push(argv.join(" "));
        return answers[argv.join(" ")] ?? { code: 0, stdout: "", stderr: "" };
      },
      exit: (code) => exits.push(code),
    },
    o.mode ?? "service",
  );
  return { ...app, fake, ran, exits, answers };
}

const latestCalls = (fake: FakeHub) => fake.calls.filter((c) => c === "GET /repos/doguyilmaz/tapster/releases/latest").length;

test("the page learns the latest tapster release once per six hours", async () => {
  const { call, fake, s } = setupWith({ mode: "once" });
  const first = (await call("GET", "/api/tapster")).data as unknown as TapsterView;
  expect(first).toEqual({ running: "0.0.0-dev", latest: "1.7.5", update: "command", command: "brew update && brew upgrade --cask tapster" });
  await call("GET", "/api/tapster");
  expect(latestCalls(fake)).toBe(1);
  const memo = s.memo.get("tapster:latest") as { at: number };
  memo.at -= 6 * 3_600_000 + 1;
  await call("GET", "/api/tapster");
  expect(latestCalls(fake)).toBe(2);
});

test("the service offers the update in the page; without a newer release there is nothing to offer", async () => {
  const { call, fake } = setupWith();
  expect(((await call("GET", "/api/tapster")).data as unknown as TapsterView).update).toBe("here");
  const none = setupWith();
  none.fake.tapsterLatest = null;
  expect(((await none.call("GET", "/api/tapster")).data as unknown as TapsterView).latest).toBeNull();
  expect(fake.calls.length).toBeGreaterThan(0);
});

test("the one-shot setup does not update itself and names the command", async () => {
  const { call, ran } = setupWith({ mode: "once" });
  await call("GET", "/api/tapster");
  const res = await call("POST", "/api/tapster/update", { version: "1.7.5" });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.data)).toContain("brew update && brew upgrade --cask tapster");
  expect(ran).toEqual([]);
});

test("an update runs Homebrew, checks the new version and its Team ID, answers and only then exits", async () => {
  const { call, ran, exits } = setupWith();
  await call("GET", "/api/tapster");
  const res = await call("POST", "/api/tapster/update", { version: "1.7.5" });
  expect(res.data).toEqual({ restarting: true, version: "1.7.5" });
  expect(ran).toEqual([
    "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/Caskroom/tapster/1.7.4/tapster",
    "brew update",
    "brew upgrade --cask tapster",
    "/opt/homebrew/bin/tapster --version",
    "/usr/bin/codesign --verify --strict /opt/homebrew/bin/tapster",
    "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/bin/tapster",
  ]);
  expect(existsSync(serviceFiles(home).session)).toBe(true);
  expect(exits).toEqual([]);
  await Bun.sleep(400);
  expect(exits).toEqual([0]);
  rmSync(serviceFiles(home).session);
});

test("the running Team ID is read at start, before Homebrew removes the running binary's folder", async () => {
  const { s, call, ran, answers, exits } = setupWith();
  await rememberTeam(s);
  delete (answers as Record<string, Ran>)["/usr/bin/codesign -dv --verbose=2 /opt/homebrew/Caskroom/tapster/1.7.4/tapster"];
  await call("GET", "/api/tapster");
  ran.length = 0;
  expect((await call("POST", "/api/tapster/update", { version: "1.7.5" })).status).toBe(200);
  expect(ran[0]).toBe("brew update");
  await Bun.sleep(400);
  expect(exits).toEqual([0]);
  rmSync(serviceFiles(home).session, { force: true });
});

test("a Bun install gets the exact version and no codesign check", async () => {
  const { call, ran } = setupWith({ where: BUN });
  await call("GET", "/api/tapster");
  expect((await call("POST", "/api/tapster/update", { version: "1.7.5" })).status).toBe(200);
  expect(ran).toEqual(["bun add -g @doguyilmaz/tapster@1.7.5", "/Users/me/.bun/bin/tapster --version"]);
});

test.each([
  ["the upgrade fails", { "brew upgrade --cask tapster": { code: 1, stdout: "", stderr: "Error: Download failed" } }, "Download failed", true],
  ["the running binary has no Team ID", { "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/Caskroom/tapster/1.7.4/tapster": { code: 1, stdout: "", stderr: "No such file or directory" } }, "Team ID", false],
  ["the new binary has no Team ID", { "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/bin/tapster": { code: 0, stdout: "", stderr: "TeamIdentifier=not set\n" } }, "Team ID", true],
  ["the new command reports another version", { "/opt/homebrew/bin/tapster --version": { code: 0, stdout: "tapster 1.7.4 (0123456789ab)\n", stderr: "" } }, "1.7.4", true],
  ["the new binary's signature does not verify", { "/usr/bin/codesign --verify --strict /opt/homebrew/bin/tapster": { code: 1, stdout: "", stderr: "invalid signature" } }, "signature", true],
  ["the new binary has another Team ID", { "/usr/bin/codesign -dv --verbose=2 /opt/homebrew/bin/tapster": { code: 0, stdout: "", stderr: "TeamIdentifier=OTHER99999\n" } }, "Team ID", true],
] as const)("the old service keeps running and turns the service off when %s", async (_, answers, said, off) => {
  rmSync(serviceFiles(home).session, { force: true });
  const { call, exits, ran } = setupWith({ answers });
  await call("GET", "/api/tapster");
  const res = await call("POST", "/api/tapster/update", { version: "1.7.5" });
  expect(res.status).toBe(400);
  const text = JSON.stringify(res.data);
  expect(text).toContain(said);
  expect(text).toContain("brew update && brew upgrade --cask tapster");
  expect(text.includes("tapster service install")).toBe(off);
  expect(ran.includes(`launchctl disable gui/${process.getuid!()}/com.doguyilmaz.tapster`)).toBe(off);
  await Bun.sleep(400);
  expect(exits).toEqual([]);
  expect(existsSync(serviceFiles(home).session)).toBe(false);
});

test("a failed brew update changes nothing, so the service stays on", async () => {
  const { call, ran, exits } = setupWith({ answers: { "brew update": { code: 1, stdout: "", stderr: "network down" } } });
  await call("GET", "/api/tapster");
  const res = await call("POST", "/api/tapster/update", { version: "1.7.5" });
  expect(res.status).toBe(400);
  expect(ran.some((r) => r.startsWith("launchctl"))).toBe(false);
  await Bun.sleep(400);
  expect(exits).toEqual([]);
});

test("on Linux a failed check turns the systemd unit off", async () => {
  const linux = setupWith({ where: BUN, answers: { "/Users/me/.bun/bin/tapster --version": { code: 0, stdout: "tapster 1.7.4 (x)\n", stderr: "" } } });
  linux.s.deps.platform = "linux";
  await linux.call("GET", "/api/tapster");
  expect((await linux.call("POST", "/api/tapster/update", { version: "1.7.5" })).status).toBe(400);
  expect(linux.ran).toContain("systemctl --user disable tapster.service");
});

test("only the release GitHub named can be installed", async () => {
  const { call, ran } = setupWith();
  await call("GET", "/api/tapster");
  expect((await call("POST", "/api/tapster/update", { version: "9.9.9" })).status).toBe(400);
  expect((await call("POST", "/api/tapster/update", { version: "1.7.5; rm -rf /" })).status).toBe(400);
  expect(ran).toEqual([]);
});

test("Linux skips codesign; a Homebrew binary on macOS without a Team ID fails", async () => {
  const ran: string[] = [];
  const run = async (argv: string[]): Promise<Ran> => {
    ran.push(argv.join(" "));
    if (argv[1] === "--version") return { code: 0, stdout: "tapster 1.7.5 (0123456789ab)\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "TeamIdentifier=not set\n" };
  };
  expect(await applyUpdate({ where: BREW, run }, "1.7.5", "linux", null)).toEqual({ ok: true });
  expect(ran.filter((r) => r.includes("codesign"))).toEqual([]);
  expect(await applyUpdate({ where: BREW, run }, "1.7.5", "darwin", null)).toMatchObject({ ok: false, changed: false });
});
