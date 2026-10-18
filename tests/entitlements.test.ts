import { expect, test } from "bun:test";
import { checkEntitlements, mergeEntitlements, parseEntitlements, renderEntitlements } from "../src/entitlements";
import { parsePlist } from "../src/plist";
import { TapsterError } from "../src/errors";

const fromCodesign = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.network.client</key><true/><key>com.apple.security.application-groups</key><array><string>5MYT4VYJFC.group</string></array></dict></plist>`;

test("reads what codesign prints, including nothing", () => {
  expect(parseEntitlements(fromCodesign)).toEqual({
    "com.apple.security.network.client": true,
    "com.apple.security.application-groups": ["5MYT4VYJFC.group"],
  });
  expect(parseEntitlements("")).toEqual({});
  expect(parseEntitlements("  \n")).toEqual({});
});

test("only listed keys pass, and get-task-allow never does", () => {
  const found = parseEntitlements(fromCodesign);
  expect(() => checkEntitlements(found, ["com.apple.security.network.client"], "Contents/MacOS/App")).toThrow(TapsterError);
  expect(() => checkEntitlements(found, ["com.apple.security.network.client", "com.apple.security.application-groups"], "x")).not.toThrow();
  expect(() => checkEntitlements({ "com.apple.security.get-task-allow": true }, ["com.apple.security.get-task-allow"], "x")).toThrow(TapsterError);
});

test("values other than booleans, strings and string lists are refused", () => {
  const xml = '<plist version="1.0"><dict><key>a.b</key><integer>1</integer></dict></plist>';
  expect(() => parseEntitlements(xml)).toThrow(TapsterError);
});

test("config entitlements are added with the team filled in", () => {
  const merged = mergeEntitlements({ "com.apple.security.network.client": true }, { "com.apple.application-identifier": "{team}.com.example.Helper" }, "5MYT4VYJFC");
  expect(merged).toEqual({ "com.apple.security.network.client": true, "com.apple.application-identifier": "5MYT4VYJFC.com.example.Helper" });
});

test("the written plist round-trips and is escaped", () => {
  const e = { "z.key": ["a", "b"], "a.key": true, "m.key": "x" };
  const xml = renderEntitlements(e);
  expect(parsePlist(Buffer.from(xml))).toEqual(e);
  expect(xml.indexOf("a.key")).toBeLessThan(xml.indexOf("m.key"));
  expect(() => renderEntitlements({ "a.key": "<x>" })).toThrow(TapsterError);
  expect(() => renderEntitlements({ "bad key": true })).toThrow(TapsterError);
});
