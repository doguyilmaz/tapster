import type { ComponentChildren, JSX, RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppStart, HubView, ProjectStatus, Problem as ProblemView } from "../contract";
import { DIFF_MARK, capFirst, changedOnly, lineDiff } from "../steps";
import { get } from "./api";
import { freshHub, freshStatuses, hub, hubCached, problemOf, say, statusCached, statuses } from "./state";

export function DiffBlock({ before, after, label }: { before: string; after: string; label?: string }) {
  return (
    <pre class="block diff" tabIndex={0} aria-label={label}>
      {changedOnly(lineDiff(before, after)).map((l, i) => (
        <span key={i} class={l.kind === "gap" ? "hunk" : l.kind}>
          {DIFF_MARK[l.kind]}
          {l.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

const PATHS: Record<string, JSX.Element> = {
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  alert: <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />,
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />,
  loader: <path d="M21 12a9 9 0 1 1-6.2-8.6" />,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  play: <path d="M7 4v16l13-8z" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  pr: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />
    </>
  ),
  package: <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7 12 12l8.7-5M12 22V12" />,
  upload: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  power: <path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  circle: <circle cx="12" cy="12" r="9" />,
  git: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, spin, label }: { name: IconName; spin?: boolean; label?: string }) {
  return (
    <svg class={`icon${spin ? " spin" : ""}`} viewBox="0 0 24 24" aria-hidden={label ? undefined : "true"} role={label ? "img" : undefined} aria-label={label}>
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ label = "Working" }: { label?: string }) {
  return <Icon name="loader" spin label={label} />;
}

type Tone = "keys" | "ok" | "warn" | "error" | "info";
const TONE_ICON: Record<Tone, IconName> = { keys: "lock", ok: "check", warn: "alert", error: "alert", info: "info" };

export function Note({ tone = "info", title, children }: { tone?: Tone; title?: string; children?: ComponentChildren }) {
  return (
    <div class={`note ${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={TONE_ICON[tone]} />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Problem({ problem }: { problem: { reason: string; fix: string } | null }) {
  if (!problem) return null;
  const reason = capFirst(problem.reason);
  return (
    <Note tone="error" title={`${reason}.`}>
      <span>{problem.fix}</span>
    </Note>
  );
}

export function Badge({ tone, children }: { tone?: "ok" | "warn" | "error" | "next"; children: ComponentChildren }) {
  return <span class={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      setDone(false);
    }
  };
  return (
    <button type="button" class="btn secondary small" onClick={copy}>
      <Icon name={done ? "check" : "copy"} />
      {done ? "Copied" : label}
    </button>
  );
}

export function Cmd({ text }: { text: string }) {
  return (
    <div class="cmd">
      <code tabIndex={0}>{text}</code>
      <Copy text={text} />
    </div>
  );
}

export function Out({ href, children, class: cls = "btn secondary", onClick }: { href: string; children: ComponentChildren; class?: string; onClick?: () => void }) {
  return (
    <a class={cls} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {children}
      <Icon name="external" />
    </a>
  );
}

export function FileDrop(props: { name: string; accept: string; label: string; hint: ComponentChildren; file: File | null; onFile: (f: File | null) => void }) {
  const [over, setOver] = useState(false);
  const pick = (files: FileList | null) => props.onFile(files && files[0] ? files[0] : null);
  return (
    <div class="field">
      <span class="label" id={`${props.name}-label`}>
        {props.label}
      </span>
      <label
        class={`drop${over ? " over" : ""}${props.file ? " has" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer?.files ?? null);
        }}
      >
        <input type="file" name={props.name} accept={props.accept} aria-labelledby={`${props.name}-label`} onChange={(e) => pick((e.currentTarget as HTMLInputElement).files)} />
        <Icon name={props.file ? "check" : "upload"} />
        <span>
          {props.file ? (
            <>
              <strong class="mono">{props.file.name}</strong>
              <span class="muted small"> ({Math.max(1, Math.round(props.file.size / 1024))} KB). Drop or choose another file to replace it.</span>
            </>
          ) : (
            <>
              <strong>Drop the file here</strong> <span class="muted">or click to choose it</span>
            </>
          )}
        </span>
      </label>
      <span class="hint">{props.hint}</span>
    </div>
  );
}

export function Password({ name, id = name, label, hint, autoComplete = "current-password" }: { name: string; id?: string; label: string; hint?: ComponentChildren; autoComplete?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class="with-toggle">
        <input class="input" id={id} name={name} type={shown ? "text" : "password"} autoComplete={autoComplete} spellcheck={false} autoCapitalize="off" autoCorrect="off" />
        <button type="button" class="btn quiet small" onClick={() => setShown(!shown)} aria-pressed={shown}>
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {hint && <span class="hint">{hint}</span>}
    </div>
  );
}

export function Field({ name, id = name, label, hint, value, placeholder, mono, autoComplete = "off", onInput }: { name: string; id?: string; label: string; hint?: ComponentChildren; value?: string; placeholder?: string; mono?: boolean; autoComplete?: string; onInput?: (v: string) => void }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        class={`input${mono ? " mono" : ""}`}
        id={id}
        name={name}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellcheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onInput={onInput ? (e) => onInput((e.currentTarget as HTMLInputElement).value) : undefined}
      />
      {hint && <span class="hint">{hint}</span>}
    </div>
  );
}

const MOVED = "GitHub shows changes here since your last visit. Look them over, then try again.";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// For holds: a part of one project's status.
export const ofProject =
  (repo: string, part: (p: ProjectStatus) => unknown) =>
  (_: HubView, projects: ProjectStatus[] | null): unknown => {
    const p = projects?.find((x) => x.repo === repo);
    return p ? part(p) : null;
  };

// While the page shows a saved view, a click waits for GitHub's answer. Then it goes through only if the button is
// still on the page and enabled, with the part of the views named by holds unchanged.
export function Busy({ busy, holds, children, onClick, ...rest }: { busy: boolean; holds?: (h: HubView, projects: ProjectStatus[] | null) => unknown; children: ComponentChildren } & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [waiting, setWaiting] = useState(false);
  const pass = useRef(false);
  const click = (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    if (pass.current || !(hubCached.value || statusCached.value)) {
      pass.current = false;
      return onClick?.(e);
    }
    e.preventDefault();
    if (waiting) return;
    const button = e.currentTarget;
    const before = hub.value;
    const listed = statuses.value?.list ?? null;
    setWaiting(true);
    void Promise.all([freshHub(), freshStatuses()]).then(([after, projects]) => {
      setWaiting(false);
      if (!after || (listed && !projects)) return;
      if (!button.isConnected || button.disabled || (holds && before && !same(holds(before, listed), holds(after, projects)))) return say("info", MOVED);
      pass.current = true;
      button.click();
    });
  };
  const shown = busy || waiting;
  return (
    <button {...rest} onClick={click} disabled={busy || rest.disabled} aria-busy={shown}>
      {shown && <Spinner />}
      {waiting ? "Checking GitHub first" : children}
    </button>
  );
}

export function Head({ title, lead, children }: { title: string; lead: string; children?: preact.ComponentChildren }) {
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

export function Done({ text }: { text: string }) {
  return (
    <div class="row">
      <span class="seal" aria-hidden="true">
        <Icon name="check" />
      </span>
      <strong>{text}</strong>
    </div>
  );
}

export function useAction(): [boolean, ProblemView | null, (f: () => Promise<void>) => Promise<void>] {
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

// Polls an App's installation. A click on the install link means the person went to GitHub, as does coming back to
// this tab after leaving it: from then on the step waits for GitHub and checks right away on each return.
export function useInstall<T>(path: string | null, settled: (v: T) => boolean): { view: T | null; asked: boolean; ask: () => void } {
  const [view, setView] = useState<T | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!path) return;
    let timer = 0;
    let wait = 4000;
    let busy = false;
    let away = false;
    let stopped = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const next = await get<T>(path);
          if (stopped) return;
          setView(next);
          wait = settled(next) ? 30000 : 4000;
        } catch {
          wait = Math.min(wait * 2, 30000);
        }
      }
      busy = false;
      if (!stopped) timer = window.setTimeout(tick, wait);
    };
    const leave = () => {
      away = true;
    };
    const comeBack = () => {
      if (!away || document.hidden) return;
      away = false;
      setAsked(true);
      void tick();
    };
    const seen = () => (document.hidden ? leave() : comeBack());
    addEventListener("blur", leave);
    addEventListener("focus", comeBack);
    document.addEventListener("visibilitychange", seen);
    timer = window.setTimeout(tick, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
      removeEventListener("blur", leave);
      removeEventListener("focus", comeBack);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [path]);
  return { view: path ? view : null, asked, ask: () => setAsked(true) };
}

