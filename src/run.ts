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
  gpg: "/usr/bin/gpg",
  gpgconf: "/usr/bin/gpgconf",
  rpm: "/usr/bin/rpm",
  rpmsign: "/usr/bin/rpmsign",
  rpm2archive: "/usr/bin/rpm2archive",
  "dpkg-deb": "/usr/bin/dpkg-deb",
  createrepo_c: "/usr/bin/createrepo_c",
  "apt-ftparchive": "/usr/bin/apt-ftparchive",
} as const;
export type Tool = keyof typeof TOOLS;

const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export type RunOptions = { env?: Record<string, string>; stdin?: string | Uint8Array; allowFail?: boolean; cwd?: string; maxOutput?: number; timeoutMs?: number };
export type RunResult = { code: number; stdout: string; stderr: string; bytes: Buffer };

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

export function ghPath(candidates: string[] = GH): string {
  const found = candidates.find((p) => existsSync(p));
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
    let size = 0;
    let stopped: TapsterError | null = null;
    const stop = (e: TapsterError) => {
      stopped ??= e;
      child.kill("SIGKILL");
    };
    const timer = opts.timeoutMs ? setTimeout(() => stop(new TapsterError(`${label} did not finish in time`, "Re-run the workflow; if it happens again, check the input it read.")), opts.timeoutMs) : null;
    const collect = (into: Buffer[]) => (d: Buffer) => {
      size += d.length;
      if (opts.maxOutput && size > opts.maxOutput) stop(new TapsterError(`${label} wrote more output than tapster reads`, "Check the input it read."));
      else into.push(d);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", () => reject(new TapsterError(`${label} could not start`, `Check that ${path} exists on this runner.`)));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (stopped) {
        reject(stopped);
        return;
      }
      const bytes = Buffer.concat(out);
      const res = { code: code ?? -1, stdout: bytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), bytes };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new TapsterError(`${label} exited with ${res.code}`, excerpt(res.stderr) || excerpt(res.stdout) || "No error output."));
        return;
      }
      resolve(res);
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
