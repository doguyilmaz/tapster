import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test("the action carries what the Marketplace needs", () => {
  const meta = parse(readFileSync("action.yml", "utf8")) as { name: string; description: string; author: string; branding: { icon: string; color: string } };
  expect(meta.name).toBe("Tapster Release Hub");
  expect(meta.description.length).toBeLessThanOrEqual(125);
  expect(meta.author).toBe("Dogu Yilmaz");
  expect(meta.branding).toEqual({ icon: "package", color: "orange" });
});
