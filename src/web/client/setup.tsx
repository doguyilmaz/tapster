import { useEffect, useRef, useState } from "preact/hooks";
import type { AppStart, FilesView, HubView, InstallView, Problem as ProblemView } from "../contract";
import { ApiError, get, post } from "./api";
import { type Stop, type StopId, changedOnly, expiresSoon, firstOpen, lineDiff, macNeeded, stops } from "../steps";
import { clonePaths, targetOf } from "./projects";
import { type SheetTarget, ProjectSheet } from "./sheet";
import { appResult, clones, go, hub, hubError, hubLoading, hubName, loadClones, loadHub, loadStatuses, mac, macChoice, openStop, problemOf, say, setMac, statusError, statuses } from "./state";
import { StatusRows } from "./status";
import { Badge, Busy, Cmd, Copy, Field, FileDrop, Icon, Note, Out, Password, Problem, Spinner } from "./ui";

function Dot({ stop, index }: { stop: Stop; index: number }) {
  if (stop.state === "done") return <span class="dot"><Icon name="check" /></span>;
  if (stop.state === "attention") return <span class="dot"><Icon name="alert" /></span>;
  if (stop.state === "skipped") return <span class="dot">–</span>;
  return <span class="dot">{index + 1}</span>;
}

function Head({ title, lead, children }: { title: string; lead: string; children?: preact.ComponentChildren }) {
  return (
    <div class="panel-head">
      <div class="spread">
        <h2 class="title">{title}</h2>
        {children}
      </div>
      <p class="lead">{lead}</p>
    </div>
  );
}

function Done({ text }: { text: string }) {
  return (
    <div class="row">
      <span class="seal" aria-hidden="true">
        <Icon name="check" />
      </span>
      <strong>{text}</strong>
    </div>
  );
}

function useAction(): [boolean, ProblemView | null, (f: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
    }
  };
  return [busy, problem, run];
}

const PROTECTIONS: [string, string][] = [
  ["A tapster environment that only main can open", "Your keys go into it, so a workflow on another branch never sees them."],
  ["main cannot be deleted or force-pushed", "By anyone, you included, so the hub's history stays as you pushed it."],
  ["Only GitHub's and tapster's actions, pinned by commit", "No other code runs next to your keys."],
  ["A read-only default token", "Workflows get write access only where the template asks for it."],
];

function Protect({ h }: { h: HubView }) {
  const [busy, problem, run] = useAction();
  return (
    <div class="panel">
      <Head title="Protect the hub" lead="These settings keep a stolen key or a stray workflow away from your signing keys. You can run this again at any time; it only restores what is missing." />
      <ul class="checks">
        {h.protect.checks.map((c, i) => (
          <li key={c.label}>
            <span class={c.ok ? "ok" : "no"}>
              <Icon name={c.ok ? "check" : "circle"} label={c.ok ? "on" : "off"} />
            </span>
            <span class="stack tight" style="gap: 0.1rem">
              <span>{PROTECTIONS[i]?.[0] ?? c.label}</span>
              <span class="muted small">{PROTECTIONS[i]?.[1]}</span>
            </span>
          </li>
        ))}
      </ul>
      {h.protect.others.length > 0 && (
        <Note tone="warn" title="These workflows stop running once the hub is protected">
          <span>They use actions from others or actions not pinned by commit. The hub does not need them. Their commits would make the hub refuse to run. You can remove them in Hub files.</span>
          <ul class="log">
            {h.protect.others.map((o) => (
              <li key={o.file}>
                <code>.github/workflows/{o.file}</code>: {o.actions.slice(0, 3).join(", ")}
              </li>
            ))}
          </ul>
        </Note>
      )}
      <Problem problem={problem} />
      {h.protect.done ? (
        <Done text={`${h.name} is protected`} />
      ) : (
        <div class="row">
          <Busy busy={busy} class="btn primary" onClick={() => run(async () => {
            await post("/api/hub/protect", { hub: h.name });
            await loadHub();
            say("ok", `${h.name} is protected.`);
          })}>
            <Icon name="shield" />
            {h.protect.checks.some((c) => c.ok) ? "Restore the protection" : `Protect ${h.name}`}
          </Busy>
        </div>
      )}
    </div>
  );
}

