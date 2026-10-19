import { expect, test } from "bun:test";
import { decodeSparkleKey } from "../src/sparkle-key";
import { JXA_ADD, jxaArgs, keychainScript, localStore, newSparkleKey, secretToolArgs } from "../src/cli/keystore";
import { TapsterError } from "../src/errors";

test("a new Sparkle key is the 32-byte seed Sparkle's own tools store", () => {
  const k = newSparkleKey();
  expect(Buffer.from(k.seed, "base64")).toHaveLength(32);
  expect(decodeSparkleKey(k.seed).publicKey).toBe(k.publicKey);
  expect(newSparkleKey().seed).not.toBe(k.seed);
});

test("the keychain gets the Sparkle key only as hex on stdin, under Sparkle's service", () => {
  const secret = "q7Zx81mPkW3vT9yLr2dNf5bHjA0123456789abcdefg=";
  const script = keychainScript({ service: "https://sparkle-project.org", account: "shared", label: "Private key for signing Sparkle updates", comment: "public key: abc=" }, secret);
  expect(script).toBe(
    `add-generic-password -s "https://sparkle-project.org" -a "shared" -l "Private key for signing Sparkle updates" -D "private key" -j "public key: abc=" -T "" -X ${Buffer.from(secret).toString("hex")}\n`,
  );
  expect(script).not.toContain(secret);
  expect(() => keychainScript({ service: "s", account: 'a" -w x', label: "l" }, secret)).toThrow(TapsterError);
  expect(() => keychainScript({ service: "s", account: "a", label: "l" }, "x".repeat(3000))).toThrow(/too long/);
});

test("large keys go to the macOS keychain through the Security API, read from stdin", () => {
  expect(jxaArgs({ service: "tapster-linux-key", account: "o/hub", label: "tapster Linux key for o/hub" })).toEqual([
    "-l", "JavaScript", "-e", JXA_ADD, "tapster-linux-key", "o/hub", "tapster Linux key for o/hub",
  ]);
  expect(JXA_ADD).toContain("fileHandleWithStandardInput");
  expect(JXA_ADD).toContain("SecItemAdd");
  expect(JXA_ADD).toContain("SecAccessCreate($(argv[2]), $.NSArray.array, access)");
});

test("on Linux the key goes to the Secret Service with the secret on stdin", () => {
  expect(secretToolArgs({ service: "tapster-linux-key", account: "o/hub", label: "tapster Linux key for o/hub" })).toEqual([
    "store", "--label", "tapster Linux key for o/hub", "service", "tapster-linux-key", "account", "o/hub",
  ]);
});

test("systems without a keystore tapster can use are refused", () => {
  expect(localStore("win32", () => true)).toBeNull();
  expect(localStore("linux", () => false)).toBeNull();
  expect(localStore("linux", () => true)!.kind).toBe("secret-service");
  expect(localStore("darwin", () => true)!.kind).toBe("keychain");
});
