import * as core from "@actions/core";
import { TapsterError } from "./errors";

const MIN = 4;
const registered = new Set<string>();

export function variants(value: string): string[] {
  if (value.length < MIN) return [];
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length >= MIN) out.add(v);
  };
  add(value);
  const bytes = Buffer.from(value, "utf8");
  add(bytes.toString("base64"));
  add(bytes.toString("hex"));
  add(bytes.toString("hex").toUpperCase());
  add(encodeURIComponent(value));
  for (const line of value.split(/\r?\n/)) add(line.trim());
  return [...out];
}

export function register(value: string): void {
  for (const v of variants(value)) {
    if (registered.has(v)) continue;
    registered.add(v);
    if (process.env.GITHUB_ACTIONS === "true") core.setSecret(v);
  }
}

export function scrub(text: string): string {
  let out = text;
  for (const v of [...registered].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}

export function readSecret(name: string): string {
  const value = process.env[name];
  delete process.env[name];
  if (!value) {
    const fix = name === "GITHUB_TOKEN" ? "The hub workflow passes it; run tapster init --workflow to restore the workflow." : `Add ${name} to the hub's "tapster" environment; tapster doctor shows how.`;
    throw new TapsterError(`${name} is not set`, fix);
  }
  register(value);
  return value;
}

export function requireVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new TapsterError(`${name} is not set`, `Add the ${name} variable to the "tapster" environment.`);
  return value;
}

export function resetMaskForTests(): void {
  registered.clear();
}
