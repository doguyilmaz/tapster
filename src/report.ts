import * as core from "@actions/core";
import { TapsterError } from "./errors";
import { scrub } from "./mask";

export type Row = { item: string; result: "published" | "rendered" | "skipped" | "failed" | "waiting"; detail: string };

const rows: Row[] = [];

export const info = (msg: string) => core.info(scrub(msg));
export const warn = (msg: string) => core.warning(scrub(msg));

export function record(row: Row): void {
  const clean = { ...row, item: scrub(row.item), detail: scrub(row.detail) };
  rows.push(clean);
  info(`${clean.item}: ${clean.result}${clean.detail ? ` (${clean.detail})` : ""}`);
}

export function failure(item: string, err: unknown): void {
  const e =
    err instanceof TapsterError
      ? err
      : new TapsterError(
          `unexpected ${err instanceof Error ? err.name : "error"}`,
          "Re-run the workflow; if it fails again, open an issue with the run link.",
        );
  record({ item, result: "failed", detail: `${e.reason}. ${e.fix}` });
  core.error(scrub(`${item}: ${e.reason}`));
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
export const rowsForTests = () => rows;
export const resetReportForTests = () => {
  rows.length = 0;
};
