import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { TapsterError } from "./errors";
import { scrub } from "./mask";

export const TOOLS = {
  codesign: "/usr/bin/codesign",
  security: "/usr/bin/security",
  xcrun: "/usr/bin/xcrun",
  openssl: "/usr/bin/openssl",
  ditto: "/usr/bin/ditto",
  git: "/usr/bin/git",
  hdiutil: "/usr/bin/hdiutil",
  xattr: "/usr/bin/xattr",
  plutil: "/usr/bin/plutil",
  spctl: "/usr/sbin/spctl",
} as const;
export type Tool = keyof typeof TOOLS;

const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export type RunOptions = { env?: Record<string, string>; stdin?: string | Uint8Array; allowFail?: boolean; cwd?: string };
export type RunResult = { code: number; stdout: string; stderr: string };

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
    ...extra,
  };
}

export function excerpt(text: string, max = 5): string {
  return scrub(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !/keychain/i.test(l))
    .slice(-max)
    .join(" | ");
}

export function ghPath(): string {
  const found = GH.find((p) => existsSync(p));
  if (!found) throw new TapsterError("gh is not installed on this runner", "Use a GitHub-hosted runner image, which ships gh.");
  return found;
}

export function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runPath(TOOLS[tool], tool, args, opts);
}

export function runPath(path: string, label: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { env: childEnv(opts.env), cwd: opts.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", () => reject(new TapsterError(`${label} could not start`, `Check that ${path} exists on this runner.`)));
    child.on("close", (code) => {
      const res = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new TapsterError(`${label} exited with ${res.code}`, excerpt(res.stderr) || "No error output."));
        return;
      }
      resolve(res);
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
