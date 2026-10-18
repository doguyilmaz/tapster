import { TapsterError } from "./errors";
import { parsePlist } from "./plist";

export type EntitlementValue = boolean | string | string[];
export type Entitlements = Record<string, EntitlementValue>;

const KEY = /^[A-Za-z0-9.-]+$/;
const VALUE = /^[A-Za-z0-9._*-]+$/;

const refuse = (what: string, fix: string) => new TapsterError(what, fix);

export function parseEntitlements(xml: string): Entitlements {
  if (xml.trim() === "") return {};
  const raw = parsePlist(Buffer.from(xml));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Buffer.isBuffer(raw) || raw instanceof Date) {
    throw refuse("the app's entitlements are not a dictionary", "Rebuild the app.");
  }
  const out: Entitlements = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean" || typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value as string[];
    else throw refuse(`the entitlement ${key} has a value tapster does not sign`, "tapster signs boolean, string and string list entitlements.");
  }
  return out;
}

export function checkEntitlements(found: Entitlements, allowed: string[], path: string): void {
  for (const key of Object.keys(found)) {
    if (key === "com.apple.security.get-task-allow") {
      throw refuse(`${path} carries com.apple.security.get-task-allow`, "Build the app in the Release configuration.");
    }
    if (!allowed.includes(key)) {
      throw refuse(`${path} asks for the entitlement ${key}`, `If the app needs it, list ${key} under entitlements in tapster.yml.`);
    }
  }
}

export function mergeEntitlements(found: Entitlements, extra: Entitlements, teamId: string): Entitlements {
  const fill = (v: string) => v.replaceAll("{team}", teamId);
  const out: Entitlements = { ...found };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = typeof value === "string" ? fill(value) : Array.isArray(value) ? value.map(fill) : value;
  }
  return out;
}

export function renderEntitlements(e: Entitlements): string {
  const string = (s: string) => {
    if (!VALUE.test(s)) throw refuse(`the entitlement value ${JSON.stringify(s)} has characters tapster does not write`, "Use letters, digits, dots, dashes and underscores.");
    return `<string>${s}</string>`;
  };
  const body = Object.keys(e)
    .sort()
    .map((key) => {
      if (!KEY.test(key)) throw refuse(`the entitlement name ${JSON.stringify(key)} is not valid`, "Use a reverse-DNS name.");
      const v = e[key]!;
      const value = typeof v === "boolean" ? (v ? "<true/>" : "<false/>") : typeof v === "string" ? string(v) : `<array>${v.map(string).join("")}</array>`;
      return `<key>${key}</key>${value}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`;
}
