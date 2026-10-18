export type Finding = { line: number; kind: string };

const stamp = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;

export function bodyLines(log: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let header = false;
  for (const [i, raw] of log.split(/\r?\n/).entries()) {
    const text = raw.replace(stamp, "");
    if (text.startsWith("##[group]Run ")) header = true;
    else if (header && text.startsWith("##[endgroup]")) header = false;
    else if (!header) out.push({ line: i + 1, text });
  }
  return out;
}

export function encodings(canary: string): { kind: string; value: string }[] {
  const b = Buffer.from(canary, "utf8");
  const out = [
    { kind: "plain", value: canary },
    { kind: "hex", value: b.toString("hex") },
    { kind: "HEX", value: b.toString("hex").toUpperCase() },
    { kind: "url", value: encodeURIComponent(canary) },
  ];
  for (let shift = 0; shift < 3; shift++) {
    out.push({ kind: `base64+${shift}`, value: Buffer.concat([Buffer.alloc(shift, 65), b]).toString("base64").slice(4, -4) });
  }
  return out.filter((e) => e.value.length >= 8);
}

export function scanPlain(log: string, canaries: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const { line, text } of bodyLines(log)) {
    for (const canary of canaries) {
      const hit = encodings(canary).find((e) => text.includes(e.value));
      if (hit) {
        findings.push({ line, kind: hit.kind });
        continue;
      }
      for (let i = 0; i + 10 <= canary.length; i++) {
        if (text.includes(canary.slice(i, i + 10))) {
          findings.push({ line, kind: "fragment" });
          break;
        }
      }
    }
  }
  return findings;
}

export function scanMasked(log: string): Finding[] {
  return bodyLines(log)
    .filter(({ text }) => text.includes("***"))
    .map(({ line }) => ({ line, kind: "masked value printed" }));
}

export function missingStages(log: string, markers: string[]): string[] {
  const body = bodyLines(log).map((l) => l.text);
  return markers.filter((m) => !body.some((t) => t.includes(m)));
}
