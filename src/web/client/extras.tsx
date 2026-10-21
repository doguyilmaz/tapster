import { useEffect, useState } from "preact/hooks";
import type { AppStart, BellCloud, BellInstallView, DoorbellDone, HubView, LinuxChange, Problem as ProblemView } from "../contract";
import { installStep, linuxWrite, toolState } from "../steps";
import { ApiError, post } from "./api";
import { doorbellResult, loadHub, problemOf, say, setCloud } from "./state";
import { KIND } from "./status";
import { Badge, Busy, Cmd, Copy, DiffBlock, Done, Field, FileDrop, Head, Icon, ManifestForm, Note, Out, Password, Problem, Spinner, savedFor, useAction, useInstall } from "./ui";

const GUIDE = "https://tapster.doguyilmaz.com/guides/";

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: preact.ComponentChildren }) {
  return (
    <li class="card pad stack tight">
      <div class="spread">
        <strong>
          {n}. {title}
        </strong>
        {done && <Badge tone="ok">Done</Badge>}
      </div>
      {children}
    </li>
  );
}

function BellToken({ h }: { h: HubView }) {
  const [busy, problem, run] = useAction();
  const [chosen, setChosen] = useState<string | null>(null);
  const cloud = h.extras.doorbell.cloudflare;
  if (cloud) {
    return (
      <p class="muted">
        Cloudflare account <strong>{cloud.account}</strong>, Workers on <code>{cloud.subdomain}.workers.dev</code>. tapster keeps the token in memory until the doorbell is deployed, for an hour at most.
      </p>
    );
  }
  const accounts = h.extras.doorbell.accounts;
  if (accounts) {
    const pick = (account: string) => {
      setChosen(account);
      void run(async () => setCloud(h.name, await post<BellCloud>("/api/hub/doorbell/account", { hub: h.name, account })));
    };
    return (
      <>
        <p class="muted">The token reaches several Cloudflare accounts. Pick the one the doorbell runs in. Next time you can narrow the token to that account under Account Resources on Cloudflare's token page.</p>
        <div class="choices">
          {accounts.map((a) => {
            const checking = busy && chosen === a.id;
            return (
              <button type="button" class="choice" key={a.id} disabled={busy} aria-pressed={checking} aria-busy={checking} onClick={() => pick(a.id)}>
                {checking ? <Spinner label="Checking" /> : <Icon name="circle" />}
                <span class="grow">
                  <strong>{a.name}</strong>
                  <span class="muted small mono">{a.id}</span>
                  {checking && <span class="small">Checking its Workers on Cloudflare</span>}
                </span>
              </button>
            );
          })}
        </div>
        <Problem problem={problem} />
      </>
    );
  }
  const submit = (e: Event) => {
    e.preventDefault();
    const token = String(new FormData(e.currentTarget as HTMLFormElement).get("token") ?? "");
    void run(async () => {
      const cloud = await post<BellCloud>("/api/hub/doorbell/cloudflare", { hub: h.name, token });
      savedFor("cloudflare");
      setCloud(h.name, cloud);
    });
  };
  return (
    <>
      <p class="muted">
        Cloudflare's token page opens with one permission filled in: <strong>Workers Scripts: Edit</strong>. Click <strong>Continue to summary</strong>, then <strong>Create Token</strong>. Copy the token it shows. To keep it to one Cloudflare account, pick that account under <strong>Account Resources</strong> on the same page.
      </p>
      <div class="row">
        <Out href={h.extras.doorbell.tokenPage}>Open Cloudflare's token page</Out>
      </div>
      <form class="secret" onSubmit={submit} autoComplete="on">
        <Field name="username" id="bell-username" label="Name in your password manager" value={`${h.name}: Cloudflare doorbell token`} autoComplete="username" hint="Your password manager saves the token under this name." />
        <Password name="token" label="The token" hint="tapster uses it for this setup only. It never stores or logs it." />
        <Problem problem={problem} />
        <div class="row">
          <Busy busy={busy} class="btn primary" type="submit">
            Check the token
          </Busy>
        </div>
      </form>
    </>
  );
}

