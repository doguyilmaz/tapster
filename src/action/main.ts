import * as core from "@actions/core";
import { TapsterError } from "../errors";
import { failedCount, failure, writeSummary } from "../report";
import { check } from "./check";
import { cleanupMode } from "./cleanup";
import { loadContext } from "./context";
import { fetchMode } from "./fetch";
import { publishMode } from "./publish";
import { renderMode } from "./render";
import { signMode } from "./sign";

async function main(): Promise<void> {
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new TapsterError("tapster runs only on GitHub-hosted runners", "Use runs-on: ubuntu-24.04 or macos-15.");
  }
  const mode = core.getInput("mode", { required: true });
  if (mode === "cleanup") return cleanupMode();
  const ctx = await loadContext(core.getInput("config") || "tapster.yml");
  if (mode === "check") return check(ctx);
  if (mode === "fetch") return fetchMode(ctx);
  if (mode === "sign") return signMode(ctx);
  if (mode === "publish") return publishMode(ctx);
  if (mode === "render") return renderMode(ctx);
  throw new TapsterError(`unknown mode ${mode}`, "Use check, fetch, sign, publish, render or cleanup.");
}

try {
  await main();
} catch (e) {
  failure("tapster", e);
} finally {
  await writeSummary();
  if (failedCount() > 0) core.setFailed("tapster: some items failed; see the summary");
}
