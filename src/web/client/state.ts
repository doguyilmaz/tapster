import { signal } from "@preact/signals";
import { type AccountView, type BellCloud, type HubChoice, type HubView, type Problem, type ProjectStatus, type ScanView, type SessionView, type StatusView, HUB_VIEW_VERSION } from "../contract";
import type { Answer, Landing } from "../steps";
import { ApiError, get, post } from "./api";

const HUB_KEY = "tapster.hub";
const VIEW_KEY = "tapster.view";

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
export const hubCached = signal(false);
export const toast = signal<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

let waiting: ((view: HubView | null) => void)[] = [];

function settle(view: HubView | null): void {
  hubCached.value = false;
  const done = waiting;
  waiting = [];
  setTimeout(() => done.forEach((f) => f(view)));
}

export const freshHub = (): Promise<HubView | null> => (hubCached.value ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(hub.value));

export const dropView = () => remember(VIEW_KEY, null);

// The saved view leaves out what only this setup's memory holds: an App key or a Cloudflare token waiting to be used.
function saveView(view: HubView): void {
  const doorbell = { ...view.extras.doorbell, key: false, cloudflare: null, accounts: null };
  remember(VIEW_KEY, JSON.stringify({ v: HUB_VIEW_VERSION, view: { ...view, app: { ...view.app, held: false }, extras: { ...view.extras, doorbell } } }));
}

export function restoreHub(): void {
  const name = hubName.value;
  if (!name || hub.value) return;
  const saved = ((): { v?: unknown; view?: HubView } | null => {
    try {
      return JSON.parse(recall(VIEW_KEY) ?? "null");
    } catch {
      return null;
    }
  })();
  if (saved?.v !== HUB_VIEW_VERSION || saved.view?.name !== name) return;
  hub.value = saved.view;
  hubCached.value = true;
}

export function go(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  path.value = location.pathname;
  window.scrollTo({ top: 0 });
}

addEventListener("popstate", () => {
  path.value = location.pathname;
});

export function say(tone: "ok" | "error" | "info", text: string): void {
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
    if (account.value.state !== "ok") dropView();
  } catch (e) {
    accountError.value = problemOf(e);
  }
}

export async function loadHubs(): Promise<void> {
  const list = await get<{ hubs: HubChoice[] }>("/api/hubs");
  hubs.value = list.hubs;
}

export function chooseHub(name: string | null, load = true): void {
  if (name !== hubName.value) {
    appResult.value = null;
    doorbellResult.value = null;
    dropView();
  }
  hubName.value = name;
  remember(HUB_KEY, name);
  hub.value = null;
  if (hubCached.value) settle(null);
  hubError.value = null;
  statuses.value = null;
  statusError.value = null;
  clones.value = null;
  if (name && load) {
    restoreHub();
    void loadHub();
  }
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
      saveView(view);
      if (hubCached.value) settle(view);
    }
  } catch (e) {
    if (hubName.value === name) {
      hubError.value = problemOf(e);
      if (hubCached.value) {
        hub.value = null;
        dropView();
        settle(null);
      }
    }
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

export const appResult = signal<Answer | null>(null);

export const doorbellResult = signal<Landing["doorbell"]>(null);

export const back = signal<Landing | null>(null);

export function setCloud(name: string, cloud: BellCloud): void {
  const h = hub.value;
  if (h?.name === name) hub.value = { ...h, extras: { ...h.extras, doorbell: { ...h.extras.doorbell, ...cloud } } };
}

export function tilde(path: string): string {
  const home = session.value?.home;
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
