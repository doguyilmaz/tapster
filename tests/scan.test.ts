import { expect, test } from "bun:test";
import { bodyLines, encodings, scanMasked, scanPlain } from "./leak/scan";

const canary = "CANARY-p12-password-7f3a9c2e1b";
const log = (...lines: string[]) => lines.map((l, i) => `2026-10-18T10:00:0${i}.0000000Z ${l}`).join("\n");

test("finds a canary in plain text, base64 at any offset, hex and fragments", () => {
  const b64 = (shift: number) => Buffer.concat([Buffer.alloc(shift, 65), Buffer.from(canary)]).toString("base64");
  for (const leaked of [canary, b64(0), b64(1), b64(2), Buffer.from(canary).toString("hex"), encodeURIComponent(canary), "x password-7f3a9c y"]) {
    expect(scanPlain(log("ok", leaked), [canary]).length).toBeGreaterThan(0);
  }
  expect(scanPlain(log("nothing here"), [canary])).toEqual([]);
});

test("step headers are not scanned", () => {
  const text = log("##[group]Run doguyilmaz/tapster@abc", "env:", `  MACOS_SIGN_PASSWORD: ${canary}`, "##[endgroup]", "tapster: done");
  expect(bodyLines(text).map((l) => l.text)).toEqual(["tapster: done"]);
  expect(scanPlain(text, [canary])).toEqual([]);
});

test("masked runs flag any *** outside headers", () => {
  expect(scanMasked(log("##[group]Run x", "  MACOS_SIGN_P12: ***", "##[endgroup]", "fine"))).toEqual([]);
  expect(scanMasked(log("aims: failed (token ***)"))).toEqual([{ line: 1, kind: "masked value printed" }]);
});

test("encodings are long enough to be meaningful", () => {
  for (const e of encodings(canary)) expect(e.value.length).toBeGreaterThanOrEqual(8);
});
