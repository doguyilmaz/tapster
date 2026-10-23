import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TapsterError } from "../errors";
import { excerpt } from "../run";
import { type Ask, LABEL, LAST_PORT, PORT, askService, privateDir, serviceFiles, writePrivate } from "../web/service";

export { LABEL };
import { type Runner, realRunner } from "./runner";
import { type Where, here, installKind, stableCommand } from "./upgrade";

const UNIT = "tapster.service";

export type ServiceIo = {
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  where: Where;
  path: string;
  run: Runner;
  say(line: string): void;
  portFree(port: number): Promise<boolean>;
  ask(sock: string, what: Ask): Promise<unknown | null>;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const logFile = (home: string) => join(home, "Library", "Logs", "tapster", "service.log");
const agentFile = (home: string) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const unitFile = (home: string) => join(home, ".config", "systemd", "user", UNIT);

export function launchAgent(o: { home: string; command: string; path: string }): string {
  const s = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${s(o.command)}
    ${s("setup")}
    ${s("--service")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s(o.path)}
  </dict>
  <key>WorkingDirectory</key>
  ${s(o.home)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${s(logFile(o.home))}
  <key>StandardErrorPath</key>
  ${s(logFile(o.home))}
</dict>
</plist>
`;
}

// systemd reads % as a specifier and a backslash or quote as quoting, so the value is quoted and a path with quotes or line breaks is refused.
const unitValue = (v: string) => {
  if (/["\\\n\r]/.test(v)) throw new TapsterError(`the path ${JSON.stringify(v)} cannot go into a systemd unit`, "Install tapster under a path without quotes, backslashes or line breaks.");
  return `"${v.replace(/%/g, "%%")}"`;
};

export function systemdUnit(o: { command: string; path: string }): string {
  return `[Unit]
Description=tapster setup

[Service]
ExecStart=${unitValue(o.command)} setup --service
Environment=${unitValue(`PATH=${o.path}`)}
WorkingDirectory=%h
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export async function choosePort(free: (port: number) => Promise<boolean>): Promise<number> {
  for (let p = PORT; p <= LAST_PORT; p++) if (await free(p)) return p;
  throw new TapsterError(`every port from ${PORT} to ${LAST_PORT} is in use`, "Close a program that uses one of them, then run tapster service install again.");
}

const portFree = async (port: number) => {
  try {
    Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) }).stop(true);
    return true;
  } catch {
    return false;
  }
};

