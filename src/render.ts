import { basename } from "node:path";
import type { AppPackage, CliPackage, PackageConfig, Platform } from "./config";
import { TapsterError } from "./errors";

export function rubyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "#") out += "\\#";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

const list = (items: string[]) => (items.length === 1 ? rubyString(items[0]!) : `[${items.map(rubyString).join(", ")}]`);

export type Download = { platform: Platform; url: string; sha256: string };
export type RenderInput = { pkg: CliPackage; version: string; downloads: Download[]; description: string; homepage: string; license: string | null };

export const downloadUrl = (repo: string, tag: string, asset: string) => `https://github.com/${repo}/releases/download/${tag}/${asset}`;

const tidyDesc = (s: string) => s.trim().replace(/\.+$/, "");

const LOWERCASE_STARTS = ["iOS", "iPhone", "macOS"];

export function descProblems(desc: string, name: string): string[] {
  const problems: string[] = [];
  if (desc === "") return ["it is empty"];
  if (/^\s/.test(desc) || /\s$/.test(desc)) problems.push("it has leading or trailing spaces");
  if (/command ?line/i.test(desc)) problems.push('it should say "command-line"');
  if (/^(?:the|an?)(?=\s)/i.test(desc)) problems.push("it starts with an article");
  if (/^[a-z]/.test(desc) && !LOWERCASE_STARTS.includes(desc.split(/\s+/)[0]!)) problems.push("it starts with a lowercase letter");
  if (new RegExp(`^${name.replaceAll("-", "").split("").join("[\\s\\-]?")}\\b`, "i").test(desc)) problems.push("it starts with the package name");
  const platform = /\b(macOS|Mac(?: ?OS(?: ?X)?)?|OS ?X)(?! virtual machines?)\b/i.exec(desc);
  if (platform && platform[1] !== "MAC") problems.push("it names the platform");
  if (/\.$/.test(desc) && !desc.endsWith("etc.")) problems.push("it ends with a full stop");
  if (/\p{So}/u.test(desc)) problems.push("it contains a symbol or emoji");
  if ([...desc].length > 80) problems.push("it is longer than 80 characters");
  return problems;
}

const SAFE = /^[A-Za-z0-9._\/-]+$/;

function caskUrl(pkg: PackageConfig, d: Download): string {
  const template = pkg.assets[d.platform];
  if (!template || !SAFE.test(pkg.repo) || !SAFE.test(template.replaceAll("{version}", ""))) throw new TapsterError(`${pkg.name}: no safe asset name for ${d.platform}`, "Check assets in tapster.yml.");
  return `"https://github.com/${pkg.repo}/releases/download/v#{version}/${template.replaceAll("{version}", "#{version}")}"`;
}

function block(lines: string[], indent: string, pkg: PackageConfig, d: Download) {
  lines.push(`${indent}sha256 ${rubyString(d.sha256)}`, `${indent}url ${caskUrl(pkg, d)}`);
}

function os(lines: string[], name: "macos" | "linux", pkg: PackageConfig, downloads: Download[]) {
  const pick = (p: string) => downloads.find((d) => d.platform === `${name === "macos" ? "darwin" : "linux"}-${p}`);
  const universal = name === "macos" ? downloads.find((d) => d.platform === "darwin-universal") : undefined;
  const arm = pick("arm64");
  const intel = pick("amd64");
  if (!universal && !arm && !intel) return;
  lines.push(`  on_${name} do`);
  if (universal) lines.push(`    sha256 ${rubyString(universal.sha256)}`, "", `    url ${caskUrl(pkg, universal)}`);
  else {
    if (arm) {
      lines.push("    on_arm do");
      block(lines, "      ", pkg, arm);
      lines.push("    end");
    }
    if (intel) {
      lines.push("    on_intel do");
      block(lines, "      ", pkg, intel);
      lines.push("    end");
    }
  }
  lines.push("  end");
}

export function renderCask(i: RenderInput): string | null {
  const { pkg } = i;
  if (!i.downloads.some((d) => d.platform.startsWith("darwin-") || d.platform.startsWith("linux-"))) return null;
  const lines = [`cask ${rubyString(pkg.name)} do`, `  version ${rubyString(i.version)}`, ""];
  os(lines, "macos", pkg, i.downloads);
  os(lines, "linux", pkg, i.downloads);
  lines.push(
    "",
    `  name ${rubyString(pkg.name)}`,
    `  desc ${rubyString(tidyDesc(i.description))}`,
    `  homepage ${rubyString(i.homepage)}`,
    "",
    "  livecheck do",
    '    skip "tapster"',
    "  end",
    "",
  );
  for (const b of pkg.binaries) lines.push(`  binary ${rubyString(b)}`);
  const c = pkg.completions;
  if (c?.bash) lines.push(`  bash_completion ${rubyString(c.bash)}`);
  if (c?.zsh) lines.push(`  zsh_completion ${rubyString(c.zsh)}`);
  if (c?.fish) lines.push(`  fish_completion ${rubyString(c.fish)}`);
  tail(lines, pkg.cask, pkg.cask.uninstall?.quit ?? []);
  return lines.join("\n");
}

