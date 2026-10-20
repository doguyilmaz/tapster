import { useEffect, useState } from "preact/hooks";
import type { AddView, DiffView, InspectView, LocalProject, Problem as ProblemView, ScanView } from "../contract";
import { post } from "./api";
import { hub, loadHub, problemOf, recall, remember, say, tilde } from "./state";
import { changedOnly, lineDiff } from "./steps";
import { Badge, Busy, Cmd, Icon, Note, Out, Problem, Spinner } from "./ui";

const ROOTS_KEY = "tapster.roots";
const KIND: Record<string, string> = { go: "Go with GoReleaser", bun: "Bun", app: "Mac app with Sparkle" };

function savedRoots(): string[] {
  try {
    const v = JSON.parse(recall(ROOTS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

function Row({ p, onOpen }: { p: LocalProject; onOpen: (p: LocalProject) => void }) {
  return (
    <div class="item">
      <button type="button" class="link" onClick={() => onOpen(p)} disabled={!p.kind}>
        <span class="name">{p.repo}</span>
        <span class="path">{tilde(p.path)}</span>
      </button>
      <span class="row">
        {p.kind ? <Badge>{KIND[p.kind]}</Badge> : <span class="muted small">{p.why}</span>}
        {p.inHub ? (
          <Badge tone="ok">In the hub</Badge>
        ) : p.proposed ? (
          <Out href={p.proposed} class="btn secondary small">
            Merge the entry
          </Out>
        ) : p.kind ? (
          <button type="button" class="btn secondary small" onClick={() => onOpen(p)}>
            Add
            <Icon name="arrow" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function Projects() {
  const h = hub.value;
  const [scan, setScan] = useState<ScanView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [roots, setRoots] = useState<string[]>(savedRoots());
  const [folder, setFolder] = useState("");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<LocalProject | null>(null);
  const [scanning, setScanning] = useState(false);
  const run = async (extra = roots) => {
    if (!h) return;
    setScanning(true);
    setProblem(null);
    try {
      setScan(await post<ScanView>("/api/projects/scan", { hub: h.name, extra }));
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
    remember(ROOTS_KEY, JSON.stringify(next));
    setFolder("");
    void run(next);
  };
  const projects = scan?.projects ?? [];
  const ready = projects.filter((p) => p.kind && !p.inHub);
  const inHub = projects.filter((p) => p.inHub);
  const other = projects.filter((p) => !p.kind && !p.inHub);
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
        <input id="folder" class="input mono" placeholder="/Users/you/Documents/code, or one project's folder" value={folder} onInput={(e) => setFolder((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autoComplete="off" />
        <button class="btn secondary" type="submit">
          <Icon name="folder" />
          Look there too
        </button>
      </form>
      <Problem problem={problem} />
      {scanning && !scan && (
        <p class="row muted" role="status">
          <Spinner /> Looking through your folders
        </p>
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
                  <Row key={p.path} p={p} onOpen={setOpen} />
                ))}
              </div>
            ) : (
              <p class="muted">
                {projects.length ? "Every supported clone here is in the hub already." : "No clone of your repositories turned up."} If a project lives elsewhere, add its folder above.
              </p>
            )}
          </section>
          {inHub.length > 0 && (
            <section class="stack tight" aria-labelledby="in-hub">
              <h2 id="in-hub" class="section-title">
                In the hub ({inHub.length})
              </h2>
              <div class="card list">
                {inHub.map((p) => (
                  <Row key={p.path} p={p} onOpen={setOpen} />
                ))}
              </div>
            </section>
          )}
          {other.length > 0 && (
            <section class="stack tight">
              <button type="button" class="btn quiet" onClick={() => setAll(!all)} aria-expanded={all} style="justify-self: start">
                <Icon name={all ? "down" : "right"} />
                {other.length} other {other.length === 1 ? "clone" : "clones"} tapster cannot publish yet
              </button>
              {all && (
                <div class="card list">
                  {other.map((p) => (
                    <Row key={p.path} p={p} onOpen={setOpen} />
                  ))}
                </div>
              )}
            </section>
          )}
          <p class="faint small">
            Looked in {scan.roots.map(tilde).join(", ")}{scan.truncated ? ", and stopped early because there were many folders" : ""}. {scan.others ? `${scan.others} ${scan.others === 1 ? "clone belongs" : "clones belong"} to other owners and ${scan.others === 1 ? "is" : "are"} not listed.` : ""}
          </p>
        </>
      )}
      {open && <Sheet p={open} hubName={h.name} onClose={() => setOpen(null)} onAdded={() => void run()} />}
    </div>
  );
}

export function notes(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines.flatMap((l) => l.split("\n"))) {
    const line = raw.trim().replace(/^- /, "");
    if (!line || /^proposed the hub entry in |^open this page and choose Install|^https:\/\//.test(line)) continue;
    if (raw.startsWith("  ") && out.length) out[out.length - 1] += ` ${line}`;
    else out.push(line.charAt(0).toUpperCase() + line.slice(1));
  }
  return out;
}

function Switch({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children: preact.ComponentChildren }) {
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

function Diff({ view }: { view: DiffView }) {
  return (
    <div class="stack tight files">
      {view.files.map((f) => {
        const lines = f.before === null ? null : changedOnly(lineDiff(f.before, f.after ?? ""));
        return (
          <details class="file" key={f.path} open>
            <summary>
              <Icon name="file" />
              <code>{f.path}</code>
              <Badge tone={f.before === null ? "next" : f.after === null ? "error" : "warn"}>{f.before === null ? "New" : f.after === null ? "Removed" : "Changed"}</Badge>
            </summary>
            <pre class="block diff">
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

function Sheet({ p, hubName, onClose, onAdded }: { p: LocalProject; hubName: string; onClose: () => void; onAdded: () => void }) {
  const [info, setInfo] = useState<InspectView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [workflow, setWorkflow] = useState("release.yml");
  const [autoTag, setAutoTag] = useState(false);
  const [dependabot, setDependabot] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<AddView | null>(null);
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [committed, setCommitted] = useState(false);
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    post<InspectView>("/api/projects/inspect", { hub: hubName, path: p.path }).then(
      (v) => {
        setInfo(v);
        setDependabot(v.dependabot);
        if (v.workflow) setWorkflow(v.workflow);
      },
      (e) => setProblem(problemOf(e)),
    );
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [p.path]);
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
  const add = () =>
    act("add", async () => {
      const res = await post<AddView>("/api/projects/add", { hub: hubName, path: p.path, options: { workflow, autoTag, dependabot, force } });
      setAdded(res);
      setDiff(await post<DiffView>("/api/projects/diff", { path: p.path, files: res.files }));
      onAdded();
      void loadHub();
    });
  const relevant = info?.dirty ?? [];
  const noWorkflow = info?.kind === "go" && info.workflows.length === 0;
  return (
    <>
      <div class="sheet-back" onClick={onClose} />
      <aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head">
          <div class="stack tight" style="flex: 1; min-width: 0; gap: 0.1rem">
            <h2 id="sheet-title" class="section-title mono" style="font-size: 1.05rem; overflow-wrap: anywhere">
              {p.repo}
            </h2>
            <span class="faint small" style="overflow-wrap: anywhere">
              {tilde(p.path)}
            </span>
          </div>
          <button type="button" class="btn quiet small" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div class="sheet-body">
          {!info && !problem && (
            <p class="row muted" role="status">
              <Spinner /> Reading the clone and its repository
            </p>
          )}
          <Problem problem={problem} />
          {info && !added && (
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
              {info.proposed && (
                <Note tone="info" title="The hub entry is waiting for you">
                  <span>Merge the pull request to let the hub publish this project.</span>
                  <Out href={info.proposed} class="btn secondary small">Review the pull request</Out>
                </Note>
              )}
              {relevant.length > 0 && (
                <Note tone="warn" title="Uncommitted changes in files tapster edits">
                  <span>{relevant.join(", ")}. Commit or stash them first, so tapster's changes stay apart from yours.</span>
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
                    <span>{info.kind === "go" ? `Edits .goreleaser.yaml and .github/workflows/${workflow}: drafts instead of releases, an attestation step and the step that rings the hub.` : "Writes .github/workflows/release.yml: build, attest, open a draft and ring the hub."} You review and commit these in the next step.</span>
                  </li>
                  <li>
                    <Icon name="right" />
                    <span>Protects {info.repo}: only you can create, move or delete branches and tags.</span>
                  </li>
                  <li>
                    <Icon name="right" />
                    <span>Proposes the project's entry to {hubName} as a pull request.</span>
                  </li>
                  {autoTag && (
                    <li>
                      <Icon name="right" />
                      <span>Adds the deploy key "tapster tags" and a release environment.</span>
                    </li>
                  )}
                </ul>
              </div>
              <div class="row">
                <Busy busy={busy === "add"} class="btn primary" onClick={add} disabled={noWorkflow}>
                  {info.inHub ? "Update the project" : `Add to ${hubName}`}
                </Busy>
              </div>
            </>
          )}
          {added && (
            <>
              <Note tone="ok" title={`tapster prepared ${p.repo}`} />
              <ul class="checks small">
                {notes(added.lines).map((l, i) => (
                  <li key={i}>
                    <Icon name="right" />
                    <span class="muted" style="overflow-wrap: anywhere">{l}</span>
                  </li>
                ))}
              </ul>
              <section class="stack tight">
                <h3 class="section-title">1. Review and commit the changes</h3>
                {diff ? <Diff view={diff} /> : <Spinner />}
                <div class="row">
                  {committed ? (
                    <Badge tone="ok">Committed</Badge>
                  ) : (
                    <Busy
                      busy={busy === "commit"}
                      class="btn primary"
                      onClick={() =>
                        act("commit", async () => {
                          await post("/api/projects/commit", { path: p.path, files: added.files });
                          setCommitted(true);
                        })
                      }
                    >
                      Commit these files
                    </Busy>
                  )}
                  {committed &&
                    (pushed ? (
                      <Badge tone="ok">Pushed</Badge>
                    ) : (
                      <Busy
                        busy={busy === "push"}
                        class="btn primary"
                        onClick={() =>
                          act("push", async () => {
                            await post("/api/projects/push", { path: p.path });
                            setPushed(true);
                            say("ok", `Pushed ${p.repo}.`);
                          })
                        }
                      >
                        Push
                      </Busy>
                    ))}
                </div>
                <p class="muted small">tapster commits only these files, in your own git setup: your hooks and commit signing apply.</p>
              </section>
              <section class="stack tight">
                <h3 class="section-title">2. Merge the hub entry</h3>
                {added.pr ? (
                  <>
                    <p class="muted">GitHub shows you the exact change to the hub's tapster.yml. Merge it to start publishing.</p>
                    <div class="row">
                      <Out href={added.pr} class="btn secondary">
                        <Icon name="pr" />
                        Review and merge on GitHub
                      </Out>
                    </div>
                  </>
                ) : (
                  <p class="muted">No pull request this time; the notes above say why.</p>
                )}
              </section>
              <section class="stack tight">
                <h3 class="section-title">3. Let the hub reach it</h3>
                <p class="muted">Unless the App already reaches {p.repo}, install it there. GitHub preselects the project; keep "Only select repositories".</p>
                <div class="row">
                  <Out href={added.installUrl} class="btn secondary">
                    Install the App on {p.repo.split("/")[1]}
                  </Out>
                </div>
              </section>
              <section class="stack tight">
                <h3 class="section-title">4. Release</h3>
                <p class="muted">Push a version tag. The project's workflow opens a draft, and the hub signs and publishes it on its next run.</p>
                <Cmd text={`git -C ${JSON.stringify(p.path)} tag v1.0.0 && git -C ${JSON.stringify(p.path)} push origin v1.0.0`} />
                <p class="faint small">Use your next version instead of v1.0.0.</p>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
