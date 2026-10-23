import { signal } from "@preact/signals";
import { render } from "preact";
import type { Problem as ProblemView, SessionView } from "../contract";
import { ApiError, claim, get, post, whenSignedOut } from "./api";
import { AccountGate, Stopped, Waiting, NoSession } from "./gates";
import { Health } from "./health";
import { HubChooser } from "./hubs";
import { Projects } from "./projects";
import { Back, Setup } from "./setup";
import { landing } from "../steps";
import { account, accountError, appResult, back, chooseHub, doorbellResult, dropView, go, hubCached, hubName, loadAccount, loadHub, openStop, path, problemOf, restoreHub, say, session, statusCached, toast } from "./state";
import { Icon, Note, Spinner } from "./ui";
import { Confirm } from "./confirm";
import { Banners, watchTapster } from "./update";

type Boot = { kind: "claiming" } | { kind: "ready" } | { kind: "no-session" } | { kind: "failed"; problem: ProblemView } | { kind: "stopped" };
const boot = signal<Boot>({ kind: "claiming" });
const choosing = signal(false);

function readReturn(): void {
  const l = landing(location.search);
  if (!l) return;
  history.replaceState(null, "", location.pathname);
  if (l.hub && l.hub !== hubName.value) chooseHub(l.hub, false);
  appResult.value = l.app;
  doorbellResult.value = l.doorbell;
  openStop.value = l.open;
  back.value = l;
}

async function start(): Promise<void> {
  const code = /^#c=([0-9a-f]{32})$/.exec(location.hash)?.[1];
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (code) {
    try {
      await claim(code);
    } catch (e) {
      boot.value = { kind: "failed", problem: problemOf(e) };
      return;
    }
  }
  try {
    session.value = await get<SessionView>("/api/session");
  } catch (e) {
    boot.value = e instanceof ApiError && e.status === 401 ? { kind: "no-session" } : { kind: "failed", problem: problemOf(e) };
    return;
  }
  readReturn();
  if (!back.value) restoreHub();
  boot.value = { kind: "ready" };
  const here = session.value.here.hub;
  if (!hubName.value && here) chooseHub(here);
  else if (hubName.value) void loadHub();
  watchTapster();
  await loadAccount();
}

whenSignedOut(() => {
  dropView();
  boot.value = { kind: "no-session" };
});

async function quit(): Promise<void> {
  try {
    await post("/api/quit");
  } catch {
    return;
  }
  boot.value = { kind: "stopped" };
}

function Link({ to, children }: { to: string; children: string }) {
  const current = path.value === to || (to === "/setup" && path.value === "/");
  return (
    <a
      href={to}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

function Header() {
  const acc = account.value;
  return (
    <header class="top">
      <div class="stripe" />
      <div class="bar">
        <a
          class="brand"
          href="/setup"
          onClick={(e) => {
            e.preventDefault();
            go("/setup");
          }}
        >
          <img src="/logo.webp" alt="" width="28" height="28" />
          tapster <small>setup</small>
        </a>
        {hubName.value && (
          <nav class="nav" aria-label="Sections">
            <Link to="/setup">Setup</Link>
            <Link to="/projects">Projects</Link>
            <Link to="/health">Health</Link>
          </nav>
        )}
        <div class="end">
          {hubName.value && (
            <button type="button" class="picker" onClick={() => (choosing.value = true)} aria-label={`Hub: ${hubName.value}. Choose another hub`}>
              <Icon name="package" />
              <span>{hubName.value}</span>
              <Icon name="down" />
            </button>
          )}
          <span class="checking" role="status" aria-live="polite">
            {(hubCached.value || statusCached.value) && (
              <>
                <Spinner label="" />
                Checking GitHub…
              </>
            )}
          </span>
          {acc?.state === "ok" && <span class="who">@{acc.login}</span>}
          {session.value?.service === false && (
            <button type="button" class="btn quiet small" onClick={quit} title="Stop tapster setup">
              <Icon name="power" />
              Close
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function Toast() {
  const t = toast.value;
  if (!t) return null;
  return (
    <div class="toast" role="status" onClick={() => (toast.value = null)}>
      <Note tone={t.tone}>
        <span>{t.text}</span>
      </Note>
    </div>
  );
}

function Page() {
  if (!hubName.value || choosing.value) {
    return (
      <HubChooser
        onChosen={(name) => {
          choosing.value = false;
          chooseHub(name);
          go("/setup", true);
        }}
        onCancel={hubName.value ? () => (choosing.value = false) : null}
      />
    );
  }
  if (path.value === "/projects") return <Projects />;
  if (path.value === "/health") return <Health />;
  return <Setup />;
}

function App() {
  const b = boot.value;
  if (b.kind === "claiming") return <Waiting text="Opening tapster setup" />;
  if (b.kind === "stopped") return <Stopped />;
  if (b.kind === "no-session" || b.kind === "failed") return <NoSession problem={b.kind === "failed" ? b.problem : null} />;
  const acc = account.value;
  if (!acc && back.value) {
    return (
      <>
        <Header />
        <main id="main">
          <Back title={back.value.title} />
        </main>
      </>
    );
  }
  if (!acc && !(hubCached.value && !accountError.value)) return <Waiting text="Checking your GitHub sign-in" />;
  if (acc && (acc.state !== "ok" || acc.missing.length)) return <AccountGate />;
  return (
    <>
      <Header />
      <main id="main">
        <Banners />
        <Page />
      </main>
      <Toast />
      <Confirm />
    </>
  );
}

render(<App />, document.getElementById("app")!);
void start().catch((e) => say("error", problemOf(e).reason));
