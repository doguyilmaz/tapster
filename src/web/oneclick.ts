import type { AddOptionsView, AddView, InspectView, Problem } from "./contract";

export type RunStepId = "add" | "commit" | "push" | "merge";
export type RunStep = { id: RunStepId; label: string; state: "open" | "wait" | "done" | "attention"; problem: Problem | null };
export type OneGo = { steps: RunStep[]; added: AddView | null; done: boolean };
export type Send = <T>(path: string, body: unknown) => Promise<T>;

const LABELS: Record<RunStepId, string> = { add: "Add the project", commit: "Commit tapster's files", push: "Push", merge: "Merge the hub entry" };

export function oneGoProblem(c: { branch: string; defaultBranch: string; dirty: string[]; ahead: number | null }): string | null {
  if (c.branch !== c.defaultBranch) return `the clone is on ${c.branch}, not ${c.defaultBranch}`;
  if (c.dirty.length) return `the clone has changes of its own in ${c.dirty.join(", ")}`;
  if (c.ahead === null) return `the clone has no origin/${c.defaultBranch}, so tapster cannot tell which commits are on GitHub yet`;
  if (c.ahead) return `the clone has ${c.ahead} ${c.ahead === 1 ? "commit" : "commits"} that ${c.ahead === 1 ? "is" : "are"} not on GitHub yet`;
  return null;
}

export function oneGoRefusal(info: InspectView): string | null {
  const p = oneGoProblem(info);
  return p && `${p.charAt(0).toUpperCase()}${p.slice(1)}.`;
}

const problemOf = (e: unknown): Problem =>
  e && typeof e === "object" && "problem" in e && (e as { problem?: Problem }).problem ? (e as { problem: Problem }).problem : { reason: "tapster setup did not answer as expected", fix: "Reload the page and try again." };

export async function addInOneGo(send: Send, go: { hub: string; info: InspectView; options: AddOptionsView }, show: (run: OneGo) => void): Promise<OneGo> {
  const { info } = go;
  const run: OneGo = { steps: (Object.keys(LABELS) as RunStepId[]).map((id) => ({ id, label: LABELS[id], state: "open", problem: null })), added: null, done: false };
  const mark = (id: RunStepId, state: RunStep["state"], problem: Problem | null = null, label?: string) => {
    run.steps = run.steps.map((s) => (s.id === id ? { ...s, state, problem, label: label ?? s.label } : s));
    show({ ...run });
  };
  const step = async (id: RunStepId, f: () => Promise<string | void>): Promise<boolean> => {
    mark(id, "wait");
    try {
      mark(id, "done", null, (await f()) ?? undefined);
      return true;
    } catch (e) {
      mark(id, "attention", problemOf(e));
      return false;
    }
  };
  const ok =
    (await step("add", async () => {
      const added = await send<AddView>("/api/projects/add", { hub: go.hub, path: info.path, options: go.options, oneGo: true });
      run.added = added;
      if (!added.pr || !added.entry || !added.head) throw { problem: { reason: "tapster could not open the hub's pull request", fix: "The notes below say why. Commit and push tapster's files yourself, then fix the hub entry." } };
    })) &&
    (await step("commit", async () => {
      const files = run.added!.files;
      if (!files.length) return "Nothing to commit";
      const r = await send<{ committed: boolean }>("/api/projects/commit", { path: info.path, files });
      return r.committed ? undefined : "Nothing to commit";
    })) &&
    (await step("push", async () => void (await send("/api/projects/push", { path: info.path })))) &&
    (await step("merge", async () => void (await send("/api/projects/merge", { hub: go.hub, name: info.name, repo: info.repo, entry: run.added!.entry, sha: run.added!.head }))));
  run.done = ok;
  show({ ...run });
  return run;
}
