import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { findApp } from "../cli/add";
import { readSmall } from "../cli/paths";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { LocalProject, ProjectKind } from "./contract";

const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies", "Documents", "Desktop", "Downloads", "Public", "vendor", "Pods", "DerivedData", "build", "dist", "target", "out"]);
const HOME_ROOTS = ["Developer", "Projects", "projects", "code", "Code", "src", "dev", "git", "GitHub", "repos", "workspace", "work"];

export { readSmall };

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export function originRepo(config: string): string | null {
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(config)?.[1] ?? "";
  const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)?.[1] ?? "";
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

export function projectKind(dir: string, entries: string[]): { kind: ProjectKind | null; why: string | null } {
  const has = (f: string) => entries.includes(f) && isFile(join(dir, f));
  if (entries.some((f) => f === "project.yml" || f === "Package.swift" || f.endsWith(".xcodeproj"))) {
    return findApp(dir) ? { kind: "app", why: null } : { kind: null, why: "an Xcode project without a Sparkle feed" };
  }
  if (has("go.mod")) return has(".goreleaser.yaml") || has(".goreleaser.yml") ? { kind: "go", why: null } : { kind: null, why: "a Go project without GoReleaser" };
  if (has("package.json")) {
    if (!has("bun.lock") && !has("bun.lockb")) return { kind: null, why: "a JavaScript project without Bun" };
    let bin: unknown = null;
    try {
      bin = (JSON.parse(readSmall(join(dir, "package.json")) ?? "{}") as { bin?: unknown }).bin;
    } catch {
      bin = null;
    }
    return bin ? { kind: "bun", why: null } : { kind: null, why: "a Bun project without a command (no bin in package.json)" };
  }
  return { kind: null, why: "no build that tapster knows" };
}

export function defaultRoots(home: string, cwd: string): string[] {
  return [cwd, dirname(cwd), ...HOME_ROOTS.map((r) => join(home, r))].filter((r) => insideHome(r, home) && r !== resolve(home));
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function insideHome(path: string, home: string): boolean {
  return within(resolve(path), resolve(home)) || within(real(path), real(home));
}

export type ScanResult = { found: (LocalProject & { owner: string })[]; truncated: boolean };

export function scanClones(roots: string[], o: { depth?: number; maxDirs?: number; deadline?: number } = {}): ScanResult {
  const depth = o.depth ?? 3;
  const maxDirs = o.maxDirs ?? 4000;
  const deadline = o.deadline ?? Date.now() + 3000;
  const seen = new Set<string>();
  const found: ScanResult["found"] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, level: number) => {
    if (visited >= maxDirs || Date.now() > deadline) {
      truncated = true;
      return;
    }
    let canonical: string;
    try {
      canonical = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(canonical);
    } catch {
      return;
    }
    if (entries.includes(".git")) {
      let git: ReturnType<typeof lstatSync> | null = null;
      try {
        git = lstatSync(join(canonical, ".git"));
      } catch {
        git = null;
      }
      const config = git?.isDirectory() ? readSmall(join(canonical, ".git", "config"), 64 * 1024) : null;
      const repo = config ? originRepo(config) : null;
      if (repo) found.push({ path: dir, repo, owner: repo.split("/")[0]!, inHub: false, proposed: null, others: [], ...projectKind(canonical, entries) });
      return;
    }
    if (level >= depth) return;
    for (const name of entries) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      try {
        if (!lstatSync(join(canonical, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(join(dir, name), level + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { found, truncated };
}

export type CloneFacts = { branch: string | null; defaultBranch: string | null; changed: number };

export function cloneFacts(dir: string): CloneFacts {
  const ref = (path: string, prefix: string) => new RegExp(`^ref: ${prefix}(.+)$`).exec(readSmall(join(dir, ".git", path), 4096)?.trim() ?? "")?.[1] ?? null;
  const mtime = (path: string) => {
    try {
      return lstatSync(join(dir, ".git", path)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return { branch: ref("HEAD", "refs/heads/"), defaultBranch: ref(join("refs", "remotes", "origin", "HEAD"), "refs/remotes/origin/"), changed: Math.max(mtime("HEAD"), mtime("index"), mtime(join("logs", "HEAD"))) };
}

const onDefault = (c: CloneFacts) => c.branch !== null && c.branch === (c.defaultBranch ?? (c.branch === "main" || c.branch === "master" ? c.branch : null));

const named = (f: { path: string; repo: string }) => basename(f.path).toLowerCase() === f.repo.split("/")[1]!.toLowerCase();

export function oneClonePerRepo<T extends { path: string; repo: string }>(found: T[], facts: (dir: string) => CloneFacts = cloneFacts): (T & { others: string[] })[] {
  const groups = new Map<string, T[]>();
  for (const f of found) groups.set(f.repo.toLowerCase(), [...(groups.get(f.repo.toLowerCase()) ?? []), f]);
  return [...groups.values()].map((list) => {
    const ranked = list.length === 1 ? list : list.map((f) => ({ f, c: facts(f.path) })).sort((a, b) => Number(named(b.f)) - Number(named(a.f)) || Number(onDefault(b.c)) - Number(onDefault(a.c)) || b.c.changed - a.c.changed).map((x) => x.f);
    return { ...ranked[0]!, others: ranked.slice(1).map((f) => f.path) };
  });
}
