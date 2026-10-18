import { GitHubError, TapsterError } from "./errors";
import type { GitHub } from "./github";

export type FileChange = { path: string; content: string | null };

export async function commitToHub(
  gh: GitHub,
  hub: string,
  message: string,
  build: (read: (path: string) => Promise<string | null>) => Promise<FileChange[]>,
): Promise<"committed" | "unchanged"> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`);
    const head = ref.object.sha;
    const commit = await gh.json<{ tree: { sha: string } }>("GET", `/repos/${hub}/git/commits/${head}`);
    const read = async (path: string): Promise<string | null> => {
      try {
        const file = await gh.json<{ content: string }>("GET", `/repos/${hub}/contents/${path}?ref=${head}`);
        return Buffer.from(file.content, "base64").toString("utf8");
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    };
    const changes = await build(read);
    if (changes.length === 0) return "unchanged";
    const tree = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: changes.map((c) => ({ path: c.path, mode: "100644", type: "blob", ...(c.content === null ? { sha: null } : { content: c.content }) })),
    });
    const next = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/commits`, { message, tree: tree.sha, parents: [head] });
    try {
      await gh.json("PATCH", `/repos/${hub}/git/refs/heads/main`, { sha: next.sha, force: false });
      return "committed";
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) continue;
      throw e;
    }
  }
  throw new TapsterError("the hub's main branch kept moving", "The next run retries.");
}
