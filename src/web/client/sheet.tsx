import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AddOptionsView, AddView, DiffView, InspectView, Problem as ProblemView, ProjectStatus } from "../contract";
import { type OneGo, addInOneGo, oneGoRefusal } from "../oneclick";
import type { ProjectStepId } from "../status";
import { changedOnly, lineDiff, notes } from "../steps";
import { post } from "./api";
import { loadClones, loadHub, problemOf, recall, remember, say, statuses, statusOf, tilde } from "./state";
import { KIND, Mark, StatusCard } from "./status";
import { Badge, Busy, Cmd, Icon, Note, Problem, Spinner } from "./ui";

export type SheetTarget = { repo: string; path: string | null; others: string[]; listed: boolean };

function Frame({ title, sub, onClose, children }: { title: string; sub: ComponentChildren; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (!ref.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", keys);
    return () => {
      removeEventListener("keydown", keys);
      before?.focus();
    };
  }, []);
  return (
    <>
      <div class="sheet-back" onClick={onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref}>
        <div class="sheet-head">
          <div class="stack tight" style="flex: 1; min-width: 0; gap: 0.1rem">
            <h2 id="sheet-title" class="section-title mono" style="font-size: 1.05rem; overflow-wrap: anywhere">
              {title}
            </h2>
            <span class="faint small" style="overflow-wrap: anywhere">
              {sub}
            </span>
          </div>
          <button type="button" class="btn quiet small" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </>
  );
}

function Switch({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children: ComponentChildren }) {
  return (
    <label class="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </label>
  );
}

const CHANGE: Record<DiffView["files"][number]["change"], { label: string; tone?: "next" | "error" | "warn" }> = {
  create: { label: "New", tone: "next" },
  remove: { label: "Removed", tone: "error" },
  update: { label: "Changed", tone: "warn" },
  same: { label: "No changes" },
};

