import { TapsterError } from "./errors";

export type AppcastInput = {
  title: string;
  version: string;
  shortVersion: string;
  minimumSystemVersion: string;
  arm64Only: boolean;
  url: string;
  length: number;
  edSignature: string;
  pubDate: Date;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

export function rfc822(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

function check(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new TapsterError(`the appcast ${what} ${JSON.stringify(value)} is not valid`, "Check the app's Info.plist and tapster.yml.");
  return value;
}

const VERSION = /^\d+(\.\d+)*$/;

export function renderAppcast(i: AppcastInput): string {
  const title = check(i.title, /^[A-Za-z0-9 ._-]+$/, "title");
  const version = check(i.version, VERSION, "version");
  const short = check(i.shortVersion, VERSION, "short version");
  const minimum = check(i.minimumSystemVersion, /^\d+(\.\d+){0,2}$/, "minimum system version");
  const url = check(i.url, /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/releases\/download\/v[0-9A-Za-z.-]+\/[A-Za-z0-9._-]+$/, "download URL");
  const signature = check(i.edSignature, /^[A-Za-z0-9+/]{86}==$/, "signature");
  if (!Number.isSafeInteger(i.length) || i.length <= 0) throw new TapsterError("the appcast length is not valid", "Check the DMG.");
  return `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>${title}</title>
        <item>
            <title>${short}</title>
            <pubDate>${rfc822(i.pubDate)}</pubDate>
            <sparkle:version>${version}</sparkle:version>
            <sparkle:shortVersionString>${short}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>${minimum}</sparkle:minimumSystemVersion>
${i.arm64Only ? "            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>\n" : ""}            <enclosure url="${url}" length="${i.length}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
        </item>
    </channel>
</rss>
`;
}

const PREFIX = "<!-- sparkle-signatures:\n";

export function signFeed(feed: string, sign: (data: Buffer) => Buffer): string {
  const content = Buffer.from(feed, "utf8");
  return `${feed}${PREFIX}edSignature: ${sign(content).toString("base64")}\nlength: ${content.length}\n-->\n`;
}

export function extractFeed(signed: string): { content: Buffer; signature: string; length: number } {
  const data = Buffer.from(signed, "utf8");
  const start = data.lastIndexOf(PREFIX);
  if (start === -1) throw new TapsterError("the feed carries no signature", "Sign it with tapster.");
  const end = data.indexOf("-->", start + PREFIX.length);
  if (end === -1) throw new TapsterError("the feed signature block is not closed", "Sign it with tapster.");
  const block = data.subarray(start + PREFIX.length, end).toString("utf8");
  const field = (key: string) => block.split("\n").find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? "";
  return { content: data.subarray(0, start), signature: field("edSignature"), length: Number(field("length")) };
}
