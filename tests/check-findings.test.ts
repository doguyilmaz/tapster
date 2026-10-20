import { afterEach, expect, test } from "bun:test";
import { reportNote, tapsterUpdate } from "../src/action/check";
import { GitHubError } from "../src/errors";
import type { GitHub } from "../src/github";
import { failedCount, findings, resetReportForTests } from "../src/report";

function latest(answer: unknown) {
  const asked: string[] = [];
  const gh = {
    json: async (method: string, path: string) => {
      asked.push(`${method} ${path}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as GitHub;
  return { gh, asked };
}

const released = (version: string) => ({ version, sha: "f".repeat(40) });

test("a newer tapster release is a concern with the way to move the hub to it", async () => {
  const { gh, asked } = latest({ tag_name: "v1.2.0" });
  expect(await tapsterUpdate(gh, released("1.1.0"))).toEqual({
    reason: "tapster v1.2.0 is out; this hub runs v1.1.0",
    fix: "Update the hub workflow with bunx @doguyilmaz/tapster setup (Hub files) or with tapster init --workflow in a clone of the hub.",
  });
  expect(asked).toEqual(["GET /repos/doguyilmaz/tapster/releases/latest"]);
  expect(await tapsterUpdate(latest({ tag_name: "v1.2.0" }).gh, released("1.2.0-rc.1"))).not.toBeNull();
});

test("the same or an older release, a build from a checkout and a failed lookup are no concern", async () => {
  expect(await tapsterUpdate(latest({ tag_name: "v1.2.0" }).gh, released("1.2.0"))).toBeNull();
  expect(await tapsterUpdate(latest({ tag_name: "v1.1.9" }).gh, released("1.2.0"))).toBeNull();
  expect(await tapsterUpdate(latest({ tag_name: "nightly" }).gh, released("1.2.0"))).toBeNull();
  expect(await tapsterUpdate(latest(new GitHubError("GitHub GET returned 404", "x", 404)).gh, released("1.2.0"))).toBeNull();
  const dev = latest({ tag_name: "v9.0.0" });
  expect(await tapsterUpdate(dev.gh, { version: "0.0.0-dev", sha: null })).toBeNull();
  expect(dev.asked).toEqual([]);
});

afterEach(resetReportForTests);

test("a refused draft stays the same finding on later runs, so the health issue does not flap", () => {
  const out = { reason: "a.tar.gz does not match checksums.txt" };
  reportNote("aims", "v1.0.0", { ...out, result: "failed" });
  const first = findings();
  expect(first).toEqual([{ item: "aims", reason: "v1.0.0: a.tar.gz does not match checksums.txt", fix: "The hub wrote this on the draft too; fix the draft or delete it." }]);
  expect(failedCount()).toBe(1);
  resetReportForTests();
  reportNote("aims", "v1.0.0", { ...out, result: "known" });
  expect(findings()).toEqual(first);
  expect(failedCount()).toBe(0);
});

test("a draft that is still waiting is not a finding", () => {
  reportNote("aims", "v1.0.0", { result: "waiting", reason: "assets are still uploading" });
  expect(findings()).toEqual([]);
});
