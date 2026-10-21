---
title: "Commands"
description: "Every tapster command and option."
sidebar:
  order: 1
---

Run each command with `bunx @doguyilmaz/tapster <command>`. Every command takes `--help`.

## tapster setup

Opens the setup in your browser: choosing the hub, its protection, the GitHub App, the Apple credentials, the hub files,
the projects on your computer and the hub's health. Under **Optional extras** it also deploys the
[doorbell](/guides/doorbell/), makes the [apt and dnf](/guides/linux/) key and stores Sparkle keys. It does what `init`,
`add` and `doctor` do. It needs no clone of the hub. See [Create the hub](/tutorial/hub/).

| Option | What it does |
| --- | --- |
| `--no-open` | Prints the link instead of opening the browser. |
| `--port <port>` | Listens on another port than 8277. Password managers save entries per address, so keep one port. |
| `--tapster <commit>` | Pins the hub workflow to a tapster commit, for a tapster built from a checkout. |

The page runs on `127.0.0.1` only. The link it opens works once; press Enter in the terminal for a fresh one. It stops
with Ctrl+C, with **Close** on the page or after two hours without use.

## tapster init

Run it in a clone of your hub. Each option below adds or changes one part of it. `init` and `init --workflow` also
rewrite the hub workflow for the tapster that runs them; review the diff before you push.

| Command | What it does |
| --- | --- |
| `init` | Protects the hub, creates its App, stores your Apple credentials and writes `tapster.yml`, the workflow and a README. Each step can run again and skips what is done. See [Create the hub](/tutorial/hub/). |
| `init --every <minutes>` | Sets how often the hub looks for drafts: 5, 6, 10, 12, 15, 20 or 30 minutes. Longer intervals must be 60 minutes times a divisor of 24. The default is 10 for a public hub and 60 for a private one. |
| `init --workflow` | Rewrites the hub workflow, pinned to the tapster that runs the command. See [Upgrade tapster](/guides/upgrade/). |
| `init --tapster <commit>` | Pins the workflow to a specific tapster commit. Goes with `init` or `init --workflow`. |
| `init --sparkle <label> [--account <account>]` | Stores a Sparkle key from your login keychain in the hub. See [Mac apps with Sparkle](/guides/sparkle/). |
| `init --sparkle <label> --new` | Makes a new Sparkle key, keeps it in your login keychain and stores it in the hub. |
| `init --linux` | Makes the key that signs the apt and dnf repositories and turns on GitHub Pages. Needs GnuPG. See [apt and dnf](/guides/linux/). |
| `init --doorbell` | Deploys the Worker that starts the hub when a project releases, through Cloudflare's API. Asks for a Cloudflare API token with a hidden prompt. Set `CLOUDFLARE_API_TOKEN` to skip the prompt. See [Faster releases](/guides/doorbell/). |
| `init --rotate app` | Stores a new private key for the hub's App. |
| `init --rotate certificate` | Stores a new Developer ID certificate. |
| `init --rotate notary` | Stores a new App Store Connect API key. |
| `init --rotate doorbell` | Gives the doorbell a new key and redeploys it with the tapster you run and the hub's schedule. Asks for the token the same way. |
| `init --rotate linux` | Makes a new Linux key. The old one keeps signing next to it. |
| `init --rotate linux --finish` | Stops signing with the previous Linux key. |

See [Rotate a key](/guides/rotate/) for when and how to rotate.

## tapster add

Run it in a clone of a project. It prepares the project's release workflow, protects the project and proposes it to the
hub. See [Add a project](/tutorial/project/).

| Option | What it does |
| --- | --- |
| `--hub owner/repo` | The hub that publishes this project. `add` asks once and remembers it in the clone's git config. |
| `--workflow file.yml` | The workflow that runs GoReleaser, when it is not `release.yml`. |
| `--auto-tag` | Lets the project's release workflow push tags with a deploy key. See [Releases tagged by a workflow](/guides/auto-tag/). |
| `--allow-dependabot` | Leaves branches named `dependabot/...` open so Dependabot can open pull requests. See [Dependabot](/guides/dependabot/). |
| `--force` | Replaces an existing release workflow. |

## tapster doctor

Run it in a clone of your hub. It reads the hub as it is on GitHub's `main` branch and checks every setting its security
depends on. Each finding names the command that fixes it. It takes no options.

## tapster mcp

Serves tapster's tools to an AI assistant over MCP, on stdin and stdout. See
[Use tapster with an AI assistant](/guides/ai/). It takes no options.

## tapster --version

Shows the version of tapster and the commit it pins hubs to.
