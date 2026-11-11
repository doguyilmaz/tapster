import { useState } from "preact/hooks";
import type { HubView, StoredCertificate } from "../contract";
import { ApiError, post } from "./api";
import { loadHub, say } from "./state";
import { confirm } from "./confirm";
import { Busy, Field, FileDrop, Note, Password, Problem, savedFor, useAction } from "./ui";

// The forms that store a Developer ID certificate and a notarization key. label null stores the hub's own; a label
// stores the ones of the packages whose entry in tapster.yml says certificate: <label>.
type FormProps = { h: HubView; label?: string | null; guide: boolean; onDone?: (stored: StoredCertificate) => void; onCancel?: () => void };

const holdsFor = (label: string | null) => (label === null ? (v: HubView) => [v.apple, v.protect.environment] : (v: HubView) => [v.extras.certificates.find((c) => c.label === label) ?? null, v.protect.environment]);

// hubKey: the hub holds its own notarization key, which a labeled certificate of the hub's team uses.
function storedText(label: string | null, c: StoredCertificate, hubKey: boolean): string {
  if (label === null) return `Certificate stored for team ${c.team}. It expires on ${c.expires}.`;
  const first = `Certificate ${label} stored for team ${c.team}. It expires on ${c.expires}.`;
  if (c.notary === "needed") return `${first} Next: a notarization key of team ${c.team}.`;
  if (c.notary === "own") return `${first} The notarization key stored for ${label} stays.`;
  if (c.removed) return `${first} tapster removed the notarization key stored for ${label}: the hub's key notarizes it, since both belong to team ${c.team}.`;
  return `${first} The hub's notarization key notarizes it too.${hubKey ? "" : " The hub has no notarization key yet; store it under Notarization key."}`;
}

