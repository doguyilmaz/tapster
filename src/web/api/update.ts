import { z } from "zod";
import { TapsterError } from "../../errors";
import { excerpt } from "../../run";
import { compareSemver, parseTag } from "../../semver";
import { TAPSTER } from "../../version";
import type { Runner } from "../../cli/runner";
import { type Where, installKind, stableCommand, upgradeAdvice } from "../../cli/upgrade";
import type { TapsterView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { LABEL, handOff } from "../service";

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

const signed = (s: Session) => s.deps.platform === "darwin" && installKind(s.deps.where) === "brew";

// Homebrew removes the running binary's versioned folder when it upgrades, so the service reads its own Team ID when it starts.
export function rememberTeam(s: Session): Promise<string | null> {
  const known = s.memo.get("tapster:team") as Promise<string | null> | undefined;
  if (known) return known;
  const read = signed(s) ? team(s.deps.run, s.deps.where.exec).catch(() => null) : Promise.resolve(null);
  s.memo.set("tapster:team", read);
  return read;
}

export type Updated = { ok: true } | { ok: false; reason: string; changed: boolean };

// Runs the install's own upgrade, then checks the new command before anything restarts: its version and, for a Homebrew
// binary on macOS, its signature and a Team ID equal to the one the running binary had at start.
export async function applyUpdate(d: { where: Where; run: Runner }, version: string, platform: NodeJS.Platform, ours: string | null): Promise<Updated> {
  const advice = upgradeAdvice(d.where, version);
  const stable = stableCommand(d.where);
  const fail = (reason: string, changed = true): Updated => ({ ok: false, reason, changed });
  if (!stable || !advice.run.length) return fail("this tapster cannot update itself", false);
  const sign = platform === "darwin" && installKind(d.where) === "brew";
  if (sign && ours === null) return fail("the running tapster shows no Team ID to compare the new one with", false);
  for (const [i, argv] of advice.run.entries()) {
    const r = await d.run(argv);
    if (r.code !== 0) return fail(`${argv.join(" ")} failed: ${excerpt(r.stderr || r.stdout) || `exit ${r.code}`}`, i === advice.run.length - 1);
  }
  const said = await d.run([stable, "--version"]);
  const now = /^tapster (\S+) /.exec(said.stdout)?.[1] ?? null;
  if (said.code !== 0 || now !== version) return fail(`the updated tapster reports ${now ?? "no version"}, not ${version}`);
  if (!sign) return { ok: true };
  if ((await d.run(["/usr/bin/codesign", "--verify", "--strict", stable])).code !== 0) return fail("the updated tapster's signature does not verify");
  const theirs = await team(d.run, stable);
  if (theirs !== ours) return fail(`the updated tapster is signed by Team ID ${theirs ?? "none"}, not ${ours}`);
  return { ok: true };
}

// After a failed check the new binary may sit at the stable path, so the service is turned off. The old process keeps
// serving; the next login does not start the unchecked one.
const turnOff = (s: Session): string[] => (s.deps.platform === "darwin" ? ["launchctl", "disable", `gui/${process.getuid?.() ?? 0}/${LABEL}`] : ["systemctl", "--user", "disable", "tapster.service"]);

const updateBody = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();

async function update(c: Ctx) {
  const { version } = await readJson(c.req, updateBody);
  const offered = await latest(c.s);
  if (offered !== version) throw new TapsterError(`tapster ${version} is not the latest release`, "Reload the page; it shows the release to update to.");
  const command = upgradeAdvice(c.s.deps.where, version).command ?? "see https://tapster.doguyilmaz.com/guides/service/";
  if (!canUpdate(c.s)) throw new TapsterError("this tapster setup does not update itself", `Update it in a terminal: ${command}`);
  if (c.s.memo.get("tapster:updating")) throw new TapsterError("an update already runs", "Wait for it to finish.");
  c.s.memo.set("tapster:updating", true);
  const done = await applyUpdate(c.s.deps, version, c.s.deps.platform, await rememberTeam(c.s)).finally(() => c.s.memo.delete("tapster:updating"));
  if (!done.ok) {
    if (!done.changed) throw new TapsterError(done.reason, `tapster setup keeps running ${TAPSTER.version}. Update it yourself in a terminal: ${command}`);
    const off = turnOff(c.s);
    await c.s.deps.run(off).catch(() => undefined);
    c.s.deps.log(`tapster setup: the update to ${version} failed its check (${done.reason}), so tapster ran ${off.join(" ")}.`);
    throw new TapsterError(done.reason, `tapster ${TAPSTER.version} keeps running here and turned the service off, so the new tapster does not start by itself. Update tapster yourself in a terminal: ${command}. Then run tapster service install to turn the service on again.`);
  }
  handOff(c.s);
  c.s.deps.log(`tapster setup: updated to ${version}, restarting.`);
  setTimeout(() => c.s.deps.exit(0), 300);
  return { restarting: true, version };
}

export const updateRoutes: Routes = {
  "GET /api/tapster": view,
  "POST /api/tapster/update": update,
};
