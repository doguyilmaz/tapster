import { useState } from "preact/hooks";
import type { HubView } from "../contract";
import { post } from "./api";
import { confirm } from "./confirm";
import { loadHub, say } from "./state";
import { Busy, Copy, Field, FileDrop, Note, Out, Problem, useAction } from "./ui";

export function AppKeyForm({ h, onDone, onCancel }: { h: HubView; onDone(): void; onCancel?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, problem, run] = useAction();
  const save = async (e: Event) => {
    e.preventDefault();
    if (!file || !await confirm(`Store the replacement App key in ${h.name}?`, <p>tapster verifies the key belongs to {h.app.slug}, checks its installation and replaces the hub's private key. Delete the old key on GitHub after the new key is stored.</p>, "Store the key")) return;
    void run(async () => {
      const data = new FormData(); data.set("hub", h.name); data.set("pem", file);
      await post("/api/hub/app/key", data);
      setFile(null); await loadHub(); onDone();
      say("ok", "Stored the App key. Delete the downloaded file and revoke older keys in the App's settings.");
    });
  };
  return <form class="stack tight" onSubmit={save}>
    <p class="muted">Open the GitHub App's settings, scroll to Private keys and generate a private key. Choose the downloaded .pem file here.</p>
    <Out href={`https://github.com/settings/apps/${h.app.slug ?? ""}`}>Open the App's settings</Out>
    <FileDrop name="app-pem" accept=".pem" label="The signing App's .pem file" file={file} onFile={setFile} hint="The key goes only into this hub's protected environment. Revoke older keys on GitHub after it is stored." />
    <Problem problem={problem} />
    <div class="row"><Busy busy={busy} disabled={!file} holds={(v) => v.app} class="btn primary small" type="submit">Store the App key</Busy>
    {onCancel && <button type="button" class="btn quiet small" onClick={onCancel} disabled={busy}>Cancel</button>}</div>
  </form>;
}

export function NewSparkleKey({ h }: { h: HubView }) {
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<{ publicKey: string; account: string } | null>(null);
  const [busy, problem, run] = useAction();
  return <form class="card pad stack tight" onSubmit={(e) => {
    e.preventDefault();
    void run(async () => {
      const ok = await confirm("Create a new Sparkle key?", <p>tapster saves a new key in this computer's keychain using account {label}. Then put its public key in the app and its hub entry. Keep an offline backup before storing it in the hub.</p>, "Create the key");
      if (ok) setMade(await post("/api/hub/sparkle/new", { hub: h.name, label }));
    });
  }}>
    <strong>Create a Sparkle key</strong>
    <p class="muted small">Use a new label for a new app or a key rotation. Existing keys are kept.</p>
    {made ? <Note tone="ok" title={`Saved in your keychain as ${made.account}`}>
      <span>Public key (SUPublicEDKey): <code style="overflow-wrap: anywhere">{made.publicKey}</code> <Copy text={made.publicKey} /></span>
      <span>In the project's Configuration editor, set sparkle.key to {made.account} and sparkle.public_key to this public key. For a rotation, use sparkle.next_key and sparkle.next_public_key. Then read keychain account {made.account} below to back it up and store it in the hub.</span>
      <button type="button" class="btn secondary small" onClick={() => { setMade(null); setLabel(""); }}>Create another key</button>
    </Note> : <><Field name="sparkle-new-label" label="New key label" value={label} onInput={setLabel} hint="Lowercase letters and digits, for example myapp2." />
      <Busy busy={busy} disabled={!/^[a-z0-9]{1,40}$/.test(label)} holds={(v) => v.extras.sparkle} class="btn secondary small" type="submit">Create in my keychain</Busy></>}
    <Problem problem={problem} />
  </form>;
}
