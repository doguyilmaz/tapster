import * as core from "@actions/core";
import { TapsterError } from "./errors";
import { scrub } from "./mask";

export type Row = { item: string; result: "published" | "rendered" | "skipped" | "failed" | "waiting"; detail: string };
export type Finding = { item: string; reason: string; fix: string };

const rows: Row[] = [];
const found: Finding[] = [];

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");
export const info = (msg: string) => core.info(oneLine(scrub(msg)));
export const warn = (msg: string) => core.warning(oneLine(scrub(msg)));

export function record(row: Row): void {
  const clean = { ...row, item: oneLine(scrub(row.item)), detail: oneLine(scrub(row.detail)) };
  rows.push(clean);
  info(`${clean.item}: ${clean.result}${clean.detail ? ` (${clean.detail})` : ""}`);
}

function addFinding(item: string, reason: string, fix: string): Finding {
  const f = { item: oneLine(scrub(item)), reason: oneLine(scrub(reason)), fix: oneLine(scrub(fix)) };
  found.push(f);
  return f;
}

export function concern(item: string, reason: string, fix: string): void {
  const f = addFinding(item, reason, fix);
  warn(`${f.item}: ${f.reason}. ${f.fix}`);
}

export function failure(item: string, err: unknown): void {
  const e =
    err instanceof TapsterError
      ? err
      : new TapsterError(
          `unexpected ${err instanceof Error ? err.name : "error"}`,
          "Re-run the workflow; if it fails again, open an issue with the run link.",
        );
  addFinding(item, e.reason, e.fix);
  record({ item, result: "failed", detail: `${e.reason}. ${e.fix}` });
  core.error(oneLine(scrub(`${item}: ${e.reason}`)));
}

export async function writeSummary(): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY || rows.length === 0) return;
  await core.summary
    .addHeading("tapster", 2)
    .addTable([
      [
        { data: "Item", header: true },
        { data: "Result", header: true },
        { data: "Detail", header: true },
      ],
      ...rows.map((r) => [r.item, r.result, r.detail]),
    ])
    .write();
}

export const failedCount = () => rows.filter((r) => r.result === "failed").length;
export const findings = (): Finding[] => [...found];
export const rowsForTests = () => rows;
export const resetReportForTests = () => {
  rows.length = 0;
  found.length = 0;
};
