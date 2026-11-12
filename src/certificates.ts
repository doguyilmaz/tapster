import type { HubConfig } from "./config";

// A package may sign with a Developer ID certificate of its own, named by a label in tapster.yml.
// Its secrets and variables are the hub's names with _<LABEL> appended. The label id is reserved:
// MACOS_NOTARY_KEY_ID would read as the notary key of a certificate named id.
export const CERT_LABEL = /^[a-z0-9]{1,40}$/;

export type CertificateNames = {
  p12: string;
  password: string;
  team: string;
  expires: string;
  notaryKey: string;
  notaryKeyId: string;
  notaryIssuer: string;
};

// label null names the hub's own certificate.
export function certificateNames(label: string | null): CertificateNames {
  const s = label === null ? "" : `_${label.toUpperCase()}`;
  return {
    p12: `MACOS_SIGN_P12${s}`,
    password: `MACOS_SIGN_PASSWORD${s}`,
    team: `TAPSTER_TEAM_ID${s}`,
    expires: `TAPSTER_CERT_EXPIRES${s}`,
    notaryKey: `MACOS_NOTARY_KEY${s}`,
    notaryKeyId: `MACOS_NOTARY_KEY_ID${s}`,
    notaryIssuer: `MACOS_NOTARY_ISSUER_ID${s}`,
  };
}

const SECRET = /^(MACOS_SIGN_P12|MACOS_SIGN_PASSWORD|MACOS_NOTARY_KEY|MACOS_NOTARY_KEY_ID|MACOS_NOTARY_ISSUER_ID)(_[A-Z0-9]{1,40})?$/;

// A secret of the hub's certificate or of a labeled one.
export const isCertificateSecret = (name: string): boolean => SECRET.test(name);

// parseHub refuses a certificate on a package without macOS code, so these are the labels the macOS steps need.
export function certificateLabels(config: Pick<HubConfig, "packages">): string[] {
  return [...new Set(config.packages.flatMap((p) => (p.certificate ? [p.certificate] : [])))];
}