function tail(lines: string[], cask: CliPackage["cask"], quit: string[]): void {
  const parts = ([["launchctl", cask.uninstall?.launchctl ?? []], ["quit", quit]] as const).filter(([, v]) => v.length > 0);
  const width = Math.max(0, ...parts.map(([k]) => k.length)) + 2;
  if (parts.length) lines.push("", `  uninstall ${parts.map(([k, v]) => `${`${k}:`.padEnd(width)}${list([...v])}`).join(",\n            ")}`);
  if (cask.zap?.trash.length) lines.push("", `  zap trash: ${list(cask.zap.trash)}`);
  if (cask.caveats) lines.push("", `  caveats ${rubyString(cask.caveats)}`);
  lines.push("end", "");
}

const MACOS_SYMBOLS = ["big_sur", "monterey", "ventura", "sonoma", "sequoia", "tahoe"];
const ARCH: Partial<Record<Platform, string>> = { "darwin-arm64": ":arm64", "darwin-amd64": ":x86_64" };

export type AppRenderInput = { pkg: AppPackage; version: string; sha256: string; macos: string; description: string; homepage: string };

export function renderAppCask(i: AppRenderInput): string {
  const { pkg } = i;
  if (!MACOS_SYMBOLS.includes(i.macos)) throw new TapsterError(`${pkg.name}: the macOS floor ${i.macos} is not one tapster renders`, "Check LSMinimumSystemVersion.");
  if (!SAFE.test(pkg.repo) || !SAFE.test(pkg.dmg.name.replaceAll("{version}", ""))) throw new TapsterError(`${pkg.name}: no safe DMG name`, "Check dmg.name in tapster.yml.");
  const platform = Object.keys(pkg.assets)[0] as Platform;
  const lines = [
    `cask ${rubyString(pkg.name)} do`,
    `  version ${rubyString(i.version)}`,
    `  sha256 ${rubyString(i.sha256)}`,
    "",
    `  url "https://github.com/${pkg.repo}/releases/download/v#{version}/${pkg.dmg.name.replaceAll("{version}", "#{version}")}"`,
    `  name ${rubyString(pkg.app.replace(/\.app$/, ""))}`,
    `  desc ${rubyString(tidyDesc(i.description))}`,
    `  homepage ${rubyString(i.homepage)}`,
    "",
    "  livecheck do",
    '    skip "tapster"',
    "  end",
    "",
  ];
  if (pkg.cask.auto_updates ?? pkg.sparkle !== undefined) lines.push("  auto_updates true");
  if (ARCH[platform]) lines.push(`  depends_on arch: ${ARCH[platform]}`);
  lines.push(`  depends_on macos: :${i.macos}`, "", `  app ${rubyString(pkg.app)}`);
  for (const b of pkg.cask.binaries ?? []) lines.push(`  binary "#{appdir}/${rubyString(`${pkg.app}/${b}`).slice(1)}`);
  tail(lines, pkg.cask, pkg.cask.uninstall?.quit ?? [pkg.bundle_id]);
  return lines.join("\n");
}

export function renderScoop(i: RenderInput): string | null {
  const arch: Record<string, { url: string; hash: string }> = {};
  for (const d of i.downloads) {
    if (d.platform === "windows-amd64") arch["64bit"] = { url: d.url, hash: d.sha256 };
    if (d.platform === "windows-arm64") arch.arm64 = { url: d.url, hash: d.sha256 };
  }
  if (!i.pkg.scoop || Object.keys(arch).length === 0) return null;
  const bins = i.pkg.binaries.map((b) => (b.endsWith(".exe") ? b : `${b}.exe`));
  const manifest = {
    version: i.version,
    description: tidyDesc(i.description),
    homepage: i.homepage,
    ...(i.license ? { license: i.license } : {}),
    architecture: arch,
    bin: bins.length === 1 ? bins[0] : bins,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const caskPath = (name: string) => `Casks/${basename(name)}.rb`;
export const scoopPath = (name: string) => `bucket/${basename(name)}.json`;
