import { expect, test } from "bun:test";
import { parseWork } from "../src/action/context";
import { TapsterError } from "../src/errors";

test("work lists are validated between jobs", () => {
  expect(parseWork('[{"package":"aims","tag":"v1.0.0","releaseId":5,"resume":false}]')).toEqual([{ package: "aims", tag: "v1.0.0", releaseId: 5, resume: false }]);
  expect(parseWork("")).toEqual([]);
  for (const bad of ['[{"package":"aims","tag":"v1.0.0#{x}","releaseId":5,"resume":false}]', '{"x":1}', "[1]", "nope"]) {
    expect(() => parseWork(bad)).toThrow(TapsterError);
  }
});