export function ManifestForm({ start, holds }: { start: AppStart; holds: (h: HubView) => unknown }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setLeaving(false);
    };
    addEventListener("pageshow", restored);
    return () => removeEventListener("pageshow", restored);
  }, []);
  return (
    <form method="post" action={start.action} class="stack tight" onSubmit={() => setLeaving(true)}>
      <input type="hidden" name="manifest" value={start.manifest} />
      <div class="row">
        <Busy busy={leaving} holds={holds} class="btn primary" type="submit">
          {leaving ? "Opening GitHub" : "Continue to GitHub"}
          {!leaving && <Icon name="arrow" />}
        </Busy>
      </div>
      <p class="muted small" role={leaving ? "status" : undefined}>
        {leaving ? (
          <>
            GitHub opens in this tab. There, click <strong>Create GitHub App</strong>; GitHub brings you back here.
          </>
        ) : (
          <>
            GitHub shows the App <code>{start.name}</code>. Click <strong>Create GitHub App</strong> there and GitHub brings you back here.
          </>
        )}
      </p>
    </form>
  );
}

export function savedFor(text: string): void {
  history.pushState(null, "", `/setup?saved=${encodeURIComponent(text)}`);
  setTimeout(() => history.replaceState(null, "", "/setup"), 1500);
}

const open: RefObject<HTMLElement>[] = [];

// Keeps focus inside a modal dialog, closes it on Escape and gives focus back to where it was. Only the dialog opened last listens.
export function useTrap(ref: RefObject<HTMLElement>, onClose: () => void): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    open.push(ref);
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const keys = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== ref) return;
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (!ref.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", keys);
    return () => {
      removeEventListener("keydown", keys);
      open.splice(open.indexOf(ref), 1);
      before?.focus();
    };
  }, []);
}