function BellApp({ h }: { h: HubView }) {
  const d = h.extras.doorbell;
  const [start, setStart] = useState<AppStart | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<ReturnType<typeof problemOf> | null>(null);
  const [busy, keyProblem, run] = useAction();
  const fresh = !d.app && Boolean(d.cloudflare);
  useEffect(() => {
    if (!fresh) return;
    post<AppStart>("/api/hub/doorbell/app", { hub: h.name }).then(setStart, (e) => setProblem(problemOf(e)));
  }, [h.name, fresh]);
  const result = doorbellResult.value;
  if (d.key) {
    return (
      <>
        {result?.kind === "created" && <Note tone="ok" title="GitHub created the doorbell App. This setup holds its key." />}
        {result?.kind === "unstored" && <Problem problem={result.problem} />}
        <p class="muted">
          The doorbell App <code>{d.app?.slug}</code> may start the hub's workflow and nothing else. Its key stays in this setup's memory until it goes to Cloudflare.
        </p>
      </>
    );
  }
  if (d.app) {
    const drop = () =>
      run(async () => {
        if (!file) throw new ApiError({ reason: "no .pem file is chosen", fix: "Drop the .pem file GitHub downloaded." }, 0);
        const data = new FormData();
        data.set("hub", h.name);
        data.set("pem", file);
        await post("/api/hub/doorbell/key", data);
        setFile(null);
        await loadHub();
      });
    return (
      <>
        <p class="muted">
          The hub knows the doorbell App <code>{d.app.slug}</code>, but this setup does not hold its key. GitHub hands a key over only once, so make a new one: open the App's settings, scroll to <strong>Private keys</strong> and click <strong>Generate a private key</strong>.
        </p>
        <div class="row">
          <Out href={`https://github.com/settings/apps/${d.app.slug}`}>Open the App's settings</Out>
        </div>
        <FileDrop name="pem" accept=".pem" label="The .pem file" file={file} onFile={setFile} hint="tapster checks that it belongs to the doorbell App. Once the doorbell runs, delete the file and every older key on that page." />
        <Problem problem={keyProblem} />
        <div class="row">
          <Busy busy={busy} class="btn primary" onClick={drop}>
            Use this key
          </Busy>
        </div>
      </>
    );
  }
  if (!d.cloudflare) return <p class="muted small">After the token.</p>;
  return (
    <>
      {result?.kind === "failed" && <Problem problem={result.problem} />}
      <p class="muted">A second private App on your account. The doorbell uses it only to start {h.name}'s workflow.</p>
      {start && (
        <ul class="checks">
          {start.permissions.map((p) => (
            <li key={p}>
              <Icon name="right" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}
      <Note tone="keys" title="Where its key goes">
        <span>GitHub hands the App's private key to this setup, once. tapster keeps it in memory and sends it to your Cloudflare account as a secret of the doorbell Worker. It never goes to GitHub or anywhere else.</span>
      </Note>
      <Problem problem={problem} />
      {start ? (
        <ManifestForm start={start} />
      ) : (
        !problem && (
          <p class="row muted">
            <Spinner /> Preparing the App
          </p>
        )
      )}
    </>
  );
}

type Watch = ReturnType<typeof useInstall<BellInstallView>>;

const bellStep = (h: HubView, w: Watch) => installStep(w.view && { id: w.view.id, wide: w.view.others.length > 0 }, w.asked);

function BellInstall({ h, watch }: { h: HubView; watch: Watch }) {
  const d = h.extras.doorbell;
  const view = watch.view;
  if (!d.key) return <p class="muted small">After the App.</p>;
  const step = bellStep(h, watch);
  if (step === "wide" && view) {
    return (
      <Note tone="error" title="The doorbell App reaches more than the hub">
        <span>
          It may start workflows only in {h.name}. Remove {view.others.join(", ")} from it: choose <strong>Only select repositories</strong> and keep only {h.name}.
        </span>
        <Out href={`https://github.com/settings/installations/${view.id}`} class="btn secondary small">
          Open the installation
        </Out>
      </Note>
    );
  }
  if (step === "done") return <p class="muted">Installed on {h.name} only.</p>;
  return (
    <>
      <p class="muted">
        This step needs your click on GitHub. Click <strong>Install the doorbell App</strong>: GitHub opens with <strong>Only select repositories</strong> and {h.name} picked. Keep only {h.name} and click <strong>Install</strong> there.
      </p>
      <div class="row">
        <Out href={d.install ?? ""} class="btn primary" onClick={watch.ask}>
          Install the doorbell App
        </Out>
      </div>
      {step === "waiting" && (
        <p class="row muted small" role="status">
          <Spinner label="Waiting for GitHub" /> Waiting for your click on GitHub. This step updates by itself once you click Install there.
        </p>
      )}
    </>
  );
}

const COST = "It costs nothing on Cloudflare's free plan, which allows 100,000 requests a day and 5 cron triggers. At a 10 minute interval the doorbell uses about 150 requests a day and one cron trigger.";

function Doorbell({ h }: { h: HubView }) {
  const d = h.extras.doorbell;
  const watch = useInstall<BellInstallView>(d.key ? `/api/hub/doorbell/installation?hub=${encodeURIComponent(h.name)}` : null, (v) => v.id !== null && v.others.length === 0);
  const [busy, problem, run] = useAction();
  const [done, setDone] = useState<DoorbellDone | null>(null);
  const installed = d.key && bellStep(h, watch) === "done";
  const ready = Boolean(d.cloudflare && installed);
  const deploy = () =>
    run(async () => {
      const res = await post<DoorbellDone>("/api/hub/doorbell/deploy", { hub: h.name });
      setDone(res);
      doorbellResult.value = null;
      await loadHub();
      say("ok", `The doorbell answers at ${res.origin}.`);
    });
  return (
    <section class="stack tight anchor" id="doorbell">
      <div class="spread">
        <h3 class="section-title">Faster releases: the doorbell</h3>
        <Badge tone={d.on ? "ok" : undefined}>{d.on ? "On" : "Off"}</Badge>
      </div>
      <p class="muted">A small Worker on your own Cloudflare account starts the hub as soon as a project opens its draft, instead of at the next scheduled run.</p>
      <p class="muted small">{COST}</p>
      {d.on ? (
        <>
          <dl class="facts">
            <dt>Address</dt>
            <dd class="mono">{d.origin}</dd>
          </dl>
          {done && done.rung.length > 0 && <p class="muted small">{done.rung.join(", ")} ring it from now on.</p>}
          {done && done.rung.length + done.missed.length === 0 && <p class="muted small">No project lists it yet; tapster add gives each new project its address.</p>}
          {done && done.missed.length > 0 && (
            <Note tone="warn" title="These projects did not get the doorbell's address">
              <ul class="log">
                {done.missed.map((r) => (
                  <li key={r}>
                    <code>gh variable set TAPSTER_DOORBELL --repo {r} --body {done.origin}</code>
                  </li>
                ))}
              </ul>
            </Note>
          )}
          <p class="faint small">
            To give it a new key, run <code>bunx @doguyilmaz/tapster init --rotate doorbell</code> in a clone of the hub.
          </p>
        </>
      ) : !h.protect.environment ? (
        <Note tone="info" title="Protect the hub first">
          <span>The doorbell keeps its App's ID in {h.name}'s tapster environment.</span>
        </Note>
      ) : (
        <ol class="stack steps">
          <Step n={1} title="A Cloudflare token" done={Boolean(d.cloudflare)}>
            <BellToken h={h} />
          </Step>
          <Step n={2} title="The doorbell App" done={d.key}>
            <BellApp h={h} />
          </Step>
          <Step n={3} title="Install it on the hub only" done={installed}>
            <BellInstall h={h} watch={watch} />
          </Step>
          <Step n={4} title="Deploy">
            <p class="muted">tapster bundles the Worker, uploads it to your Cloudflare account with the App's key as a secret and gives every project in tapster.yml its address.</p>
            <Problem problem={problem} />
            <div class="row">
              <Busy busy={busy} class="btn primary" disabled={!ready} onClick={deploy}>
                Deploy the doorbell
              </Busy>
            </div>
          </Step>
        </ol>
      )}
      <a href={`${GUIDE}doorbell/`} target="_blank" rel="noopener noreferrer" class="small">
        Read the doorbell guide
      </a>
    </section>
  );
}

function LinuxTools({ h }: { h: HubView }) {
  const l = h.extras.linux;
  const [maintainer, setMaintainer] = useState(l.maintainer ?? "");
  const [shown, setShown] = useState(l.tools);
  const [picked, setPicked] = useState<string[]>(l.tools.filter((t) => t.on).map((t) => t.name));
  const seen = JSON.stringify([l.maintainer, l.tools]);
  useEffect(() => {
    setMaintainer(l.maintainer ?? "");
    setShown(l.tools);
    setPicked(l.tools.filter((t) => t.on).map((t) => t.name));
  }, [seen]);
  const [writing, writeProblem, write] = useAction();
  const [change, setChange] = useState<LinuxChange | null>(null);
  const [checkProblem, setCheckProblem] = useState<ProblemView | null>(null);
  const body = { hub: h.name, maintainer, tools: shown.map((t) => ({ name: t.name, was: t.on, on: picked.includes(t.name) })) };
  const toolsChanged = body.tools.filter((t) => t.was !== t.on).length;
  const maintainerChanged = maintainer.trim() !== (l.maintainer ?? "");
  const changed = maintainerChanged || toolsChanged > 0;
  const asked = JSON.stringify(body);
  useEffect(() => {
    setChange(null);
    setCheckProblem(null);
    if (!changed || !maintainer.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      post<LinuxChange>("/api/hub/linux/preview", body).then(
        (c) => live && setChange(c),
        (e) => live && setCheckProblem(problemOf(e)),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked]);
  const submit = (e: Event) => {
    e.preventDefault();
    void write(async () => {
      const res = await post<{ result: string }>("/api/hub/linux/config", body);
      await loadHub();
      say("ok", res.result === "committed" ? "Wrote the Linux settings to tapster.yml on main." : "tapster.yml already had these settings.");
    });
  };
  const on = l.tools.filter((t) => t.on).map((t) => t.name);
  return (
    <form class="stack tight" onSubmit={submit}>
      <Field name="maintainer" label="Maintainer" value={maintainer} onInput={setMaintainer} placeholder="Your Name <you@example.com>" hint="Every .deb and .rpm names this person, as Name <address>." />
      <div class="stack tight">
        <div class="spread">
          <h4 class="section-title">Command line tools to ship</h4>
          <span class="small" role="status">
            On now: {on.length ? on.join(", ") : "none"}
          </span>
        </div>
        <p class="muted small">Only tools with Linux archives in tapster.yml are listed. Each switch sets linux: true or false on the tool's entry.</p>
        {shown.length ? (
          shown.map((t) => {
            const now = picked.includes(t.name);
            return (
              <label class="switch" key={t.name}>
                <input type="checkbox" checked={now} aria-describedby={`tool-${t.name}`} onChange={(e) => setPicked((e.currentTarget as HTMLInputElement).checked ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />
                <span class="grow">
                  <strong>Ship {t.name} to apt and dnf</strong>
                  <span id={`tool-${t.name}`}>
                    {t.repo} · {KIND[t.kind] ?? t.kind} · {t.archives.join(", ")}
                  </span>
                </span>
                <Badge tone={t.on !== now ? "next" : now ? "ok" : undefined}>{toolState(t.on, now)}</Badge>
              </label>
            );
          })
        ) : (
          <p class="muted small">No command line tool in tapster.yml maps a Linux archive yet.</p>
        )}
        {l.left.length > 0 && <p class="muted small">Not listed: {l.left.map((x) => `${x.name} ${x.why}`).join("; ")}.</p>}
      </div>
      {change && change.after !== change.before && (
        <div class="stack tight">
          <h4 class="section-title">The change to tapster.yml</h4>
          <DiffBlock before={change.before} after={change.after} label="The change to tapster.yml" />
        </div>
      )}
      <Problem problem={checkProblem ?? writeProblem} />
      <div class="row">
        <Busy busy={writing} class="btn primary" type="submit" disabled={!changed || !change || change.after === change.before}>
          {linuxWrite(maintainerChanged, toolsChanged)}
        </Busy>
      </div>
    </form>
  );
}

function Linux({ h }: { h: HubView }) {
  const l = h.extras.linux;
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [making, makeProblem, make] = useAction();
  const makeKey = () =>
    make(async () => {
      const res = await post<{ fingerprint: string; keychain: boolean }>("/api/hub/linux/key", { hub: h.name });
      setFingerprint(res.fingerprint);
      await loadHub();
      say("ok", `Stored the Linux signing key in the hub and in your ${res.keychain ? "login keychain" : "keyring"}.`);
    });
  return (
    <section class="stack tight">
      <div class="spread">
        <h3 class="section-title">apt and dnf repositories</h3>
        <Badge tone={l.stored ? "ok" : l.wanted ? "warn" : undefined}>{l.stored ? "Key stored" : l.wanted ? "Key missing" : "Off"}</Badge>
      </div>
      <p class="muted">{l.wanted && !l.stored ? "tapster.yml asks for Linux packages, but the hub has no key to sign them yet." : "Linux users install your command line tools with apt and dnf from the hub's GitHub Pages. The hub signs the packages with a key of your own."}</p>
      {!l.stored &&
        (!h.protect.environment ? (
          <Note tone="info" title="Protect the hub first">
            <span>The key goes into {h.name}'s tapster environment.</span>
          </Note>
        ) : !l.gpg ? (
          <Note tone="warn" title="GnuPG is not installed">
            <span>tapster makes the key with GnuPG on this computer. Install it, then check again.</span>
            <Cmd text="brew install gnupg" />
            <div class="row">
              <button type="button" class="btn secondary small" onClick={() => void loadHub()}>
                <Icon name="refresh" />
                Check again
              </button>
            </div>
          </Note>
        ) : !l.keystore ? (
          <Note tone="warn" title="This computer has no keychain tapster can use">
            <span>On Linux, install secret-tool (libsecret-tools), then check again. The key must never live only in GitHub, which never gives secrets back.</span>
          </Note>
        ) : (
          <>
            <ul class="checks">
              <li>
                <Icon name="right" />
                <span>Turns on GitHub Pages for {h.name}, with GitHub Actions as the source.</span>
              </li>
              <li>
                <Icon name="right" />
                <span>Makes an RSA 4096 signing key with GnuPG on this computer.</span>
              </li>
            </ul>
            <Note tone="keys" title="Where it goes">
              <span>
                The key becomes a secret of {h.name}'s tapster environment. tapster also keeps it in your {l.keystore === "keyring" ? "keyring" : "login keychain"}, because GitHub never gives a secret back. Nothing else holds it.
              </span>
            </Note>
            <Problem problem={makeProblem} />
            <div class="row">
              <Busy busy={making} class="btn primary" onClick={makeKey}>
                <Icon name="key" />
                Make the signing key
              </Busy>
            </div>
          </>
        ))}
      {l.stored && (
        <>
          {fingerprint ? (
            <dl class="facts">
              <dt>Fingerprint</dt>
              <dd class="mono">{fingerprint}</dd>
            </dl>
          ) : (
            <Done text="The signing key is stored" />
          )}
          <p class="faint small">
            To replace it, run <code>bunx @doguyilmaz/tapster init --rotate linux</code> in a clone of the hub. The{" "}
            <a href={`${GUIDE}linux/#rotate-the-key`} target="_blank" rel="noopener noreferrer">
              guide
            </a>{" "}
            explains how users move to the new key.
          </p>
          {h.files.config ? (
            <LinuxTools h={h} />
          ) : (
            <p class="muted small">Write the hub files first; then pick the tools here.</p>
          )}
        </>
      )}
      <a href={`${GUIDE}linux/`} target="_blank" rel="noopener noreferrer" class="small">
        Read the apt and dnf guide
      </a>
    </section>
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

export function Extras({ h }: { h: HubView }) {
  const missing = h.extras.sparkle.filter((s) => !s.stored);
  return (
    <div class="panel">
      <Head title="Optional extras" lead="The hub works without these. Each one runs from this page; the terminal commands do the same." />
      <Doorbell h={h} />
      <Linux h={h} />
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
            <a href={`${GUIDE}sparkle/`} target="_blank" rel="noopener noreferrer">
              Sparkle guide
            </a>
            .
          </p>
        </section>
      )}
    </div>
  );
}