const servicePath = (command: string, path: string) => [...new Set([dirname(command), ...path.split(":").filter((p) => p.startsWith("/")), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");

async function must(io: ServiceIo, argv: string[]): Promise<void> {
  const r = await io.run(argv);
  if (r.code !== 0) throw new TapsterError(`${argv.join(" ")} failed: ${excerpt(r.stderr || r.stdout) || `exit ${r.code}`}`, `Run it yourself to see why, then run tapster service install again.`);
}

async function install(io: ServiceIo): Promise<void> {
  const command = stableCommand(io.where);
  if (!command) {
    const how = installKind(io.where) === "bunx" ? "bunx runs a temporary copy" : "this tapster is not installed with Homebrew, Bun or npm";
    throw new TapsterError(`the service needs an installed tapster, and ${how}`, "Install it with brew install --cask doguyilmaz/tap/tapster or bun add -g @doguyilmaz/tapster, then run tapster service install.");
  }
  if (io.platform !== "darwin" && io.platform !== "linux") throw new TapsterError("the service runs on macOS and Linux", "Run tapster setup when you need it instead.");
  await remove(io);
  const port = await choosePort(io.portFree);
  const files = serviceFiles(io.home);
  privateDir(files.dir);
  writePrivate(files.json, JSON.stringify({ port }));
  const path = servicePath(command, io.path);
  if (io.platform === "darwin") {
    mkdirSync(dirname(logFile(io.home)), { recursive: true, mode: 0o700 });
    privateDir(dirname(logFile(io.home)));
    mkdirSync(dirname(agentFile(io.home)), { recursive: true });
    writeFileSync(agentFile(io.home), launchAgent({ home: io.home, command, path }));
    // An update whose check failed turns the service off with launchctl disable; installing again turns it back on.
    await must(io, ["launchctl", "enable", `gui/${io.uid}/${LABEL}`]);
    await must(io, ["launchctl", "bootstrap", `gui/${io.uid}`, agentFile(io.home)]);
  } else {
    mkdirSync(dirname(unitFile(io.home)), { recursive: true });
    writeFileSync(unitFile(io.home), systemdUnit({ command, path }));
    await must(io, ["systemctl", "--user", "daemon-reload"]);
    await must(io, ["systemctl", "--user", "enable", "--now", UNIT]);
  }
  io.say(`tapster setup now runs at http://127.0.0.1:${port} and starts when you log in. Open it with tapster setup.`);
}

// Stops and removes the agent or the unit. The install itself (Homebrew, Bun or npm) stays.
async function remove(io: ServiceIo): Promise<void> {
  if (io.platform === "darwin") {
    await io.run(["launchctl", "bootout", `gui/${io.uid}/${LABEL}`]);
    rmSync(agentFile(io.home), { force: true });
  } else if (io.platform === "linux") {
    await io.run(["systemctl", "--user", "disable", "--now", UNIT]);
    if (existsSync(unitFile(io.home))) {
      rmSync(unitFile(io.home), { force: true });
      await io.run(["systemctl", "--user", "daemon-reload"]);
    }
  }
}

async function uninstall(io: ServiceIo): Promise<void> {
  await remove(io);
  const files = serviceFiles(io.home);
  if ((await io.ask(files.sock, "status")) !== null) await io.ask(files.sock, "stop");
  rmSync(files.dir, { recursive: true, force: true });
  io.say("The tapster service is gone. tapster itself stays installed; tapster setup still works as before.");
}

async function status(io: ServiceIo): Promise<void> {
  const installed = existsSync(io.platform === "darwin" ? agentFile(io.home) : unitFile(io.home));
  const answer = (await io.ask(serviceFiles(io.home).sock, "status")) as { version?: string; port?: number; pid?: number } | null;
  if (answer) io.say(`tapster ${answer.version} runs at http://127.0.0.1:${answer.port} (process ${answer.pid}).`);
  if (!installed) io.say("The tapster service is not installed. Install it with tapster service install.");
  else if (!answer) io.say("The tapster service is installed but does not answer. See tapster service logs.");
}

async function logs(io: ServiceIo): Promise<void> {
  if (io.platform === "darwin") {
    const file = logFile(io.home);
    if (!existsSync(file)) return io.say(`No log yet at ${file}.`);
    io.say(readFileSync(file, "utf8").split("\n").slice(-200).join("\n"));
    io.say(`(the last 200 lines of ${file})`);
    return;
  }
  const r = await io.run(["journalctl", "--user", "-u", UNIT, "-n", "200", "--no-pager"]);
  io.say(r.stdout || r.stderr);
}

export const realServiceIo = (): ServiceIo => ({
  home: process.env.HOME ?? "",
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  where: here(),
  path: process.env.PATH ?? "",
  run: realRunner,
  say: (l) => console.log(l),
  portFree,
  ask: askService,
});

export async function service(args: string[], io: ServiceIo = realServiceIo()): Promise<void> {
  const [what, ...rest] = args;
  if (rest.length) throw new TapsterError(`unknown option ${rest.join(" ")}`, "tapster service takes install, uninstall, status or logs.");
  if (what === "install") return install(io);
  if (what === "uninstall") return uninstall(io);
  if (what === "status") return status(io);
  if (what === "logs") return logs(io);
  throw new TapsterError(what ? `unknown service command ${what}` : "tapster service needs a command", "Run tapster service install, uninstall, status or logs.");
}
