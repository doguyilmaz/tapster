import { writeBplist } from "./bplist";
import { TapsterError } from "./errors";

export type DmgLayout = { window: [number, number, number, number]; icon_size: number; app: [number, number]; applications: [number, number] };

const real = ($real: number) => ({ $real });
const FREE = [6, 7, 8, 9, 10, 12, ...Array.from({ length: 17 }, (_, i) => 14 + i)];

function utf16be(s: string): Buffer {
  return Buffer.from(s, "utf16le").swap16();
}

function record(name: string, code: string, type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  return Buffer.concat([head, utf16be(name), Buffer.from(code + type, "latin1"), data]);
}

const blob = (data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};

function iloc([x, y]: [number, number]): Buffer {
  const b = Buffer.alloc(16, 0);
  b.writeUInt32BE(x, 0);
  b.writeUInt32BE(y, 4);
  Buffer.from("ffffffffffff0000", "hex").copy(b, 8);
  return b;
}

export function dsStore(layout: DmgLayout, appName: string): Buffer {
  const [left, top, right, bottom] = layout.window;
  if (right <= left || bottom <= top) throw new TapsterError("dmg.layout.window must be [left, top, right, bottom]", "Fix dmg.layout in tapster.yml.");
  const bwsp = writeBplist({
    ContainerShowSidebar: false,
    ShowPathbar: false,
    ShowSidebar: false,
    ShowStatusBar: false,
    ShowTabView: false,
    ShowToolbar: false,
    SidebarWidth: 0,
    WindowBounds: `{{${left}, ${top}}, {${right - left}, ${bottom - top}}}`,
  });
  const icvp = writeBplist({
    arrangeBy: "none",
    backgroundColorBlue: real(1),
    backgroundColorGreen: real(1),
    backgroundColorRed: real(1),
    backgroundType: 0,
    gridOffsetX: real(0),
    gridOffsetY: real(0),
    gridSpacing: real(100),
    iconSize: real(layout.icon_size),
    labelOnBottom: true,
    showIconPreview: true,
    showItemInfo: false,
    textSize: real(12),
    viewOptionsVersion: 1,
  });
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1);
  const records = [
    { name: ".", code: "bwsp", bytes: record(".", "bwsp", "blob", blob(bwsp)) },
    { name: ".", code: "icvp", bytes: record(".", "icvp", "blob", blob(icvp)) },
    { name: ".", code: "vSrn", bytes: record(".", "vSrn", "long", one) },
    { name: "Applications", code: "Iloc", bytes: record("Applications", "Iloc", "blob", blob(iloc(layout.applications))) },
    { name: appName, code: "Iloc", bytes: record(appName, "Iloc", "blob", blob(iloc(layout.app))) },
  ].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  const leafHead = Buffer.alloc(8);
  leafHead.writeUInt32BE(records.length, 4);
  const leaf = Buffer.concat([leafHead, ...records.map((r) => r.bytes)]);
  if (leaf.length > 0x2000) throw new TapsterError("the DMG layout does not fit one .DS_Store page", "Shorten the app name.");

  const file = Buffer.alloc(4 + 0x4000, 0);
  const put = (offset: number, ...words: number[]) => words.forEach((w, i) => file.writeUInt32BE(w, 4 + offset + i * 4));
  file.writeUInt32BE(1, 0);
  file.write("Bud1", 4, "latin1");
  put(4, 0x800, 0x800, 0x800);
  Buffer.from("0000100c000000870000200b00000000", "hex").copy(file, 4 + 0x10);
  put(0x20, 2, 0, records.length, 1, 0x1000);
  let p = 0x800;
  put(p, 3, 0, 0x80b, 0x25, 0x200d);
  p += 8 + 256 * 4;
  put(p, 1);
  p += 4;
  file[4 + p] = 4;
  file.write("DSDB", 4 + p + 1, "latin1");
  p += 5;
  put(p, 1);
  p += 4;
  for (let i = 0; i < 32; i++) {
    if (FREE.includes(i)) {
      put(p, 1, 2 ** i);
      p += 8;
    } else {
      put(p, 0);
      p += 4;
    }
  }
  leaf.copy(file, 4 + 0x2000);
  return file;
}
