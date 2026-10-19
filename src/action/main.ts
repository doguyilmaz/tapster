import * as core from "@actions/core";
import { TapsterError } from "../errors";
import { failedCount, failure, writeSummary } from "../report";
import { check } from "./check";
import { cleanupMode } from "./cleanup";
import { loadContext } from "./context";
import { fetchMode } from "./fetch";
import { guardRun } from "./guard";
import { linuxBuildMode, linuxSignMode } from "./linux";
import { packageMode } from "./package";
import { publishMode } from "./publish";
import { renderMode } from "./render";
import { sealMode } from "./seal";
import { signMode } from "./sign";
import { sparkleMode } from "./sparkle";

async function main(): Promise<void> {
  guardRun(process.env, core.getInput("template"));
  const mode = core.getInput("mode", { required: true });
  if (mode === "cleanup") return cleanupMode();
  const ctx = await loadContext(core.getInput("config") || "tapster.yml");
  if (mode === "check") return check(ctx);
  if (mode === "fetch") return fetchMode(ctx);
  if (mode === "sign") return signMode(ctx);
  if (mode === "package") return packageMode(ctx);
  if (mode === "seal") return sealMode(ctx);
  if (mode === "sparkle") return sparkleMode(ctx);
  if (mode === "linux-build") return linuxBuildMode(ctx);
  if (mode === "linux-sign") return linuxSignMode(ctx);
  if (mode === "publish") return publishMode(ctx);
  if (mode === "render") return renderMode(ctx);
  throw new TapsterError(`unknown mode ${mode}`, "Use check, fetch, sign, package, seal, sparkle, publish, render, linux-build, linux-sign or cleanup.");
}

try {
  await main();
} catch (e) {
  failure("tapster", e);
} finally {
  await writeSummary();
  if (failedCount() > 0) core.setFailed("tapster: some items failed; see the summary");
}
