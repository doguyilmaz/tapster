import { createSign } from "node:crypto";
import { GitHubError } from "./errors";
import { GitHub, type FetchLike } from "./github";
import { register } from "./mask";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem).toString("base64url");
  const jwt = `${head}.${body}.${sig}`;
  register(jwt);
  return jwt;
}

export type InstallationToken = { token: string; revoke(): Promise<void> };

export async function installationToken(
  appId: string,
  pem: string,
  repo: string,
  permissions: Record<string, "read" | "write">,
  fetchImpl?: FetchLike,
): Promise<InstallationToken> {
  const app = new GitHub(appJwt(appId, pem), fetchImpl);
  const installation = await app.json<{ id: number }>("GET", `/repos/${repo}/installation`);
  const { token } = await app.json<{ token: string }>("POST", `/app/installations/${installation.id}/access_tokens`, {
    repositories: [repo.split("/")[1]],
    permissions,
  });
  register(token);
  const gh = new GitHub(token, fetchImpl);
  return {
    token,
    revoke: async () => {
      await gh.request("DELETE", "/installation/token").catch(() => undefined);
    },
  };
}

export const attestationToken = (appId: string, pem: string, repo: string, fetchImpl?: FetchLike) =>
  installationToken(appId, pem, repo, { attestations: "read" }, fetchImpl);

export async function installationRepos(appId: string, pem: string, owner: string, fetchImpl?: FetchLike): Promise<string[] | null> {
  const app = new GitHub(appJwt(appId, pem), fetchImpl);
  let installation: { id: number };
  try {
    installation = await app.json<{ id: number }>("GET", `/users/${owner}/installation`);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
  const { token } = await app.json<{ token: string }>("POST", `/app/installations/${installation.id}/access_tokens`, { permissions: { metadata: "read" } });
  register(token);
  const gh = new GitHub(token, fetchImpl);
  try {
    const repos: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh.json<{ repositories: { full_name: string }[] }>("GET", `/installation/repositories?per_page=100&page=${page}`);
      repos.push(...batch.repositories.map((r) => r.full_name));
      if (batch.repositories.length < 100) break;
    }
    return repos;
  } finally {
    await gh.request("DELETE", "/installation/token").catch(() => undefined);
  }
}
