import type { CodeItem } from "./bundle";
import { type AppPackage, BUNDLE_ID } from "./config";
import { TapsterError } from "./errors";

const refuse = (what: string) => new TapsterError(what, "Set the identifier under code in tapster.yml or fix the bundle's CFBundleIdentifier.");

export function identifierFor(item: CodeItem, pkg: Pick<AppPackage, "bundle_id" | "code">): string {
  if (item.path === ".") {
    if (item.bundleId !== pkg.bundle_id) throw refuse(`the app's CFBundleIdentifier is ${item.bundleId ?? "missing"}, not ${pkg.bundle_id}`);
    return pkg.bundle_id;
  }
  const configured = pkg.code[item.path]?.identifier;
  if (item.kind === "bundle") {
    const id = item.bundleId;
    if (!id || !BUNDLE_ID.test(id)) throw refuse(`${item.path} has no valid CFBundleIdentifier`);
    if (configured && configured !== id) throw refuse(`${item.path} says ${id} in its Info.plist, but code sets ${configured}`);
    if (bundleIdAllowed(item.path, id, pkg)) return id;
    throw refuse(`${item.path} claims the identifier ${id}, which belongs outside ${pkg.bundle_id}`);
  }
  return configured ?? defaultIdentifier(pkg.bundle_id, item.path);
}

export const defaultIdentifier = (bundleId: string, path: string) => `${bundleId}.${path.split("/").pop()!.replace(/[^A-Za-z0-9.-]/g, "-")}`;

const SPARKLE = /^Contents\/Frameworks\/Sparkle\.framework\/Versions\/[^/]+(\/|$)/;

export function bundleIdAllowed(path: string, id: string, pkg: Pick<AppPackage, "bundle_id">): boolean {
  if (id.startsWith(`${pkg.bundle_id}.`)) return true;
  return id.startsWith("org.sparkle-project.") && SPARKLE.test(path);
}
