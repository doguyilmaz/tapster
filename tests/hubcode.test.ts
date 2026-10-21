import { expect, test } from "bun:test";
import { hubCodeFiles } from "../src/web/api/hub";

test("only the Action and the hub's templates count as hub code", () => {
  expect(hubCodeFiles(["src/web/client/setup.tsx", "README.md", "site/x.md"])).toEqual([]);
  expect(hubCodeFiles(["dist/index.js", "src/action/check.ts", "action.yml", "templates/hub/tapster.yml", "templates/project/ring.yml"])).toEqual(["dist/index.js", "action.yml", "templates/hub/tapster.yml"]);
});
