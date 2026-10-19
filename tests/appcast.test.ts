import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AppcastInput, extractFeed, renderAppcast, rfc822, signFeed } from "../src/appcast";
import { decodeSparkleKey } from "../src/sparkle-key";
import { TapsterError } from "../src/errors";

const input: AppcastInput = {
  title: "HafifPix",
  version: "1.3.1",
  shortVersion: "1.3.1",
  minimumSystemVersion: "15.0",
  arm64Only: true,
  url: "https://github.com/doguyilmaz/hafifpix/releases/download/v1.3.1/HafifPix-1.3.1.dmg",
  length: 7109861,
  edSignature: "CNq1TFCHO9e/qHtH5qomJ2Z4Saush6JfQ+jNX7TmGOCOU7MaPOsNd2cqk9hy6MsxL5jxdWTXlKcGXtjK/9dgAw==",
  pubDate: new Date("2026-08-11T03:40:26Z"),
};

test("the appcast matches what generate_appcast writes today", () => {
  expect(renderAppcast(input)).toBe(readFileSync(new URL("./golden/hafifpix.appcast.xml", import.meta.url), "utf8"));
  expect(renderAppcast({ ...input, arm64Only: false })).not.toContain("hardwareRequirements");
});

test.each([
  ["a title with markup", { title: "A<b>&c" }],
  ["a prerelease version", { version: "1.3.1-beta" }],
  ["a short version with letters", { shortVersion: "1.3a" }],
  ["a minimum system with spaces", { minimumSystemVersion: "15 .0" }],
  ["a url outside GitHub releases", { url: "https://example.com/x.dmg" }],
  ["a signature that is not base64", { edSignature: "x\"/><evil" }],
])("refuses %s", (_, change) => {
  expect(() => renderAppcast({ ...input, ...change })).toThrow(TapsterError);
});

test("a signed feed passes Sparkle's extraction rule and verifies", () => {
  const key = decodeSparkleKey(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64"));
  const feed = renderAppcast(input);
  const signed = signFeed(feed, (b) => key.sign(b));
  expect(signed.startsWith(feed)).toBe(true);
  expect(signed.endsWith("-->\n")).toBe(true);
  const { content, signature, length } = extractFeed(signed);
  expect(content.toString("utf8")).toBe(feed);
  expect(length).toBe(Buffer.byteLength(feed));
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.publicKey, "base64")]), format: "der", type: "spki" });
  expect(verify(null, content, pub, Buffer.from(signature, "base64"))).toBe(true);
});

test("dates are RFC 822 in UTC", () => {
  expect(rfc822(new Date("2026-10-19T00:05:09Z"))).toBe("Mon, 19 Oct 2026 00:05:09 +0000");
});
