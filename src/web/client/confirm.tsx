import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { useTrap } from "./ui";

type Asking = { title: string; body: ComponentChildren; action: string; done(ok: boolean): void };

const asking = signal<Asking | null>(null);

// Writing a key, merging to the hub's main, tagging a release and updating tapster or the hub each wait for this click.
export function confirm(title: string, body: ComponentChildren, action: string): Promise<boolean> {
  asking.value?.done(false);
  return new Promise((resolve) => {
    asking.value = {
      title,
      body,
      action,
      done: (ok) => {
        asking.value = null;
        resolve(ok);
      },
    };
  });
}

function Dialog({ a }: { a: Asking }) {
  const ref = useRef<HTMLDivElement>(null);
  useTrap(ref, () => a.done(false));
  return (
    <>
      <div class="confirm-back" onClick={() => a.done(false)} />
      <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" ref={ref}>
        <h2 id="confirm-title" class="section-title">
          {a.title}
        </h2>
        <div id="confirm-body" class="stack tight">
          {a.body}
        </div>
        <div class="row confirm-actions">
          <button type="button" class="btn secondary" onClick={() => a.done(false)}>
            Cancel
          </button>
          <button type="button" class="btn primary" onClick={() => a.done(true)}>
            {a.action}
          </button>
        </div>
      </div>
    </>
  );
}

export function Confirm() {
  const a = asking.value;
  return a ? <Dialog key={a.title} a={a} /> : null;
}
