import { useState } from "preact/hooks";
import type { HubView } from "../contract";
import { post } from "./api";
import { confirm } from "./confirm";
import { loadHub, loadStatuses, say } from "./state";
import { Busy, DiffBlock, Field, Note, Out, Problem, useAction } from "./ui";

export const validCertificateLabel = (label: string | null) => label === null || (/^[a-z0-9]{1,40}$/.test(label) && label !== "id");

export function CertificateChoice({ h, id, value, onChange }: { h: HubView; id: string; value: string | null; onChange: (label: string | null) => void }) {
  const [adding, setAdding] = useState(false);
  const labels = h.extras.certificates;
  const isNew = adding || (value !== null && !labels.some((c) => c.label === value));
  return <div class="stack tight">
    <div class="field">
      <label for={id}>Developer ID certificate (.p12)</label>
      <select id={id} class="input" value={isNew ? "__new" : value ?? ""} onChange={(e) => {
        const next = (e.currentTarget as HTMLSelectElement).value;
        setAdding(next === "__new");
        onChange(next === "__new" ? "" : next || null);
      }}>
        <option value="">Hub default{h.apple.certificateStored ? "" : " · not stored yet"}</option>
        {labels.map((c) => <option key={c.label} value={c.label}>{c.label} · {c.stored ? `team ${c.team}` : "not stored yet"}</option>)}
        <option value="__new">Add an app-specific certificate</option>
      </select>
    </div>
    {isNew && <Field id={`${id}-label`} name="certificate-label" label="Certificate label" value={value ?? ""} onInput={onChange} placeholder="myapp" hint="1–40 lowercase letters or digits, other than id. You can share a label between apps of the same team." />}
    <p class="muted small">The .p12 signs macOS code. The separate .p8 App Store Connect key notarizes it. Apps of the hub's Apple team can use its notarization key; a different team needs its own.</p>
  </div>;
}

export function CertificateAssignment({ h, project, onDone, onCancel }: { h: HubView; project: HubView["packages"][number]; onDone?: () => void; onCancel?: () => void }) {
  const [label, setLabel] = useState<string | null>(project.certificate ?? null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, problem, run] = useAction();
  const save = () => run(async () => {
    const target = { hub: h.name, name: project.name, repo: project.repo };
    const plan = await post<{ before: string; entry: string }>("/api/projects/entry/certificate", { ...target, label });
    if (plan.entry === plan.before) { say("info", "This certificate is already selected."); return; }
    if (!(await confirm(`Change the certificate of ${project.name}?`, <>
      <p>tapster proposes and merges this entry change in {h.name}. It takes effect on the next hub run. Store any missing certificate and its notarization key before publishing.</p>
      <DiffBlock before={plan.before} after={plan.entry} label={`Certificate of ${project.name}`} />
    </>, "Save certificate choice"))) return;
    try {
      const opened = await post<{ pr: string; head: string; entry: string }>("/api/projects/entry/propose", { ...target, entry: plan.entry, before: plan.before });
      setProposal(opened.pr);
      await post("/api/projects/entry/merge", { ...target, entry: opened.entry, sha: opened.head, before: plan.before });
      setProposal(null);
    } catch (error) {
      void loadHub();
      void loadStatuses();
      throw error;
    }
    await loadHub();
    void loadStatuses();
    say("ok", label ? `${project.name} now uses certificate ${label}. Store any missing credentials in Certificates for single apps.` : `${project.name} now uses the hub's default certificate.`);
    onDone?.();
  });
  const selected = h.extras.certificates.find((c) => c.label === label);
  const missing = label === null ? !h.apple.certificateStored || !h.apple.notary : !selected?.stored || selected.notary === "needed" || (selected.notary === "hub" && !h.apple.notary);
  return <div class="card pad stack tight certificate-assignment">
    <strong>Signing certificate for {project.name}</strong>
    <CertificateChoice h={h} id={`certificate-choice-${project.name}`} value={label} onChange={setLabel} />
    {missing && <Note tone="warn" title="Credentials still needed">Signing waits until the selected certificate and its notarization key are stored. After saving, upload the .p12 under Certificates for single apps in Optional extras or under Apple certificate for the hub default.</Note>}
    <Problem problem={problem} />
    {proposal && <Out href={proposal} class="btn secondary small">Review the pending certificate change</Out>}
    <div class="row">
      <Busy busy={busy} holds={(v) => [v.packages, v.extras.certificates, v.apple]} class="btn secondary small" disabled={!validCertificateLabel(label) || label === (project.certificate ?? null)} onClick={save}>Save certificate choice</Busy>
      {onCancel && <button type="button" class="btn quiet small" onClick={onCancel} disabled={busy}>Cancel</button>}
    </div>
  </div>;
}
