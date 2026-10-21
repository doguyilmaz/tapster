import { signal } from "@preact/signals";
import type { AccountView, HubChoice, HubView, Problem, ProjectStatus, ScanView, SessionView, StatusView } from "../contract";
import { ApiError, get, post } from "./api";

const HUB_KEY = "tapster.hub";

const saved = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const remember = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return;
  }
};

export const recall = saved;

export const path = signal(location.pathname);
export const session = signal<SessionView | null>(null);
export const account = signal<AccountView | null>(null);
export const accountError = signal<Problem | null>(null);
export const hubs = signal<HubChoice[] | null>(null);
export const hubName = signal<string | null>(saved(HUB_KEY));
export const hub = signal<HubView | null>(null);
export const hubLoading = signal(false);
export const hubError = signal<Problem | null>(null);
export const toast = signal<{ tone: "ok" | "error"; text: string } | null>(null);

export function go(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  path.value = location.pathname;
  window.scrollTo({ top: 0 });
}

addEventListener("popstate", () => {
  path.value = location.pathname;
});

export function say(tone: "ok" | "error", text: string): void {
  toast.value = { tone, text };
  setTimeout(() => {
    if (toast.value?.text === text) toast.value = null;
  }, 5000);
}

export const problemOf = (e: unknown): Problem => (e instanceof ApiError ? e.problem : { reason: "something went wrong", fix: "Reload the page and try again." });

export async function loadAccount(): Promise<void> {
  try {
    account.value = await get<AccountView>("/api/account");
    accountError.value = null;
  } catch (e) {
    accountError.value = problemOf(e);
  }
}

export async function loadHubs(): Promise<void> {
  const list = await get<{ hubs: HubChoice[] }>("/api/hubs");
  hubs.value = list.hubs;
}

export function chooseHub(name: string | null): void {
  if (name !== hubName.value) {
    appResult.value = null;
    doorbellResult.value = null;
  }
  hubName.value = name;
  remember(HUB_KEY, name);
  hub.value = null;
  hubError.value = null;
  statuses.value = null;
  statusError.value = null;
  clones.value = null;
  if (name) void loadHub();
}

export const statuses = signal<{ hub: string; list: ProjectStatus[] } | null>(null);
export const statusError = signal<Problem | null>(null);

let loading: { hub: string; done: Promise<void> } | null = null;

export function loadStatuses(): Promise<void> {
  const name = hubName.value;
  if (!name) return Promise.resolve();
  if (loading?.hub === name) return loading.done;
  const done = (async () => {
    try {
      const view = await get<StatusView>(`/api/projects/status?hub=${encodeURIComponent(name)}`);
      if (hubName.value !== name) return;
      statuses.value = { hub: name, list: view.projects };
      statusError.value = null;
    } catch (e) {
      if (hubName.value === name) statusError.value = problemOf(e);
    } finally {
      loading = null;
    }
  })();
  loading = { hub: name, done };
  return done;
}

export async function statusOf(repo: string): Promise<ProjectStatus | null> {
  const name = hubName.value;
  if (!name) return null;
  const s = (await get<StatusView>(`/api/projects/status?hub=${encodeURIComponent(name)}&repo=${encodeURIComponent(repo)}`)).projects[0] ?? null;
  const now = statuses.value;
  if (s && now?.hub === name && s.entry.state !== "missing") {
    const known = now.list.some((x) => x.repo === s.repo);
    statuses.value = { hub: name, list: known ? now.list.map((x) => (x.repo === s.repo ? s : x)) : [...now.list, s] };
  }
  return s;
}

const ROOTS_KEY = "tapster.roots";

export function savedRoots(): string[] {
  try {
    const v = JSON.parse(recall(ROOTS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

export const saveRoots = (roots: string[]) => remember(ROOTS_KEY, JSON.stringify(roots));

export const clones = signal<{ hub: string; scan: ScanView } | null>(null);

export async function loadClones(extra = savedRoots()): Promise<void> {
  const name = hubName.value;
  if (!name) return;
  const scan = await post<ScanView>("/api/projects/scan", { hub: name, extra });
  if (hubName.value === name) clones.value = { hub: name, scan };
}

export async function loadHub(): Promise<void> {
  const name = hubName.value;
  if (!name) return;
  hubLoading.value = true;
  try {
    const view = await get<HubView>(`/api/hub?hub=${encodeURIComponent(name)}`);
    if (hubName.value === name) {
      hub.value = view;
      hubError.value = null;
    }
  } catch (e) {
    if (hubName.value === name) hubError.value = problemOf(e);
  } finally {
    hubLoading.value = false;
  }
}

const MAC_KEY = (name: string) => `tapster.mac.${name}`;
export const macChoice = signal<Record<string, "yes" | "no">>({});

export function mac(name: string): "yes" | "no" | null {
  return macChoice.value[name] ?? ((saved(MAC_KEY(name)) as "yes" | "no" | null) || null);
}

export function setMac(name: string, choice: "yes" | "no"): void {
  remember(MAC_KEY(name), choice);
  macChoice.value = { ...macChoice.value, [name]: choice };
}

export const openStop = signal<string | null>(null);

export const appResult = signal<{ kind: "created" } | { kind: "failed" | "unstored"; problem: Problem } | { kind: "unknown" } | null>(null);

export const doorbellResult = signal<{ kind: "created" } | { kind: "failed" | "unstored"; problem: Problem } | null>(null);

export function tilde(path: string): string {
  const home = session.value?.home;
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
