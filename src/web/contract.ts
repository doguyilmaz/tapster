export type Problem = { reason: string; fix: string };

export type SessionView = { version: string; dev: boolean; platform: string; home: string; here: { hub: string | null; repo: string | null; path: string } };

export type AccountView = { state: "no-gh" } | { state: "signed-out" } | { state: "ok"; login: string; missing: string[] };

export type HubChoice = { name: string; private: boolean; tapster: boolean; url: string };

export type Check = { label: string; ok: boolean };

export type OtherWorkflow = { file: string; actions: string[] };

export type HubView = {
  name: string;
  url: string;
  private: boolean;
  empty: boolean;
  protect: { done: boolean; checks: Check[]; others: OtherWorkflow[] };
  app: { id: string | null; slug: string | null; key: boolean; installed: InstallView | null };
  apple: { needed: boolean | null; certificate: { team: string; expires: string } | null; certificateStored: boolean; notary: boolean };
  files: { config: boolean; state: boolean; readme: boolean; workflow: "missing" | "current" | "older" | "newer" | "other"; pinned: string | null; every: number | null };
  packages: { name: string; repo: string; kind: string }[];
  invalid: { name: string; reason: string }[];
  issue: { url: string; number: number; updated: string; body: string } | null;
  extras: { doorbell: boolean; linux: { wanted: boolean; stored: boolean }; sparkle: { label: string; stored: boolean }[] };
};

export type InstallView = { checked: boolean; id: number | null; onHub: boolean; repos: string[] };

export type AppStart = { action: string; manifest: string; permissions: string[]; name: string };

export type FilePlan = { path: string; content: string; before: string | null; change: "create" | "update" | "same" | "remove" };

export type FilesView = { files: FilePlan[]; kept: string[]; pin: string; notes: string[]; foreign: string[]; readme: boolean };

export type ProjectKind = "go" | "bun" | "app";

export type LocalProject = {
  path: string;
  repo: string;
  kind: ProjectKind | null;
  why: string | null;
  inHub: boolean;
  proposed: string | null;
};

export type ScanView = { projects: LocalProject[]; roots: string[]; others: number; truncated: boolean };

export type InspectView = {
  path: string;
  repo: string;
  name: string;
  kind: ProjectKind;
  branch: string;
  dirty: string[];
  workflows: string[];
  workflow: string | null;
  releaseFlow: "missing" | "ours" | "other";
  dependabot: boolean;
  private: boolean;
  protected: boolean;
  inHub: boolean;
  proposed: string | null;
  apple: boolean;
};

export type AddOptionsView = { workflow: string; autoTag: boolean; dependabot: boolean; force: boolean };

export type AddView = { lines: string[]; pr: string | null; entry: string | null; installUrl: string; files: string[] };

export type DiffView = { files: { path: string; before: string | null; after: string | null }[] };

export type HealthView = {
  checks: { name: string; ok: boolean; fix: string; note?: string }[];
  note: string | null;
  runs: { id: number; url: string; event: string; status: string; conclusion: string | null; created: string }[];
};
