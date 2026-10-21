import type { KeyRef, Store } from "../../src/cli/keystore";

export function memoryStore(): Store & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const id = (ref: KeyRef) => `${ref.service} ${ref.account}`;
  return {
    kind: "keychain",
    items,
    exists: async (ref) => items.has(id(ref)),
    save: async (ref, secret) => void items.set(id(ref), secret),
    read: async (ref) => items.get(id(ref)) ?? null,
    remove: async (ref) => void items.delete(id(ref)),
  };
}
