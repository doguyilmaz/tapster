import type { CodeItem } from "./bundle";
import { type AppPackage, BUNDLE_ID } from "./config";
import { TapsterError } from "./errors";

const refuse = (what: string) => new TapsterError(what, "Set the identifier under code in tapster.yml, or fix the bundle's CFBundleIdentifier.");

export function identifierFor(item: CodeItem, pkg: AppPackage): string {
  if (item.path === ".") {
    if (item.bundleId !== pkg.bundle_id) throw refuse(`the app's CFBundleIdentifier is ${item.bundleId ?? "missing"}, not ${pkg.bundle_id}`);
    return pkg.bundle_id;
  }
  const configured = pkg.code[item.path]?.identifier;
  if (configured) return configured;
  if (item.kind === "bundle") {
    const id = item.bundleId;
    if (!id || !BUNDLE_ID.test(id)) throw refuse(`${item.path} has no valid CFBundleIdentifier`);
    if (id.startsWith(`${pkg.bundle_id}.`)) return id;
    if (id.startsWith("org.sparkle-project.") && item.path.split("/").includes("Sparkle.framework")) return id;
    throw refuse(`${item.path} claims the identifier ${id}, which belongs outside ${pkg.bundle_id}`);
  }
  const file = item.path.split("/").pop()!.replace(/[^A-Za-z0-9.-]/g, "-");
  return `${pkg.bundle_id}.${file}`;
}
