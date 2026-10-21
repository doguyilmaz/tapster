import { useEffect, useRef, useState } from "preact/hooks";
import type { ConfigView, EntryCheck, Problem as ProblemView, ProjectStatus } from "../contract";
import { capFirst } from "../steps";
import { post } from "./api";
import { hubName, problemOf, say, statusOf } from "./state";
import { Busy, DiffBlock, Icon, Note, Out, Problem } from "./ui";

type Opened = { pr: string; head: string; entry: string };

const target = (s: ProjectStatus) => ({ hub: hubName.value, name: s.name, repo: s.repo });

function Editor({ s, c, onDone, onCancel }: { s: ProjectStatus; c: ConfigView; onDone: (problem: ProblemView | null) => void; onCancel: () => void }) {
  const [text, setText] = useState(c.entry);
  const [check, setCheck] = useState<EntryCheck>({ before: c.entry, problem: null, same: true });
  const [checking, setChecking] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    if (text === c.entry) {
      setChecking(false);
      setCheck({ before: c.entry, problem: null, same: true });
      return;
    }
    setChecking(true);
    const timer = window.setTimeout(async () => {
      try {
        const r = await post<EntryCheck>("/api/projects/entry/check", { ...target(s), entry: text });
        if (n === asked.current) setCheck(r);
      } catch (e) {
        if (n === asked.current) setCheck({ before: c.entry, problem: problemOf(e), same: false });
      } finally {
        if (n === asked.current) setChecking(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);
  const id = `entry-${s.name}`;
  const bad = !checking && check.problem;
  const ready = !checking && !check.problem && !check.same;
  const land = async () => {
    setBusy(true);
    try {
      const opened = await post<Opened>("/api/projects/entry/propose", { ...target(s), entry: text, before: check.before });
      await post("/api/projects/entry/merge", { ...target(s), entry: opened.entry, before: check.before, sha: opened.head });
      say("ok", `Merged the change to the entry of ${s.name}.`);
      onDone(null);
    } catch (e) {
      onDone(problemOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack tight">
      <div class="field">
        <label for={id}>The entry of {s.name}</label>
        <textarea
          id={id}
          class="input mono entry-edit"
          rows={Math.min(28, text.split("\n").length + 2)}
          value={text}
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          spellcheck={false}
          autoComplete="off"
          aria-invalid={bad ? "true" : undefined}
          aria-describedby={`${id}-hint`}
        />
        <span class={bad ? "hint bad" : "hint"} id={`${id}-hint`} role="status">
          {checking ? "Checking the entry as part of the hub's tapster.yml." : check.problem ? `${capFirst(check.problem.reason)}. ${check.problem.fix}` : check.same ? "Nothing changed yet." : "The hub accepts this entry."}
        </span>
      </div>
      <div class="row">
        <button type="button" class="btn secondary small" aria-expanded={show} onClick={() => setShow(!show)}>
          {show ? "Hide the change" : "Show the change"}
        </button>
        <Busy busy={busy} class="btn primary small" disabled={!ready} onClick={land}>
          {!busy && <Icon name="pr" />}
          Propose and merge
        </Busy>
        <button type="button" class="btn quiet small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {show && <DiffBlock before={check.before} after={text} label={`The change to the entry of ${s.name} against main`} />}
      <p class="muted small">tapster opens a pull request on {hubName.value} that changes only these lines. It checks that pull request again and merges it with your GitHub sign-in.</p>
    </div>
  );
}

export function Configuration({ s, onStatus }: { s: ProjectStatus; onStatus: (s: ProjectStatus) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const c = s.config;
  if (!c) return null;
  const refresh = async () => {
    const next = await statusOf(s.repo).catch(() => null);
    if (next) onStatus(next);
  };
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const propose = () =>
    act(async () => {
      await post("/api/projects/entry/propose", { ...target(s), entry: c.update, before: c.entry });
      say("ok", `Proposed the update of ${s.name}.`);
    });
  const merge = () =>
    act(async () => {
      await post("/api/projects/entry/merge", { ...target(s), entry: c.pending!.entry, before: c.entry, sha: c.pending!.head });
      say("ok", `Merged the update of ${s.name}.`);
    });
  const p = c.pending;
  return (
    <section class="stack tight config" aria-labelledby={`config-${s.name}`}>
      <div class="spread">
        <h3 id={`config-${s.name}`} class="section-title">
          Configuration
        </h3>
        {!editing && !p && (
          <button type="button" class="btn quiet small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      <p class="muted small">
        This is the entry of {s.name} in {hubName.value}'s tapster.yml. It lives in the hub because only you can change what the hub signs. The App that writes to your projects cannot.
      </p>
      {editing ? (
        <Editor
          s={s}
          c={c}
          onCancel={() => setEditing(false)}
          onDone={(trouble) => {
            setEditing(false);
            setProblem(trouble);
            void refresh();
          }}
        />
      ) : (
        <pre class="block" tabIndex={0} aria-label={`The entry of ${s.name}`}>
          {c.entry}
        </pre>
      )}
      {!editing && p && (
        <Note tone="info" title="An update waits in a pull request">
          {p.entry ? (
            <>
              <span>It changes only these lines of the entry. tapster checks it again and merges it with your GitHub sign-in.</span>
              <DiffBlock before={c.entry} after={p.entry} label={`The update of ${s.name}`} />
            </>
          ) : (
            <span>tapster cannot merge it from here: {p.blocked}</span>
          )}
          <div class="row">
            {p.entry && p.head && (
              <Busy busy={busy} class="btn primary small" onClick={merge}>
                {!busy && <Icon name="pr" />}
                Merge the update
              </Busy>
            )}
            <Out href={p.pr} class={p.entry ? "btn secondary small" : "btn primary small"}>
              {p.entry ? "Review on GitHub" : "Review and merge on GitHub"}
            </Out>
          </div>
        </Note>
      )}
      {!editing && !p && c.update && (
        <Note tone="info" title="The entry lacks what the project ships now">
          <span>tapster read this from {c.from.join("; ")}. Proposing it adds these lines and changes no other.</span>
          <DiffBlock before={c.entry} after={c.update} label={`The update tapster proposes for ${s.name}`} />
          <div class="row">
            <Busy busy={busy} class="btn primary small" onClick={propose}>
              {!busy && <Icon name="pr" />}
              Propose the update
            </Busy>
          </div>
        </Note>
      )}
      {!editing && c.manual.length > 0 && (
        <Note tone="warn" title="Write these in the entry by hand">
          <ul class="log">
            {c.manual.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Note>
      )}
      <Problem problem={problem} />
    </section>
  );
}
