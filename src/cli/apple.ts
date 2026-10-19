import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapsterError } from "../errors";
import { scrub } from "../mask";
import { TOOLS, run, runPath } from "../run";
import { setEnvSecret, setEnvVariable } from "./gh";
import { removeTemp, tempDir } from "./temp";

export type Certificate = { team: string; expires: string; name: string };

export const P12_LIMIT = 64 * 1024;
export const P8_LIMIT = 8 * 1024;

export function teamIdFromSubject(subject: string): string | null {
  return /(?:^|[,/]\s*)OU=([A-Z0-9]{10})(?:[,/]|$)/.exec(subject)?.[1] ?? null;
}

export function checkCertificate(subject: string, notAfter: string, now = Date.now()): Certificate {
  const cn = /(?:^|,)CN=((?:[^,\\]|\\.)*)/.exec(subject)?.[1] ?? "";
  if (!cn.startsWith("Developer ID Application:")) {
    throw new TapsterError(`the certificate is "${cn || "unnamed"}", not a Developer ID Application certificate`, "Create a Developer ID Application certificate at developer.apple.com, export it with its key from Keychain Access as .p12, then run this again.");
  }
  const team = teamIdFromSubject(subject);
  if (!team) throw new TapsterError("the certificate has no team ID", "Export the Developer ID Application certificate from Keychain Access.");
  const end = Date.parse(notAfter);
  if (Number.isNaN(end)) throw new TapsterError("the certificate's expiry date cannot be read", "Export the certificate again from Keychain Access.");
  const expires = new Date(end).toISOString().slice(0, 10);
  if (end < now) throw new TapsterError(`the certificate expired on ${expires}`, "Create a new Developer ID Application certificate at developer.apple.com.");
  return { team, expires, name: cn.replace(/\\(.)/g, "$1") };
}

export function checkP12(info: { code: number; stdout: string }, certs: { code: number; stdout: string }): void {
  if (/mac verify error|invalid password/i.test(info.stdout)) throw new TapsterError("the .p12 could not be opened with that password", "Check the password you set when exporting it or export it again.");
  if (/unsupported/i.test(info.stdout)) throw new TapsterError("this system's openssl cannot read the .p12", "Run this on macOS or export the certificate again from Keychain Access.");
  if (!/certificate bag/i.test(info.stdout)) throw new TapsterError("the .p12 holds no certificate", "Export the Developer ID Application certificate from My Certificates in Keychain Access.");
  if (!/key ?bag/i.test(info.stdout)) throw new TapsterError("the .p12 holds the certificate but not its private key", "Export it from My Certificates in Keychain Access on the Mac that holds the key.");
  if (certs.code !== 0 || !certs.stdout.includes("BEGIN CERTIFICATE")) throw new TapsterError("the .p12 could not be read", "Export it again from My Certificates in Keychain Access.");
}

export async function inspectP12(data: Uint8Array, password: string, now = Date.now()): Promise<Certificate> {
  if (data.length === 0 || data.length > P12_LIMIT) throw new TapsterError("that file is not a .p12 certificate", "Export the Developer ID Application certificate from Keychain Access as .p12.");
  const passin = password === "" ? "pass:" : "env:TAPSTER_P12";
  const p12 = (args: string[]) => run("openssl", ["pkcs12", ...args, "-passin", passin], { env: { TAPSTER_P12: password }, stdin: data, allowFail: true });
  let legacy: string[] = [];
  let bags = await p12(["-info", "-noout"]);
  if (/unsupported/i.test(bags.stderr)) {
    legacy = ["-legacy"];
    bags = await p12([...legacy, "-info", "-noout"]);
  }
  const certs = await p12([...legacy, "-nokeys", "-clcerts"]);
  checkP12({ code: bags.code, stdout: `${bags.stdout}\n${bags.stderr}` }, certs);
  const info = await run("openssl", ["x509", "-noout", "-subject", "-enddate", "-nameopt", "RFC2253"], { stdin: certs.stdout });
  const subject = /^subject=\s*(.*)$/m.exec(info.stdout)?.[1]?.trim() ?? "";
  const notAfter = /^notAfter=(.*)$/m.exec(info.stdout)?.[1]?.trim() ?? "";
  return checkCertificate(subject, notAfter, now);
}

