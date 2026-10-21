import { expect, test } from "bun:test";
import type { HubView } from "../src/web/contract";
import { installStep, landing, linuxWrite, stops, toolState } from "../src/web/steps";

const hub = (o: { apple?: Partial<HubView["apple"]>; files?: Partial<HubView["files"]> } = {}): HubView => ({
  name: "octo/homebrew-tap",
  url: "u",
  private: false,
  empty: false,
  protect: { done: true, environment: true, checks: [], others: [] },
  app: { id: "1", slug: "s", key: true, held: false, install: null },
  apple: { needed: true, certificate: { team: "5MYT4VYJFC", expires: "2099-02-01" }, certificateStored: true, notary: true, ...o.apple },
  files: { config: true, state: true, readme: true, workflow: "current", pinned: "v1.6.0 (0123456)", every: null, ...o.files },
  packages: [],
  invalid: [],
  issue: null,
  extras: { doorbell: { on: false, origin: null, app: null, install: null, key: false, cloudflare: null, accounts: null, tokenPage: "" }, linux: { wanted: false, stored: false, gpg: false, keystore: null, maintainer: null, tools: [], left: [] }, sparkle: [] },
});

const status = (h: HubView, id: string) => stops(h, null).find((s) => s.id === id)!.status;

test("a stop that holds two facts shows each on its own line", () => {
  expect(status(hub(), "certificate")).toEqual(["Team 5MYT4VYJFC", "Expires 2099-02-01"]);
  expect(status(hub({ files: { workflow: "older" } }), "files")).toEqual(["Runs v1.6.0 (0123456)", "Update available"]);
  expect(status(hub({ files: { workflow: "other", pinned: null } }), "files")).toEqual(["Runs a workflow tapster did not write", "Review it"]);
  expect(status(hub({ files: { workflow: "newer" } }), "files")).toEqual(["Runs v1.6.0 (0123456)", "Newer than this tapster"]);
  expect(status(hub(), "files")).toEqual(["Runs v1.6.0 (0123456)"]);
  expect(status(hub({ apple: { certificate: null } }), "certificate")).toEqual(["Not stored yet"]);
  for (const s of stops(hub(), null)) for (const line of s.status) expect(line).not.toMatch(/, (expires|update|review|newer)/i);
});

test("coming back from GitHub lands on the section the person left, with what GitHub answered", () => {
  expect(landing("")).toBeNull();
  expect(landing("?saved=cloudflare")).toBeNull();
  expect(landing("?doorbell=created&hub=octo%2Fhomebrew-tap")).toEqual({ hub: "octo/homebrew-tap", open: "extras", title: "Back from GitHub: finishing the doorbell App", app: null, doorbell: { kind: "created" } });
  expect(landing("?doorbell=unstored&hub=octo%2Fhomebrew-tap&reason=r&fix=f")).toMatchObject({ open: "extras", doorbell: { kind: "unstored", problem: { reason: "r", fix: "f" } } });
  expect(landing("?doorbell=failed&hub=octo%2Fhomebrew-tap")).toMatchObject({ open: "extras", doorbell: { kind: "failed" } });
  expect(landing("?app=created&hub=octo%2Fhomebrew-tap")).toEqual({ hub: "octo/homebrew-tap", open: "app", title: "Back from GitHub: finishing the GitHub App", app: { kind: "created" }, doorbell: null });
  expect(landing("?app=failed&hub=octo%2Fhomebrew-tap&reason=r&fix=f")).toMatchObject({ open: "app", app: { kind: "failed", problem: { reason: "r", fix: "f" } } });
  expect(landing("?app=unknown")).toEqual({ hub: null, open: "app", title: "Back from GitHub: finishing the GitHub App", app: { kind: "unknown" }, doorbell: null });
});

test("an install step waits on GitHub only after the person clicked through to it", () => {
  expect(installStep(null, false)).toBe("ask");
  expect(installStep({ id: null, wide: false }, false)).toBe("ask");
  expect(installStep(null, true)).toBe("waiting");
  expect(installStep({ id: null, wide: false }, true)).toBe("waiting");
  expect(installStep({ id: 5, wide: false }, false)).toBe("done");
  expect(installStep({ id: 5, wide: false }, true)).toBe("done");
  expect(installStep({ id: 5, wide: true }, false)).toBe("wide");
  expect(installStep({ id: 5, wide: true }, true)).toBe("wide");
});

test("the Linux button says what it writes to tapster.yml", () => {
  expect(linuxWrite(true, 0)).toBe("Write the maintainer to tapster.yml");
  expect(linuxWrite(false, 1)).toBe("Write 1 tool to tapster.yml");
  expect(linuxWrite(true, 2)).toBe("Write the maintainer and 2 tools to tapster.yml");
  expect(linuxWrite(false, 0)).toBe("Nothing to write");
});

test("each tool's switch reads as text, including what a write changes", () => {
  expect([toolState(true, true), toolState(false, false), toolState(false, true), toolState(true, false)]).toEqual(["On", "Off", "Turns on", "Turns off"]);
});
