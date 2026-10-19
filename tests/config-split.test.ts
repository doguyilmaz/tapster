import { expect, test } from "bun:test";
import { parseHub } from "../src/config";
import { TapsterError } from "../src/errors";

const head = "version: 1\ntap: o/tap\npackages:\n";
const cli = (name: string, extra = "") => `  - name: ${name}
    repo: o/${name}
    binaries: [${name}]
    assets:
      darwin-arm64: "${name}_{version}_darwin_arm64.tar.gz"
${extra}`;

test("one bad package is reported with its reason and the others load", () => {
  const { config, invalid } = parseHub(head + cli("good") + cli("bad", "    shiny: 1\n") + cli("other"), "o");
  expect(config.packages.map((p) => p.name)).toEqual(["good", "other"]);
  expect(invalid).toHaveLength(1);
  expect(invalid[0]!.name).toBe("bad");
  expect(invalid[0]!.reason).toContain("shiny");
});

test("a package without a usable name is named by its position", () => {
  const { invalid } = parseHub(head + cli("good") + "  - repo: o/x\n", "o");
  expect(invalid.map((i) => i.name)).toEqual(["packages[1]"]);
});

test("rules that read one package fail only that package", () => {
  const foreign = cli("foreign").replace("repo: o/foreign", "repo: someone/foreign");
  const zip = cli("zip").replace("darwin_arm64.tar.gz", "darwin_arm64.zip");
  const linux = cli("lin", "    linux: true\n");
  const { config, invalid } = parseHub(head + cli("good") + foreign + zip + linux, "o");
  expect(config.packages.map((p) => p.name)).toEqual(["good"]);
  expect(invalid.map((i) => i.name)).toEqual(["foreign", "zip", "lin"]);
});

test("a conflict between packages fails every package involved", () => {
  const twin = cli("twin").replace("binaries: [twin]", "binaries: [good]");
  const { config, invalid } = parseHub(head + cli("good") + twin + cli("free"), "o");
  expect(config.packages.map((p) => p.name)).toEqual(["free"]);
  expect(invalid.map((i) => i.name).sort()).toEqual(["good", "twin"]);
  expect(invalid[0]!.reason).toContain("good");
});

test("a name listed twice fails both entries", () => {
  const { config, invalid } = parseHub(head + cli("same") + cli("same") + cli("free"), "o");
  expect(config.packages.map((p) => p.name)).toEqual(["free"]);
  expect(invalid.map((i) => i.name)).toEqual(["same", "same"]);
});

test("apps with overlapping bundle ids fail together", () => {
  const app = (name: string, id: string) => `  - name: ${name}
    repo: o/${name}
    kind: app
    app: ${name}.app
    bundle_id: ${id}
    assets:
      darwin-arm64: "${name}-{version}.app.tar.gz"
    dmg: { name: "${name}-{version}.dmg" }
`;
  const { config, invalid } = parseHub(head + app("one", "com.o.One") + app("two", "com.o.One.Two") + cli("free"), "o");
  expect(config.packages.map((p) => p.name)).toEqual(["free"]);
  expect(invalid.map((i) => i.name).sort()).toEqual(["one", "two"]);
});

test.each([
  ["bad YAML", "version: [1\n"],
  ["a bad top level", "version: 2\ntap: o/tap\npackages: []\n"],
  ["packages that are not a list", "version: 1\ntap: o/tap\npackages: {}\n"],
])("%s still fails the whole hub", (_, text) => {
  expect(() => parseHub(text, "o")).toThrow(TapsterError);
});

test("check records each invalid package as failed, or only the one asked for", async () => {
  const { reportInvalid } = await import("../src/action/check");
  const { resetReportForTests, rowsForTests } = await import("../src/report");
  const invalid = [
    { name: "a", reason: "a is invalid: x", fix: "Fix it." },
    { name: "b", reason: "b is invalid: y", fix: "Fix it." },
  ];
  resetReportForTests();
  reportInvalid(invalid, "");
  expect(rowsForTests().map((r) => [r.item, r.result])).toEqual([["a", "failed"], ["b", "failed"]]);
  resetReportForTests();
  reportInvalid(invalid, "b");
  expect(rowsForTests().map((r) => r.item)).toEqual(["b"]);
  resetReportForTests();
});
