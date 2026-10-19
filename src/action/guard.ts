import { TapsterError } from "../errors";

export const TEMPLATE = "2";

const LEAK_TEST = "doguyilmaz/tapster/.github/workflows/leak.yml@";

export function guardRun(env: Record<string, string | undefined>, template: string): void {
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new TapsterError("tapster runs only on GitHub-hosted runners", "Use runs-on: ubuntu-24.04 or macos-15.");
  }
  const repo = (env.GITHUB_REPOSITORY ?? "").toLowerCase();
  const ref = (env.GITHUB_WORKFLOW_REF ?? "").toLowerCase();
  const leakTest = repo === "doguyilmaz/tapster" && ref.startsWith(LEAK_TEST);
  if (!leakTest) {
    if (ref !== `${repo}/.github/workflows/tapster.yml@refs/heads/main`) {
      throw new TapsterError("tapster runs only from .github/workflows/tapster.yml on the hub's main branch", "Start the hub's tapster workflow; other workflows and branches never get the credentials.");
    }
    if (env.GITHUB_EVENT_NAME !== "schedule" && env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
      throw new TapsterError(`tapster runs only on its schedule or a manual start, not on ${env.GITHUB_EVENT_NAME}`, "Restore the hub workflow with tapster init --workflow.");
    }
  }
  if (template !== TEMPLATE) {
    throw new TapsterError("the hub workflow was written for another tapster version", "Run tapster init --workflow in the hub clone, then commit and push.");
  }
}
