import { useEffect, useState } from "preact/hooks";
import type { LocalProject, Problem as ProblemView, ProjectStatus } from "../contract";
import { clones, hub, loadClones, loadStatuses, problemOf, saveRoots, savedRoots, statusError, statuses, tilde } from "./state";
import { type SheetTarget, ProjectSheet } from "./sheet";
import { KIND, StatusRows } from "./status";
import { Badge, Icon, Problem, Spinner } from "./ui";

function Row({ p, onOpen }: { p: LocalProject; onOpen: (p: LocalProject) => void }) {
  return (
    <div class="item">
      <button type="button" class="link" onClick={() => onOpen(p)} disabled={!p.kind}>
        <span class="name">{p.repo}</span>
        <span class="path">
          {tilde(p.path)}
          {p.others.length ? ` and ${p.others.length} more ${p.others.length === 1 ? "clone" : "clones"}` : ""}
        </span>
      </button>
      <span class="row">
        {p.kind ? <Badge>{KIND[p.kind]}</Badge> : <span class="muted small">{p.why}</span>}
        {p.kind && (
          <button type="button" class="btn secondary small" onClick={() => onOpen(p)} aria-label={`Add ${p.repo}`}>
            Add
            <Icon name="arrow" />
          </button>
        )}
      </span>
    </div>
  );
}

export const clonePaths = (list: LocalProject[]) => new Map(list.map((p) => [p.repo.toLowerCase(), p]));

export function targetOf(s: ProjectStatus, local: Map<string, LocalProject>): SheetTarget {
  const c = local.get(s.repo.toLowerCase());
  return { repo: s.repo, path: c?.path ?? null, others: c?.others ?? [], listed: true };
}

export function Projects() {
  const h = hub.value;
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [roots, setRoots] = useState<string[]>(savedRoots());
  const [folder, setFolder] = useState("");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<SheetTarget | null>(null);
  const [scanning, setScanning] = useState(false);
  const run = async (extra = roots) => {
    if (!h) return;
    setScanning(true);
    setProblem(null);
    try {
      await Promise.all([loadClones(extra), loadStatuses()]);
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    void run();
  }, [h?.name]);
  if (!h) return null;
  const addFolder = (e: Event) => {
    e.preventDefault();
    const path = folder.trim().replace(/^['"]|['"]$/g, "");
    if (!path) return;
    const next = [path, ...roots.filter((r) => r !== path)].slice(0, 10);
    setRoots(next);
    saveRoots(next);
    setFolder("");
    void run(next);
  };
  const scan = clones.value?.hub === h.name ? clones.value.scan : null;
  const listed = statuses.value?.hub === h.name ? statuses.value.list : null;
  const projects = scan?.projects ?? [];
  const local = clonePaths(projects);
  const known = new Set((listed ?? []).map((s) => s.repo.toLowerCase()));
  const inHub = (p: LocalProject) => known.has(p.repo.toLowerCase()) || p.inHub || p.proposed !== null;
  const ready = projects.filter((p) => p.kind && !inHub(p));
  const other = projects.filter((p) => !p.kind && !inHub(p));
  const openLocal = (p: LocalProject) => setOpen({ repo: p.repo, path: p.path, others: p.others, listed: inHub(p) });
  return (
    <div class="stack" style="gap: 1.5rem">
      <div class="spread">
        <div class="stack tight">
          <p class="eyebrow">Projects on this computer</p>
          <h1 class="title">Add your projects to {h.name}</h1>
          <p class="lead">tapster looks for clones of your own repositories here. It reads each clone's <code>.git/config</code> and checks which build files exist. Nothing leaves this computer.</p>
        </div>
        <button type="button" class="btn secondary" onClick={() => void run()} disabled={scanning}>
          <Icon name="refresh" spin={scanning} />
          Look again
        </button>
      </div>
      <form class="row" onSubmit={addFolder} style="flex-wrap: nowrap">
        <label class="sr" for="folder">
          A folder to look in
        </label>
        <input id="folder" class="input mono" placeholder="A folder, such as /Users/you/Documents/code" value={folder} onInput={(e) => setFolder((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autoComplete="off" />
        <button class="btn secondary" type="submit">
          <Icon name="folder" />
          Look there too
        </button>
      </form>
      <Problem problem={problem ?? statusError.value} />
      {scanning && !scan && (
        <p class="row muted" role="status">
          <Spinner /> Looking through your folders
        </p>
      )}
      {(listed?.length ?? 0) > 0 && (
        <section class="stack tight" aria-labelledby="in-hub">
          <h2 id="in-hub" class="section-title">
            In the hub ({listed!.length})
          </h2>
          <StatusRows list={listed!} paths={new Map([...local].map(([k, p]) => [k, p.path]))} onOpen={(s) => setOpen(targetOf(s, local))} />
        </section>
      )}
      {scan && (
        <>
          <section class="stack tight" aria-labelledby="ready">
            <h2 id="ready" class="section-title">
              Ready to add ({ready.length})
            </h2>
            {ready.length ? (
              <div class="card list">
                {ready.map((p) => (
                  <Row key={p.path} p={p} onOpen={openLocal} />
                ))}
              </div>
            ) : (
              <p class="muted">
                {projects.length ? "Every supported clone here is in the hub already." : "No clone of your repositories turned up."} If a project lives elsewhere, add its folder above.
              </p>
            )}
          </section>
          {other.length > 0 && (
            <section class="stack tight">
              <button type="button" class="btn quiet" onClick={() => setAll(!all)} aria-expanded={all} style="justify-self: start">
                <Icon name={all ? "down" : "right"} />
                {other.length} other {other.length === 1 ? "clone" : "clones"} tapster cannot publish yet
              </button>
              {all && (
                <div class="card list">
                  {other.map((p) => (
                    <Row key={p.path} p={p} onOpen={openLocal} />
                  ))}
                </div>
              )}
            </section>
          )}
          <p class="faint small">
            Looked in {scan.roots.map(tilde).join(", ")}
            {scan.truncated ? "; it stopped early because there were many folders" : ""}. {scan.others ? `${scan.others} ${scan.others === 1 ? "clone belongs" : "clones belong"} to other owners and ${scan.others === 1 ? "is" : "are"} not listed.` : ""}
          </p>
        </>
      )}
      {open && (
        <ProjectSheet
          key={open.repo}
          target={open}
          hubName={h.name}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
