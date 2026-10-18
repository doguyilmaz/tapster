import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type HubConfig, NAME, TAG, parseConfig } from "../config";
import { TapsterError } from "../errors";
import type { WorkItem } from "../plan";

export type Context = { hub: string; owner: string; config: HubConfig; workspace: string };

export async function loadContext(configPath: string): Promise<Context> {
  const hub = process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!hub || !owner || !workspace) throw new TapsterError("tapster runs inside GitHub Actions only", "Call it from the hub workflow.");
  const text = await readFile(join(workspace, configPath), "utf8").catch(() => {
    throw new TapsterError(`${configPath} is missing in the hub`, "Run tapster init in a clone of the hub.");
  });
  return { hub, owner, config: parseConfig(text, owner), workspace };
}

const work = z
  .array(z.object({ package: z.string().regex(NAME), tag: z.string().regex(TAG), releaseId: z.number().int().positive(), resume: z.boolean() }).strict())
  .max(50);

export function parseWork(text: string): WorkItem[] {
  if (text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TapsterError("the work list is not valid JSON", "Pass the check job's work output unchanged.");
  }
  const r = work.safeParse(raw);
  if (!r.success) throw new TapsterError("the work list is invalid", "Pass the check job's work output unchanged.");
  return r.data;
}
