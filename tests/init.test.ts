import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appManifest, fillWorkflow, teamIdFromSubject } from "../src/cli/init";
import pins from "../templates/pins.json";

test("the App asks only for what tapster needs", () => {
  const m = appManifest("o", "o/homebrew-tap", "http://127.0.0.1:5000/callback") as Record<string, unknown>;
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({ contents: "write", attestations: "read", metadata: "read" });
  expect(m.default_events).toEqual([]);
  expect(m.name).toBe("tapster-o-tap");
  expect((appManifest("averyveryverylongowner", "averyveryverylongowner/homebrew-tapster-test", "x") as { name: string }).name.length).toBeLessThanOrEqual(34);
});

test("team id comes from the certificate subject", () => {
  expect(teamIdFromSubject("UID=ABC,CN=Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC),OU=5MYT4VYJFC,O=Dogu Kaan Yilmaz,C=TR")).toBe("5MYT4VYJFC");
  expect(teamIdFromSubject("CN=x")).toBeNull();
});

test("the workflow template is filled with pinned SHAs", () => {
  const out = fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" });
  expect(out).not.toContain("__");
  expect(out).toContain(`doguyilmaz/tapster@${"f".repeat(40)} # v1.0.0`);
  expect(out).toContain(`actions/checkout@${pins["actions/checkout"].sha}`);
});