export function CertificateForm({ h, label = null, guide, onDone, onCancel }: FormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, problem, run] = useAction();
  const id = label === null ? "" : `cert-${label}-`;
  const submit = async (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const asked =
      label === null
        ? await confirm(`Store the certificate in ${h.name}?`, <p>tapster stores the .p12 and its password as secrets of the hub's tapster environment. Only hub workflows on main can use them.</p>, "Store the certificate")
        : await confirm(`Store the certificate ${label} in ${h.name}?`, <p>tapster stores the .p12 and its password as secrets of the hub's tapster environment and passes them to the hub workflow on main. Only hub workflows on main can use them.</p>, "Store the certificate");
    if (!asked) return;
    void run(async () => {
      if (!file) throw new ApiError({ reason: "no .p12 file is chosen", fix: "Drop the .p12 you exported from Keychain Access." }, 0);
      const data = new FormData(form);
      data.delete("username");
      data.set("hub", h.name);
      data.set("p12", file);
      if (label !== null) data.set("label", label);
      const stored = await post<StoredCertificate>("/api/hub/certificate", data);
      savedFor(label === null ? "certificate" : `certificate-${label}`);
      setFile(null);
      await loadHub();
      say("ok", storedText(label, stored, h.apple.notary));
      onDone?.(stored);
    });
  };
  return (
    <>
      <details class="card pad" open={guide}>
        <summary>
          <strong>How to get the .p12</strong>
        </summary>
        <ol class="stack tight" style="margin: 0.8rem 0 0; padding-left: 1.2rem">
          <li>
            No certificate yet? Create a <strong>Developer ID Application</strong> certificate at{" "}
            <a href="https://developer.apple.com/account/resources/certificates" target="_blank" rel="noopener noreferrer">
              developer.apple.com
            </a>
            .
          </li>
          <li>
            In Keychain Access, open <strong>My Certificates</strong>, right-click <strong>Developer ID Application: …</strong> and choose <strong>Export</strong>.
          </li>
          <li>Save it as .p12 with a password. Your password manager can make one.</li>
        </ol>
      </details>
      <form class="secret" onSubmit={submit} autoComplete="on">
        <Field
          name="username"
          id={`${id}username`}
          label="Name in your password manager"
          value={label === null ? `${h.name}: Developer ID certificate` : `${h.name}: Developer ID certificate ${label}`}
          autoComplete="username"
          hint="Your password manager saves the .p12 password under this name, so it can fill it in next time."
        />
        <FileDrop name="p12" id={`${id}p12`} accept=".p12,application/x-pkcs12" label="The .p12 file" file={file} onFile={setFile} hint="It stays in memory on this computer until tapster stores it in the hub." />
        <Password name="password" id={`${id}password`} label="Its password" hint="The password you set when exporting it." />
        <Note tone="keys" title="Where it goes">
          <span>tapster opens the file with your password on this computer to check it is a Developer ID Application certificate that has not expired. Then the file and its password become secrets of the tapster environment in {h.name}. Keep your own backup: GitHub never shows a secret again.</span>
        </Note>
        <Problem problem={problem} />
        <div class="row">
          <Busy busy={busy} holds={holdsFor(label)} class="btn primary" type="submit">
            Check and store
          </Busy>
          {onCancel && (
            <button type="button" class="btn quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </>
  );
}

export function NotaryForm({ h, label = null, guide, onDone, onCancel }: Omit<FormProps, "onDone"> & { onDone?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, problem, run] = useAction();
  const id = label === null ? "" : `notary-${label}-`;
  const submit = async (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const title = label === null ? `Store the notarization key in ${h.name}?` : `Store the notarization key of the certificate ${label} in ${h.name}?`;
    if (!(await confirm(title, <p>tapster stores the .p8 key, its ID and the issuer ID as secrets of the hub's tapster environment. Only hub workflows on main can use them.</p>, "Store the key"))) return;
    void run(async () => {
      if (!file) throw new ApiError({ reason: "no .p8 file is chosen", fix: "Drop the AuthKey_….p8 you downloaded from App Store Connect." }, 0);
      const data = new FormData(form);
      data.set("hub", h.name);
      data.set("p8", file);
      if (label !== null) data.set("label", label);
      const done = await post<{ checked: boolean }>("/api/hub/notary", data);
      savedFor(label === null ? "notary" : `notary-${label}`);
      setFile(null);
      await loadHub();
      if (label === null) say("ok", done.checked ? "Apple accepted the key and tapster stored it." : "Key stored. Apple checks it at the first release.");
      else say("ok", done.checked ? `Apple accepted the key for the certificate ${label} and tapster stored it.` : `Key for the certificate ${label} stored. Apple checks it at the first release.`);
      onDone?.();
    });
  };
  return (
    <>
      <details class="card pad" open={guide}>
        <summary>
          <strong>How to get the key</strong>
        </summary>
        <ol class="stack tight" style="margin: 0.8rem 0 0; padding-left: 1.2rem">
          <li>
            In{" "}
            <a href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank" rel="noopener noreferrer">
              App Store Connect
            </a>
            , open <strong>Users and Access</strong>, <strong>Integrations</strong>, <strong>App Store Connect API</strong>, <strong>Team Keys</strong>.
          </li>
          <li>
            Create a key with <strong>Developer</strong> access and download <code>AuthKey_….p8</code>. Apple offers the download once.
          </li>
          <li>The Key ID is in the list; the Issuer ID is above it.</li>
        </ol>
      </details>
      <form class="secret" onSubmit={submit} autoComplete="off">
        <FileDrop name="p8" id={`${id}p8`} accept=".p8" label="The .p8 file" file={file} onFile={setFile} hint="It stays in memory on this computer until tapster stores it in the hub." />
        <div class="grid2">
          <Field name="keyId" id={`${id}keyId`} label="Key ID" mono placeholder="ABCDE12345" />
          <Field name="issuerId" id={`${id}issuerId`} label="Issuer ID" mono placeholder="00000000-0000-0000-0000-000000000000" />
        </div>
        <Note tone="keys" title="Where it goes">
          <span>On a Mac, tapster asks Apple whether the key works before storing it. The key and its two IDs become secrets of the tapster environment in {h.name}.</span>
        </Note>
        <Problem problem={problem} />
        <div class="row">
          <Busy busy={busy} holds={holdsFor(label)} class="btn primary" type="submit">
            Check with Apple and store
          </Busy>
          {onCancel && (
            <button type="button" class="btn quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </>
  );
}
