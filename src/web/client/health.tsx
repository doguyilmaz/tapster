import { useEffect, useState } from "preact/hooks";
import type { HealthView, Problem as ProblemView } from "../contract";
import { get, post } from "./api";
import { go, hub, loadHub, openStop, problemOf, say } from "./state";
import { Badge, Busy, Icon, Note, Out, Problem, Spinner } from "./ui";
import { capFirst } from "../steps";

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
};

const PROTECTION = new Set(["the tapster environment exists", "only main may open the tapster environment", "main cannot be deleted or force-pushed, by anyone", "the hub runs only GitHub's and tapster's actions, pinned by commit", "the default workflow token is read-only"]);
const WORKFLOW = new Set(["the hub workflow exists", "the hub workflow is tapster's template", "the hub workflow runs only on schedule and manual dispatch", "tapster.yml is valid"]);

function FixButton({ name, fix, hub: hubName, onFixed }: { name: string; fix: string; hub: string; onFixed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  if (PROTECTION.has(name)) {
    return (
      <span class="stack tight">
        <span class="row">
          <Busy
            busy={busy}
            class="btn secondary small"
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                await post("/api/hub/protect", { hub: hubName });
                await loadHub();
                onFixed();
              } catch (e) {
                setProblem(problemOf(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="shield" />
            Restore the protection
          </Busy>
        </span>
        <Problem problem={problem} />
      </span>
    );
  }
  const stop = WORKFLOW.has(name) && !(name === "tapster.yml is valid" && fix !== "Run tapster init.") ? "files" : name === "the credentials this hub needs are stored" ? null : undefined;
  if (stop === undefined) return null;
  return (
    <span class="row">
      <button
        type="button"
        class="btn secondary small"
        onClick={() => {
          openStop.value = stop;
          go("/setup");
        }}
      >
        Fix it in Setup
        <Icon name="arrow" />
      </button>
    </span>
  );
}


const RESULT: Record<string, { tone?: "ok" | "warn" | "error"; text: string }> = {
  success: { tone: "ok", text: "Done" },
  failure: { tone: "error", text: "Failed" },
  cancelled: { text: "Cancelled" },
  skipped: { text: "Skipped" },
};

export function Health() {
  const h = hub.value;
  const [view, setView] = useState<HealthView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const load = async () => {
    if (!h) return;
    setLoading(true);
    setProblem(null);
    try {
      setView(await get<HealthView>(`/api/hub/health?hub=${encodeURIComponent(h.name)}`));
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [h?.name]);
  if (!h) return null;
  const bad = view?.checks.filter((c) => !c.ok) ?? [];
  const good = view?.checks.filter((c) => c.ok) ?? [];
  const runNow = async () => {
    setStarting(true);
    try {
      const r = await post<{ started: boolean }>("/api/hub/run", { hub: h.name });
      say("ok", r.started ? "The hub run started. It shows up below in a few seconds." : "A hub run is already queued or running. It shows up below.");
      setTimeout(() => void load(), 4000);
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setStarting(false);
    }
  };
  return (
    <div class="stack" style="gap: 1.5rem; max-width: 900px">
      <div class="spread">
        <div class="stack tight">
          <p class="eyebrow">Health</p>
          <h1 class="title">{view ? (bad.length ? `${bad.length} ${bad.length === 1 ? "thing needs" : "things need"} you` : `${h.name} is healthy`) : `Checking ${h.name}`}</h1>
          <p class="lead">The same checks as tapster doctor, run against the hub as it is on GitHub's main branch.</p>
        </div>
        <div class="row">
          <button type="button" class="btn secondary" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" spin={loading} />
            Check again
          </button>
          <Busy busy={starting} class="btn primary" onClick={runNow}>
            <Icon name="play" />
            Run the hub now
          </Busy>
        </div>
      </div>
      <Problem problem={problem} />
      {h.issue && (
        <Note tone="warn" title={`The hub opened issue #${h.issue.number}: tapster: the hub needs attention`}>
          <span>Updated {when(h.issue.updated)}. It closes itself once everything is fine.</span>
          <details>
            <summary class="small">Show what it says</summary>
            <pre class="block" style="white-space: pre-wrap; margin-top: 0.5rem">{h.issue.body.replace(/<!--[\s\S]*?-->/g, "").trim()}</pre>
          </details>
          <Out href={h.issue.url} class="btn secondary small">Open the issue</Out>
        </Note>
      )}
      {loading && !view && (
        <p class="row muted" role="status">
          <Spinner /> Running the checks
        </p>
      )}
      {view && (
        <div class="card list">
          {[...bad, ...good].map((c) => (
            <div class="item" key={c.name} style="grid-template-columns: auto minmax(0, 1fr); align-items: start">
              <span class={c.ok ? "ok" : "bad"} style={`color: var(--${c.ok ? "green" : "wax"}); padding-top: 0.15rem`}>
                <Icon name={c.ok ? "check" : "alert"} label={c.ok ? "ok" : "needs a fix"} />
              </span>
              <div class="stack tight" style="gap: 0.2rem">
                <span style="font-weight: 550">{capFirst(c.name)}</span>
                {!c.ok && <span class="muted small">{c.fix}</span>}
                {!c.ok && <FixButton name={c.name} fix={c.fix} hub={h.name} onFixed={() => void load()} />}
                {c.note && <span class="faint small">{capFirst(c.note)}.</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {view?.note && <p class="muted small">{capFirst(view.note.replace(/^note: /, ""))}.</p>}
      {view && (
        <section class="stack tight">
          <h2 class="section-title">Recent hub runs</h2>
          {view.runs.length ? (
            <div class="card list">
              {view.runs.map((r) => {
                const result = r.status === "completed" ? (RESULT[r.conclusion ?? ""] ?? { text: r.conclusion ?? "Done" }) : { tone: "warn" as const, text: r.status === "queued" ? "Queued" : "Running" };
                return (
                  <div class="item" key={r.id}>
                    <span class="stack tight" style="gap: 0.1rem">
                      <span>{r.event === "schedule" ? "On schedule" : r.event === "workflow_dispatch" ? "Started by hand or the doorbell" : r.event}</span>
                      <span class="faint small">{when(r.created)}</span>
                    </span>
                    <span class="row">
                      <Badge tone={result.tone}>{result.text}</Badge>
                      <Out href={r.url} class="btn quiet small">
                        Log
                      </Out>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p class="muted">No runs yet. The workflow starts once the hub files are on main.</p>
          )}
        </section>
      )}
    </div>
  );
}
