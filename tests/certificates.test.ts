import { expect, test } from "bun:test";
import { certificateLabels, certificateNames, isCertificateSecret } from "../src/certificates";
import { parseHub } from "../src/config";

const hub = (entries: string) => `version: 1
tap: o/tap
linux: { maintainer: "O <o@x.yz>" }
packages:
${entries}`;

const go = (certificate: string, name = "goer") => `  - { name: ${name}, repo: o/${name}, binaries: [${name}], certificate: ${certificate}, assets: { darwin-arm64: "${name}_{version}.tar.gz" } }\n`;

test("go, bun, tool-app and app packages may name a certificate", () => {
  const { config, invalid } = parseHub(
    hub(
      go("acme") +
        `  - { name: buner, repo: o/buner, kind: bun, binaries: [buner], certificate: acme, assets: { darwin-arm64: "b_{version}.tar.gz" } }
  - { name: tooler, repo: o/tooler, binaries: [tooler], certificate: beta2, app: { name: T.app, bundle_id: com.o.T }, assets: { darwin-arm64: "t_{version}.tar.gz" } }
  - { name: apper, repo: o/apper, kind: app, app: A.app, bundle_id: com.o.A, certificate: acme, assets: { darwin-arm64: "A-{version}.tar.gz" }, dmg: { name: "A-{version}.dmg" } }
  - { name: plain, repo: o/plain, binaries: [plain], assets: { darwin-arm64: "p_{version}.tar.gz" } }
`,
    ),
    "o",
  );
  expect(invalid).toEqual([]);
  expect(config.packages.map((p) => p.certificate)).toEqual(["acme", "acme", "beta2", "acme", undefined]);
  expect(certificateLabels(config)).toEqual(["acme", "beta2"]);
});

test("a certificate label is lowercase letters and digits, never id, and only for macOS code", () => {
  const reason = (entry: string) => parseHub(hub(entry), "o").invalid.map((i) => i.reason);
  expect(reason(go("Acme"))).toEqual(["goer is invalid: certificate: must be 1 to 40 lowercase letters or digits"]);
  expect(reason(go("a".repeat(41)))).toEqual(["goer is invalid: certificate: must be 1 to 40 lowercase letters or digits"]);
  expect(reason(go("a".repeat(40)))).toEqual([]);
  expect(reason(go("ac-me"))).toEqual(["goer is invalid: certificate: must be 1 to 40 lowercase letters or digits"]);
  expect(reason(go("id"))).toEqual(["goer is invalid: certificate: id is reserved; pick another label"]);
  const linux = parseHub(hub('  - { name: lin, repo: o/lin, binaries: [lin], linux: true, certificate: acme, assets: { linux-amd64: "l_{version}.tar.gz" } }\n'), "o");
  expect(linux.invalid).toEqual([{ name: "lin", repo: "o/lin", reason: "lin: certificate picks the certificate for macOS code, but lin ships none", fix: "Map a darwin-* asset or remove certificate." }]);
  expect(linux.config.packages).toEqual([]);
});

test("certificate labels keep package order and appear once", () => {
  const { config } = parseHub(hub(go("beta", "one") + go("acme", "two") + go("beta", "three")), "o");
  expect(certificateLabels(config)).toEqual(["beta", "acme"]);
  expect(certificateLabels(parseHub(hub(go("acme").replace(", certificate: acme", "")), "o").config)).toEqual([]);
});

test("a label's names are the hub's names with the label appended", () => {
  expect(certificateNames(null)).toEqual({
    p12: "MACOS_SIGN_P12",
    password: "MACOS_SIGN_PASSWORD",
    team: "TAPSTER_TEAM_ID",
    expires: "TAPSTER_CERT_EXPIRES",
    notaryKey: "MACOS_NOTARY_KEY",
    notaryKeyId: "MACOS_NOTARY_KEY_ID",
    notaryIssuer: "MACOS_NOTARY_ISSUER_ID",
  });
  expect(certificateNames("acme2")).toEqual({
    p12: "MACOS_SIGN_P12_ACME2",
    password: "MACOS_SIGN_PASSWORD_ACME2",
    team: "TAPSTER_TEAM_ID_ACME2",
    expires: "TAPSTER_CERT_EXPIRES_ACME2",
    notaryKey: "MACOS_NOTARY_KEY_ACME2",
    notaryKeyId: "MACOS_NOTARY_KEY_ID_ACME2",
    notaryIssuer: "MACOS_NOTARY_ISSUER_ID_ACME2",
  });
  for (const n of ["MACOS_SIGN_P12", "MACOS_NOTARY_KEY_ID", "MACOS_SIGN_P12_ACME", "MACOS_NOTARY_KEY_ID_ACME", "MACOS_NOTARY_ISSUER_ID_X1"]) expect(isCertificateSecret(n)).toBe(true);
  for (const n of ["TAPSTER_TEAM_ID_ACME", "MACOS_SIGN_P12_", "MACOS_SIGN_P12_acme", "SPARKLE_KEY_ACME", "MACOS_SIGN_P12X"]) expect(isCertificateSecret(n)).toBe(false);
});
