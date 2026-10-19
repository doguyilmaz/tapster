import { expect, test } from "bun:test";
import { parsePlist } from "../src/plist";
import { TapsterError } from "../src/errors";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- comment -->
  <key>CFBundleIdentifier</key><string>com.example.App</string>
  <key>CFBundleShortVersionString</key><string>1.4.1</string>
  <key>Name</key><string>A &amp; B &lt;x&gt; &#65;&#x42;</string>
  <key>Count</key><integer>-42</integer>
  <key>Ratio</key><real>1.5</real>
  <key>On</key><true/>
  <key>Off</key><false/>
  <key>Empty</key><string/>
  <key>List</key><array><string>a</string><dict/><array/></array>
  <key>Blob</key><data>
    aGk=
  </data>
</dict>
</plist>`;

test("reads XML plists", () => {
  expect(parsePlist(Buffer.from(xml))).toEqual({
    CFBundleIdentifier: "com.example.App",
    CFBundleShortVersionString: "1.4.1",
    Name: "A & B <x> AB",
    Count: -42,
    Ratio: 1.5,
    On: true,
    Off: false,
    Empty: "",
    List: ["a", {}, []],
    Blob: Buffer.from("hi"),
  });
});

// /usr/bin/plutil -convert binary1 of { id: "com.example.App", n: 7, ok: true, list: ["x", 300], u: "ü" }
const binary = Buffer.from(
  "YnBsaXN0MDDVAQIDBAUGBwgLDFJpZFFuVGxpc3RSb2tRdV8QD2NvbS5leGFtcGxlLkFwcBAHogkKUXgRASwJYQD8CBMWGB0gIjQ2OTs+PwAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAABC",
  "base64",
);

test("reads binary plists", () => {
  expect(parsePlist(binary)).toEqual({ id: "com.example.App", n: 7, ok: true, list: ["x", 300], u: "ü" });
});

test.each([
  ["not a plist", Buffer.from("hello")],
  ["unclosed dict", Buffer.from('<plist version="1.0"><dict><key>a</key><string>b</string></plist>')],
  ["key without value", Buffer.from('<plist version="1.0"><dict><key>a</key></dict></plist>')],
  ["unknown tag", Buffer.from('<plist version="1.0"><script>x</script></plist>')],
  ["deep nesting", Buffer.from(`<plist version="1.0">${"<array>".repeat(100)}${"</array>".repeat(100)}</plist>`)],
  ["truncated binary", binary.subarray(0, 40)],
  ["binary with a bad offset table", Buffer.concat([binary.subarray(0, binary.length - 8), Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff])])],
  ["over 1 MiB", Buffer.alloc((1 << 20) + 1, 32)],
])("rejects %s", (_, data) => {
  expect(() => parsePlist(data)).toThrow(TapsterError);
});

test("binary plists that reference themselves are rejected", () => {
  // array object 0 whose only element is object 0
  const objects = Buffer.from([0xa1, 0x00]);
  const offsets = Buffer.from([8]);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(10n, 24);
  expect(() => parsePlist(Buffer.concat([Buffer.from("bplist00"), objects, offsets, trailer]))).toThrow(TapsterError);
});

test("an XML plist that declares another encoding is refused", () => {
  const body = '<plist version="1.0"><dict><key>a</key><string>b</string></dict></plist>';
  expect(() => parsePlist(Buffer.from(`<?xml version="1.0" encoding="UTF-7"?>${body}`))).toThrow(/UTF-8/);
  expect(() => parsePlist(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body)]))).toThrow(/UTF-8/);
  expect(parsePlist(Buffer.from(`<?xml version="1.0" encoding="utf-8"?>${body}`))).toEqual({ a: "b" });
  expect(parsePlist(Buffer.from(`\ufeff<?xml version='1.0'?>${body}`))).toEqual({ a: "b" });
});
