import { signal } from "@preact/signals";
import type { FilesView, HubView, SessionView, TapsterView } from "../contract";
import { ApiError, get, post } from "./api";
import { confirm } from "./confirm";
import { hub, loadHub, say, session } from "./state";
import { Busy, Cmd, Note, Out, Problem, Spinner, useAction } from "./ui";

const CHECK_EVERY = 6 * 3_600_000;
const tapster = signal<TapsterView | null>(null);
const restarting = signal<{ version: string; lost: boolean } | null>(null);

async function loadTapster(): Promise<void> {
  try {
    tapster.value = await get<TapsterView>("/api/tapster");
  } catch {
    return;
  }
}

let timer = 0;
export function watchTapster(): void {
  void loadTapster();
  clearInterval(timer);
  timer = window.setInterval(loadTapster, CHECK_EVERY);
}

// The service exits after a checked update and launchd or systemd starts the new one. The page waits for it, then reloads where it is.
async function waitFor(version: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const now = await get<SessionView>("/api/session").catch(() => null);
    if (now?.version === version) return location.reload();
  }
  restarting.value = { version, lost: true };
}

function TapsterBanner({ t }: { t: TapsterView & { latest: string } }) {
  const [busy, problem, run] = useAction();
  const update = async () => {
    const ok = await confirm(
      `Update tapster to ${t.latest}?`,
      <>
        <p>
          tapster runs <code>{t.command}</code>, checks that the new command reports {t.latest} and carries the same signature, then restarts with it.
        </p>
        <p class="muted small">If a check fails, {t.running} keeps running and this page shows what to do.</p>
      </>,
      "Update tapster",
    );
    if (!ok) return;
    void run(async () => {
      await post("/api/tapster/update", { version: t.latest });
      restarting.value = { version: t.latest, lost: false };
      void waitFor(t.latest);
    });
  };
  return (
    <div class="banner">
      <Note tone="info" title={`tapster ${t.latest} is available`}>
        <span>This setup runs {t.running}.</span>
        {t.update === "here" ? (
          <div class="row">
            <Busy busy={busy} class="btn primary small" onClick={update}>
              Update
            </Busy>
            <Out class="btn secondary small" href={`https://github.com/doguyilmaz/tapster/releases/tag/v${t.latest}`}>
              What changed
            </Out>
          </div>
        ) : (
          <>
            <span>Update it in a terminal, then start tapster setup again:</span>
            {t.command && <Cmd text={t.command} />}
          </>
        )}
        <Problem problem={problem} />
      </Note>
    </div>
  );
}

function Restarting({ r }: { r: { version: string; lost: boolean } }) {
  if (r.lost)
    return (
      <div class="banner">
        <Problem problem={{ reason: `tapster ${r.version} did not come back`, fix: "Run tapster service status in a terminal. tapster service logs shows why it stopped." }} />
      </div>
    );
  return (
    <div class="banner" role="status">
      <Note tone="info" title={`Updating tapster to ${r.version}`}>
        <span class="row">
          <Spinner label="" /> tapster setup restarts with the new version. This page reloads by itself.
        </span>
      </Note>
    </div>
  );
}

const hubVersion = (h: HubView) => h.files.pinned?.split(" ")[0]?.replace(/^v/, "") ?? "an older version";

function HubBanner({ h }: { h: HubView }) {
  const [busy, problem, run] = useAction();
  const running = session.value?.version ?? "this version";
  const update = () =>
    run(async () => {
      const body = { hub: h.name, every: h.files.every, remove: [], readme: false };
      const view = await post<FilesView>("/api/hub/files/preview", body);
      if (view.foreign.length) throw new ApiError({ reason: "main changed in ways only you may change it", fix: "Open Hub files in Setup to see the commits. tapster writes nothing to main until you review them." }, 0);
      const changes = view.files.filter((f) => f.change !== "same");
      if (!changes.length) return void (await loadHub());
      const ok = await confirm(
        `Update ${h.name} to tapster ${running}?`,
        <>
          <p>tapster writes {changes.length === 1 ? "this file" : `these ${changes.length} files`} to main in one commit, as the Hub files step does:</p>
          <ul class="log">
            {changes.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </>,
        "Update the hub",
      );
      if (!ok) return;
      await post("/api/hub/files", body);
      await loadHub();
      say("ok", `${h.name} now runs tapster ${running}.`);
    });
  const needed = h.files.update === "needed";
  return (
    <div class="banner">
      <Note tone={needed ? "warn" : "info"} title={`The hub runs tapster ${hubVersion(h)}`}>
        <span>{needed ? `tapster ${running} changes the code that runs in the hub, so update it.` : `tapster ${running} changes only the setup page and the terminal, so updating the hub is optional.`}</span>
        <div class="row">
          <Busy busy={busy} holds={(v) => v.files} class={`btn ${needed ? "primary" : "secondary"} small`} onClick={() => void update()}>
            Update the hub
          </Busy>
        </div>
        <Problem problem={problem} />
      </Note>
    </div>
  );
}

export function Banners() {
  const t = tapster.value;
  const h = hub.value;
  return (
    <>
      {restarting.value ? <Restarting r={restarting.value} /> : t?.latest ? <TapsterBanner t={{ ...t, latest: t.latest }} /> : null}
      {h && h.files.workflow === "older" && h.files.update && <HubBanner h={h} />}
    </>
  );
}

