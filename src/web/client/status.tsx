import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FollowView, Problem as ProblemView, ProjectStatus, ReachView } from "../contract";
import { type ProjectStep, type ProjectStepId, bumps, canRelease, followSteps, projectNext, projectSteps, releasableParent, tagCommand, tagProblem } from "../status";
import { get, post } from "./api";
import { hub, hubName, problemOf, say, statusOf, tilde } from "./state";
import { Badge, Busy, Cmd, Icon, Note, Out, Problem, Spinner, ofProject } from "./ui";
import { capFirst } from "../steps";
import { Configuration } from "./config";

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

export function Mark({ state }: { state: ProjectStep["state"] }) {
  const m = MARK[state];
  return <span class={m.cls}>{state === "wait" ? <Spinner label={m.label} /> : <Icon name={m.icon} label={m.label} />}</span>;
}

const sentence = (parts: string[]) => {
  const text = parts.join("; ");
  return `${capFirst(text)}.`;
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

export function reachLine(s: ProjectStatus): string {
  const a = s.app;
  if (a.how === "key") return a.reaches ? `The App reaches ${s.repo}; tapster checked with the App's key.` : `The App does not reach ${s.repo} yet; tapster checked with the App's key.`;
  if (a.how === "run") return a.reaches ? `The hub's check on ${when(a.at ?? "")} reached ${s.repo}.` : `The hub's check on ${when(a.at ?? "")} could not reach ${s.repo}: ${a.reason}.`;
  if (a.how === "release") return `The hub has published a release of ${s.name}, so its App reached ${s.repo} then.`;
  return sentence([a.reason ?? "the hub has not checked it yet"]);
}

function AppStep({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const [armed, setArmed] = useState(false);
  const [asked, setAsked] = useState<number | null>(null);
  const [live, setLive] = useState<{ running: boolean; run: string | null } | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const ask = async () => {
    setProblem(null);
    setArmed(false);
    try {
      if (s.app.how === "key") {
        const next = await statusOf(s.repo);
        if (next) onStatus(next);
        return;
      }
      const r = await post<{ started: boolean; run: string | null; at: string }>("/api/projects/check", { hub: hubName.value });
      setLive({ running: true, run: r.run });
      setAsked(Date.parse(r.at));
    } catch (e) {
      setProblem(problemOf(e));
    }
  };
  useEffect(() => {
    if (!armed) return;
    const back = () => {
      if (document.hidden) return;
      setArmed(false);
      void ask();
    };
    document.addEventListener("visibilitychange", back);
    addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      removeEventListener("focus", back);
    };
  }, [armed]);
  const watching = asked === null && s.app.running;
  useEffect(() => {
    if (asked === null && !watching) return;
    const from = asked ?? 0;
    let timer = 0;
    let wait = 6000;
    let again = false;
    const until = Date.now() + 20 * 60_000;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const v = await get<ReachView>(`/api/projects/reach?${q(s)}`);
          setLive({ running: v.running, run: v.run });
          if (!v.running && (asked === null || (v.since && Date.parse(v.since) >= from - 15_000))) {
            const next = await statusOf(s.repo);
            if (next) onStatus(next);
            setLive(null);
            if (asked !== null || !next?.app.running) {
              setAsked(null);
              return;
            }
          }
          if (!v.running && !again && asked !== null) {
            again = true;
            await post("/api/projects/check", { hub: hubName.value });
          }
          wait = 6000;
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      if (Date.now() < until) timer = window.setTimeout(tick, wait);
      else {
        setAsked(null);
        setLive(null);
      }
    };
    timer = window.setTimeout(tick, 3000);
    return () => clearTimeout(timer);
  }, [asked, watching, s.repo]);
  const running = asked !== null || s.app.running;
  const run = live?.run ?? (s.app.running ? s.app.run : null);
  return (
    <>
      <span class="muted">{reachLine(s)}</span>
      {s.app.reaches === false && <span class="muted">The hub cannot publish {s.repo} until its App reaches it.</span>}
      {running && (
        <p class="row muted small" role="status">
          <Spinner label="Checking" /> The hub checks its App now. This updates by itself when its run ends.
          {run && (
            <a href={run} target="_blank" rel="noopener noreferrer">
              Open the run
            </a>
          )}
        </p>
      )}
      {armed && !running && (
        <p class="muted small" role="status">
          Once you have clicked Install on GitHub, come back to this page: tapster then asks the hub to check.
        </p>
      )}
      <Problem problem={problem} />
      {s.app.reaches !== true && s.app.installUrl && (
        <span class="muted small">
          GitHub preselects {s.repo}. Keep "Only select repositories". With "All repositories" the App would also reach {hubName.value}, which holds your keys. The hub then refuses to run.
        </span>
      )}
      {s.app.reaches !== true && (
        <div class="row">
          {s.app.installUrl ? (
            <Out href={s.app.installUrl} class={s.app.reaches === false ? "btn primary small" : "btn secondary small"} onClick={() => setArmed(true)}>
              Install the App on {s.name}
            </Out>
          ) : (
            <span class="muted small">Create the hub's GitHub App in Setup first.</span>
          )}
          <Busy busy={false} type="button" class="btn secondary small" onClick={() => void ask()} disabled={running}>
            <Icon name="refresh" />
            Check again
          </Busy>
        </div>
      )}
    </>
  );
}

