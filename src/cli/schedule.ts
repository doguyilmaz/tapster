import { parse } from "yaml";
import { TapsterError } from "../errors";

export function cronFor(minutes: number): string {
  if (Number.isInteger(minutes) && minutes >= 5 && minutes < 60 && 60 % minutes === 0) return `7-59/${minutes} * * * *`;
  if (minutes === 60) return "7 * * * *";
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours > 1 && hours <= 24 && 24 % hours === 0) return `7 */${hours} * * *`;
  throw new TapsterError(`${minutes} minutes is not an interval tapster can schedule`, "Use 5, 10, 15, 20 or 30 minutes, or 60 minutes times a divisor of 24.");
}

export function everyFromFlow(text: string): number | null {
  const cron = (parse(text) as { on?: { schedule?: { cron?: string }[] } } | null)?.on?.schedule?.[0]?.cron;
  if (!cron) return null;
  const m = /^7-59\/(\d+) \* \* \* \*$/.exec(cron) ?? null;
  if (m) return Number(m[1]);
  if (cron === "7 * * * *") return 60;
  const h = /^7 \*\/(\d+) \* \* \*$/.exec(cron);
  return h ? Number(h[1]) * 60 : null;
}

export function workerCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  return minutes === 60 ? "0 * * * *" : `0 */${minutes / 60} * * *`;
}
