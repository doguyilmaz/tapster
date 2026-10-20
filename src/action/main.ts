import * as core from "@actions/core";
import { TapsterError } from "../errors";
import { register } from "../mask";
import { failedCount, failure, findings, writeReach, writeSummary } from "../report";
import { check } from "./check";
import { cleanupMode } from "./cleanup";
import { loadContext } from "./context";
import { fetchMode } from "./fetch";
import { guardRun } from "./guard";
import { guide } from "./guide";
import { checkOutputs, reportMode } from "./health";
import { linuxBuildMode, linuxSignMode } from "./linux";
import { packageMode } from "./package";
import { publishMode } from "./publish";
import { renderMode } from "./render";
import { sealMode } from "./seal";
import { signMode } from "./sign";
import { sparkleMode } from "./sparkle";

const mode = core.getInput("mode") || "guide";
let token = "";
let guarded = false;

async function main(): Promise<void> {
  if (mode === "guide") return guide();
  guardRun(process.env, core.getInput("template"));
  guarded = true;
  if (mode === "cleanup") return cleanupMode();
  if (mode === "report") return reportMode();
  if (mode === "check") {
    token = process.env.GITHUB_TOKEN ?? "";
    register(token);
  }
  const ctx = await loadContext(core.getInput("config") || "tapster.yml");
  if (mode === "check") return check(ctx, token);
  if (mode === "fetch") return fetchMode(ctx);
  if (mode === "sign") return signMode(ctx);
  if (mode === "package") return packageMode(ctx);
  if (mode === "seal") return sealMode(ctx);
  if (mode === "sparkle") return sparkleMode(ctx);
  if (mode === "linux-build") return linuxBuildMode(ctx);
  if (mode === "linux-sign") return linuxSignMode(ctx);
  if (mode === "publish") return publishMode(ctx);
  if (mode === "render") return renderMode(ctx);
  throw new TapsterError(`unknown mode ${mode}`, "Use guide, check, fetch, sign, package, seal, sparkle, publish, render, linux-build, linux-sign, cleanup or report.");
}

try {
  await main();
} catch (e) {
  failure("tapster", e);
} finally {
  await writeSummary();
  if (mode === "check") writeReach();
  if (mode === "check") await checkOutputs(findings(), guarded ? { name: process.env.GITHUB_REPOSITORY ?? "", token } : null);
  if (failedCount() > 0) core.setFailed("tapster: some items failed; see the summary");
}