function Diff({ view }: { view: DiffView }) {
  return (
    <div class="stack tight files">
      {view.files.map((f) => {
        const lines = f.before === null ? null : changedOnly(lineDiff(f.before, f.after ?? ""));
        return (
          <details class="file" key={f.path} open={f.change !== "same"}>
            <summary>
              <Icon name="file" />
              <code>{f.path}</code>
              <Badge tone={CHANGE[f.change].tone}>{CHANGE[f.change].label}</Badge>
            </summary>
            <pre class="block diff" tabIndex={0}>
              {lines
                ? lines.map((l, i) => (
                    <span key={i} class={l.kind === "gap" ? "hunk" : l.kind}>
                      {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : l.kind === "gap" ? "@ " : "  "}
                      {l.text}
                      {"\n"}
                    </span>
                  ))
                : f.after}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function Changes({ repo, path, files, ahead }: { repo: string; path: string; files: string[]; ahead: number | null }) {
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    setDiff(null);
    if (files.length) post<DiffView>("/api/projects/diff", { path, files }).then(setDiff, (e) => setProblem(problemOf(e)));
  }, [path, files.join("\n")]);
  const act = async (name: string, f: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(null);
    }
  };
  const real = diff?.files.filter((f) => f.change !== "same") ?? [];
  const nothing = files.length === 0 || (diff !== null && real.length === 0);
  const push = (
    <Busy
      busy={busy === "push"}
      class="btn primary"
      onClick={() =>
        act("push", async () => {
          await post("/api/projects/push", { path });
          setPushed(true);
          say("ok", `Pushed ${repo}.`);
        })
      }
    >
      Push
    </Busy>
  );
  return (
    <div class="stack tight">
      {files.length > 0 && !diff && !problem && <Spinner label="Reading the changes" />}
      {diff && <Diff view={diff} />}
      <Problem problem={problem} />
      {nothing ? (
        <div class="row">
          <span class="row muted">
            <Icon name="check" /> No changes: the clone's files match its last commit.
          </span>
          {ahead !== null && ahead > 0 && (pushed ? <Badge tone="ok">Pushed</Badge> : push)}
        </div>
      ) : (
        diff && (
          <>
            <div class="row">
              {committed ? (
                <Badge tone="ok">Committed</Badge>
              ) : (
                <Busy
                  busy={busy === "commit"}
                  class="btn primary"
                  onClick={() =>
                    act("commit", async () => {
                      await post("/api/projects/commit", { path, files: real.map((f) => f.path) });
                      setCommitted(true);
                    })
                  }
                >
                  Commit {real.length === 1 ? "this file" : "these files"}
                </Busy>
              )}
              {committed && (pushed ? <Badge tone="ok">Pushed</Badge> : push)}
            </div>
            <p class="muted small">tapster commits only these files, in your own git setup: your hooks and commit signing apply.</p>
          </>
        )
      )}
    </div>
  );
}

const ONE_GO = "tapster.oneGo";

function AddForm({ info, hubName, status, onAdded, onOneGo, onCancel }: { info: InspectView; hubName: string; status: ProjectStatus | null; onAdded: (a: AddView) => void; onOneGo: (o: AddOptionsView) => void; onCancel: (() => void) | null }) {
  const [workflow, setWorkflow] = useState(info.workflow ?? "release.yml");
  const [autoTag, setAutoTag] = useState(status?.release.autoTag ?? false);
  const [dependabot, setDependabot] = useState(info.dependabot);
  const [force, setForce] = useState(false);
  const [oneGo, setOneGo] = useState(recall(ONE_GO) === "1");
  const [preview, setPreview] = useState<DiffView | null>(null);
  const [busy, setBusy] = useState<"add" | "preview" | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const noWorkflow = info.kind === "go" && info.workflows.length === 0;
  const options = { workflow, autoTag, dependabot, force };
  const offered = !status || status.entry.state === "missing";
  const refusal = offered && oneGo ? oneGoRefusal(info) : null;
  const inOneGo = offered && oneGo && !refusal;
  useEffect(() => setPreview(null), [workflow, autoTag, dependabot, force]);
  const act = async (what: "add" | "preview", f: () => Promise<void>) => {
    setBusy(what);
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(null);
    }
  };
  const add = () => {
    if (inOneGo) return onOneGo(options);
    return act("add", async () => {
      onAdded(await post<AddView>("/api/projects/add", { hub: hubName, path: info.path, options }));
      void loadHub();
    });
  };
  const toggle = (on: boolean) => {
    setOneGo(on);
    remember(ONE_GO, on ? "1" : null);
  };
  return (
    <>
      <dl class="facts">
        <dt>Kind</dt>
        <dd>{KIND[info.kind]}</dd>
        <dt>Branch</dt>
        <dd class="mono">{info.branch}</dd>
        <dt>Repository</dt>
        <dd>
          {info.private ? "Private" : "Public"}, {info.protected ? "protected by tapster's rulesets" : "not protected yet"}
        </dd>
        <dt>Hub</dt>
        <dd>{info.inHub ? "Already in the hub" : info.proposed ? "Proposed, waiting for you to merge" : "Not in the hub yet"}</dd>
      </dl>
      {info.branch !== info.defaultBranch && (
        <Note tone="warn" title={`This clone is on ${info.branch}, not ${info.defaultBranch}`}>
          <span>tapster changes the files on {info.branch}. Releases use the workflow on {info.defaultBranch}, so the change counts once it is merged there.</span>
        </Note>
      )}
      {info.dirty.length > 0 && (
        <Note tone="warn" title="Uncommitted changes in files tapster edits">
          <span>{info.dirty.join(", ")}. Commit or stash them first, so tapster's changes stay apart from yours.</span>
        </Note>
      )}
      {info.private && (
        <Note tone="warn" title="This repository is private">
          <span>The hub can publish it, but Homebrew, Scoop, apt and dnf users can only install from public projects. Its rulesets need a paid plan; without them the hub refuses it unless you accept the risk with protection: off.</span>
        </Note>
      )}
      {!info.apple && <Note tone="info" title="The hub has no Apple credentials">tapster leaves the macOS builds out of this project's entry.</Note>}
      <div class="stack tight">
        <h3 class="section-title">Options</h3>
        {info.kind === "go" &&
          (noWorkflow ? (
            <Note tone="error" title="No workflow runs GoReleaser">
              <span>tapster edits the workflow that runs goreleaser/goreleaser-action. Add one to .github/workflows first.</span>
            </Note>
          ) : (
            <div class="field">
              <label for="workflow">The workflow that runs GoReleaser</label>
              <select id="workflow" class="input" value={workflow} onChange={(e) => setWorkflow((e.currentTarget as HTMLSelectElement).value)}>
                {info.workflows.map((w) => (
                  <option key={w} value={w}>
                    .github/workflows/{w}
                  </option>
                ))}
              </select>
            </div>
          ))}
        {info.kind !== "go" && info.releaseFlow === "other" && (
          <Switch checked={force} onChange={setForce} title="Replace the existing release workflow">
            .github/workflows/release.yml exists and tapster does not recognize it. Without this, tapster only adds the step that rings the hub, if the workflow opens a draft release.
          </Switch>
        )}
        <Switch checked={autoTag} onChange={setAutoTag} title="Let the release workflow push tags">
          For workflows that decide the version and tag by themselves. tapster adds a deploy key that only the default branch's release environment can use; the rulesets let deploy keys tag.
        </Switch>
        <Switch checked={dependabot} onChange={setDependabot} title="Keep Dependabot's pull requests">
          {info.dependabot ? "This clone uses Dependabot. " : ""}Branches named dependabot/... stay open to anything with write access, the hub's App included, so a stolen App key could run your workflows on its own code there.
        </Switch>
      </div>
      <div class="stack tight">
        <h3 class="section-title">What tapster does</h3>
        <ul class="checks">
          <li>
            <Icon name="right" />
            <span>{info.kind === "go" ? `Edits .goreleaser.yaml and .github/workflows/${workflow}: drafts instead of releases, an attestation step and the step that rings the hub.` : "Writes .github/workflows/release.yml: build, attest, open a draft and ring the hub."}{inOneGo ? "" : " You review and commit these in the next step."}</span>
          </li>
          <li>
            <Icon name="right" />
            <span>Protects {info.repo}: only you can create, move or delete branches and tags.</span>
          </li>
          <li>
            <Icon name="right" />
            <span>{status && status.entry.state !== "missing" ? `Keeps the project's entry in ${hubName} as it is.` : `Proposes the project's entry to ${hubName} as a pull request.`}</span>
          </li>
          {autoTag && (
            <li>
              <Icon name="right" />
              <span>Adds the deploy key "tapster tags" and a release environment.</span>
            </li>
          )}
          {inOneGo && (
            <li>
              <Icon name="right" />
              <span>Commits only its own files, pushes {info.defaultBranch} and merges the hub entry with your GitHub sign-in. It stops at the first step that fails.</span>
            </li>
          )}
        </ul>
      </div>
      {offered && (
        <Switch checked={oneGo} onChange={toggle} title="Add, commit, push and merge in one go">
          Off by default. This browser remembers your choice. Check the changes first if you want to see them before anything happens.
        </Switch>
      )}
      {refusal && (
        <Note tone="warn" title="Not in one go for this clone">
          <span>{refusal} Add then runs step by step.</span>
        </Note>
      )}
      {inOneGo && preview && <Diff view={preview} />}
      <Problem problem={problem} />
      <div class="row">
        <Busy busy={busy === "add"} class="btn primary" onClick={add} disabled={noWorkflow || busy !== null}>
          {inOneGo ? "Add, commit, push and merge" : status ? "Update the project" : `Add to ${hubName}`}
        </Busy>
        {inOneGo && !preview && (
          <Busy busy={busy === "preview"} class="btn secondary" disabled={noWorkflow || busy !== null} onClick={() => act("preview", async () => setPreview(await post<DiffView>("/api/projects/preview", { hub: hubName, path: info.path, options })))}>
            <Icon name="eye" />
            Check the changes first
          </Busy>
        )}
        {onCancel && (
          <button type="button" class="btn quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

function RunSteps({ run }: { run: OneGo }) {
  const stopped = run.steps.find((x) => x.state === "attention");
  return (
    <section class="stack tight" aria-labelledby="one-go">
      <h3 id="one-go" class="section-title">
        In one go
      </h3>
      <ol class="checks" aria-live="polite">
        {run.steps.map((x) => (
          <li key={x.id}>
            <Mark state={x.state} />
            <span class="stack tight" style="gap: 0.3rem; flex: 1; min-width: 0">
              <span>{x.label}</span>
              {x.problem && <Problem problem={x.problem} />}
            </span>
          </li>
        ))}
      </ol>
      {stopped && <p class="muted small">tapster stopped there and did nothing after it. The steps below finish it by hand.</p>}
    </section>
  );
}

function OtherClones({ path, others, onPick }: { path: string; others: string[]; onPick: (p: string) => void }) {
  return (
    <Note tone="info" title="This repository has more than one clone here">
      <span>tapster uses {tilde(path)}, the clone on the default branch or the one changed last. You can pick another:</span>
      <ul class="log">
        {others.map((o) => (
          <li key={o} class="row" style="justify-content: space-between">
            <code>{tilde(o)}</code>
            <button type="button" class="btn secondary small" onClick={() => onPick(o)}>
              Use this clone
            </button>
          </li>
        ))}
      </ul>
    </Note>
  );
}

export function ProjectSheet({ target, hubName, onClose }: { target: SheetTarget; hubName: string; onClose: () => void }) {
  const [path, setPath] = useState(target.path);
  const [others, setOthers] = useState(target.others);
  const listed = statuses.value?.hub === hubName ? (statuses.value.list.find((x) => x.repo.toLowerCase() === target.repo.toLowerCase()) ?? null) : null;
  const [status, setStatus] = useState<ProjectStatus | null>(listed);
  const [waiting, setWaiting] = useState(target.listed && !listed);
  const [info, setInfo] = useState<InspectView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [editing, setEditing] = useState(false);
  const [added, setAdded] = useState<AddView | null>(null);
  const [run, setRun] = useState<OneGo | null>(null);
  const inspect = (dir: string) => post<InspectView>("/api/projects/inspect", { hub: hubName, path: dir }).then(setInfo, (e) => setProblem(problemOf(e)));
  useEffect(() => {
    setInfo(null);
    setProblem(null);
    if (path) void inspect(path);
  }, [path]);
  useEffect(() => {
    if (!waiting) return;
    statusOf(target.repo)
      .then((s) => setStatus(s && s.entry.state !== "missing" ? s : null), (e) => setProblem(problemOf(e)))
      .finally(() => setWaiting(false));
  }, []);
  const pick = (p: string) => {
    setOthers([...others.filter((o) => o !== p), ...(path ? [path] : [])]);
    setPath(p);
    setEditing(false);
    setAdded(null);
    setRun(null);
  };
  const onAdded = (a: AddView) => {
    setAdded(a);
    setEditing(false);
    if (path) void inspect(path);
    void loadClones().catch(() => undefined);
    void statusOf(target.repo).then(setStatus, (e) => setProblem(problemOf(e)));
  };
  const oneGo = async (options: AddOptionsView) => {
    if (!info) return;
    setEditing(false);
    const done = await addInOneGo(post, { hub: hubName, info, options }, (r) => {
      setRun(r);
      if (r.added) setAdded(r.added);
    });
    if (done.added) onAdded(done.added);
    void loadHub();
    if (done.done) say("ok", `Added ${target.repo} and merged its hub entry.`);
  };
  const running = run !== null && run.steps.some((x) => x.state === "wait");
  const addFixes = status !== null && (status.entry.state === "missing" || (!status.protection.ok && !status.protection.off) || (!status.setup.ok && (!info || !info.ready)));
  const fix = (id: ProjectStepId): ComponentChildren => {
    if (!path) return id === "setup" || addFixes ? <span class="muted small">No clone of it turned up on this computer. Add its folder in Projects or run tapster add in a clone.</span> : null;
    if (id !== "setup" || !info) return null;
    if (added?.files.length && !run?.done) return <span class="muted small">Commit and push the changes above{info.branch === info.defaultBranch ? "" : `, then merge them into ${info.defaultBranch}`}. Then click Refresh.</span>;
    if (!info.ready) return <span class="muted small">The clone does not have tapster's release files yet. Update the project below.</span>;
    if (info.dirty.length) {
      return (
        <>
          <span class="muted small">The clone has tapster's files. Commit and push them, then merge them into {info.defaultBranch} if you work on another branch.</span>
          <Changes repo={target.repo} path={info.path} files={info.dirty} ahead={info.ahead} />
        </>
      );
    }
    if (info.ahead !== null && info.ahead > 0) {
      return (
        <>
          <span class="muted small">The clone's last commit has tapster's files but is not on GitHub yet.</span>
          <Changes repo={target.repo} path={info.path} files={[]} ahead={info.ahead} />
        </>
      );
    }
    return <span class="muted small">{info.branch === info.defaultBranch ? `The clone has tapster's files. Push ${info.branch}, then check again.` : `The clone's branch ${info.branch} has tapster's files. Merge it into ${info.defaultBranch} on GitHub.`}</span>;
  };
  const card = status && <StatusCard s={status} onStatus={setStatus} fix={fix} />;
  return (
    <Frame title={target.repo} sub={path ? tilde(path) : "No clone on this computer"} onClose={onClose}>
      {path && !info && !problem && (
        <p class="row muted" role="status">
          <Spinner /> Reading the clone and its repository
        </p>
      )}
      <Problem problem={problem} />
      {path && others.length > 0 && !added && <OtherClones path={path} others={others} onPick={pick} />}
      {run && <RunSteps run={run} />}
      {waiting ? (
        <p class="row muted" role="status">
          <Spinner /> Reading where {target.repo} stands
        </p>
      ) : running && !added ? null : added ? (
        <>
          <Note tone="ok" title={`tapster prepared ${target.repo}`} />
          <ul class="checks small">
            {notes(added.lines).map((n, i) => (
              <li key={i}>
                <Icon name="right" />
                <span class="stack tight" style="min-width: 0">
                  <span class="muted" style="overflow-wrap: anywhere">
                    {n.text}
                  </span>
                  {n.block && (
                    <pre class="block" tabIndex={0}>
                      {n.block}
                    </pre>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {!running && !run?.done && (
            <section class="stack tight">
              <h3 class="section-title">Review and commit the changes</h3>
              <Changes repo={target.repo} path={path!} files={added.files} ahead={info?.ahead ?? null} />
            </section>
          )}
          {!running && (card ?? <Spinner label="Reading the project's status" />)}
        </>
      ) : status && !editing ? (
        <>
          {card}
          {addFixes && info && (
            <div class="row" style="border-top: 1px solid var(--line); padding-top: 1rem">
              <button type="button" class="btn primary" onClick={() => setEditing(true)}>
                Update the project
                <Icon name="arrow" />
              </button>
              <span class="muted small">tapster prepares the release files, protects the repository and proposes a missing entry.</span>
            </div>
          )}
          {addFixes && !path && <Cmd text="bunx @doguyilmaz/tapster add" />}
        </>
      ) : (
        info && (
          <AddForm
            info={info}
            hubName={hubName}
            status={status}
            onAdded={(a) => {
              setRun(null);
              onAdded(a);
            }}
            onOneGo={(o) => void oneGo(o)}
            onCancel={status ? () => setEditing(false) : null}
          />
        )
      )}
    </Frame>
  );
}
