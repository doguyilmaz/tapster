import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { TapsterError } from "../errors";
import { runPath } from "../run";

export type KeyRef = { service: string; account: string; label: string; comment?: string };

export type Store = {
  kind: "keychain" | "secret-service";
  exists(ref: KeyRef): Promise<boolean>;
  save(ref: KeyRef, secret: string): Promise<void>;
  read(ref: KeyRef): Promise<string | null>;
  remove(ref: KeyRef): Promise<void>;
};

export function newSparkleKey(): { seed: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { seed: seed.toString("base64"), publicKey: raw.toString("base64") };
}

const SAFE = /^[A-Za-z0-9 .:/@_+=()-]+$/;

function checkRef(ref: KeyRef): void {
  for (const v of [ref.service, ref.account, ref.label, ...(ref.comment === undefined ? [] : [ref.comment])]) {
    if (!SAFE.test(v)) throw new TapsterError(`"${v}" cannot name a keychain item`, "Use letters, digits and simple punctuation.");
  }
}

export function keychainScript(ref: KeyRef, secret: string): string {
  checkRef(ref);
  const comment = ref.comment === undefined ? "" : ` -j "${ref.comment}"`;
  const line = `add-generic-password -s "${ref.service}" -a "${ref.account}" -l "${ref.label}" -D "private key"${comment} -T "" -X ${Buffer.from(secret).toString("hex")}\n`;
  if (line.length > 4000) throw new TapsterError("the key is too long for one security command", "tapster stores large keys through the Security API instead.");
  return line;
}

export const JXA_ADD = `ObjC.import("Security");
ObjC.import("Foundation");
function run(argv) {
  const k = (ref) => ObjC.castRefToObject(ref);
  const access = Ref();
  const made = $.SecAccessCreate($(argv[2]), $.NSArray.array, access);
  if (made !== 0) return String(made);
  const q = $.NSMutableDictionary.alloc.init;
  q.setObjectForKey(k(access[0]), k($.kSecAttrAccess));
  q.setObjectForKey(k($.kSecClassGenericPassword), k($.kSecClass));
  q.setObjectForKey($(argv[0]), k($.kSecAttrService));
  q.setObjectForKey($(argv[1]), k($.kSecAttrAccount));
  q.setObjectForKey($(argv[2]), k($.kSecAttrLabel));
  q.setObjectForKey($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, k($.kSecValueData));
  return String($.SecItemAdd(q, null));
}`;

export function jxaArgs(ref: KeyRef): string[] {
  checkRef(ref);
  return ["-l", "JavaScript", "-e", JXA_ADD, ref.service, ref.account, ref.label];
}

export function secretToolArgs(ref: KeyRef): string[] {
  checkRef(ref);
  return ["store", "--label", ref.label, "service", ref.service, "account", ref.account];
}

const SECURITY = "/usr/bin/security";
const OSASCRIPT = "/usr/bin/osascript";
const SECRET_TOOL = "/usr/bin/secret-tool";

const keychain: Store = {
  kind: "keychain",
  exists: async (ref) => (await runPath(SECURITY, "security", ["find-generic-password", "-s", ref.service, "-a", ref.account], { allowFail: true })).code === 0,
  async save(ref, secret) {
    let script: string | null = null;
    try {
      script = keychainScript(ref, secret);
    } catch (e) {
      if (!(e instanceof TapsterError) || !e.reason.includes("too long")) throw e;
    }
    if (script !== null) {
      const res = await runPath(SECURITY, "security", ["-i"], { stdin: script, allowFail: true });
      if (res.code === 0 && !/error|returned/i.test(res.stderr)) return;
      throw new TapsterError("the login keychain refused the key", "Unlock the login keychain and run this again.");
    }
    const res = await runPath(OSASCRIPT, "osascript", jxaArgs(ref), { stdin: secret, allowFail: true });
    if (res.code !== 0 || res.stdout.trim() !== "0") throw new TapsterError(`the login keychain refused the key (status ${res.stdout.trim() || res.code})`, "Unlock the login keychain and run this again.");
  },
  async read(ref) {
    const res = await runPath(SECURITY, "security", ["find-generic-password", "-s", ref.service, "-a", ref.account, "-w"], { allowFail: true });
    return res.code === 0 ? res.stdout.replace(/\n$/, "") : null;
  },
  async remove(ref) {
    await runPath(SECURITY, "security", ["delete-generic-password", "-s", ref.service, "-a", ref.account], { allowFail: true });
  },
};

const secretService: Store = {
  kind: "secret-service",
  exists: async (ref) => (await secretService.read(ref)) !== null,
  async save(ref, secret) {
    const res = await runPath(SECRET_TOOL, "secret-tool", secretToolArgs(ref), { stdin: secret, allowFail: true });
    if (res.code !== 0) throw new TapsterError("the Secret Service refused the key", "Unlock your keyring (GNOME Keyring or KWallet) and run this again.");
  },
  async read(ref) {
    checkRef(ref);
    const res = await runPath(SECRET_TOOL, "secret-tool", ["lookup", "service", ref.service, "account", ref.account], { allowFail: true });
    return res.code === 0 && res.stdout !== "" ? res.stdout : null;
  },
  async remove(ref) {
    checkRef(ref);
    await runPath(SECRET_TOOL, "secret-tool", ["clear", "service", ref.service, "account", ref.account], { allowFail: true });
  },
};

export function localStore(platform: string = process.platform, has: (path: string) => boolean = existsSync): Store | null {
  if (platform === "darwin") return has(SECURITY) && has(OSASCRIPT) ? keychain : null;
  if (platform === "linux") return has(SECRET_TOOL) ? secretService : null;
  return null;
}

export async function previousKey(store: Store, ref: KeyRef): Promise<string | null> {
  const value = await store.read(ref);
  if (value !== null || !(await store.exists(ref))) return value;
  throw new TapsterError(
    "the previous key is in your keychain, but tapster could not read it",
    "Choose Allow when macOS asks, and run this where you can see that question (not over SSH). Nothing was changed.",
  );
}

export function requireStore(what: string): Store {
  const store = localStore();
  if (store) return store;
  throw new TapsterError(
    `tapster keeps a copy of ${what} in your keychain, and this system has none it can use`,
    "Run this on macOS, or on Linux with secret-tool (libsecret-tools) installed, so the key is never kept only in GitHub, which never gives secrets back.",
  );
}
