import { expect, test } from "bun:test";
import pins from "../templates/pins.json";

test("every pinned action is a full commit sha", () => {
  for (const [name, pin] of Object.entries(pins)) {
    expect(pin.sha, name).toMatch(/^[0-9a-f]{40}$/);
  }
});
