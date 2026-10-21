import { expect, test } from "bun:test";
import { changedEntry, entryText, missing, withAdditions, withEntryText } from "../src/hubentry";
import { parseHub } from "../src/config";

const HUB = `version: 1
tap: o/tap
packages:
  # the tools
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
    cask:
      zap: { trash: ["~/.config/aims"] }
    # kept on its own line

  - { name: ebb, repo: o/ebb, binaries: [ebb], assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz" } }
linux: { maintainer: "O <o@x.yz>" }
`;

const AIMS = `- name: aims
  repo: o/aims
  binaries: [aims]
  assets:
    darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
    linux-amd64: "aims_{version}_linux_amd64.tar.gz"
  cask:
    zap: { trash: ["~/.config/aims"] }`;

test("an entry's own lines come out without the list's indent, comments around it left in the file", () => {
  expect(entryText(HUB, "aims")).toBe(AIMS);
  expect(entryText(HUB, "ebb")).toBe('- { name: ebb, repo: o/ebb, binaries: [ebb], assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz" } }');
  expect(entryText(HUB, "nope")).toBeNull();
  expect(entryText("version: 1\ntap: o/tap\npackages: [{ name: aims, repo: o/aims }]\n", "aims")).toBeNull();
});

test("a valid edit replaces only the entry's lines and keeps every other byte", () => {
  const next = withEntryText(HUB, "aims", AIMS.replace("binaries: [aims]", "binaries: [aims]\n  homepage: https://aims.example.com"), "o");
  expect(next).toBe(HUB.replace("    binaries: [aims]\n", "    binaries: [aims]\n    homepage: https://aims.example.com\n"));
  expect(parseHub(next, "o").invalid).toEqual([]);
  expect(changedEntry(HUB, next, "aims", "o")).toBe(AIMS.replace("binaries: [aims]", "binaries: [aims]\n  homepage: https://aims.example.com"));
  expect(withEntryText(HUB, "aims", `${AIMS}\r\n\r\n`, "o")).toBe(HUB);
});

test("an edit that reaches another entry or the rest of tapster.yml is refused", () => {
  const reason = (entry: string) => {
    try {
      withEntryText(HUB, "aims", entry, "o");
      return null;
    } catch (e) {
      return (e as { reason: string }).reason;
    }
  };
  expect(reason(`${AIMS}\n- { name: lockstep, repo: o/lockstep, binaries: [ls], assets: { linux-amd64: "a.tar.gz" } }`)).toBe("the box must hold exactly one entry that starts with - name:");
  expect(reason(`${AIMS}\nlinux: { maintainer: "M <m@x.yz>" }`)).toStartWith("the entry is not valid YAML at line 9");
  const shared = HUB.replace("    binaries: [aims]\n", "    binaries: [aims]\n    license: &lic MIT\n").replace("binaries: [ebb],", "binaries: [ebb], license: *lic,");
  expect(() => withEntryText(shared, "aims", entryText(shared, "aims")!.replace("&lic MIT", "&lic Apache-2.0"), "o")).toThrow("the change reaches beyond the entry of aims");
  expect(reason(`${AIMS}\n  binaries: [ebb]`)).toStartWith("the entry is not valid YAML at line 9");
  expect(reason(AIMS.replace("binaries: [aims]", "binaries: [ebb]"))).toBe("the hub would refuse this entry: aims and ebb both ship a binary named ebb");
  expect(reason(AIMS.replace("name: aims", "name: aimz"))).toBe("the entry must keep the name aims");
  expect(reason(AIMS.replace("repo: o/aims", "repo: o/other"))).toBe("the entry must keep the repository o/aims");
  expect(reason(AIMS.replace("binaries: [aims]", "binaries: aims"))).toStartWith("the hub would refuse this entry: aims is invalid: binaries:");
  expect(reason("name: aims\nrepo: o/aims")).toBe("the box must hold exactly one entry that starts with - name:");
});

test("an entry that leans on another entry's anchor cannot be read or edited on its own, and nothing throws", () => {
  const shared = HUB.replace("    binaries: [aims]\n", "    binaries: [aims]\n    license: &lic MIT\n").replace("binaries: [ebb],", "binaries: [ebb], license: *lic,");
  expect(entryText(shared, "ebb")).toBeNull();
  expect(entryText(shared, "aims")).toContain("license: &lic MIT");
  expect(() => withEntryText(shared, "ebb", "- { name: ebb, repo: o/ebb }", "o")).toThrow("tapster cannot read the entry of ebb on its own in tapster.yml");
  expect(() => withEntryText(HUB, "aims", `${AIMS}\n  license: *nowhere`, "o")).toThrow("the entry is not valid YAML");
});

