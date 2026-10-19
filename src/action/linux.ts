import * as core from "@actions/core";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapsterError } from "../errors";
import { buildLinux } from "../linux/build";
import { NFPM, installNfpm, nfpmPackager } from "../linux/nfpm";
import { signLinux } from "../linux/sign";
import { readSecret } from "../mask";
import { linuxUrl } from "../config";
import { failure, info } from "../report";
import { STATE_PATH, parseState } from "../state";
import { workdir } from "../workdir";
import type { Context } from "./context";

export const linuxDir = () => join(process.env.RUNNER_TEMP ?? tmpdir(), "tapster-linux");

export async function linuxBuildMode(ctx: Context): Promise<void> {
  const state = parseState(await readFile(join(ctx.workspace, STATE_PATH), "utf8").catch(() => null));
  const out = linuxDir();
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await mkdir(workdir(), { recursive: true, mode: 0o700 });
  const nfpm = await installNfpm(fetch, workdir(), NFPM[process.arch === "arm64" ? "arm64" : "x64"]);
  const built = await buildLinux(ctx.config, state, ctx.hub, { fetch, out, packager: nfpmPackager(nfpm) });
  for (const f of built.failed) failure("linux", new TapsterError(f, "The live repositories stay as they are; fix the release and run the workflow with linux set."));
  if (!built.failed.length) info(built.changed ? "linux: packages built" : "linux: the live repositories are current");
  core.setOutput("changed", String(built.changed));
}

export async function linuxSignMode(ctx: Context): Promise<void> {
  const key = readSecret("TAPSTER_LINUX_KEY");
  const previous = process.env.TAPSTER_LINUX_KEY_PREVIOUS ? readSecret("TAPSTER_LINUX_KEY_PREVIOUS") : null;
  delete process.env.TAPSTER_LINUX_KEY_PREVIOUS;
  const state = parseState(await readFile(join(ctx.workspace, STATE_PATH), "utf8").catch(() => null));
  const signed = await signLinux({ dir: linuxDir(), config: ctx.config, state, owner: ctx.owner.toLowerCase(), url: linuxUrl(ctx.config, ctx.hub), key, previous, fetch });
  info(`linux: signed ${signed.packages} checked package${signed.packages === 1 ? "" : "s"} with key ${signed.fingerprint}`);
}
