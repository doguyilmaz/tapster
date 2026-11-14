import { useState } from "preact/hooks";
import type { InspectView, Problem as ProblemView, SyncView } from "../contract";
import { post } from "./api";
import { confirm } from "./confirm";
import { problemOf, say } from "./state";
import { Busy, Cmd, Note, Problem } from "./ui";

type Synced = Extract<SyncView, { state: "synced" }>;

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

function Result({ r, defaultBranch }: { r: Synced; defaultBranch: string }) {
  const where = r.from ? `git switch ${r.from} && git stash pop` : "git stash pop";
  return (
    <>
      <Note tone={r.fetched ? "ok" : "warn"} title={`The clone is on ${r.branch} now`}>
        <span>
          {!r.fetched
            ? "GitHub did not answer, so it may miss the newest commits. Try again later."
            : r.pulled
              ? `It brought in ${commits(r.pulled)} from GitHub.`
              : r.diverged
                ? ""
                : "It matches GitHub."}
        </span>
      </Note>
      {r.stashed && (
        <Note tone="info" title="Your changes are put aside, not lost">
          <span>git stash keeps them. To bring them back{r.from ? ` on ${r.from}` : ""}, run:</span>
          <Cmd text={where} />
        </Note>
      )}
      {r.diverged && (
        <Note tone="warn" title={`${defaultBranch} has commits on both sides`}>
          <span>
            This clone has {commits(r.diverged.ahead)} on {defaultBranch} that GitHub does not have and GitHub has {commits(r.diverged.behind)} this clone does not have. tapster did not combine them,
            so nothing is lost. To combine them, run:
          </span>
          <Cmd text={`git pull --rebase origin ${defaultBranch}`} />
        </Note>
      )}
    </>
  );
}

export function BranchSync({ info, onSynced }: { info: InspectView; onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [result, setResult] = useState<Synced | null>(null);
  const target = info.defaultBranch;
  const send = (stash: boolean) => post<SyncView>("/api/projects/sync", { path: info.path, stash });
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      let r = await send(false);
      if (r.state === "changes") {
        const asked = confirm(
          "Put your uncommitted changes aside?",
          <>
            <p>
              {r.files.length === 1 ? "A file has" : `${r.files.length} files have`} changes that are not committed. tapster puts them aside with git stash, then switches to {target}. Nothing is
              deleted: you bring them back with one command whenever you want.
            </p>
            <ul class="log">
              {r.files.slice(0, 8).map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
              {r.files.length > 8 && <li>And {r.files.length - 8} more.</li>}
            </ul>
          </>,
          "Put aside and switch",
        );
        if (!(await asked)) return;
        r = await send(true);
      }
      if (r.state === "synced") {
        setResult(r);
        say("ok", `The clone is on ${r.branch} now.`);
        onSynced();
      }
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (info.branch === target) return result && <Result r={result} defaultBranch={target} />;
  return (
    <Note tone="warn" title={`This clone is on ${info.branch}, not ${target}`}>
      <span>
        tapster changes the files on {info.branch}. Releases use the workflow on {target}, so the change counts once it is merged there. tapster can move this clone to {target} and bring it up to
        date with GitHub. {info.branch === "a detached HEAD" ? "" : `${info.branch} and its commits stay as they are.`}
      </span>
      <Problem problem={problem} />
      <div class="row">
        <Busy busy={busy} class="btn secondary small" onClick={() => void start()}>
          Switch to {target} and update
        </Busy>
      </div>
    </Note>
  );
}
