import { GitHubError } from "../errors";
import { GitHub } from "../github";
import { appJwt } from "../token";
import type { CreatedApp } from "./appflow";
import { setEnvSecret, setEnvVariable } from "./gh";

export function appManifest(owner: string, hub: string, redirect: string): object {
  return {
    name: `tapster-${owner}-${hub.split("/")[1]!.replace(/^homebrew-/, "")}`.toLowerCase().slice(0, 34),
    url: `https://github.com/${hub}`,
    redirect_url: redirect,
    public: false,
    default_permissions: { contents: "write", attestations: "read", metadata: "read" },
    default_events: [],
    hook_attributes: { url: "https://example.com/tapster-has-no-webhook", active: false },
  };
}

export async function storeApp(hub: string, created: CreatedApp): Promise<void> {
  await Promise.all([setEnvVariable(hub, "TAPSTER_APP_ID", String(created.id)), setEnvVariable(hub, "TAPSTER_APP_SLUG", created.slug), setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", created.pem)]);
}

export type AppInstallation = { id: number | null; onHub: boolean };

export async function appInstallation(appId: string, pem: string, owner: string, hub: string, gh = new GitHub(appJwt(appId, pem))): Promise<AppInstallation> {
  let id: number;
  try {
    id = (await gh.json<{ id: number }>("GET", `/users/${owner}/installation`)).id;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return { id: null, onHub: false };
    throw e;
  }
  const onHub = await gh.json("GET", `/repos/${hub}/installation`).then(() => true, (e) => (e instanceof GitHubError && e.status === 404 ? false : Promise.reject(e)));
  return { id, onHub };
}
