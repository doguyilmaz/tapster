---
title: Commands
section: Reference
order: 1
description: Every tapster command and option.
---

Run each command with `bunx @doguyilmaz/tapster <command>`. Every command takes `--help`.

## tapster init

Run it in a clone of your hub. It sets the hub up. Each option below adds or changes one part of it. Each step can
run again and skips what is done, so if `init` stops halfway, run it again. Every run also rewrites the hub workflow for
the tapster that runs it; review the diff before you push.

| Command | What it does |
| --- | --- |
| `init` | Protects the hub, creates its App, stores your Apple credentials and writes `tapster.yml`, the workflow and a README. See [Create the hub](/tutorial/hub). |
| `init --every <minutes>` | Sets how often the hub looks for drafts. The default is 10 minutes for a public hub and 60 for a private one. |
| `init --workflow` | Rewrites the hub workflow, pinned to the tapster that runs the command. See [Upgrade tapster](/guides/upgrade). |
| `init --tapster <commit>` | Pins the workflow to a specific tapster commit. Goes with `init` or `init --workflow`. |
| `init --sparkle <label> [--account <account>]` | Stores a Sparkle key from your login keychain in the hub. See [Mac apps with Sparkle](/guides/sparkle). |
| `init --sparkle <label> --new` | Makes a new Sparkle key, keeps it in your login keychain and stores it in the hub. |
| `init --linux` | Makes the key that signs the apt and dnf repositories and turns on GitHub Pages. See [apt and dnf](/guides/linux). |
| `init --doorbell` | Deploys the Worker that starts the hub when a project releases. See [Faster releases](/guides/doorbell). |
| `init --rotate app` | Stores a new private key for the hub's App. |
| `init --rotate certificate` | Stores a new Developer ID certificate. |
| `init --rotate notary` | Stores a new App Store Connect API key. |
| `init --rotate doorbell` | Gives the doorbell a new key and redeploys it with the hub's version and schedule. |
| `init --rotate linux` | Makes a new Linux key. The old one keeps signing next to it. |
| `init --rotate linux --finish` | Stops signing with the previous Linux key. |

See [Rotate a key](/guides/rotate) for when and how to rotate.

## tapster add

Run it in a clone of a project. It prepares the project's release workflow, protects the project and proposes it to the
hub. See [Add a project](/tutorial/project).

| Option | What it does |
| --- | --- |
| `--hub owner/repo` | The hub that publishes this project. `add` asks once and remembers it in the clone's git config. |
| `--workflow file.yml` | The workflow that runs GoReleaser, when it is not `release.yml`. |
| `--auto-tag` | Lets the project's release workflow push tags with a deploy key. See [Releases tagged by a workflow](/guides/auto-tag). |
| `--allow-dependabot` | Leaves branches named `dependabot/...` open so Dependabot can open pull requests. See [Dependabot](/guides/dependabot). |
| `--force` | Replaces an existing release workflow. |

## tapster doctor

Run it in a clone of your hub. It reads the hub as it is on GitHub's `main` branch and checks every setting its security
depends on. Each finding names the command that fixes it. It takes no options.

## tapster --version

Shows the version of tapster and the commit it pins hubs to.