function EntryStep({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const p = s.entry.proposal;
  const merge = async () => {
    if (!p) return;
    setBusy(true);
    setProblem(null);
    try {
      await post("/api/projects/merge", { hub: hubName.value, name: s.name, repo: s.repo, entry: p.entry, sha: p.head });
      say("ok", `Merged the hub entry of ${s.name}.`);
      const next = await statusOf(s.repo);
      if (next) onStatus(next);
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span class="muted">Waiting in a pull request on {hubName.value}. Merge it to let the hub publish {s.name}.</span>
      {p ? (
        <>
          <pre class="block" tabIndex={0} aria-label={`The entry for ${s.name}`}>
            {p.entry}
          </pre>
          <span class="muted small">
            The pull request ends at commit <code>{p.head.slice(0, 7)}</code> and only adds this entry to tapster.yml. tapster checks that again and merges it with your GitHub sign-in.
          </span>
        </>
      ) : (
        s.entry.blocked && <span class="muted small">tapster cannot merge it from here: {s.entry.blocked}</span>
      )}
      <Problem problem={problem} />
      <div class="row">
        {p && (
          <Busy busy={busy} holds={ofProject(s.repo, (p) => p.entry)} class="btn primary small" onClick={merge}>
            {!busy && <Icon name="pr" />}
            Merge the hub entry
          </Busy>
        )}
        <Out href={s.entry.pr!} class={p ? "btn secondary small" : "btn primary small"}>
          {p ? "Review on GitHub" : "Review and merge on GitHub"}
        </Out>
      </div>
    </>
  );
}

function Follow({ s, tag, onStatus }: { s: ProjectStatus; tag: string; onStatus: (s: ProjectStatus) => void }) {
  const [view, setView] = useState<FollowView | null>(null);
  const [kick, setKick] = useState<{ started: boolean; doorbell: boolean } | null>(null);
  useEffect(() => {
    let timer = 0;
    let wait = 5000;
    let kicked = false;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const v = await get<FollowView>(`/api/projects/follow?${q(s)}&tag=${encodeURIComponent(tag)}`);
          setView(v);
          wait = 5000;
          if (v.draft && !v.draft.note && !kicked) {
            kicked = true;
            setKick(await post<{ started: boolean; doorbell: boolean }>("/api/projects/publish", { hub: hubName.value, repo: s.repo }));
          }
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
  const hubRun = kick ? (view?.hubRun ?? null) : null;
  const seen = useRef(false);
  if (hubRun && hubRun.status !== "completed") seen.current = true;
  const hubBusy = (hubRun !== null && hubRun.status !== "completed") || Boolean(kick?.started && !seen.current);
  const publishing = view?.published
    ? "Published"
    : view?.draft?.note
      ? "The hub will not publish it until the draft is fixed"
      : hubBusy
        ? kick?.doorbell
          ? "The doorbell started the hub; it signs and publishes it now"
          : "The hub signs and publishes it now"
        : kick?.doorbell
          ? "The doorbell starts the hub"
          : "The hub signs and publishes it on its next run";
  const states = followSteps({
    run: !run ? "none" : !ran ? "running" : runOk ? "ok" : "failed",
    draft: view?.draft?.note ? "note" : view?.draft ? "open" : "none",
    published: Boolean(view?.published),
    hubBusy,
  });
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
        {item(states[0]!, !run ? "The release workflow starts" : !ran ? "The release workflow runs" : runOk || draftOpen ? "The release workflow finished" : `The release workflow ended: ${run.conclusion ?? "unknown"}`, run ? { href: run.url, label: "Open the run" } : undefined)}
        {item(states[1]!, view?.draft?.note ? view.draft.note : draftOpen ? "The workflow opened the draft" : "The workflow opens a draft", view?.draft ? { href: view.draft.url, label: "Open the draft" } : undefined)}
        {item(states[2]!, publishing, view?.published ? { href: view.published.url, label: "Open the release" } : hubBusy && hubRun ? { href: hubRun.url, label: "Open the hub's run" } : { href: view?.hub ?? "#", label: "Hub runs" })}
      </ol>
      {!view?.published && <p class="muted small">Without this page open, the hub publishes it on its next scheduled run. GitHub can start those hours late; the doorbell starts the hub right away.</p>}
    </div>
  );
}

function ReleaseBox({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const preferred = s.release.suggest ? bumps(s.release.highest)[s.release.suggest.kind] : s.release.next;
  const [version, setVersion] = useState(preferred);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  useEffect(() => setVersion(preferred), [preferred]);
  const inFlight = started ?? (s.release.atHead && s.release.latest?.tag !== s.release.atHead ? s.release.atHead : null);
  if (inFlight) return <Follow s={s} tag={inFlight} onStatus={onStatus} />;
  const gate = canRelease(s);
  const parent = s.release.head?.skip ? releasableParent(s.release.head) : null;
  const before = parent ? tagCommand(s.repo, s.release.next, { sha: parent.sha }) : null;
  if (!gate.ok) {
    return (
      <>
        <p class="muted">{gate.why}</p>
        {before && <Cmd text={before} />}
      </>
    );
  }
  const head = s.release.head!;
  const tag = version.trim();
  const next = bumps(s.release.highest);
  const bad = tagProblem(tag, s.release.highest);
  const id = `version-${s.name}`;
  const release = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await post("/api/projects/release", { hub: hubName.value, repo: s.repo, tag, sha: head.sha });
      setStarted(tag);
      void statusOf(s.repo).then((fresh) => fresh && onStatus(fresh), () => undefined);
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
        <div class="bumps" role="group" aria-label="Pick the next version">
          {(["patch", "minor", "major"] as const).map((kind) => (
            <button type="button" class="choice" key={kind} aria-pressed={tag === next[kind]} onClick={() => setVersion(next[kind])}>
              {kind === "patch" ? "Patch" : kind === "minor" ? "Minor" : "Major"} <span class="mono">{next[kind]}</span>
            </button>
          ))}
        </div>
        <input id={id} class="input mono" value={version} onInput={(e) => setVersion((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autoComplete="off" aria-invalid={bad ? "true" : undefined} aria-describedby={`${id}-hint`} />
        <span class={bad ? "hint bad" : "hint"} id={`${id}-hint`}>
          {bad ? `${bad}.` : !s.release.highest ? "GitHub has no version tag for this project yet." : `${tag === next.major ? "The next major" : tag === next.minor ? "The next minor" : tag === next.patch ? "The next patch" : "A version"} after ${s.release.highest}, the highest tag on GitHub.`}
          {!bad && s.release.suggest && tag === preferred && ` Suggested because ${s.release.suggest.reason}.`}
        </span>
      </div>
      {s.entry.state !== "merged" && <Note tone="info">The hub publishes it once you merge the hub entry.</Note>}
      <p class="muted small">
        {reachLine(s)}
        {s.app.reaches === false ? " The hub cannot publish this release until its App reaches the project." : ""}
      </p>
      <Problem problem={problem} />
      <div class="row">
        <Busy busy={busy} holds={ofProject(s.repo, (p) => p.release)} class="btn primary" onClick={release} disabled={Boolean(bad)}>
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
          Refresh
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
            <>
              <span class="muted">On {s.defaultBranch}, the release workflow opens drafts, attests the archives and leaves signing to the hub.</span>
              {s.setup.triggers.length > 0 && (
                <Note tone="warn" title="A merge can start a release">
                  <span>
                    The release workflow also starts on {s.setup.triggers.join(" and ")}. Merge such a change only once the hub entry is merged and the hub's App reaches {s.repo}. Otherwise the hub refuses the draft and you release again.
                  </span>
                </Note>
              )}
            </>
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
            <EntryStep s={s} onStatus={onStatus} />
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
                {(s.config?.update || s.config?.pending) && <span>Configuration below has an update for the hub entry.</span>}
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
      {!s.unreadable && <Configuration s={s} onStatus={onStatus} />}
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
