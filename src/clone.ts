import { type RunResult, TOOLS, runPath } from "./run";

// A clone's own config must not run anything while tapster reads it: a partial clone would fetch a missing object
// through any remote its config names, ext:: included.
export const READ_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none" };

export const readGit = (dir: string, args: string[], o: { timeoutMs?: number; maxOutput?: number } = {}): Promise<RunResult> =>
  runPath(TOOLS.git, "git", ["-C", dir, ...args], { env: READ_ENV, allowFail: true, timeoutMs: o.timeoutMs ?? 20_000, maxOutput: o.maxOutput ?? 4 << 20 });
