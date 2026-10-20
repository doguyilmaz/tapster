import { expect, test } from "bun:test";
import { cronFor, everyFromFlow } from "../src/cli/schedule";
import { TapsterError } from "../src/errors";

test("the interval becomes a GitHub cron a few minutes past the hour", () => {
  expect(cronFor(10)).toBe("7-59/10 * * * *");
  expect(cronFor(30)).toBe("7-59/30 * * * *");
  expect(cronFor(60)).toBe("7 * * * *");
  expect(cronFor(180)).toBe("7 */3 * * *");
  for (const bad of [0, 7, 45, 90, 1441]) expect(() => cronFor(bad)).toThrow(TapsterError);
});

test("the interval is read back from the workflow", () => {
  expect(everyFromFlow('on:\n  schedule:\n    - cron: "7-59/10 * * * *"\n')).toBe(10);
  expect(everyFromFlow('on:\n  schedule:\n    - cron: "7 * * * *"\n')).toBe(60);
  expect(everyFromFlow('on:\n  schedule:\n    - cron: "7 */3 * * *"\n')).toBe(180);
  expect(everyFromFlow("on: { workflow_dispatch: {} }\n")).toBeNull();
});

test("the hub workflow gets the schedule it is asked for", async () => {
  const { fillWorkflow } = await import("../src/cli/hubfiles");
  const pins = (await import("../templates/pins.json")).default;
  const template = await Bun.file("templates/hub/tapster.yml").text();
  const tapster = { sha: "f".repeat(40), tag: "v1.0.0" };
  expect(everyFromFlow(fillWorkflow(template, pins, tapster))).toBe(10);
  expect(everyFromFlow(fillWorkflow(template, pins, tapster, [], 60))).toBe(60);
  expect(fillWorkflow(template, pins, tapster)).not.toContain("__");
});

test("the interval error lists every interval tapster accepts", () => {
  expect(cronFor(6)).toBe("7-59/6 * * * *");
  expect(cronFor(12)).toBe("7-59/12 * * * *");
  expect(() => cronFor(7)).toThrow(TapsterError);
  try {
    cronFor(7);
  } catch (e) {
    expect((e as TapsterError).fix).toBe("Use 5, 6, 10, 12, 15, 20 or 30 minutes. Longer intervals must be 60 minutes times a divisor of 24.");
  }
});
