import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FollowView, Problem as ProblemView, ProjectStatus } from "../contract";
import { type ProjectStep, type ProjectStepId, canRelease, projectNext, projectSteps, tagCommand, tagProblem } from "../status";
import { get, post } from "./api";
import { hubName, problemOf, say, statusOf, tilde } from "./state";
import { Badge, Busy, Cmd, Icon, Note, Out, Problem, Spinner } from "./ui";

export const KIND: Record<string, string> = { go: "Go with GoReleaser", bun: "Bun", app: "Mac app with Sparkle" };

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

const q = (s: ProjectStatus) => `hub=${encodeURIComponent(hubName.value ?? "")}&repo=${encodeURIComponent(s.repo)}`;

export function StatusBadge({ s }: { s: ProjectStatus }) {
  const next = projectNext(s);
  if (!next) return <Badge tone="ok">{s.release.latest ? `Published ${s.release.latest.tag}` : "Ready"}</Badge>;
  return <Badge tone={next.state === "attention" ? "error" : next.state === "wait" ? undefined : "next"}>{next.label}</Badge>;
}

export function StatusRows({ list, paths, onOpen }: { list: ProjectStatus[]; paths: Map<string, string>; onOpen: (s: ProjectStatus) => void }) {
  return (
    <div class="card list">
      {list.map((s) => {
        const path = paths.get(s.repo.toLowerCase());
        return (
          <div class="item" key={s.repo}>
            <button type="button" class="link" onClick={() => onOpen(s)}>
              <span class="name">{s.repo}</span>
              <span class="path">{path ? tilde(path) : "No clone on this computer"}</span>
            </button>
            <span class="row">
              <Badge>{KIND[s.kind] ?? s.kind}</Badge>
              <StatusBadge s={s} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MARK: Record<ProjectStep["state"], { icon: "check" | "alert" | "circle" | "loader"; cls: string; label: string }> = {
  done: { icon: "check", cls: "ok", label: "Done" },
  open: { icon: "circle", cls: "no", label: "To do" },
  wait: { icon: "loader", cls: "no", label: "Waiting" },
  attention: { icon: "alert", cls: "bad", label: "Needs you" },
};

function Mark({ state }: { state: ProjectStep["state"] }) {
  const m = MARK[state];
  return <span class={m.cls}>{state === "wait" ? <Spinner label={m.label} /> : <Icon name={m.icon} label={m.label} />}</span>;
}

const sentence = (parts: string[]) => {
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

function Step({ state, title, children }: { state: ProjectStep["state"]; title: string; children: ComponentChildren }) {
  return (
    <li>
      <Mark state={state} />
      <span class="stack tight" style="gap: 0.3rem; flex: 1; min-width: 0">
        <strong>{title}</strong>
        {children}
      </span>
    </li>
  );
}

function AppStep({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching || s.app.reaches !== false) return;
    let timer = 0;
    let wait = 5000;
    const until = Date.now() + 15 * 60_000;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await get<{ reaches: boolean | null }>(`/api/projects/reach?${q(s)}`);
          if (r.reaches !== false) {
            const next = await statusOf(s.repo);
            if (next) onStatus(next);
            return;
          }
          wait = 5000;
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      if (Date.now() < until) timer = window.setTimeout(tick, wait);
      else setWatching(false);
    };
    timer = window.setTimeout(tick, 2000);
    return () => clearTimeout(timer);
  }, [watching, s.app.reaches, s.repo]);
  if (s.app.reaches) return <span class="muted">The hub's App reaches {s.repo}.</span>;
  if (!s.app.installUrl) return <span class="muted">Create the hub's GitHub App in Setup first.</span>;
  const link = (
    <Out href={s.app.installUrl} class={s.app.reaches === false ? "btn primary small" : "btn secondary small"} onClick={() => setWatching(true)}>
      Install the App on {s.name}
    </Out>
  );
  if (s.app.reaches === null) {
    return (
      <>
        <span class="muted">GitHub shows an App's repositories only to the App, so tapster cannot check this. Each hub run reports a project the App cannot reach.</span>
        <div class="row">{link}</div>
      </>
    );
  }
  return (
    <>
      <span class="muted">The hub cannot publish {s.repo} until its App reaches it. GitHub preselects the project; keep "Only select repositories".</span>
      <div class="row">{link}</div>
      {watching && (
        <p class="row muted small" role="status">
          <Spinner label="Checking" /> This updates by itself once you click Install on GitHub.
        </p>
      )}
    </>
  );
}

function Follow({ s, tag, onStatus }: { s: ProjectStatus; tag: string; onStatus: (s: ProjectStatus) => void }) {
  const [view, setView] = useState<FollowView | null>(null);
  useEffect(() => {
    let timer = 0;
    let wait = 5000;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const v = await get<FollowView>(`/api/projects/follow?${q(s)}&tag=${encodeURIComponent(tag)}`);
          setView(v);
          wait = 5000;
          const failed = v.run?.status === "completed" && v.run.conclusion !== "success" && !v.draft && !v.published;
          if (v.published || v.draft?.note || failed) {
            const next = await statusOf(s.repo).catch(() => null);
            if (next) onStatus(next);
            return;
          }
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 1000);
    return () => clearTimeout(timer);
  }, [tag, s.repo]);
  const run = view?.run ?? null;
  const ran = run?.status === "completed";
  const runOk = ran && run.conclusion === "success";
  const draftOpen = Boolean(view?.draft || view?.published);
  const item = (state: ProjectStep["state"], text: ComponentChildren, link?: { href: string; label: string }) => (
    <li>
      <Mark state={state} />
      <span class="row" style="gap: 0.5rem">
        <span>{text}</span>
        {link && (
          <a href={link.href} target="_blank" rel="noopener noreferrer" class="small">
            {link.label}
          </a>
        )}
      </span>
    </li>
  );
  return (
    <div class="stack tight">
      <p>
        <strong>Tagged {tag}</strong> <span class="muted">on {s.defaultBranch}.</span>
      </p>
      <ol class="checks" aria-live="polite">
        {item(!run ? "wait" : !ran ? "wait" : runOk || draftOpen ? "done" : "attention", !run ? "The release workflow starts" : !ran ? "The release workflow runs" : runOk || draftOpen ? "The release workflow finished" : `The release workflow ended: ${run.conclusion ?? "unknown"}`, run ? { href: run.url, label: "Open the run" } : undefined)}
        {item(view?.draft?.note ? "attention" : draftOpen ? "done" : "wait", view?.draft?.note ? view.draft.note : draftOpen ? "The workflow opened the draft" : "The workflow opens a draft", view?.draft ? { href: view.draft.url, label: "Open the draft" } : undefined)}
        {item(view?.published ? "done" : view?.draft?.note ? "open" : "wait", view?.published ? "Published" : "The hub signs and publishes it on its next run", view?.published ? { href: view.published.url, label: "Open the release" } : { href: view?.hub ?? "#", label: "Hub runs" })}
      </ol>
    </div>
  );
}

function ReleaseBox({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const [version, setVersion] = useState(s.release.next);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  useEffect(() => setVersion(s.release.next), [s.release.next]);
  if (started) return <Follow s={s} tag={started} onStatus={onStatus} />;
  const gate = canRelease(s);
  if (!gate.ok) return <p class="muted">{gate.why}</p>;
  const head = s.release.head!;
  const tag = version.trim();
  const bad = tagProblem(tag, s.release.highest);
  const id = `version-${s.name}`;
  const release = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await post("/api/projects/release", { hub: hubName.value, repo: s.repo, tag, sha: head.sha });
      setStarted(tag);
      say("ok", `Tagged ${tag} on ${s.repo}.`);
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="release stack tight">
      <p class="muted small">tapster tags this commit on GitHub with your sign-in, never the clone on this computer. The tag starts the release workflow.</p>
      <dl class="facts">
        <dt>Commit</dt>
        <dd>
          <a href={head.url} target="_blank" rel="noopener noreferrer" class="mono">
            {head.sha.slice(0, 7)}
          </a>{" "}
          {head.subject}
        </dd>
        <dt>Date</dt>
        <dd>{when(head.date)}</dd>
        <dt>Branch</dt>
        <dd class="mono">{s.defaultBranch}</dd>
      </dl>
      <div class="field">
        <label for={id}>Version</label>
        <input id={id} class="input mono" value={version} onInput={(e) => setVersion((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autoComplete="off" aria-invalid={bad ? "true" : undefined} aria-describedby={`${id}-hint`} />
        <span class={bad ? "hint bad" : "hint"} id={`${id}-hint`}>
          {bad ? `${bad}.` : s.release.highest ? `The next patch after ${s.release.highest}, the highest tag on GitHub.` : "GitHub has no version tag for this project yet."}
        </span>
      </div>
      {s.entry.state !== "merged" && <Note tone="info">The hub publishes it once you merge the hub entry.</Note>}
      <Problem problem={problem} />
      <div class="row">
        <Busy busy={busy} class="btn primary" onClick={release} disabled={Boolean(bad)}>
          <Icon name="play" />
          Release {tag || "a version"}
        </Busy>
      </div>
      {!bad && (
        <details class="more">
          <summary>Or tag it from a terminal</summary>
          <Cmd text={tagCommand(s.repo, tag, { sha: head.sha }) ?? ""} />
        </details>
      )}
    </div>
  );
}

export function StatusCard({ s, onStatus, fix }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void; fix: (id: ProjectStepId) => ComponentChildren }) {
  const [busy, setBusy] = useState(false);
  const steps = projectSteps(s);
  const state = (id: ProjectStepId) => steps.find((x) => x.id === id)?.state ?? "done";
  const r = s.release;
  const refresh = async () => {
    setBusy(true);
    try {
      const next = await statusOf(s.repo);
      if (next) onStatus(next);
    } catch (e) {
      say("error", problemOf(e).reason);
    } finally {
      setBusy(false);
    }
  };
  const remove = s.secrets.names.map((n) => `gh secret delete ${n} --repo ${s.repo}`);
  return (
    <section class="stack tight" aria-labelledby={`status-${s.name}`}>
      <div class="spread">
        <h3 id={`status-${s.name}`} class="section-title">
          Where {s.name} stands
        </h3>
        <Busy busy={busy} class="btn quiet small" onClick={refresh}>
          {!busy && <Icon name="refresh" />}
          Check again
        </Busy>
      </div>
      {s.unreadable ? (
        <Note tone="error" title={`GitHub did not show ${s.repo}`}>
          <span>{s.unreadable} If the repository was renamed or deleted, change or remove its entry in the hub's tapster.yml.</span>
        </Note>
      ) : (
      <ol class="checks status">
        <Step state={state("setup")} title="Release workflow">
          {s.setup.ok ? (
            <span class="muted">On {s.defaultBranch}, the release workflow opens drafts, attests the archives and leaves signing to the hub.</span>
          ) : (
            <>
              <span class="muted">{sentence(s.setup.problems)}</span>
              {fix("setup")}
            </>
          )}
        </Step>
        <Step state={state("protect")} title="Protection">
          {s.protection.off ? (
            <span class="muted">The hub entry sets protection: off, so a stolen App key could tag code the hub would sign.</span>
          ) : s.protection.ok ? (
            <span class="muted">Only you can create, move or delete its branches and tags.</span>
          ) : (
            <>
              <span class="muted">Not protected by tapster's rulesets. {sentence(s.protection.problems)}</span>
              {fix("protect")}
            </>
          )}
        </Step>
        <Step state={state("entry")} title="Hub entry">
          {s.entry.state === "merged" ? (
            <span class="muted">In {hubName.value}'s tapster.yml.</span>
          ) : s.entry.state === "proposed" ? (
            <>
              <span class="muted">Waiting in a pull request on {hubName.value}. Merge it to let the hub publish {s.name}.</span>
              <div class="row">
                <Out href={s.entry.pr!} class="btn primary small">
                  <Icon name="pr" />
                  Review and merge
                </Out>
              </div>
            </>
          ) : (
            <>
              <span class="muted">Not in the hub yet.</span>
              {fix("entry")}
            </>
          )}
        </Step>
        <Step state={state("app")} title="The hub's App">
          <AppStep s={s} onStatus={onStatus} />
        </Step>
        <Step state={state("release")} title="Releases">
          {r.draft ? (
            r.draft.note ? (
              <Note tone="error" title={`The hub will not publish the draft ${r.draft.tag}`}>
                <span>{r.draft.note}</span>
                <a href={r.draft.url} target="_blank" rel="noopener noreferrer">
                  Open the draft
                </a>
              </Note>
            ) : (
              <span class="muted">
                {r.draft.tag} waits as a draft; the hub publishes it on its next run.{" "}
                <a href={r.draft.url} target="_blank" rel="noopener noreferrer">
                  Open the draft
                </a>
              </span>
            )
          ) : r.latest ? (
            <span class="muted">
              The latest release is{" "}
              <a href={r.latest.url} target="_blank" rel="noopener noreferrer">
                {r.latest.tag}
              </a>
              {r.latest.byHub ? ", published by the hub." : ". The hub did not publish it."}
            </span>
          ) : (
            <span class="muted">No release yet.</span>
          )}
          <ReleaseBox s={s} onStatus={onStatus} />
        </Step>
        {s.secrets.names.length > 0 && s.secrets.published && (
          <Step state="open" title="Old release secrets">
            <span class="muted">The hub has published a release of {s.name}, so these secrets are no longer needed. tapster shows their names only.</span>
            {remove.map((c) => (
              <Cmd key={c} text={c} />
            ))}
          </Step>
        )}
      </ol>
      )}
      {s.secrets.names.length > 0 && !s.secrets.published && (
        <Note tone="info" title="Old release secrets">
          <span>
            {s.repo} still holds {s.secrets.names.join(", ")}. Delete them once the hub has published a release of {s.name}; this card then shows the commands.
          </span>
        </Note>
      )}
    </section>
  );
}
