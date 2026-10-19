import { expect, test } from "bun:test";
import { entitlementsFor, mergeEntitlements, parseEntitlements, renderEntitlements } from "../src/entitlements";
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
test("entitlements come only from config; the build cannot add one", () => {
  const p = { code: { "Contents/MacOS/Helper": { entitlements: { "com.apple.application-identifier": "{team}.com.o.B.Helper" } } } } as never;
  expect(entitlementsFor("Contents/MacOS/Helper", {}, p, "TEAM000001").entitlements).toEqual({ "com.apple.application-identifier": "TEAM000001.com.o.B.Helper" });
  expect(entitlementsFor("Contents/MacOS/Helper", { "com.apple.application-identifier": "TEAM000001.com.o.B.Helper" }, p, "TEAM000001").dropped).toEqual([]);
  expect(() => entitlementsFor("Contents/MacOS/Helper", { "com.apple.application-identifier": "OTHER.x" }, p, "TEAM000001")).toThrow(TapsterError);
  expect(() => entitlementsFor("Contents/MacOS/App", { "com.apple.security.network.client": true }, p, "TEAM000001")).toThrow(TapsterError);
  expect(entitlementsFor("Contents/MacOS/App", { "com.apple.security.get-task-allow": true }, p, "TEAM000001")).toEqual({ entitlements: {}, dropped: ["com.apple.security.get-task-allow"] });
});
