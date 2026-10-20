---
name: tapster-releases
description: Find out why a release published through a tapster hub did not appear, why a draft waits or what the hub's issue "tapster: the hub needs attention" means. It also says what to do. Use when the user pushed a tag and nothing happened, sees a draft that stays a draft or got a health issue from their hub.
---

# Diagnose a tapster release

A project's release workflow builds the files and opens a **draft** release with `checksums.txt`. The hub's `tapster`
workflow checks the draft, signs and notarizes macOS code, publishes the release and writes the cask, Scoop manifest
and apt and dnf repositories. When the hub refuses a draft it writes the reason at the top of the draft's notes.

## Look in this order

With the tapster MCP server connected, use its tools; otherwise use `gh`.

1. **The draft.** MCP `release_status` with the project's `owner/name`. Without MCP: `gh release view <tag> --repo <repo>`.
   A `hubNote` (or a quoted "tapster will not publish this draft" line in the notes) is the hub's reason. No draft at
   all means the project's release workflow failed: `gh run list --repo <repo> --workflow release.yml`.
2. **The hub's runs.** MCP `hub_runs`. Without MCP: `gh run list --repo <hub> --workflow tapster.yml`. No run in the last day
   means the schedule did not fire; MCP `run_hub` or `gh workflow run tapster.yml --repo <hub>` starts one. A failed
   run's summary table names each item and its fix.
3. **The hub's health.** MCP `hub_status` shows the open health issue; `doctor` lists every failing setting with its
   fix.

## Common reasons

- "is not protected against a stolen App key": the project lost its rulesets; run `bunx @doguyilmaz/tapster add` in
  its clone again.
- "the hub's App is not installed on": install the App on the project, from tapster setup (Projects) or with the link
  that `tapster add` prints.
- "no attestation yet": the project's workflow did not attest the files; the draft waits up to an hour.
- "the Developer ID certificate expires on": renew it at developer.apple.com, then replace it in tapster setup
  (Apple certificate) or with `tapster init --rotate certificate`.
- "the hub changed in ways only you may change it": someone else pushed to the hub's `main`; review and revert those
  commits.
- "tapster vX is out": update the hub workflow in tapster setup (Hub files) or with `tapster init --workflow`.

The full list is at https://tapster.doguyilmaz.com/reference/troubleshooting/. Never ask the user for their keys; every
fix that needs a key runs in tapster's own page or prompts.
