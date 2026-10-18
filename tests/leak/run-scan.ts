import { missingStages, scanMasked, scanPlain } from "./scan";

const repo = process.env.SCAN_REPO ?? process.env.GITHUB_REPOSITORY!;
const run = process.env.SCAN_RUN_ID ?? process.env.GITHUB_RUN_ID!;
const token = process.env.GH_TOKEN!;
const canaries = (process.env.PLAIN_CANARIES ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const stages = JSON.parse(process.env.EXPECT_STAGES ?? "{}") as Record<string, string[]>;
const api = (path: string, accept = "application/vnd.github+json") =>
  fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" } });

const jobs = ((await (await api(`/repos/${repo}/actions/runs/${run}/jobs?per_page=100`)).json()) as { jobs: { id: number; name: string }[] }).jobs;
if (jobs.length === 0) throw new Error("no jobs found for this run");
let failures = 0;
for (const job of jobs) {
  const plain = job.name.startsWith("plain");
  const masked = job.name.startsWith("masked") || process.env.SCAN_ALL_MASKED === "1";
  if (!plain && !masked) continue;
  const res = await api(`/repos/${repo}/actions/jobs/${job.id}/logs`, "application/vnd.github.v3.raw");
  const log = await res.text();
  const findings = plain ? scanPlain(log, canaries) : scanMasked(log);
  for (const f of findings) console.log(`LEAK ${job.name} line ${f.line}: ${f.kind}`);
  const missing = missingStages(log, stages[job.name] ?? []);
  for (const m of missing) console.log(`STAGE NOT REACHED ${job.name}: ${m}`);
  failures += missing.length;
  console.log(`${job.name}: ${findings.length === 0 ? "clean" : `${findings.length} finding(s)`}`);
  failures += findings.length;
}
process.exit(failures === 0 ? 0 : 1);
