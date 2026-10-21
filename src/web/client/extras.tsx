import { useEffect, useState } from "preact/hooks";
import type { AppStart, BellInstallView, DoorbellDone, HubView } from "../contract";
import { ApiError, get, post } from "./api";
import { doorbellResult, loadHub, problemOf, say } from "./state";
import { Badge, Busy, Cmd, Copy, Done, Field, FileDrop, Head, Icon, Note, Out, Password, Problem, Spinner, savedFor, useAction } from "./ui";

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
  const cloud = h.extras.doorbell.cloudflare;
  if (cloud) {
    return (
      <p class="muted">
        Cloudflare account <strong>{cloud.account}</strong>, Workers on <code>{cloud.subdomain}.workers.dev</code>. tapster keeps the token in memory until the doorbell is deployed, for an hour at most.
      </p>
    );
  }
  const submit = (e: Event) => {
    e.preventDefault();
    const token = String(new FormData(e.currentTarget as HTMLFormElement).get("token") ?? "");
    void run(async () => {
      await post("/api/hub/doorbell/cloudflare", { hub: h.name, token });
      savedFor("cloudflare");
      await loadHub();
    });
  };
  return (
    <>
      <p class="muted">
        Cloudflare's token page opens with one permission filled in: <strong>Workers Scripts: Edit</strong>. Click <strong>Continue to summary</strong>, then <strong>Create Token</strong>. Copy the token it shows.
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
    </>
  );
}

function BellInstall({ h, view }: { h: HubView; view: BellInstallView | null }) {
  const slug = h.extras.doorbell.app?.slug ?? "";
  if (!h.extras.doorbell.key) return <p class="muted small">After the App.</p>;
  if (view?.id && view.others.length) {
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
  if (view?.id) return <p class="muted">Installed on {h.name} only.</p>;
  return (
    <>
      <p class="muted">
        On GitHub, choose <strong>Only select repositories</strong> and pick {h.name}, only that one. Click <strong>Install</strong>.
      </p>
      <div class="row">
        <Out href={`https://github.com/apps/${slug}/installations/new`} class="btn primary">
          Install the doorbell App
        </Out>
      </div>
      <p class="row muted small" role="status">
        <Spinner /> Not installed yet. This updates by itself.
      </p>
    </>
  );
}

function useBellInstall(h: HubView): BellInstallView | null {
  const [view, setView] = useState<BellInstallView | null>(null);
  const held = h.extras.doorbell.key;
  useEffect(() => {
    if (!held) return;
    let timer = 0;
    let wait = 4000;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const next = await get<BellInstallView>(`/api/hub/doorbell/installation?hub=${encodeURIComponent(h.name)}`);
          setView(next);
          wait = next.id !== null && next.others.length === 0 ? 30000 : 4000;
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 300);
    return () => clearTimeout(timer);
  }, [h.name, held]);
  return held ? view : null;
}

const COST = "It costs nothing on Cloudflare's free plan, which allows 100,000 requests a day and 5 cron triggers. At a 10 minute interval the doorbell uses about 150 requests a day and one cron trigger.";

function Doorbell({ h }: { h: HubView }) {
  const d = h.extras.doorbell;
  const install = useBellInstall(h);
  const [busy, problem, run] = useAction();
  const [done, setDone] = useState<DoorbellDone | null>(null);
  const ready = Boolean(d.cloudflare && d.key && install?.id && install.others.length === 0);
  const deploy = () =>
    run(async () => {
      const res = await post<DoorbellDone>("/api/hub/doorbell/deploy", { hub: h.name });
      setDone(res);
      doorbellResult.value = null;
      await loadHub();
      say("ok", `The doorbell answers at ${res.origin}.`);
    });
  return (
    <section class="stack tight">
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
          {done && <p class="muted small">{done.rung.length ? `${done.rung.join(", ")} ring it from now on.` : "No project lists it yet; tapster add gives each new project its address."}</p>}
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
          <Step n={3} title="Install it on the hub only" done={Boolean(install?.id && install.others.length === 0)}>
            <BellInstall h={h} view={install} />
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

function Linux({ h }: { h: HubView }) {
  const l = h.extras.linux;
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [maintainer, setMaintainer] = useState(l.maintainer ?? "");
  const [picked, setPicked] = useState<string[]>(l.tools.filter((t) => t.on).map((t) => t.name));
  const [making, makeProblem, make] = useAction();
  const [writing, writeProblem, write] = useAction();
  const makeKey = () =>
    make(async () => {
      const res = await post<{ fingerprint: string }>("/api/hub/linux/key", { hub: h.name });
      setFingerprint(res.fingerprint);
      await loadHub();
      say("ok", "Stored the Linux signing key in the hub and in your keychain.");
    });
  const submit = (e: Event) => {
    e.preventDefault();
    void write(async () => {
      const res = await post<{ result: string }>("/api/hub/linux/config", { hub: h.name, maintainer, tools: picked });
      await loadHub();
      say("ok", res.result === "committed" ? "Wrote the Linux settings to tapster.yml on main." : "tapster.yml already had these settings.");
    });
  };
  const changed = maintainer !== (l.maintainer ?? "") || picked.join() !== l.tools.filter((t) => t.on).map((t) => t.name).join();
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
              <span>The key becomes a secret of {h.name}'s tapster environment. tapster also keeps it in your login keychain, because GitHub never gives a secret back. Nothing else holds it.</span>
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
            <form class="stack tight" onSubmit={submit}>
              <Field name="maintainer" label="Maintainer" value={maintainer} onInput={setMaintainer} placeholder="Your Name <you@example.com>" hint="Every .deb and .rpm names this person, as Name <address>." />
              {l.tools.length ? (
                l.tools.map((t) => (
                  <label class="switch" key={t.name}>
                    <input type="checkbox" checked={picked.includes(t.name)} onChange={(e) => setPicked((e.currentTarget as HTMLInputElement).checked ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />
                    <span>
                      <strong>Ship {t.name} to apt and dnf</strong>
                      <span>Sets linux: true on its entry in tapster.yml.</span>
                    </span>
                  </label>
                ))
              ) : (
                <p class="muted small">No command line tool in tapster.yml maps a Linux archive yet.</p>
              )}
              <Problem problem={writeProblem} />
              <div class="row">
                <Busy busy={writing} class="btn primary" type="submit" disabled={!changed || !maintainer}>
                  Write to tapster.yml
                </Busy>
              </div>
            </form>
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
