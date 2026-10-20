import type { GitHub } from "./github";

const BOT_PATHS = /^(\.tapster|Casks|bucket)\//;

export async function foreignWritesAt(gh: GitHub, hub: string, owner: string): Promise<{ head: string | null; writes: string[] }> {
  const ref = encodeURIComponent("refs/heads/main");
  const [last] = await gh.json<{ after: string }[]>("GET", `/repos/${hub}/activity?ref=${ref}&actor=${owner}&per_page=1`);
  if (!last) return { head: null, writes: [`GitHub shows no push by ${owner} to main`] };
  const at = last.after.slice(0, 7);
  const head = (await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`)).object.sha;
  const cmp = await gh.json<{ status: string; files?: { filename: string }[] }>("GET", `/repos/${hub}/compare/${last.after}...${head}`);
  if (cmp.status === "identical") return { head, writes: [] };
  if (cmp.status !== "ahead") return { head, writes: [`main no longer contains your last push (${at})`] };
  const files = cmp.files ?? [];
  if (files.length >= 300) return { head, writes: [`more files changed after your last push (${at}) than GitHub lists`] };
  return { head, writes: files.filter((f) => !BOT_PATHS.test(f.filename)).map((f) => `${f.filename} changed after your last push (${at})`) };
}

export const foreignWrites = async (gh: GitHub, hub: string, owner: string): Promise<string[]> => (await foreignWritesAt(gh, hub, owner)).writes;
