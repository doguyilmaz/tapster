---
title: "Troubleshooting"
description: "What the messages you are most likely to meet mean and what to do."
sidebar:
  order: 4
---

tapster says what went wrong and, on the next line, what to do. This page adds the why for the messages people meet
most. Start with [`tapster doctor`](/reference/commands/#tapster-doctor) in your hub clone.

## In tapster setup

| Message | What to do |
| --- | --- |
| `tapster setup` prints the list of commands instead of opening the page | An older tapster installed with Homebrew comes first on your PATH; `bunx` runs it. Run `brew upgrade --cask tapster` or start the latest with `bunx @doguyilmaz/tapster@latest setup`. |
| `bunx` says `@doguyilmaz/tapster@1.2.3 failed to resolve` right after a release | Bun still holds the package list it read before the release. Run `bun pm cache rm` once or install with `brew upgrade --cask tapster`. |
| `Port 8277 is in use` (in the terminal) | Another tapster setup may be open; use that one or stop it. The new one uses another port. Your password manager may not offer the entries it saved for 8277. |
| `Open tapster setup from your terminal` | The page has no session, for example after you closed its tab. Press Enter in the terminal where tapster setup runs for a fresh link. |
| `this link was already used` | Someone opened the same link twice, so tapster ended every session. Open the fresh link the terminal printed. |
| `Allow gh to change workflows` | Run the command the page shows, `gh auth refresh -s workflow`. The page continues by itself. |
| `main changed in ways only you may change it` | Someone else pushed to the hub. Review those commits on GitHub and revert what you did not make, then write the hub files again. |
| `git could not push without asking for a password or passphrase` | Push from a terminal in the project's folder; the page shows the command. |
| `... is outside your home folder` | tapster reads clones inside your home folder only. Move the clone or link it into your home folder. |

## The doorbell and the Linux key

tapster setup and `tapster init` show the same messages for these.

| Message | What to do |
| --- | --- |
| `Cloudflare did not accept that token` | Copy the token again. Cloudflare shows it once; if it is gone, create a new one from the token page tapster opens. |
| `the Cloudflare token lacks the Workers Scripts edit permission` | Create a new token from the token page tapster opens. It asks for **Workers Scripts: Edit**, the only permission the doorbell needs. |
| `Cloudflare shows the token no account` | The token reaches no account. Create it again and keep your account under **Account Resources**. |
| `the token reaches 2 Cloudflare accounts` | Create it again with only the account the doorbell should use under **Account Resources**. |
| `the Cloudflare account ... has no workers.dev subdomain yet` | Open the link in the message and pick a subdomain once, then try again. |
| `the doorbell App reaches ... besides <hub>` | Open the App's installation, choose **Only select repositories** and keep only the hub. The doorbell may start workflows only there. |
| `that key does not belong to the doorbell App` | Generate the key on the doorbell App's settings page, not on the hub App's. |
| `this setup holds no Cloudflare token` | tapster keeps the token for an hour at most. Paste it again; your password manager can fill it in. |
| `GnuPG is not installed` or `gpg is not installed` | Run `brew install gnupg`, then try again. |
| `the hub already has a Linux signing key` | The hub has its key. To replace it, run `tapster init --rotate linux`; see [Rotate the key](/guides/linux/#rotate-the-key). |
| `the maintainer is not Name <address>` | Write it like `Your Name <you@example.com>`. |

## In your terminal

| Message | What to do |
| --- | --- |
| `gh is not signed in` | Run `gh auth login`. tapster uses the GitHub CLI's own sign-in, not a `GH_TOKEN` variable. |
| `this folder is not a clone of a GitHub repository` | Run tapster inside the clone, where `git remote get-url origin` points at github.com. |
| `GitHub refused environments on this private hub` | Environments need a public hub or GitHub Pro. Make the hub public. |
| `the .p12 could not be opened with that password` | The password is the one you set when you exported the certificate. If you lost it, export again. |
| `the .p12 holds the certificate but not its private key` | Export from **My Certificates** on the Mac that holds the key. See [Get your Apple credentials](/tutorial/apple/). |
| `the certificate is "...", not a Developer ID Application certificate` | Apple Development and Developer ID Installer certificates cannot sign downloads. Create a Developer ID Application certificate. |
| `Apple rejected the notary key (HTTP 401)` | Check the `.p8` file, the Key ID and the Issuer ID. A revoked key also gives 401. |
| `no App was created within 30 minutes` | Run the command again. It starts a new page. |
| `<hub> has no App yet` | Run `tapster init` in the hub clone first, then `tapster add` again. |
| `.github/workflows/release.yml already exists` | Move your workflow aside. To replace it, run `tapster add --force`. |
| `no GoReleaser step found in the release workflow` | Name the workflow that runs GoReleaser: `tapster add --workflow ci.yml`. |
| `the hub would refuse this entry: ...` | Fix what the message names in the project, then run `tapster add` again. |
| `the hub already has a branch tapster-add-<name>` | Merge or delete that pull request on the hub, then run `tapster add` again. |

## On the hub's run

These stop a whole run. The run's summary names them.

| Message | What to do |
| --- | --- |
| `the hub changed in ways only you may change it: ...` | Someone else or a bot changed a file on `main` after your last push. Review those commits, revert what you did not make and push. Your push marks `main` as reviewed. If you did not expect them, rotate the App key. |
| `the App is not installed on any of your repositories` | Install the App on your projects. `tapster add` prints the link for each. |
| `GitHub shows no push by <you> to main` | Push a commit to the hub's `main` yourself. The hub runs only after a push of yours. |
| `the App is installed on the hub` | Remove the hub from the App's repositories at [github.com/settings/installations](https://github.com/settings/installations). The App must reach your projects only. |
| `tapster runs only from .github/workflows/tapster.yml on the hub's main branch` | Start the **tapster** workflow on `main`. Other workflows and branches never get the keys. |
| `the hub workflow was written for another tapster version` | Run `tapster init --workflow` in the hub clone, then commit and push. |
| `TAPSTER_APP_ID is not set` or another `... is not set` | The setup is not finished. Run `bunx @doguyilmaz/tapster setup` on your computer or `tapster init` in a clone of the hub. |

These stop one project. The others still publish:

| Message | What to do |
| --- | --- |
| `the hub's App is not installed on you/project` | Run `tapster add` in the project and open the install link it prints. |
| `you/project is not protected against a stolen App key: ...` | Run `tapster add` in the project. It restores the rules. |
| `<name> ships macOS code, but this hub has no Apple credentials` | Run `tapster init --rotate certificate` and `tapster init --rotate notary`. |
| `the Developer ID certificate expired on <date>` | Create a new certificate, then run `tapster init --rotate certificate`. |
| `<name> is invalid: ...` or `<name>: ...` | Fix the entry in `tapster.yml`. See [tapster.yml](/reference/config/). |

## The issue "tapster: the hub needs attention"

The hub checks itself on every run. When something needs you, it opens this issue in the hub and lists each finding
with its fix. It edits the issue when the findings change and closes it once all is well, so you never close it
yourself. Fix the findings with `bunx @doguyilmaz/tapster setup` (under Health) or `tapster doctor` in a clone of the
hub.

If the hub's issues are turned off, the run's summary says so instead. Turn them on in the hub's settings to get the
issue.

## On a draft

When the hub will not publish a draft, it writes the reason at the top of the draft's release notes and turns its run
red once. Later runs leave it alone until the reason changes. Fix the cause. If the files are wrong, delete the draft
and run the project's release workflow again.

| Reason | What to do |
| --- | --- |
| `the draft was created by ...` or `... was uploaded by ...` | The hub takes drafts and files only from the project's own workflow or from you. Delete the draft and release from the workflow. |
| `... does not match checksums.txt` | A file changed after `checksums.txt` was written. Build the release again. |
| `... is attached but not listed in checksums.txt` | Every file in the draft must be in `checksums.txt`. |
| `... has no valid build attestation from ...` | The file was not attested by the workflow the entry names. Check `workflow` in the entry and the attestation step of the project's release workflow. |
| `... holds ..., a Mach-O file not listed in binaries` | List every macOS executable of the archive under `binaries`. |
| `tag ... is not like v1.2.3` | Use tags such as `v1.2.3` or `v1.2.3-rc.1`. |
| `a release for this tag is already published; delete the draft` | Delete the extra draft. |
| `the app's version is ..., but the tag says ...` | Stamp both version keys of the app with the tag's version. |
| `SUPublicEDKey ... is not the key pinned in tapster.yml` | The app and its entry name different Sparkle keys. Installed copies would reject the update. |

## Drafts that wait

Some reasons only mean the draft is not ready yet. The hub tries again on every run and writes a note only after an
hour without a new upload, ending in `for more than an hour`:

| Reason | What it usually means |
| --- | --- |
| `assets are still uploading` or `... is not attached yet` | The project's workflow failed before it uploaded everything. Look at its run. |
| `no attestation yet for ...` | The attestation step did not run or failed. Look at the project's run. |
| `the tag is not pushed yet` | The draft names a tag that does not exist in the project. |

## Still stuck

Open an [issue](https://github.com/doguyilmaz/tapster/issues) with the message and the link to the run. Never paste a
key or a secret. tapster does not put them in its messages.
