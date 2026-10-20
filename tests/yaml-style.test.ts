import { expect, test } from "bun:test";
import { adaptGoreleaser, adaptReleaseWorkflow, addRingStep } from "../src/cli/add";
import { withEntry } from "../src/cli/hubpr";

test("tapster's YAML edits keep the project's flow lists as they were written", () => {
  expect(adaptGoreleaser("builds:\n  - goos: [darwin, linux]\n    goarch: [amd64, arm64]\n").text).toContain("goos: [darwin, linux]\n    goarch: [amd64, arm64]");
  const flow = 'on:\n  push:\n    tags: ["v*"]\njobs:\n  r:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: goreleaser/goreleaser-action@v6\n        with: { args: release --clean }\n';
  const adapted = adaptReleaseWorkflow(flow, "a".repeat(40), "v4").text;
  expect(adapted).toContain('tags: ["v*"]');
  expect(adapted).toContain("with: { args: release --clean }");
  const ring = addRingStep('on: { push: { tags: ["v*"] } }\njobs:\n  r:\n    steps:\n      - run: gh release create "$TAG" --draft\n');
  expect(ring).toContain('tags: ["v*"]');
  const hub = "version: 1\ntap: o/tap\npackages:\n  - { name: a, repo: o/a, binaries: [a], assets: { linux-amd64: a.tgz } }\n";
  expect(withEntry(hub, "  - name: b\n    repo: o/b", "b")).toContain("binaries: [a], assets: { linux-amd64: a.tgz }");
});

test("only lines that changed take the YAML library's style", async () => {
  const { keepStyle } = await import("../src/cli/hubpr");
  expect(keepStyle("a: [x, y]\nb: { c: d }\n", "a: [ x, y ]\nb: { c: d }\nnew: [ z ]\n")).toBe("a: [x, y]\nb: { c: d }\nnew: [ z ]\n");
  expect(keepStyle("s: \"[ keep ]\"\n", "s: \"[ keep ]\"\n")).toBe("s: \"[ keep ]\"\n");
});
