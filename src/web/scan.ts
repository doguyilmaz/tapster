import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { LocalProject, ProjectKind } from "./contract";

const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies", "Documents", "Desktop", "Downloads", "Public", "vendor", "Pods", "DerivedData", "build", "dist", "target", "out"]);
const HOME_ROOTS = ["Developer", "Projects", "projects", "code", "Code", "src", "dev", "git", "GitHub", "repos", "workspace", "work"];

export function readSmall(path: string, limit = 1 << 20): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > limit) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

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
  if (entries.some((f) => f === "project.yml" || f === "Package.swift" || f.endsWith(".xcodeproj"))) return { kind: "app", why: null };
  if (has("go.mod")) return has(".goreleaser.yaml") || has(".goreleaser.yml") ? { kind: "go", why: null } : { kind: null, why: "a Go project without GoReleaser" };
  if (has("package.json")) return has("bun.lock") || has("bun.lockb") ? { kind: "bun", why: null } : { kind: null, why: "a JavaScript project without Bun" };
  return { kind: null, why: "no build that tapster knows" };
}

export function defaultRoots(home: string, cwd: string): string[] {
  return [cwd, dirname(cwd), ...HOME_ROOTS.map((r) => join(home, r))];
}

export function insideHome(path: string, home: string): boolean {
  const p = resolve(path);
  return p === home || p.startsWith(home.endsWith(sep) ? home : `${home}${sep}`);
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
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(real);
    } catch {
      return;
    }
    if (entries.includes(".git")) {
      let git: ReturnType<typeof lstatSync> | null = null;
      try {
        git = lstatSync(join(real, ".git"));
      } catch {
        git = null;
      }
      const config = git?.isDirectory() ? readSmall(join(real, ".git", "config"), 64 * 1024) : null;
      const repo = config ? originRepo(config) : null;
      if (repo) found.push({ path: real, repo, owner: repo.split("/")[0]!, inHub: false, ...projectKind(real, entries) });
      return;
    }
    if (level >= depth) return;
    for (const name of entries) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      try {
        if (!lstatSync(join(real, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(join(real, name), level + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { found, truncated };
}
