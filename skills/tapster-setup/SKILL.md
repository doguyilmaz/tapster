---
name: tapster-setup
description: Set up a tapster release hub or add a project to one. Use when the user wants to sign, notarize and publish the releases of their Go (GoReleaser), Bun or Sparkle Mac app projects through their Homebrew tap, mentions tapster or asks to publish to Homebrew, Scoop, apt or dnf from one tap.
---

# Set up tapster

tapster turns the user's Homebrew tap into a hub that signs, notarizes and publishes the releases of their projects.
Projects build and open draft releases; the hub, a GitHub Actions workflow in the tap, does the rest. Docs:
https://tapster.doguyilmaz.com/

## Rules

- Never ask the user to paste a key, a password, a token or a `.p12`/`.p8` file into the chat. Never read those files
  yourself. The user enters them in tapster's own page or prompts, which store them in their GitHub account.
- Creating the GitHub App needs the user's click on GitHub. Apple files live on the user's computer. You cannot do these
  steps for them; tell them what to click or drop.
- tapster serves personal GitHub accounts, not organizations.

## Check first

1. `bun --version` (install from https://bun.sh if missing).
2. `gh auth status` (the GitHub CLI must be signed in; `gh auth login` if not, `gh auth refresh -s workflow` if the
   `workflow` scope is missing).
3. If the tapster MCP server is connected, call `hub_status` to see what is done.

## The easy way: the setup page

Ask the user to run, in their own terminal:

```sh
bunx @doguyilmaz/tapster setup
```

It opens a page served by their computer that walks through: choosing or creating the tap, protecting it, creating
the GitHub App, the Apple certificate and notary key (for macOS builds), writing the hub files and adding the projects
it finds on their computer. Each stop shows what it changes on GitHub. Help them read the page; do not try to drive it.

## The terminal way

In a clone of the tap: `bunx @doguyilmaz/tapster init` (it asks the same questions). In each project clone:
`bunx @doguyilmaz/tapster add` (options: `--auto-tag` for workflows that push their own tags, `--allow-dependabot`
to keep Dependabot's pull requests, `--workflow <file>` when GoReleaser runs in another workflow). Then the user
reviews and commits the changes, merges the pull request tapster opened on the hub and tags the release with the `gh`
command `tapster add` prints, which tags the default branch's latest commit on GitHub.

## After setup

- `bunx @doguyilmaz/tapster doctor` in a clone of the hub (or the MCP `doctor` tool) checks every setting.
- A release: in tapster setup, open the project under Projects and click Release. tapster tags the default branch's
  latest commit on GitHub (never a local clone, which can be behind) with the next patch version after the highest tag
  on GitHub. Setup starts the hub as soon as the draft opens. Without setup the hub publishes it
  on its next scheduled run, which GitHub can start hours late. The doorbell starts it right away (Optional extras in
  tapster setup or `tapster init --doorbell`).
- Problems with a release: use the tapster-releases skill.
