import { expect, test } from "bun:test";
import { type Ask, refreshService } from "../src/web/service";

const old = { version: "2.0.2", port: 8278, pid: 10 };
const fresh = { version: "2.1.0", port: 8278, pid: 11 };

function io(statuses: unknown[], legacy = false) {
  const calls: Ask[] = [];
  return {
    calls,
    pause: async () => {},
    ask: async (_: string, what: Ask): Promise<unknown | null> => {
      calls.push(what);
      if (what === "status") return statuses.length > 1 ? statuses.shift() : statuses[0] ?? null;
      if (what === "restart" && legacy) return null;
      return { stopping: true };
    },
  };
}

test("setup loads the installed version before it asks the service for a pairing", async () => {
  const mock = io([old, old, null, fresh]);
  expect(await refreshService("sock", "2.1.0", mock)).toEqual(fresh);
  expect(mock.calls).toEqual(["status", "restart", "status", "status", "status"]);
  expect(mock.calls).not.toContain("pair");
});

test("a service predating restart falls back to stop and waits for the new process", async () => {
  const mock = io([old, null, fresh], true);
  expect(await refreshService("sock", "2.1.0", mock)).toEqual(fresh);
  expect(mock.calls.slice(0, 3)).toEqual(["status", "restart", "stop"]);
});

test.each(["2.1.0", "2.2.0", "3.0.0"])("setup does not restart or downgrade service %s", async (version) => {
  const mock = io([{ ...old, version }]);
  expect((await refreshService("sock", "2.1.0", mock))?.version).toBe(version);
  expect(mock.calls).toEqual(["status"]);
});

test("a checkout cannot restart a released service just by opening setup", async () => {
  const mock = io([old]);
  expect(await refreshService("sock", "0.0.0-dev", mock)).toEqual(old);
  expect(mock.calls).toEqual(["status"]);
});

test("no installed service and malformed answers leave the socket alone", async () => {
  for (const answer of [null, { version: "2.0.2", port: 80, pid: 10 }, { version: "2.0.2" }]) {
    const mock = io([answer]);
    expect(await refreshService("sock", "2.1.0", mock)).toBeNull();
    expect(mock.calls).toEqual(["status"]);
  }
});

test("a service that never comes back yields an actionable error and never pairs with the old version", async () => {
  const mock = io([old]);
  await expect(refreshService("sock", "2.1.0", mock)).rejects.toThrow("did not come back");
  expect(mock.calls).not.toContain("pair");
});

test("explicit restart waits for a different process even at the same version", async () => {
  const mock = io([fresh, fresh, { ...fresh, pid: 12 }]);
  expect((await refreshService("sock", "2.1.0", mock, true))?.pid).toBe(12);
  expect(mock.calls[1]).toBe("restart");
});
