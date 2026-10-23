import { z } from "zod";
import { TapsterError } from "../../errors";
import { excerpt } from "../../run";
import { compareSemver, parseTag } from "../../semver";
import { TAPSTER } from "../../version";
import type { Runner } from "../../cli/runner";
import { type Where, installKind, stableCommand, upgradeAdvice } from "../../cli/upgrade";
import type { TapsterView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";

const CHECK_EVERY = 6 * 3_600_000;
const STABLE = /^v(\d+\.\d+\.\d+)$/;

type Latest = { at: number; version: string | null };

async function release(s: Session): Promise<string | null> {
  const known = s.memo.get("tapster:latest") as Latest | undefined;
  if (known && Date.now() - known.at < CHECK_EVERY) return known.version;
  const gh = await s.deps.github();
  const tag = (await gh.json<{ tag_name?: string }>("GET", "/repos/doguyilmaz/tapster/releases/latest")).tag_name ?? "";
  const version = STABLE.exec(tag)?.[1] ?? null;
  s.memo.set("tapster:latest", { at: Date.now(), version } satisfies Latest);
  return version;
}

// The latest release when it is newer than this tapster, from GitHub at most every six hours. A build from a checkout has no release to compare.
async function latest(s: Session): Promise<string | null> {
  if (TAPSTER.sha === null && s.deps.pin === null) return null;
  const version = await release(s).catch(() => null);
  const ours = parseTag(`v${TAPSTER.version}`);
  return version !== null && ours !== null && compareSemver(parseTag(`v${version}`)!, ours) > 0 ? version : null;
}

const canUpdate = (s: Session) => s.mode === "service" && stableCommand(s.deps.where) !== null;

async function view(c: Ctx): Promise<TapsterView> {
  const version = await latest(c.s);
  return { running: TAPSTER.version, latest: version, update: canUpdate(c.s) ? "here" : "command", command: version ? upgradeAdvice(c.s.deps.where, version).command : null };
}

const team = async (run: Runner, path: string): Promise<string | null> => {
  const r = await run(["/usr/bin/codesign", "-dv", "--verbose=2", path]);
  const id = /^TeamIdentifier=(.+)$/m.exec(r.stderr)?.[1]?.trim();
  return r.code === 0 && id && id !== "not set" ? id : null;
};

// Runs the install's own upgrade, then checks the new command before anything restarts: its version and, for a signed binary, its signature and Team ID.
export async function applyUpdate(d: { where: Where; run: Runner }, version: string, platform: NodeJS.Platform): Promise<void> {
  const advice = upgradeAdvice(d.where, version);
  const stable = stableCommand(d.where);
  const fail = (reason: string) => new TapsterError(reason, `tapster setup keeps running ${TAPSTER.version}. Update it yourself in a terminal: ${advice.command}`);
  if (!stable || !advice.run.length) throw fail("this tapster cannot update itself");
  for (const argv of advice.run) {
    const r = await d.run(argv);
    if (r.code !== 0) throw fail(`${argv.join(" ")} failed: ${excerpt(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }
  const said = await d.run([stable, "--version"]);
  const now = /^tapster (\S+) /.exec(said.stdout)?.[1] ?? null;
  if (said.code !== 0 || now !== version) throw fail(`the updated tapster reports ${now ?? "no version"}, not ${version}`);
  if (platform !== "darwin" || installKind(d.where) !== "brew") return;
  const ours = await team(d.run, d.where.exec);
  if (ours === null) return;
  if ((await d.run(["/usr/bin/codesign", "--verify", "--strict", stable])).code !== 0) throw fail("the updated tapster's signature does not verify");
  const theirs = await team(d.run, stable);
  if (theirs !== ours) throw fail(`the updated tapster is signed by Team ID ${theirs ?? "none"}, not ${ours}`);
}

const updateBody = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();

async function update(c: Ctx) {
  const { version } = await readJson(c.req, updateBody);
  const offered = await latest(c.s);
  if (offered !== version) throw new TapsterError(`tapster ${version} is not the latest release`, "Reload the page; it shows the release to update to.");
  if (!canUpdate(c.s)) throw new TapsterError("this tapster setup does not update itself", `Update it in a terminal: ${upgradeAdvice(c.s.deps.where, version).command ?? "see https://tapster.doguyilmaz.com/guides/service/"}`);
  if (c.s.memo.get("tapster:updating")) throw new TapsterError("an update already runs", "Wait for it to finish.");
  c.s.memo.set("tapster:updating", true);
  try {
    await applyUpdate(c.s.deps, version, c.s.deps.platform);
  } catch (e) {
    c.s.memo.delete("tapster:updating");
    throw e;
  }
  c.s.deps.log(`tapster setup: updated to ${version}, restarting.`);
  setTimeout(() => c.s.deps.exit(0), 300);
  return { restarting: true, version };
}

export const updateRoutes: Routes = {
  "GET /api/tapster": view,
  "POST /api/tapster/update": update,
};
