import { expect, test } from "bun:test";
import { autoTagSteps } from "../src/cli/hubpr";
import { capFirst, notes } from "../src/web/steps";

test("add's notes read as sentences, with YAML and commands kept as blocks", () => {
  const said = [
    "- release.draft: true; the tapster hub publishes after signing",
    "- Dependabot cannot open pull requests here now: GitHub does not let personal repositories exempt it from the rules.",
    "  To keep it, run tapster add --allow-dependabot.",
    ["- automatic tags: a deploy key lives in its release environment.", "  Push tags from your release workflow like this:", autoTagSteps({ sha: "a".repeat(40), tag: "v7" })].join("\n"),
    "- the hub entry was not proposed: o/x is already in the hub's tapster.yml. Edit its entry there instead.\n  The entry for o/homebrew-tap's tapster.yml:\n  - name: x\n    repo: o/x",
    "- proposed the hub entry in https://github.com/o/homebrew-tap/pull/1; merge it to start publishing",
    "- open this page and choose Install, unless the hub's App already reaches o/x; the project is preselected:\n  https://github.com/apps/x/installations/new",
  ];
  const out = notes(said);
  expect(out.map((n) => n.text)).toEqual([
    "release.draft: true; the tapster hub publishes after signing",
    "Dependabot cannot open pull requests here now: GitHub does not let personal repositories exempt it from the rules. To keep it, run tapster add --allow-dependabot.",
    "Automatic tags: a deploy key lives in its release environment. Push tags from your release workflow like this:",
    "The hub entry was not proposed: o/x is already in the hub's tapster.yml. Edit its entry there instead. The entry for o/homebrew-tap's tapster.yml:",
  ]);
  expect(out[2]!.block).toContain("  environment: release\n  steps:");
  expect(out[2]!.block!.split("\n")[0]).toBe("# in the job that decides the version, on the default branch:");
  expect(out[3]!.block).toBe("- name: x\n  repo: o/x");
  expect(out[0]!.block).toBeNull();
  expect(notes(["- doguyilmaz/ebb still holds release secrets"])[0]!.text).toBe("doguyilmaz/ebb still holds release secrets");
  expect(notes(["- added the attestation step"])[0]!.text).toBe("Added the attestation step");
  expect(notes(["- the hub has no Apple credentials, so the entry leaves out the macOS builds", "  Remove the macOS builds too."])[0]!.text).toBe("The hub has no Apple credentials, so the entry leaves out the macOS builds. Remove the macOS builds too.");
});

test("a sentence that starts with a name keeps the name as written", () => {
  expect(capFirst("doguyilmaz/tapster is protected")).toBe("doguyilmaz/tapster is protected");
  expect(capFirst("tapster.yml is valid")).toBe("tapster.yml is valid");
  expect(capFirst("tapster's hub ran")).toBe("tapster's hub ran");
  expect(capFirst("the hub ran in the last day")).toBe("The hub ran in the last day");
  expect(capFirst("main cannot be deleted")).toBe("Main cannot be deleted");
});
