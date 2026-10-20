import { useEffect, useState } from "preact/hooks";
import type { Problem as ProblemView } from "../contract";
import { post } from "./api";
import { account, hubs, loadHubs, problemOf, session } from "./state";
import { Badge, Busy, Icon, Note, Problem, Spinner } from "./ui";

export function HubChooser({ onChosen, onCancel }: { onChosen: (name: string) => void; onCancel: (() => void) | null }) {
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [name, setName] = useState("homebrew-tap");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const login = account.value?.state === "ok" ? account.value.login : "you";
  useEffect(() => {
    loadHubs().catch((e) => setProblem(problemOf(e)));
  }, []);
  const list = hubs.value;
  const here = session.value?.here.hub ?? null;
  const taken = list?.some((h) => h.name.toLowerCase() === `${login}/${name}`.toLowerCase()) ?? false;
  const valid = /^homebrew-[A-Za-z0-9._-]{1,80}$/.test(name);
  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const made = await post<{ hub: string }>("/api/hubs", { name, private: visibility === "private" });
      onChosen(made.hub);
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack" style="gap: 2rem; max-width: 860px">
      <div class="hello">
        <div class="stack tight">
          <h1 class="title">Choose your hub</h1>
          <p class="lead">
            Your hub is your Homebrew tap: a repository whose name starts with <code>homebrew-</code>. tapster turns it into the one place that signs, notarizes and publishes the releases of all your projects.
          </p>
          {onCancel && (
            <p>
              <button type="button" class="btn quiet" onClick={onCancel}>
                Keep the current hub
              </button>
            </p>
          )}
        </div>
        <img src="/courier.webp" alt="The tapster octopus courier with sealed parcels" width="220" height="220" />
      </div>
      <Problem problem={problem} />
      <section class="stack tight" aria-labelledby="yours">
        <h2 id="yours" class="section-title">
          Your taps
        </h2>
        {list === null && !problem && (
          <p class="row muted">
            <Spinner /> Looking for repositories named homebrew-… on your account
          </p>
        )}
        {list?.length === 0 && <p class="muted">You have no repository named homebrew-… yet. Create one below.</p>}
        <div class="choices">
          {list?.map((h) => (
            <button type="button" class="choice" key={h.name} onClick={() => onChosen(h.name)}>
              <Icon name="package" />
              <span class="grow">
                <span class="mono">{h.name}</span>
                <span class="muted small">{h.tapster ? "Already a tapster hub" : "A tap without tapster yet"}</span>
              </span>
              {h.name === here && <Badge tone="next">This folder</Badge>}
              <Badge tone={h.private ? "warn" : undefined}>{h.private ? "Private" : "Public"}</Badge>
              <Icon name="right" />
            </button>
          ))}
        </div>
      </section>
      <section class="card pad stack" aria-labelledby="new">
        <h2 id="new" class="section-title">
          Or create a new tap
        </h2>
        <form class="stack" onSubmit={create}>
          <div class="field">
            <label for="tap-name">Repository name</label>
            <div class="row" style="flex-wrap: nowrap">
              <span class="mono muted">{login}/</span>
              <input class="input mono" id="tap-name" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value.trim())} spellcheck={false} autoComplete="off" />
            </div>
            <span class="hint">
              Users install with <code>brew install {login}/{name.replace(/^homebrew-/, "") || "tap"}/&lt;name&gt;</code>.
            </span>
          </div>
          <fieldset class="stack tight" style="border: 0; padding: 0; margin: 0">
            <legend class="label" style="font-weight: 600; font-size: 0.92rem; margin-bottom: 0.4rem">
              Visibility
            </legend>
            <label class="switch">
              <input type="radio" name="visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} />
              <span>
                <strong>Public (recommended)</strong>
                <span>GitHub gives public repositories free macOS runners, which signing needs. It also gives them the protected environment that holds your keys.</span>
              </span>
            </label>
            <label class="switch">
              <input type="radio" name="visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />
              <span>
                <strong>Private</strong>
                <span>Needs GitHub Pro for the protected environment. Every run uses your plan's Actions minutes. Users can only install from public projects.</span>
              </span>
            </label>
          </fieldset>
          {taken && <Note tone="warn">You already have this repository. Pick it from the list above.</Note>}
          <div class="row">
            <Busy busy={busy} class="btn primary" type="submit" disabled={!valid || taken}>
              Create {login}/{name}
            </Busy>
            {!valid && <span class="muted small">The name must start with homebrew-.</span>}
          </div>
        </form>
      </section>
    </div>
  );
}
