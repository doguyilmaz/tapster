export const REACH_TITLE = "tapster reach";

export const reachNote = (list: { name: string; reached: boolean }[]): string => list.map((r) => `${r.name}: ${r.reached ? "yes" : "no"}`).join(", ");

export function readReachNote(message: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!/^[a-z0-9][a-z0-9-]*: (yes|no)(, [a-z0-9][a-z0-9-]*: (yes|no))*$/.test(message)) return out;
  for (const m of message.matchAll(/([a-z0-9][a-z0-9-]*): (yes|no)/g)) out[m[1]!] = m[2] === "yes";
  return out;
}