function Installation({ h, slug }: { h: HubView; slug: string }) {
  const [view, setView] = useState<InstallView | null>(h.app.installed);
  useEffect(() => {
    if (!h.app.installed) return;
    let timer = 0;
    let wait = 4000;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const next = await get<InstallView>(`/api/hub/installation?hub=${encodeURIComponent(h.name)}`);
          setView(next);
          wait = next.id !== null && !next.onHub ? 30000 : 4000;
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [h.name, Boolean(h.app.installed)]);
  const install = `https://github.com/apps/${slug}/installations/new`;
  return (
    <div class="stack tight">
      <h3 class="section-title">Install it on your projects</h3>
      <p class="muted">
        On GitHub, choose <strong>Only select repositories</strong> and pick the projects the hub should publish. Never pick {h.name}: the App can write to every repository it is installed on. The hub holds your signing keys. You can also install it per project later, from Projects.
      </p>
      {view?.checked && view.onHub && (
        <Note tone="error" title={`The App is installed on ${h.name}`}>
          <span>Remove {h.name} from it; the hub refuses to run until you do.</span>
          <Out href={`https://github.com/settings/installations/${view.id}`} class="btn secondary small">Open the installation</Out>
        </Note>
      )}
      {view?.checked && !view.onHub && view.id !== null && (
        <Note tone="ok" title="The App is installed">
          <span>{view.repos.length ? `It reaches ${view.repos.join(", ")}.` : "It reaches no repository yet."}</span>
        </Note>
      )}
      {view?.checked && view.id === null && (
        <p class="row muted small">
          <Spinner /> Not installed yet. This updates by itself once you click Install on GitHub.
        </p>
      )}
      {!view && <p class="muted small">GitHub shows an App's repositories only to the App itself. Each hub run reports a project the App cannot reach.</p>}
      <div class="row">
        <Out href={install} class={view?.id ? "btn secondary" : "btn primary"}>
          {view?.id ? "Change its repositories" : "Install the App"}
        </Out>
        <Out href={`https://github.com/settings/apps/${slug}`} class="btn quiet">
          App settings
        </Out>
      </div>
    </div>
  );
}

function ProtectFirst({ h, what, onGo }: { h: HubView; what: string; onGo: () => void }) {
  return (
    <div class="panel">
      <Head title={what} lead={`This step stores a key in ${h.name}'s tapster environment. Protect the hub first, so only workflows on main can open it.`} />
      <Note tone="info" title="Protect the hub first">
        <span>Then come back here.</span>
      </Note>
      <div class="row">
        <button type="button" class="btn primary" onClick={onGo}>
          <Icon name="shield" />
          Go to Protect the hub
        </button>
      </div>
    </div>
  );
}

function App({ h }: { h: HubView }) {
  const [start, setStart] = useState<AppStart | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [storing, storeProblem, store] = useAction();
  const result = appResult.value;
  const created = Boolean(h.app.id && h.app.slug && h.app.key);
  useEffect(() => {
    if (created || h.app.id || h.app.held || result?.kind === "unstored") return;
    post<AppStart>("/api/hub/app", { hub: h.name }).then(setStart, (e) => setProblem(problemOf(e)));
  }, [h.name, created, result?.kind]);
  if ((result?.kind === "unstored" || h.app.held) && !created) {
    return (
      <div class="panel">
        <Head title="Store the App's key" lead="GitHub created the App and handed its key to this setup, but storing it in the hub failed. The key is still in memory here, so try again." />
        {result?.kind === "unstored" && <Problem problem={result.problem} />}
        <Problem problem={storeProblem} />
        <div class="row">
          <Busy
            busy={storing}
            class="btn primary"
            onClick={() =>
              store(async () => {
                await post("/api/hub/app/store", { hub: h.name });
                await loadHub();
                appResult.value = { kind: "created" };
              })
            }
          >
            Store the key again
          </Busy>
        </div>
        <p class="muted small">If this setup stops first, the key is gone. Then delete the App at github.com/settings/apps and create it again here.</p>
      </div>
    );
  }
  if (h.app.id && !h.app.key) {
    return (
      <div class="panel">
        <Head title="The App's key is missing" lead={`The hub knows its App (${h.app.slug ?? h.app.id}), but its private key is not stored. Generate a new key on GitHub and store it from a clone of the hub:`} />
        <Cmd text="bunx @doguyilmaz/tapster init --rotate app" />
        <Out href={`https://github.com/settings/apps/${h.app.slug ?? ""}`}>Open the App on GitHub</Out>
      </div>
    );
  }
  if (created) {
    return (
      <div class="panel">
        <Head title="The GitHub App" lead="The hub uses this private App to write releases to the projects you install it on. It cannot touch anything else." />
        {result?.kind === "created" && <Note tone="ok" title="GitHub created the App and tapster stored its key in the hub." />}
        <dl class="facts">
          <dt>App</dt>
          <dd class="mono">{h.app.slug}</dd>
          <dt>Key</dt>
          <dd>A secret of the tapster environment in {h.name}</dd>
        </dl>
        <p class="muted small">
          Optional: give the App tapster's logo.{" "}
          <a href="/logo.png" download="tapster-logo.png">
            Download the logo
          </a>
          , then upload it under Display information in{" "}
          <a href={`https://github.com/settings/apps/${h.app.slug}`} target="_blank" rel="noopener noreferrer">
            the App's settings
          </a>
          . GitHub has no API for this.
        </p>
        <Installation h={h} slug={h.app.slug!} />
      </div>
    );
  }
  return (
    <div class="panel">
      <Head title="Create the GitHub App" lead={`${h.name} needs a GitHub App to write releases to your projects. GitHub creates it on your account after you confirm.`} />
      {result?.kind === "failed" && <Problem problem={result.problem} />}
      {result?.kind === "unknown" && <Note tone="warn" title="That answer from GitHub did not belong to this setup">Start the App again below; nothing was stored.</Note>}
      {start && (
        <div class="stack tight">
          <h3 class="section-title">It asks for</h3>
          <ul class="checks">
            {start.permissions.map((p) => (
              <li key={p}>
                <Icon name="right" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Note tone="keys" title="Where its key goes">
        <span>GitHub hands the App's private key to tapster on this computer, once. tapster stores it as a secret of the tapster environment in {h.name}. It goes nowhere else.</span>
      </Note>
      <Problem problem={problem} />
      {start ? (
        <form method="post" action={start.action} class="stack tight">
          <input type="hidden" name="manifest" value={start.manifest} />
          <div class="row">
            <button class="btn primary" type="submit">
              Continue to GitHub
              <Icon name="arrow" />
            </button>
          </div>
          <p class="muted small">
            GitHub shows the App <code>{start.name}</code>. Click <strong>Create GitHub App</strong> there and GitHub brings you back here.
          </p>
        </form>
      ) : (
        !problem && (
          <p class="row muted">
            <Spinner /> Preparing the App
          </p>
        )
      )}
    </div>
  );
}

function Mac({ h, choice }: { h: HubView; choice: "yes" | "no" | null }) {
  const needed = macNeeded(h, choice);
  return (
    <div class="panel">
      <Head title="Will this hub sign macOS software?" lead="Mac apps and command line tools with macOS builds must be signed and notarized by Apple. That needs an Apple Developer Program membership and two files from Apple." />
      {h.apple.needed ? (
        <Note tone="ok" title="Yes">
          <span>{h.apple.certificate || h.apple.notary ? "The hub already holds Apple credentials." : "tapster.yml lists packages with macOS code."}</span>
        </Note>
      ) : (
        <div class="choices">
          <button type="button" class="choice" aria-pressed={needed === true} onClick={() => setMac(h.name, "yes")}>
            <Icon name={needed === true ? "check" : "circle"} />
            <span class="grow">
              <strong>Yes, sign macOS software</strong>
              <span class="muted small">Next: your Developer ID certificate and a notarization key.</span>
            </span>
          </button>
          <button type="button" class="choice" aria-pressed={needed === false} onClick={() => setMac(h.name, "no")}>
            <Icon name={needed === false ? "check" : "circle"} />
            <span class="grow">
              <strong>No, only Linux and Windows</strong>
              <span class="muted small">The hub leaves macOS builds out. You can add Apple credentials later, here.</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function savedFor(text: string): void {
  history.pushState(null, "", `/setup?saved=${encodeURIComponent(text)}`);
  setTimeout(() => history.replaceState(null, "", "/setup"), 1500);
}

function Certificate({ h }: { h: HubView }) {
  const [file, setFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, problem, run] = useAction();
  const cert = h.apple.certificate;
  const showForm = !cert || !h.apple.certificateStored || replacing;
  const submit = (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    void run(async () => {
      if (!file) throw new ApiError({ reason: "no .p12 file is chosen", fix: "Drop the .p12 you exported from Keychain Access." }, 0);
      const data = new FormData(form);
      data.delete("username");
      data.set("hub", h.name);
      data.set("p12", file);
      const stored = await post<{ team: string; expires: string; name: string }>("/api/hub/certificate", data);
      savedFor("certificate");
      setReplacing(false);
      setFile(null);
      await loadHub();
      say("ok", `Certificate stored for team ${stored.team}. It expires on ${stored.expires}.`);
    });
  };
  return (
    <div class="panel">
      <Head title="Apple certificate" lead="A Developer ID Application certificate, exported with its private key as a .p12 file. The hub signs your macOS code with it." />
      {cert && h.apple.certificateStored && (
        <>
          <dl class="facts">
            <dt>Team</dt>
            <dd class="mono">{cert.team}</dd>
            <dt>Expires</dt>
            <dd>
              {cert.expires} {expiresSoon(cert.expires) && <Badge tone="error">Renew it soon</Badge>}
            </dd>
          </dl>
          {!replacing && (
            <div class="row">
              <button type="button" class="btn secondary" onClick={() => setReplacing(true)}>
                Replace the certificate
              </button>
              <span class="muted small">For a renewal or a new team.</span>
            </div>
          )}
        </>
      )}
      {showForm && (
        <>
          <details class="card pad" open={!cert}>
            <summary>
              <strong>How to get the .p12</strong>
            </summary>
            <ol class="stack tight" style="margin: 0.8rem 0 0; padding-left: 1.2rem">
              <li>
                No certificate yet? Create a <strong>Developer ID Application</strong> certificate at{" "}
                <a href="https://developer.apple.com/account/resources/certificates" target="_blank" rel="noopener noreferrer">
                  developer.apple.com
                </a>
                .
              </li>
              <li>
                In Keychain Access, open <strong>My Certificates</strong>, right-click <strong>Developer ID Application: …</strong> and choose <strong>Export</strong>.
              </li>
              <li>Save it as .p12 with a password. Your password manager can make one.</li>
            </ol>
          </details>
          <form class="secret" onSubmit={submit} autoComplete="on">
            <Field name="username" label="Name in your password manager" value={`${h.name}: Developer ID certificate`} autoComplete="username" hint="Your password manager saves the .p12 password under this name, so it can fill it in next time." />
            <FileDrop name="p12" accept=".p12,application/x-pkcs12" label="The .p12 file" file={file} onFile={setFile} hint="It stays in memory on this computer until tapster stores it in the hub." />
            <Password name="password" label="Its password" hint="The password you set when exporting it." />
            <Note tone="keys" title="Where it goes">
              <span>tapster opens the file with your password on this computer to check it is a Developer ID Application certificate that has not expired. Then the file and its password become secrets of the tapster environment in {h.name}. Keep your own backup: GitHub never shows a secret again.</span>
            </Note>
            <Problem problem={problem} />
            <div class="row">
              <Busy busy={busy} class="btn primary" type="submit">
                Check and store
              </Busy>
              {replacing && (
                <button type="button" class="btn quiet" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function Notary({ h }: { h: HubView }) {
  const [file, setFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, problem, run] = useAction();
  const showForm = !h.apple.notary || replacing;
  const submit = (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    void run(async () => {
      if (!file) throw new ApiError({ reason: "no .p8 file is chosen", fix: "Drop the AuthKey_….p8 you downloaded from App Store Connect." }, 0);
      const data = new FormData(form);
      data.set("hub", h.name);
      data.set("p8", file);
      const done = await post<{ checked: boolean }>("/api/hub/notary", data);
      savedFor("notary");
      setReplacing(false);
      setFile(null);
      await loadHub();
      say("ok", done.checked ? "Apple accepted the key and tapster stored it." : "Key stored. Apple checks it at the first release.");
    });
  };
  return (
    <div class="panel">
      <Head title="Notarization key" lead="An App Store Connect API key. The hub sends your signed code to Apple with it; Apple notarizes it." />
      {h.apple.notary && !replacing && (
        <>
          <Done text="The notarization key is stored" />
          <div class="row">
            <button type="button" class="btn secondary" onClick={() => setReplacing(true)}>
              Replace the key
            </button>
          </div>
        </>
      )}
      {showForm && (
        <>
          <details class="card pad" open={!h.apple.notary}>
            <summary>
              <strong>How to get the key</strong>
            </summary>
            <ol class="stack tight" style="margin: 0.8rem 0 0; padding-left: 1.2rem">
              <li>
                In{" "}
                <a href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank" rel="noopener noreferrer">
                  App Store Connect
                </a>
                , open <strong>Users and Access</strong>, <strong>Integrations</strong>, <strong>App Store Connect API</strong>, <strong>Team Keys</strong>.
              </li>
              <li>
                Create a key with <strong>Developer</strong> access and download <code>AuthKey_….p8</code>. Apple offers the download once.
              </li>
              <li>The Key ID is in the list; the Issuer ID is above it.</li>
            </ol>
          </details>
          <form class="secret" onSubmit={submit} autoComplete="off">
            <FileDrop name="p8" accept=".p8" label="The .p8 file" file={file} onFile={setFile} hint="It stays in memory on this computer until tapster stores it in the hub." />
            <div class="grid2">
              <Field name="keyId" label="Key ID" mono placeholder="ABCDE12345" />
              <Field name="issuerId" label="Issuer ID" mono placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <Note tone="keys" title="Where it goes">
              <span>On a Mac, tapster asks Apple whether the key works before storing it. The key and its two IDs become secrets of the tapster environment in {h.name}.</span>
            </Note>
            <Problem problem={problem} />
            <div class="row">
              <Busy busy={busy} class="btn primary" type="submit">
                Check with Apple and store
              </Busy>
              {replacing && (
                <button type="button" class="btn quiet" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

const EVERY = [5, 10, 15, 20, 30, 60, 120, 180, 360];

function FileCard({ f }: { f: FilesView["files"][number] }) {
  const tone = f.change === "create" ? "next" : f.change === "update" ? "warn" : f.change === "remove" ? "error" : undefined;
  const label = { create: "New", update: "Changes", same: "Unchanged", remove: "Removed" }[f.change];
  const diff = f.change === "update" && f.before !== null ? changedOnly(lineDiff(f.before, f.content)) : null;
  return (
    <details class="file">
      <summary>
        <Icon name="file" />
        <code>{f.path}</code>
        <Badge tone={tone}>{label}</Badge>
        <Icon name="down" />
      </summary>
      <pre class="block diff">
        {diff
          ? diff.map((l, i) => (
              <span key={i} class={l.kind === "gap" ? "hunk" : l.kind}>
                {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : l.kind === "gap" ? "@ " : "  "}
                {l.text}
                {"\n"}
              </span>
            ))
          : f.change === "remove"
            ? f.before
            : f.content}
      </pre>
    </details>
  );
}

function Files({ h }: { h: HubView }) {
  const [every, setEvery] = useState<number | null>(h.files.every);
  const [remove, setRemove] = useState<string[]>([]);
  const [readme, setReadme] = useState(false);
  const [view, setView] = useState<FilesView | null>(null);
  const [loading, loadProblem, load] = useAction();
  const [busy, problem, run] = useAction();
  const [written, setWritten] = useState(false);
  const others = h.protect.others.map((o) => o.file);
  useEffect(() => {
    void load(async () => setView(await post<FilesView>("/api/hub/files/preview", { hub: h.name, every, remove, readme })));
  }, [h.name, every, remove.join(","), readme]);
  const changes = view?.files.filter((f) => f.change !== "same") ?? [];
  const write = () =>
    run(async () => {
      const res = await post<{ result: string }>("/api/hub/files", { hub: h.name, every, remove, readme });
      setWritten(true);
      await loadHub();
      setView(await post<FilesView>("/api/hub/files/preview", { hub: h.name, every, remove: [], readme: false }));
      setRemove([]);
      setReadme(false);
      say("ok", res.result === "committed" ? `Wrote the hub files to ${h.name}.` : "The hub files were already up to date.");
    });
  return (
    <div class="panel">
      <Head title="Hub files" lead="The hub's settings, its record of published releases, a README for your users and the workflow that does the work. tapster writes them to main in one commit." />
      <div class="grid2">
        <div class="field">
          <label for="every">Look for new releases every</label>
          <select id="every" class="input" value={String(every ?? (h.private ? 60 : 10))} onChange={(e) => setEvery(Number((e.currentTarget as HTMLSelectElement).value))}>
            {EVERY.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : m === 60 ? "hour" : `${m / 60} hours`}
              </option>
            ))}
          </select>
          <span class="hint">{h.private ? "A private hub bills every run as at least one minute; hourly keeps a hub within the free minutes." : "Public hubs run for free. The doorbell can start the hub right after each release."}</span>
        </div>
      </div>
      {h.files.workflow === "newer" && (
        <Note tone="warn" title={`The hub runs ${h.files.pinned}, newer than this tapster`}>
          <span>
            tapster keeps the hub's workflow, so it does not move the hub back. To change the workflow, run the latest: <code>bunx @doguyilmaz/tapster@latest setup</code>
          </span>
        </Note>
      )}
      {others.length > 0 && (
        <div class="stack tight">
          <h3 class="section-title">The tap's old workflows</h3>
          {others.map((f) => (
            <label class="switch" key={f}>
              <input type="checkbox" checked={remove.includes(f)} onChange={(e) => setRemove((e.currentTarget as HTMLInputElement).checked ? [...remove, f] : remove.filter((x) => x !== f))} />
              <span>
                <strong>Remove .github/workflows/{f}</strong>
                <span>It stops running once the hub is protected. Its commits would make the hub refuse to run.</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {(view?.readme || readme) && (
        <label class="switch">
          <input type="checkbox" checked={readme} onChange={(e) => setReadme((e.currentTarget as HTMLInputElement).checked)} />
          <span>
            <strong>Replace README.md with tapster's</strong>
            <span>It tells your users how to install from the hub, including brew trust, which Homebrew asks for before it loads casks from a tap. Your current README goes away; the diff below shows both.</span>
          </span>
        </label>
      )}
      {loading && !view && (
        <p class="row muted">
          <Spinner /> Comparing with {h.name}
        </p>
      )}
      <Problem problem={loadProblem} />
      {view && (
        <div class="stack tight files">
          <div class="spread">
            <h3 class="section-title">{changes.length ? `${changes.length} ${changes.length === 1 ? "change" : "changes"} for main` : "main is up to date"}</h3>
            <span class="muted small">Workflow: {view.pin}</span>
          </div>
          {view.files.map((f) => (
            <FileCard key={f.path} f={f} />
          ))}
          {view.kept.length > 0 && <p class="muted small">Kept as they are: {view.kept.join(", ")}.</p>}
          {view.notes
            .filter((n) => !n.startsWith("The hub looks for new drafts every"))
            .map((n) => (
              <p class="muted small" key={n}>
                {n}
              </p>
            ))}
        </div>
      )}
      {view && view.foreign.length > 0 && (
        <Note tone="error" title="main changed in ways only you may change it">
          <ul class="log">
            {view.foreign.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <span>Review those commits on GitHub and revert what you did not make. tapster writes nothing to main until then, because a write from you would mark them as reviewed.</span>
        </Note>
      )}
      <Problem problem={problem} />
      {written && (
        <Note tone="info" title="Have a clone of the hub on this computer?">
          <span>
            Run <code>git pull</code> in it, so it has the new files.
          </span>
        </Note>
      )}
      {view && changes.length > 0 && view.foreign.length === 0 && (
        <div class="row">
          <Busy busy={busy} class="btn primary" onClick={write}>
            Write {changes.length === 1 ? "the change" : `the ${changes.length} changes`} to main
          </Busy>
        </div>
      )}
      {view && changes.length === 0 && <Done text="The hub files are up to date" />}
    </div>
  );
}

function Projects({ h }: { h: HubView }) {
  const [open, setOpen] = useState<SheetTarget | null>(null);
  useEffect(() => {
    void loadStatuses();
    if (clones.value?.hub !== h.name) void loadClones().catch(() => undefined);
  }, [h.name]);
  const list = statuses.value?.hub === h.name ? statuses.value.list : null;
  const local = clonePaths(clones.value?.hub === h.name ? clones.value.scan.projects : []);
  return (
    <div class="panel">
      <Head title={h.packages.length || list?.length ? "Your projects" : "Add your first project"} lead="tapster finds the projects cloned on this computer and adds them to the hub: it prepares the release workflow, protects the repository and proposes the hub entry. Open a project to see where it stands." />
      <Problem problem={statusError.value} />
      {list === null && h.packages.length > 0 && !statusError.value && (
        <p class="row muted" role="status">
          <Spinner /> Reading where your projects stand
        </p>
      )}
      {list !== null && list.length > 0 && <StatusRows list={list} paths={new Map([...local].map(([k, p]) => [k, p.path]))} onOpen={(s) => setOpen(targetOf(s, local))} />}
      {open && <ProjectSheet key={open.repo} target={open} hubName={h.name} onClose={() => setOpen(null)} />}
      {h.invalid.length > 0 && (
        <Note tone="warn" title="The hub leaves these entries out">
          <ul class="log">
            {h.invalid.map((i) => (
              <li key={i.name}>
                <code>{i.name}</code>: {i.reason}
              </li>
            ))}
          </ul>
        </Note>
      )}
      <div class="row">
        <button type="button" class="btn primary" onClick={() => go("/projects")}>
          {h.packages.length ? "Add more projects" : "Find my projects"}
          <Icon name="arrow" />
        </button>
      </div>
    </div>
  );
}

function SparkleKey({ h, label }: { h: HubView; label: string }) {
  const [account, setAccount] = useState("ed25519");
  const [read, setRead] = useState<{ publicKey: string; users: string[]; key: string } | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, problem, run] = useAction();
  if (!read) {
    return (
      <form
        class="card pad stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setRead(await post("/api/hub/sparkle/read", { hub: h.name, label, account })));
        }}
      >
        <strong>
          Sparkle key <code>{label}</code>
        </strong>
        <p class="muted small">tapster reads it from your login keychain, where Sparkle's generate_keys keeps it. macOS asks you first; choose Allow.</p>
        <div class="row" style="flex-wrap: nowrap; align-items: end">
          <Field name={`account-${label}`} label="Keychain account" value={account} mono onInput={setAccount} />
          <Busy busy={busy} class="btn primary" type="submit">
            <Icon name="key" />
            Read it from my keychain
          </Busy>
        </div>
        <Problem problem={problem} />
      </form>
    );
  }
  const submit = (e: Event) => {
    e.preventDefault();
    const pasted = String(new FormData(e.currentTarget as HTMLFormElement).get("password") ?? "");
    void run(async () => {
      await post("/api/hub/sparkle/store", { hub: h.name, label, pasted });
      savedFor(`sparkle-${label}`);
      await loadHub();
      say("ok", `Stored the Sparkle key ${label} in the hub.`);
    });
  };
  return (
    <div class="card pad stack tight">
      <strong>
        Sparkle key <code>{label}</code>
      </strong>
      <p class="muted small">
        It signs updates for {read.users.join(", ")}. Its public key, <code>{read.publicKey}</code>, matches tapster.yml.
      </p>
      <div class="cmd">
        <code>{shown ? read.key : "•".repeat(32)}</code>
        <button type="button" class="btn quiet small" onClick={() => setShown(!shown)} aria-pressed={shown}>
          {shown ? "Hide" : "Show"}
        </button>
        <Copy text={read.key} />
      </div>
      <Note tone="keys" title="Keep a copy outside your Mac">
        <span>If this key is lost, installed copies of the app can never update again. Paste it below: your password manager offers to save it when you store the key. tapster checks that the pasted key is the right one.</span>
      </Note>
      <form class="secret" onSubmit={submit} autoComplete="on">
        <Field name="username" label="Name in your password manager" value={`${h.name}: Sparkle key ${label}`} autoComplete="username" />
        <Password name="password" label="Paste the key" hint="The key from the box above, pasted as it is." />
        <Problem problem={problem} />
        <div class="row">
          <Busy busy={busy} class="btn primary" type="submit">
            Store in the hub
          </Busy>
        </div>
      </form>
    </div>
  );
}

function Extras({ h }: { h: HubView }) {
  const repo = h.name.split("/")[1]!;
  const missing = h.extras.sparkle.filter((s) => !s.stored);
  return (
    <div class="panel">
      <Head title="Optional extras" lead="The hub works without these. The doorbell and the apt and dnf key run in a terminal for now, in a clone of the hub, because they need Wrangler or gpg on your computer." />
      <Cmd text={`gh repo clone ${h.name} && cd ${repo}`} />
      <section class="stack tight">
        <div class="spread">
          <h3 class="section-title">Faster releases: the doorbell</h3>
          <Badge tone={h.extras.doorbell ? "ok" : undefined}>{h.extras.doorbell ? "On" : "Off"}</Badge>
        </div>
        <p class="muted">A small Worker on your own Cloudflare account starts the hub as soon as a project opens its draft, instead of at the next scheduled run. Wrangler asks you to sign in to Cloudflare in your browser.</p>
        {!h.extras.doorbell && <Cmd text="bunx @doguyilmaz/tapster init --doorbell" />}
        <a href="https://tapster.doguyilmaz.com/guides/doorbell/" target="_blank" rel="noopener noreferrer" class="small">
          Read the doorbell guide
        </a>
      </section>
      <section class="stack tight">
        <div class="spread">
          <h3 class="section-title">apt and dnf repositories</h3>
          <Badge tone={h.extras.linux.stored ? "ok" : h.extras.linux.wanted ? "warn" : undefined}>{h.extras.linux.stored ? "Key stored" : h.extras.linux.wanted ? "Key missing" : "Off"}</Badge>
        </div>
        <p class="muted">{h.extras.linux.wanted && !h.extras.linux.stored ? "tapster.yml asks for Linux packages, but the hub has no key to sign them yet." : "Linux users install your command line tools with apt and dnf from the hub's GitHub Pages. tapster makes the signing key with gpg and keeps a copy in your keychain."}</p>
        {!h.extras.linux.stored && <Cmd text="bunx @doguyilmaz/tapster init --linux" />}
        <a href="https://tapster.doguyilmaz.com/guides/linux/" target="_blank" rel="noopener noreferrer" class="small">
          Read the apt and dnf guide
        </a>
      </section>
      {h.extras.sparkle.length > 0 && (
        <section class="stack tight">
          <div class="spread">
            <h3 class="section-title">Sparkle keys</h3>
            <Badge tone={missing.length ? "warn" : "ok"}>{missing.length ? `${missing.length} missing` : "All stored"}</Badge>
          </div>
          <p class="muted">Each Mac app signs its update feed with a Sparkle key. tapster keeps it in your keychain and in the hub.</p>
          {missing[0] && <SparkleKey key={missing[0].label} h={h} label={missing[0].label} />}
          {missing.length > 1 && <p class="muted small">Then: {missing.slice(1).map((s) => s.label).join(", ")}. One key at a time, so your password manager saves each under its own name.</p>}
          <p class="faint small">
            No key yet? Make one in a terminal with <code>bunx @doguyilmaz/tapster init --sparkle &lt;label&gt; --new</code>; see the{" "}
            <a href="https://tapster.doguyilmaz.com/guides/sparkle/" target="_blank" rel="noopener noreferrer">
              Sparkle guide
            </a>
            .
          </p>
        </section>
      )}
    </div>
  );
}

function Ready({ h }: { h: HubView }) {
  return (
    <div class="card pad row" style="gap: 1.25rem; flex-wrap: nowrap">
      <img src="/courier.webp" alt="" width="96" height="96" style="border-radius: 20%; flex: none" />
      <div class="stack tight">
        <h2 class="section-title" style="font-size: 1.15rem">
          {h.name} is ready
        </h2>
        <p class="muted">Open a project under Your projects and click Release: tapster tags its latest commit on GitHub and the hub signs and publishes it on its next run. Health shows how the hub is doing.</p>
      </div>
    </div>
  );
}

export function Setup() {
  const h = hub.value;
  const [open, setOpen] = useState<StopId | "extras" | null>(() => {
    const asked = openStop.value as StopId | null;
    openStop.value = null;
    return asked;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  void macChoice.value;
  const listing = Boolean(h && h.name === hubName.value && h.files.config);
  useEffect(() => {
    if (listing && statuses.value?.hub !== h!.name) void loadStatuses();
  }, [h?.name, listing]);
  if (hubError.value) {
    return (
      <div class="stack" style="max-width: 640px">
        <Problem problem={hubError.value} />
        <div class="row">
          <button type="button" class="btn secondary" onClick={() => void loadHub()}>
            <Icon name="refresh" />
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!h || h.name !== hubName.value) {
    return (
      <p class="row muted" role="status">
        <Spinner /> Reading {hubName.value} from GitHub
      </p>
    );
  }
  const choice = mac(h.name);
  const list = stops(h, choice, Date.now(), statuses.value?.hub === h.name ? statuses.value.list : null);
  const current = open ?? (appResult.value?.kind === "created" ? "app" : firstOpen(list));
  const done = list.filter((s) => s.state === "done" || s.state === "skipped").length;
  const next = list.find((s) => s.state === "now" || s.state === "attention");
  const pick = (id: StopId | "extras") => {
    setOpen(id);
    if (window.matchMedia("(max-width: 900px)").matches) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const gate = (what: string, el: preact.JSX.Element) => (h.protect.environment ? el : <ProtectFirst h={h} what={what} onGo={() => pick("protect")} />);
  const panel: Record<StopId | "extras", preact.JSX.Element> = {
    extras: <Extras h={h} />,
    protect: <Protect h={h} />,
    app: h.app.id || h.app.held || appResult.value?.kind === "unstored" ? <App h={h} /> : gate("Create the GitHub App", <App h={h} />),
    macos: <Mac h={h} choice={choice} />,
    certificate: gate("Apple certificate", <Certificate h={h} />),
    notary: gate("Notarization key", <Notary h={h} />),
    files: <Files h={h} />,
    project: <Projects h={h} />,
  };
  return (
    <div class="stack" style="gap: 1.5rem">
      <div class="spread">
        <div class="stack tight">
          <p class="eyebrow">
            {done} of {list.length} done{next ? `. Next: ${next.name}` : ""}
            {hubLoading.value && <Spinner label="Checking GitHub" />}
          </p>
          <h1 class="title">{next ? `Set up ${h.name}` : `${h.name} is set up`}</h1>
        </div>
        <Out href={h.url} class="btn quiet">
          {h.name} on GitHub
        </Out>
      </div>
      <div class="progress" aria-hidden="true">
        <span style={`width: ${(done / list.length) * 100}%`} />
      </div>
      {!next && <Ready h={h} />}
      {h.empty && <Note tone="info" title={`${h.name} has no commits yet`}>tapster gives it a first commit when it writes the hub files.</Note>}
      <div class="setup">
        <ol class="route" aria-label="Setup steps">
          {list.map((s, i) => (
            <li key={s.id} class={`${s.state}${s.id === current ? " open" : ""}`}>
              <button type="button" onClick={() => pick(s.id)} aria-current={s.id === current ? "step" : undefined} aria-label={`${s.name}: ${s.status}${s.state === "now" ? ", next" : s.state === "attention" ? ", needs you" : ""}`}>
                <Dot stop={s} index={i} />
                <span>
                  <span class="stop-name">{s.name}</span>
                  <span class="stop-state">{s.status}</span>
                </span>
              </button>
            </li>
          ))}
          <li class={`extra${current === "extras" ? " open" : ""}`}>
            <button type="button" onClick={() => pick("extras")} aria-current={current === "extras" ? "step" : undefined}>
              <span class="dot">
                <Icon name="plus" />
              </span>
              <span>
                <span class="stop-name">Optional extras</span>
                <span class="stop-state">Doorbell, apt and dnf, Sparkle</span>
              </span>
            </button>
          </li>
        </ol>
        <div class="card pad stack" ref={panelRef} style="gap: 1.5rem">
          {panel[current]}
          {(() => {
            const at = list.findIndex((s) => s.id === current);
            const here = list[at];
            const after = list.slice(at + 1).find((s) => s.state !== "done" && s.state !== "skipped");
            if (!here || (here.state !== "done" && here.state !== "skipped") || !after) return null;
            return (
              <div class="row" style="border-top: 1px solid var(--line); padding-top: 1.25rem">
                <button type="button" class="btn primary" onClick={() => pick(after.id)}>
                  Continue: {after.name}
                  <Icon name="arrow" />
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
