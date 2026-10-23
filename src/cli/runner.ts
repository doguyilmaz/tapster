import { TapsterError } from "../errors";

export type Ran = { code: number; stdout: string; stderr: string };

// Every outside command the service and its update need (launchctl, systemctl, brew, bun, npm, codesign) goes through one of these, so tests never run them.
export type Runner = (argv: string[], opts?: { env?: Record<string, string> }) => Promise<Ran>;

export const realRunner: Runner = async (argv, opts = {}) => {
  const bin = argv[0]!.startsWith("/") ? argv[0]! : Bun.which(argv[0]!);
  if (!bin) throw new TapsterError(`${argv[0]} is not on PATH`, `Run it yourself: ${argv.join(" ")}`);
  const proc = Bun.spawn([bin, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