export async function saveCertificate(hub: string, data: Uint8Array, password: string, cert: Certificate): Promise<void> {
  await setEnvSecret(hub, "MACOS_SIGN_P12", Buffer.from(data).toString("base64"));
  await setEnvSecret(hub, "MACOS_SIGN_PASSWORD", password);
  await setEnvVariable(hub, "TAPSTER_TEAM_ID", cert.team);
  await setEnvVariable(hub, "TAPSTER_CERT_EXPIRES", cert.expires);
}

export const notaryArgs = (keyPath: string, keyId: string, issuer: string) => ["notarytool", "history", "--key", keyPath, "--key-id", keyId, "--issuer", issuer, "--output-format", "json"];

export function notaryCheckError(stderr: string): TapsterError {
  if (/HTTP status code: 401\b/.test(stderr)) return new TapsterError("Apple rejected the notary key (HTTP 401)", "Check the .p8 file, the Key ID and the Issuer ID in App Store Connect, then run this again.");
  if (/HTTP status code: 403\b/.test(stderr)) return new TapsterError("Apple refused the notary key (HTTP 403)", "Accept the latest agreements in App Store Connect and check that the key has Developer access, then run this again.");
  const line = stderr.split("\n").find((l) => l.trim() !== "")?.trim() ?? "no message";
  const missing = /unable to find utility|notarytool.*not found/i.test(stderr);
  return new TapsterError(`notarytool could not check the key: ${scrub(line).slice(0, 300)}`, missing ? "Install Xcode or its command line tools (xcode-select --install), then run this again." : "Check your connection and the key in App Store Connect, then run this again.");
}

export type NotaryKey = { p8: Uint8Array; keyId: string; issuer: string };

export function checkP8(p8: Uint8Array): void {
  if (p8.length === 0 || p8.length > P8_LIMIT || !Buffer.from(p8).toString("utf8").includes("BEGIN PRIVATE KEY")) {
    throw new TapsterError("that file is not an App Store Connect key", "Download the .p8 from App Store Connect, Users and Access, Integrations.");
  }
}

export function notaryKey(p8: Uint8Array, keyId: string, issuer: string): NotaryKey {
  checkP8(p8);
  const id = keyId.trim();
  if (!/^[A-Z0-9]{10}$/.test(id)) throw new TapsterError(`${id || "an empty Key ID"} is not a Key ID`, "Copy the 10-character Key ID next to the key in App Store Connect.");
  const iss = issuer.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(iss)) {
    throw new TapsterError("that is not an Issuer ID", "Copy the Issuer ID shown above the key list in App Store Connect.");
  }
  return { p8, keyId: id, issuer: iss };
}

export async function verifyNotary(key: NotaryKey): Promise<boolean> {
  if (process.platform !== "darwin" || !existsSync(TOOLS.xcrun)) return false;
  const dir = tempDir("tapster-notary-");
  try {
    const path = join(dir, `AuthKey_${key.keyId}.p8`);
    await writeFile(path, key.p8, { mode: 0o600 });
    const res = await runPath(TOOLS.xcrun, "xcrun", notaryArgs(path, key.keyId, key.issuer), { allowFail: true });
    if (res.code !== 0) throw notaryCheckError(res.stderr);
    return true;
  } finally {
    removeTemp(dir);
  }
}

export async function saveNotary(hub: string, key: NotaryKey): Promise<void> {
  await setEnvSecret(hub, "MACOS_NOTARY_KEY", Buffer.from(key.p8).toString("base64"));
  await setEnvSecret(hub, "MACOS_NOTARY_KEY_ID", key.keyId);
  await setEnvSecret(hub, "MACOS_NOTARY_ISSUER_ID", key.issuer);
}
