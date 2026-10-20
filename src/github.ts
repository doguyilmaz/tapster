import { GitHubError } from "./errors";

export type Account = { login: string; type: string };
export type Asset = { id: number; name: string; size: number; state: string; digest: string | null; browser_download_url: string; uploader?: Account | null; created_at?: string };
export type Release = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  upload_url: string;
  author?: Account | null;
  body?: string | null;
  assets: Asset[];
};
export type Repo = { id: number; private: boolean; description: string | null; html_url: string; default_branch: string };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const USER_HINTS: Record<number, string> = {
  401: "Your GitHub sign-in was rejected; run gh auth login again.",
  403: "Your account may not do this here; check that you own the repository, then run gh auth refresh to renew the sign-in.",
  404: "Not found or not visible to your gh sign-in; check the name and run gh auth status.",
  409: "GitHub reported a conflict; run the command again.",
  422: "GitHub rejected the request.",
};

const HINTS: Record<number, string> = {
  401: "The credential was rejected; rotate it with tapster init --rotate.",
  403: "Access denied: check the App's permissions and that it is installed on this repository.",
  404: "Not found. The App may not be installed on this repository.",
  409: "GitHub reported a conflict; the next run retries.",
  422: "GitHub rejected the request.",
};

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(url)";
  }
}

type RequestInitLite = { body?: unknown; raw?: Uint8Array; contentType?: string; accept?: string; auth?: boolean };

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly who: "app" | "user" = "app",
  ) {}

  async request(method: string, url: string, init: RequestInitLite = {}): Promise<Response> {
    const full = url.startsWith("https://") ? url : `https://api.github.com${url}`;
    const headers: Record<string, string> = {
      Accept: init.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tapster",
    };
    if (init.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    if (init.contentType) headers["Content-Type"] = init.contentType;
    else if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(full, { method, headers, body, redirect: "manual" });
      } catch {
        if (attempt < 4) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new GitHubError(`GitHub ${method} ${pathOf(full)}: network error`, "GitHub did not answer; the next run retries.", 0);
      }
      if ((res.status >= 500 || res.status === 429) && attempt < 4) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) {
        await res.body?.cancel();
        const hints = this.who === "user" ? USER_HINTS : HINTS;
        throw new GitHubError(`GitHub ${method} ${pathOf(full)} returned ${res.status}`, hints[res.status] ?? (this.who === "user" ? "Try again in a moment." : "The next run retries."), res.status);
      }
      return res;
    }
  }

  async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res = await this.request(method, url, body === undefined ? {} : { body });
    for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
      const location = res.headers.get("location");
      let next: URL | null = null;
      try {
        next = location ? new URL(location) : null;
      } catch {
        next = null;
      }
      if (hops >= 3 || !next || next.protocol !== "https:" || next.host !== "api.github.com") {
        throw new GitHubError(`GitHub ${method} ${pathOf(url)} moved somewhere tapster does not follow`, "Update the repository name in tapster.yml.", res.status);
      }
      res = await this.request(method, next.toString(), body === undefined ? {} : { body });
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listReleases(repo: string): Promise<Release[]> {
    const out: Release[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<Release[]>("GET", `/repos/${repo}/releases?per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  getRelease = (repo: string, id: number) => this.json<Release>("GET", `/repos/${repo}/releases/${id}`);
  getRepo = (repo: string) => this.json<Repo>("GET", `/repos/${repo}`);

  async downloadAsset(repo: string, assetId: number): Promise<Buffer> {
    const res = await this.request("GET", `/repos/${repo}/releases/assets/${assetId}`, { accept: "application/octet-stream" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new GitHubError(`GitHub sent a redirect without a location for asset ${assetId}`, "The next run retries.", res.status);
      const next = await this.request("GET", location, { auth: false, accept: "application/octet-stream" });
      return Buffer.from(await next.arrayBuffer());
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async uploadAsset(release: Release, name: string, data: Uint8Array): Promise<Asset> {
    const base = release.upload_url.replace(/\{.*\}$/, "");
    const res = await this.request("POST", `${base}?name=${encodeURIComponent(name)}`, { raw: data, contentType: "application/octet-stream" });
    return (await res.json()) as Asset;
  }

  deleteAsset = (repo: string, id: number) => this.request("DELETE", `/repos/${repo}/releases/assets/${id}`).then(() => undefined);
  renameAsset = (repo: string, id: number, name: string) => this.json<Asset>("PATCH", `/repos/${repo}/releases/assets/${id}`, { name });
  updateRelease = (repo: string, id: number, tag: string, patch: { draft?: boolean; make_latest?: "true" | "false" }) =>
    this.json<Release>("PATCH", `/repos/${repo}/releases/${id}`, { ...patch, tag_name: tag });
}
