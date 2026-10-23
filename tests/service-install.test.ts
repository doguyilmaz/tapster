import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapsterError } from "../src/errors";
import { parsePlist } from "../src/plist";
import { type ServiceIo, LABEL, choosePort, launchAgent, service, systemdUnit } from "../src/cli/service";
import type { Ran } from "../src/cli/runner";
import type { Where } from "../src/cli/upgrade";
import { serviceFiles } from "../src/web/service";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const BREW: Where = { exec: "/opt/homebrew/Caskroom/tapster/1.6.0/tapster", script: "/$bunfs/root/tapster", sha: "a" };
const BUN: Where = { exec: "/Users/me/.bun/bin/bun", script: "/Users/me/.bun/install/global/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" };
const BUNX: Where = { exec: "/b/bun", script: "/T/bunx-501-@doguyilmaz/tapster@latest/node_modules/@doguyilmaz/tapster/dist/cli.js", sha: "a" };

function io(o: Partial<ServiceIo> = {}) {
  const home = mkdtempSync(join(tmpdir(), "svc-install-"));
  homes.push(home);
  const ran: string[] = [];
  const said: string[] = [];
  const answers: Record<string, Ran> = {};
  const value: ServiceIo = {
    home,
    platform: "darwin",
    uid: 501,
    where: BREW,
    path: "/opt/homebrew/bin:/usr/bin:relative/bin:/bin",
    run: async (argv) => {
      ran.push(argv.join(" "));
      return answers[argv.join(" ")] ?? { code: 0, stdout: "", stderr: "" };
    },
    say: (l) => said.push(l),
    portFree: async () => true,
    ask: async () => null,
    ...o,
  };
  return { value, home, ran, said, answers };
}

const PLIST = (home: string) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = (home: string) => join(home, ".config", "systemd", "user", "tapster.service");

test("the LaunchAgent runs the stable command at login, keeps it alive and logs to ~/Library/Logs/tapster", () => {
  const text = launchAgent({ home: "/Users/me", command: "/opt/homebrew/bin/tapster", path: "/opt/homebrew/bin:/usr/bin" });
  expect(parsePlist(Buffer.from(text))).toEqual({
    Label: "com.doguyilmaz.tapster",
    ProgramArguments: ["/opt/homebrew/bin/tapster", "setup", "--service"],
    EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/bin" },
    WorkingDirectory: "/Users/me",
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: "/Users/me/Library/Logs/tapster/service.log",
    StandardErrorPath: "/Users/me/Library/Logs/tapster/service.log",
  });
  expect(launchAgent({ home: "/Users/a&b", command: "/x/<tapster>", path: "/usr/bin" })).toContain("/x/&lt;tapster&gt;");
});

test("the systemd unit restarts the stable command always and starts with the user's session", () => {
  const text = systemdUnit({ command: "/home/me/.bun/bin/tapster", path: "/home/me/.bun/bin:/usr/bin" });
  expect(text).toContain('ExecStart="/home/me/.bun/bin/tapster" setup --service\n');
  expect(text).toContain('Environment="PATH=/home/me/.bun/bin:/usr/bin"\n');
  expect(text).toContain("WorkingDirectory=%h\n");
  expect(text).toContain("Restart=always\n");
  expect(text).toContain("WantedBy=default.target\n");
  expect(systemdUnit({ command: "/opt/my apps/100%/tapster", path: "/usr/bin" })).toContain('ExecStart="/opt/my apps/100%%/tapster" setup --service');
  expect(() => systemdUnit({ command: '/x/"q"\n', path: "/usr/bin" })).toThrow(TapsterError);
});

test("the port is 8277 unless taken, then the next free one up to 8299", async () => {
  expect(await choosePort(async () => true)).toBe(8277);
  expect(await choosePort(async (p) => p > 8279)).toBe(8280);
  await expect(choosePort(async () => false)).rejects.toThrow(/8277 to 8299/);
});

test("from bunx, service install refuses and names the two ways to install", async () => {
  const t = io({ where: BUNX });
  const e = (await service(["install"], t.value).catch((x) => x)) as TapsterError;
  expect(e).toBeInstanceOf(TapsterError);
  expect(e.fix).toContain("brew install --cask doguyilmaz/tap/tapster");
  expect(e.fix).toContain("bun add -g @doguyilmaz/tapster");
  expect(t.ran).toEqual([]);
  expect(existsSync(serviceFiles(t.home).dir)).toBe(false);
});