test("an untouched entry comes back byte for byte, blank lines with spaces and CRLF files included", () => {
  const spaced = HUB.replace("    binaries: [aims]\n", "    binaries: [aims]\n      \n");
  expect(withEntryText(spaced, "aims", entryText(spaced, "aims")!, "o")).toBe(spaced);
  expect(withEntryText(spaced, "aims", entryText(spaced, "aims")!.replace("repo: o/aims", "repo: o/aims\n  license: MIT"), "o")).toBe(spaced.replace("    repo: o/aims\n", "    repo: o/aims\n    license: MIT\n"));
  const crlf = HUB.replace(/\n/g, "\r\n");
  expect(entryText(crlf, "aims")).toBe(AIMS);
  expect(withEntryText(crlf, "aims", AIMS, "o")).toBe(crlf);
  expect(withEntryText(crlf, "aims", `${AIMS}\n  license: MIT`, "o")).toBe(crlf.replace('    zap: { trash: ["~/.config/aims"] }\r\n', '    zap: { trash: ["~/.config/aims"] }\r\n    license: MIT\r\n'));
  const keep = "version: 1\ntap: o/tap\npackages:\n  - name: t\n    repo: o/t\n    binaries: [t]\n    assets: { linux-amd64: t.tar.gz }\n    cask:\n      caveats: |+\n        keep\n\n";
  expect(withEntryText(keep, "t", entryText(keep, "t")!, "o")).toBe(keep);
});

test("a pull request that changes more than the entry is not read as an entry change", () => {
  const edited = withEntryText(HUB, "aims", `${AIMS}\n  license: MIT`, "o");
  expect(changedEntry(HUB, edited, "aims", "o")).toBe(`${AIMS}\n  license: MIT`);
  expect(changedEntry(HUB, edited.replace("tap: o/tap", "tap: o/other"), "aims", "o")).toBeNull();
  expect(changedEntry(HUB, edited.replace("binaries: [ebb]", "binaries: [ebb, x]"), "aims", "o")).toBeNull();
  expect(changedEntry(HUB, edited.replace("  # the tools\n", ""), "aims", "o")).toBeNull();
  expect(changedEntry(HUB, edited.replace("    # kept on its own line\n", "    # mine\n"), "aims", "o")).toBeNull();
});

test("only keys the entry lacks are proposed, and maps it has only gain keys", () => {
  const current = { app: { name: "x.app" }, cask: { zap: { trash: ["~/a"] } }, license: "MIT" };
  expect(missing(current, { app: { name: "y.app", bundle_id: "com.o.x" }, cask: { zap: { trash: ["~/b"] }, uninstall: { launchctl: ["l"] } }, license: "Apache-2.0" })).toEqual({
    app: { bundle_id: "com.o.x" },
    cask: { uninstall: { launchctl: ["l"] } },
  });
  expect(missing(current, { license: "MIT", app: { name: "x.app" } })).toBeUndefined();
});

test("additions land after the keys that are there, in block and flow style alike", () => {
  const add = { app: { name: "aims.app", bundle_id: "com.o.aims", binaries: ["Contents/MacOS/aims"] }, cask: { uninstall: { launchctl: ["com.o.aims.keepalive"] }, zap: { trash: ["~/x"] } } };
  const out = withAdditions(AIMS, missing({ cask: { zap: {} } }, add) as Record<string, unknown>);
  expect(out).toBe(`- name: aims
  repo: o/aims
  binaries: [aims]
  assets:
    darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
    linux-amd64: "aims_{version}_linux_amd64.tar.gz"
  cask:
    zap: { trash: ["~/.config/aims"] }
    uninstall:
      launchctl: ["com.o.aims.keepalive"]
  app:
    name: aims.app
    bundle_id: com.o.aims
    binaries: ["Contents/MacOS/aims"]`);
  const ebb = entryText(HUB, "ebb")!;
  expect(withAdditions(ebb, { assets: { "darwin-arm64": "ebb_{version}_darwin_arm64.tar.gz" }, license: "MIT" })).toBe(
    '- { name: ebb, repo: o/ebb, binaries: [ebb], assets: { linux-amd64: "ebb_{version}_linux_amd64.tar.gz", darwin-arm64: "ebb_{version}_darwin_arm64.tar.gz" }, license: MIT }',
  );
  expect(withAdditions("- name: pix\n  repo: o/pix\n  sparkle: { key: pix }\n  carry: {}", { sparkle: { feed: "appcast-2.xml" }, carry: { "appcast.xml": `sha256:${"a".repeat(64)}` } })).toBe(
    `- name: pix\n  repo: o/pix\n  sparkle: { key: pix, feed: appcast-2.xml }\n  carry: {appcast.xml: "sha256:${"a".repeat(64)}"}`,
  );
  expect(withAdditions("- name: t\n  repo: o/t\n  caveats: |+\n    keep\n\n", { license: "MIT" })).toBeNull();
});
