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

test("the Marketplace snippet runs the guide: mode is optional, defaults to guide and no input takes a token", () => {
  const meta = parse(readFileSync("action.yml", "utf8")) as { inputs: Record<string, { description: string; required?: boolean; default?: string }> };
  expect(meta.inputs.mode!.required).toBe(false);
  expect(meta.inputs.mode!.default).toBe("guide");
  expect(meta.inputs.mode!.description).toContain("Leave it empty on first use");
  expect(Object.keys(meta.inputs).filter((k) => /token|key|secret/i.test(k))).toEqual([]);
});
