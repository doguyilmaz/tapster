import { escape, head, LOGO_URI } from "./page";

const CSS = `
body { padding: 7vh 16px 48px; }
.card { max-width: 580px; margin: 0 auto; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 2rem 2rem 1.4rem; box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 14px 36px rgb(20 20 30 / 7%); }
.card .brand { margin-bottom: 1.6rem; }
.status { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 1rem; }
.status.ok { background: var(--see-bg); color: var(--see); }
.status.fail { background: var(--warn-bg); color: var(--warn); }
h1 { font-size: 1.6rem; }
.lead { font-size: 1.05rem; }
.facts { margin: 1.4rem 0 1.6rem; }
.facts dt { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-top: 1.1rem; }
.facts dd { margin: 0.3rem 0 0; }
.facts ul { padding-left: 1.1rem; margin: 0; }
ol.next { padding-left: 1.3rem; }
.local { margin: 1.6rem 0 0; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 0.85rem; color: var(--muted); }
@media (max-width: 520px) { body { padding-top: 16px; } .card { padding: 1.4rem 1.2rem 1.1rem; } }
`;

const ICONS = {
  ok: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  fail: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};

function card(title: string, body: string, status?: "ok" | "fail"): string {
  return `${head(`${title} · tapster`, CSS)}
<body>
<main class="card">
<span class="brand"><img src="${LOGO_URI}" width="34" height="34" alt="">tapster</span>
${status ? `<div class="status ${status}">${ICONS[status]}</div>\n` : ""}<h1>${escape(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function startPage(o: { title: string; lead: string; permissions: string[]; key: string; action: string; manifest: string }): string {
  return card(
    o.title,
    `<p class="lead">${escape(o.lead)}</p>
<dl class="facts">
<dt>What it may do</dt>
<dd><ul>${o.permissions.map((p) => `<li>${escape(p)}</li>`).join("")}<li>Nothing else. It has no webhook and receives no events.</li></ul></dd>
<dt>Where its key goes</dt>
<dd>${escape(o.key)}</dd>
</dl>
<form method="post" action="${escape(o.action)}">
<input type="hidden" name="manifest" value="${escape(o.manifest)}">
<button class="button" type="submit">Continue to GitHub</button>
</form>
<p class="local">This page comes from tapster on your computer (127.0.0.1). The button sends GitHub only this App's description: its name, these permissions and the address to return to. GitHub shows it to you again; click <strong>Create GitHub App</strong> there.</p>`,
  );
}

export function donePage(o: { title: string; next: string[] }): string {
  return card(
    o.title,
    `<p class="lead">Back in your terminal, tapster takes it from here:</p>
<ol class="next">${o.next.map((n) => `<li>${escape(n)}</li>`).join("")}</ol>
<p class="local">You can close this tab.</p>`,
    "ok",
  );
}

export function failPage(o: { reason: string; again: string }): string {
  return card(
    "Nothing was set up",
    `<p class="lead">${escape(o.reason)}</p>
<p>Run <code>${escape(o.again)}</code> again in your terminal. It continues where it stopped.</p>
<p class="local">You can close this tab.</p>`,
    "fail",
  );
}