test("service install on macOS writes the agent, the port and a private log folder, then bootstraps it", async () => {
  const t = io({ portFree: async (p) => p !== 8277 });
  await service(["install"], t.value);
  const f = serviceFiles(t.home);
  expect(JSON.parse(readFileSync(f.json, "utf8"))).toEqual({ port: 8278 });
  expect(statSync(f.json).mode & 0o777).toBe(0o600);
  expect(statSync(f.dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(t.home, "Library", "Logs", "tapster")).mode & 0o777).toBe(0o700);
  const agent = parsePlist(readFileSync(PLIST(t.home))) as Record<string, unknown>;
  expect(agent.ProgramArguments).toEqual(["/opt/homebrew/bin/tapster", "setup", "--service"]);
  expect((agent.EnvironmentVariables as { PATH: string }).PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(t.ran).toEqual([`launchctl bootout gui/501/${LABEL}`, `launchctl enable gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${PLIST(t.home)}`]);
  expect(t.said.join("\n")).toContain("http://127.0.0.1:8278");
});

test("service install on Linux writes the user unit and enables it now", async () => {
  const t = io({ platform: "linux", where: BUN });
  await service(["install"], t.value);
  expect(readFileSync(UNIT(t.home), "utf8")).toContain('ExecStart="/Users/me/.bun/bin/tapster" setup --service');
  expect(t.ran).toEqual(["systemctl --user disable --now tapster.service", "systemctl --user daemon-reload", "systemctl --user enable --now tapster.service"]);
});

test("a failing bootstrap is reported with its output", async () => {
  const t = io();
  t.answers[`launchctl bootstrap gui/501 ${PLIST(t.home)}`] = { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
  await expect(service(["install"], t.value)).rejects.toThrow(/Input\/output error/);
});

test("service uninstall removes the agent and ~/.config/tapster but never the install", async () => {
  const t = io();
  await service(["install"], t.value);
  t.ran.length = 0;
  await service(["uninstall"], t.value);
  expect(t.ran).toEqual([`launchctl bootout gui/501/${LABEL}`]);
  expect(existsSync(PLIST(t.home))).toBe(false);
  expect(existsSync(serviceFiles(t.home).dir)).toBe(false);
  const lt = io({ platform: "linux", where: BUN });
  await service(["install"], lt.value);
  lt.ran.length = 0;
  await service(["uninstall"], lt.value);
  expect(lt.ran).toEqual(["systemctl --user disable --now tapster.service", "systemctl --user daemon-reload"]);
  expect(existsSync(UNIT(lt.home))).toBe(false);
});

test("service uninstall also stops a service started by hand", async () => {
  const asked: string[] = [];
  const t = io({ ask: async (_, what) => (asked.push(what), what === "stop" ? { stopping: true } : { version: "1.6.0", port: 8277, pid: 9 }) });
  await service(["uninstall"], t.value);
  expect(asked).toContain("stop");
});

test("service status says whether it is installed and where it answers", async () => {
  const off = io();
  await service(["status"], off.value);
  expect(off.said.join("\n")).toContain("not installed");
  const on = io({ ask: async () => ({ version: "1.6.0", port: 8278, pid: 4242 }) });
  mkdirSync(join(on.home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(PLIST(on.home), "");
  await service(["status"], on.value);
  expect(on.said.join("\n")).toContain("tapster 1.6.0 runs at http://127.0.0.1:8278 (process 4242)");
});

test("service logs shows the log file on macOS and the journal on Linux", async () => {
  const mac = io();
  mkdirSync(join(mac.home, "Library", "Logs", "tapster"), { recursive: true });
  writeFileSync(join(mac.home, "Library", "Logs", "tapster", "service.log"), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
  await service(["logs"], mac.value);
  expect(mac.said.join("\n")).toContain("line 299");
  expect(mac.said.join("\n")).not.toContain("line 99\n");
  const linux = io({ platform: "linux" });
  linux.answers["journalctl --user -u tapster.service -n 200 --no-pager"] = { code: 0, stdout: "journal line", stderr: "" };
  await service(["logs"], linux.value);
  expect(linux.said.join("\n")).toContain("journal line");
});

test("unknown service commands are refused", async () => {
  await expect(service(["restart"], io().value)).rejects.toThrow(TapsterError);
  await expect(service([], io().value)).rejects.toThrow(TapsterError);
});
