export type Problem = { reason: string; fix: string };

export type SessionView = { version: string; dev: boolean; platform: string; home: string; here: { hub: string | null; repo: string | null; path: string } };

export type AccountView = { state: "no-gh" } | { state: "signed-out" } | { state: "ok"; login: string; missing: string[] };

export type HubChoice = { name: string; private: boolean; tapster: boolean; url: string };

export type Check = { label: string; ok: boolean };

export type OtherWorkflow = { file: string; actions: string[] };

// Bump on any change to HubView: the page keeps the last one in localStorage and paints it before GitHub answers.
export const HUB_VIEW_VERSION = 1;

export type HubView = {
  name: string;
  url: string;
  private: boolean;
  empty: boolean;
  protect: { done: boolean; environment: boolean; checks: Check[]; others: OtherWorkflow[] };
  app: { id: string | null; slug: string | null; key: boolean; held: boolean; install: string | null };
  apple: { needed: boolean | null; certificate: { team: string; expires: string } | null; certificateStored: boolean; notary: boolean };
  files: { config: boolean; state: boolean; readme: boolean; workflow: "missing" | "current" | "older" | "newer" | "other"; pinned: string | null; update: "needed" | "optional" | null; every: number | null };
  packages: { name: string; repo: string; kind: string }[];
  invalid: { name: string; reason: string }[];
  issue: { url: string; number: number; updated: string; body: string } | null;
  extras: { doorbell: DoorbellView; linux: LinuxView; sparkle: { label: string; stored: boolean }[] };
};

export type DoorbellView = {
  on: boolean;
  origin: string | null;
  app: { id: string; slug: string } | null;
  install: string | null;
  key: boolean;
  tokenPage: string;
} & BellCloud;

export type BellCloud = { cloudflare: { account: string; subdomain: string } | null; accounts: { id: string; name: string }[] | null };

export type BellInstallView = { id: number | null; others: string[] };

export type DoorbellDone = { origin: string; rung: string[]; missed: string[] };

export type LinuxTool = { name: string; repo: string; kind: "go" | "bun"; archives: string[]; on: boolean };

export type LinuxView = { wanted: boolean; stored: boolean; gpg: boolean; keystore: "keychain" | "keyring" | null; maintainer: string | null; tools: LinuxTool[]; left: { name: string; why: string }[] };

export type LinuxChange = { before: string; after: string };

export type InstallView = { checked: boolean; id: number | null; onHub: boolean; repos: string[] };

export type AppStart = { action: string; manifest: string; permissions: string[]; name: string };

export type FilePlan = { path: string; content: string; before: string | null; change: "create" | "update" | "same" | "remove" };

export type HubCode = { from: string; to: string; changed: string[]; compare: string };
export type FilesView = { files: FilePlan[]; kept: string[]; pin: string; notes: string[]; foreign: string[]; readme: boolean; hubCode: HubCode | null };

export type ProjectKind = "go" | "bun" | "app";

export type LocalProject = {
  path: string;
  repo: string;
  kind: ProjectKind | null;
  why: string | null;
  inHub: boolean;
  proposed: string | null;
  others: string[];
};

export type ScanView = { projects: LocalProject[]; roots: string[]; others: number; truncated: boolean };

export type InspectView = {
  path: string;
  repo: string;
  name: string;
  kind: ProjectKind;
  branch: string;
  defaultBranch: string;
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
  ready: boolean;
  ahead: number | null;
  unpushed: Unpushed[];
};

export type Unpushed = { sha: string; subject: string; tapster: boolean };

export type CommitResult = { committed: boolean; ahead: number | null; unpushed: Unpushed[] };

export type AddOptionsView = { workflow: string; autoTag: boolean; dependabot: boolean; force: boolean };

export type AddView = { lines: string[]; pr: string | null; head: string | null; entry: string | null; installUrl: string; files: string[] };

export type DiffView = { files: { path: string; before: string | null; after: string | null; change: "create" | "update" | "same" | "remove" }[] };

// skip, parent and changesRelease are set only when the commit's message carries a skip marker. parent.tag stays
// undefined until tapster has read the tags.
export type CommitView = {
  sha: string;
  subject: string;
  date: string;
  url: string;
  skip?: string;
  parent?: { sha: string; subject: string; url: string; skip: string | null; tag?: string | null } | null;
  changesRelease?: boolean;
};

export type ReachView = {
  reaches: boolean | null;
  how: "key" | "run" | "release" | null;
  at: string | null;
  since: string | null;
  reason: string | null;
  run: string | null;
  running: boolean;
};

export type ProjectStatus = {
  name: string;
  repo: string;
  url: string;
  kind: string;
  defaultBranch: string;
  setup: { ok: boolean; problems: string[]; triggers: string[] };
  protection: { ok: boolean; off: boolean; problems: string[] };
  entry: { state: "merged" | "proposed" | "missing"; pr: string | null; proposal: { head: string; entry: string } | null; blocked: string | null };
  app: ReachView & { installUrl: string };
  release: {
    latest: { tag: string; url: string; byHub: boolean } | null;
    draft: { tag: string; url: string; note: string | null } | null;
    highest: string | null;
    next: string;
    autoTag: boolean;
    atHead: string | null;
    suggest: { kind: "patch" | "minor" | "major"; reason: string } | null;
    head: CommitView | null;
  };
  secrets: { names: string[]; published: boolean };
  unreadable: string | null;
  config?: ConfigView | null;
};

// entry: this project's lines in main's tapster.yml. update: the same lines with what tapster derived from the project
// added (null when nothing is missing). pending: an update waiting in the hub's pull request from tapster-update-<name>.
export type ConfigView = {
  entry: string;
  update: string | null;
  from: string[];
  manual: string[];
  pending: { pr: string; head: string | null; entry: string | null; blocked: string | null } | null;
};

export type EntryCheck = { before: string; problem: Problem | null; same: boolean };

// Bump on any change to ProjectStatus: the page keeps the last list in localStorage and paints it before GitHub answers.
export const STATUS_VIEW_VERSION = 1;

export type StatusView = { projects: ProjectStatus[] };

export type FollowView = {
  run: { status: string; conclusion: string | null; url: string } | null;
  draft: { url: string; note: string | null } | null;
  published: { url: string; byHub: boolean } | null;
  hub: string;
  hubRun: { status: string; conclusion: string | null; url: string } | null;
};

export type HealthView = {
  checks: { name: string; ok: boolean; fix: string; note?: string }[];
  note: string | null;
  runs: { id: number; url: string; event: string; status: string; conclusion: string | null; created: string }[];
};
