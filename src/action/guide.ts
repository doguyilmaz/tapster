import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { z } from "zod";

const FLOW = ".github/workflows/tapster.yml";

const payload = z.object({
  repository: z
    .object({
      full_name: z.string().optional(),
      private: z.boolean().optional(),
      owner: z.object({ type: z.string().optional() }).optional(),
    })
    .optional(),
});

const code = (s: string) => `\`${s.replace(/[`\r\n]/g, "")}\``;

function seen(repo: z.infer<typeof payload>["repository"], name: string, workflow: string, ref: string): string[] {
  const lines: string[] = [];
  const tap = /^homebrew-/i.test(name.split("/")[1] ?? "");
  lines.push(
    tap
      ? `${code(name)} is a tap: its name starts with \`homebrew-\`.`
      : `${code(name)} is not a tap: its name does not start with \`homebrew-\`. Use a repository such as \`you/homebrew-tap\` as the hub. The setup app can create one.`,
  );
  if (repo?.private === false) lines.push("It is public, so its runs get free macOS runners and the protected environment that holds your keys.");
  if (repo?.private === true) lines.push("It is private. A private hub needs GitHub Pro for the protected environment that holds your keys. Its runs use your plan's Actions minutes.");
  if (repo?.owner?.type === "User") lines.push("It belongs to a personal account, which tapster serves.");
  if (repo?.owner?.type === "Organization") lines.push("It belongs to an organization. tapster serves personal accounts only, so use a tap of your own account.");
  if (workflow) lines.push(`This run came from ${code(workflow)} on ${code(ref.replace(/^refs\/heads\//, ""))}.`);
  return lines;
}

export function guideText(event: unknown, env: Record<string, string | undefined>): { summary: string; notice: string } {
  const parsed = payload.safeParse(event);
  const repo = parsed.success ? parsed.data.repository : undefined;
  const name = repo?.full_name || env.GITHUB_REPOSITORY || "this repository";
  const [, workflow = "", ref = ""] = /^[^/]+\/[^/]+\/([^@]+)@(.+)$/.exec(env.GITHUB_WORKFLOW_REF ?? "") ?? [];
  const after =
    !workflow || workflow === FLOW
      ? "The setup replaces this workflow with the hub workflow."
      : `The setup writes the hub workflow to ${code(FLOW)}. After that, delete ${code(workflow)}.`;
  const summary = [
    "## tapster",
    "",
    "tapster turns a Homebrew tap into a release hub that signs, notarizes and publishes the releases of your projects. This run changes nothing. It only shows the way.",
    "",
    "### What this run sees",
    "",
    ...seen(repo, name, workflow, ref).map((l) => `- ${l}`),
    "",
    "### Next step",
    "",
    "Set up the hub on your computer, in one of two ways:",
    "",
    "- **The setup app:** run `bunx @doguyilmaz/tapster setup`. It opens a local page in your browser that walks you through every step.",
    "- **The terminal:** run `bunx @doguyilmaz/tapster init` in a clone of the tap.",
    "",
    "### Why the setup runs on your computer",
    "",
    "- Creating the GitHub App needs your click on GitHub.",
    "- Your Apple certificate and notary key are files on your computer.",
    "- Protecting the hub needs admin rights that the hub's workflow must never hold.",
    "",
    `${after} Your keys go only to your own GitHub account.`,
    "",
    "The tutorial explains every step: https://tapster.doguyilmaz.com/tutorial/before/",
    "",
  ].join("\n");
  const notice = "Set up this hub on your computer with bunx @doguyilmaz/tapster setup (or bunx @doguyilmaz/tapster init in a clone of the tap). The run summary explains why and how.";
  return { summary, notice };
}

export async function guide(env: Record<string, string | undefined> = process.env): Promise<void> {
  let event: unknown = null;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    event = null;
  }
  const { summary, notice } = guideText(event, env);
  core.notice(notice, { title: "tapster" });
  if (env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(summary).write();
}
