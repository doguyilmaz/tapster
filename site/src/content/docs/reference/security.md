---
title: "Security"
description: "Where each key lives, who can use it and what stops a stolen one."
sidebar:
  order: 3
---

tapster has no server and no account. It is a command you run on your computer and a GitHub Action that runs in your
hub. Your keys go from your computer to your own GitHub repository or Cloudflare account and nowhere else. No one else,
including tapster's author, ever receives them.

tapster's own code does use the keys: inside your hub's runs, at the exact commit your hub workflow pins. A newer
tapster reaches them only after you run `tapster init --workflow` and push the result.

## Where each key lives

| Key | Where it is stored | Who can use it |
| --- | --- | --- |
| Developer ID certificate (`.p12`) and its password | Secrets of your hub's `tapster` environment | Hub workflows on `main` |
| App Store Connect API key (`.p8`) | Secrets of your hub's `tapster` environment | Hub workflows on `main` |
| tapster App private key | Secret of your hub's `tapster` environment | Hub workflows on `main` |
| Sparkle key of each app | Secret of the `tapster` environment and your login keychain | Only the step that signs the feed |
| Linux signing key | Secret of the `tapster` environment and your login keychain | Only the job that signs packages |
| Doorbell App private key | Secret of your Cloudflare Worker | The Worker |
| Tag key (with `--auto-tag`) | Secret of the project's `release` environment | The project's workflows on its default branch |

Your projects hold no signing keys. They build, attest and open a draft release.

tapster reads each key once while you set it up and hands it to the GitHub CLI through standard input. The GitHub CLI
encrypts it for your repository before it leaves your computer. The doorbell's key goes to your Cloudflare account the
same way, through Cloudflare's Wrangler. tapster does not print keys, keep copies in files or put
them on a command line. Keys that tapster
creates for you (Sparkle and Linux) also stay in your login keychain, because GitHub never gives a secret back. macOS
asks you before any app reads them from there.

## What stops a stolen key

The tapster App can write releases to your projects. If someone stole its key, they could try to tag code and have your
hub sign it. Several checks stop that:

- **Only you can tag.** `tapster add` gives each project rulesets so that only you can create, move or delete its tags
  and branches. With `--auto-tag`, a deploy key that only the default branch's workflows can read may push tags and
  branches too.
- **The draft must come from the project.** The hub signs a draft only when its tag exists and the draft was opened by
  the project's own workflow or by you. Every file in it must have been uploaded the same way.
- **Every file must match.** Each file must match `checksums.txt`. A public project must also attest its files in its
  own release workflow. The hub verifies that attestation before signing. It checks the files once more right before
  it publishes.
- **The hub watches itself.** tapster runs only from the hub workflow on `main`. It stops when the App is installed on
  the hub. It also stops when a file on `main` changed after your last push, unless the hub wrote it itself: casks,
  Scoop manifests and its state. Your next push marks `main` as reviewed again.

A draft the hub refuses is never signed. See [Troubleshooting](/reference/troubleshooting/#on-a-draft) for how it tells
you.

## What runs next to a key

- The jobs that hold keys run tapster's code, GitHub's own actions pinned by commit and, for Linux packages, signing
  tools installed from Ubuntu. The hub does not run Homebrew.
- The job that attests runs apart from the jobs that sign.
- The hub reaches each project with a token limited to that one repository and revokes it when the work is done.
- The Sparkle key reaches only the step that signs the feed. The hub refuses a Sparkle key whose public half differs
  from the one your installed apps trust.
- The job that builds Linux packages has no key. The job that signs them rebuilds what each package must contain and
  refuses anything else.
- The check job's own token can only read the hub's files and issues.
- The report job holds no keys. Its token may write the hub's issues and nothing else. It opens, edits and closes one
  issue, `tapster: the hub needs attention`. The findings reach it as an input of tapster's step, never through a shell.
- The doorbell's App may only start the hub's workflow. The Worker accepts only GitHub's own tokens from your
  repositories, made for its address.

## The setup page

`tapster setup` serves its page from your computer, on `127.0.0.1` only.

- The link it opens holds a code that works once. The page trades it for a session token that lives in that browser tab.
  A copy of the link in your browser history, your terminal or another program's view of the command line is worthless
  once used. If a link is used twice, tapster ends every session and prints a fresh link.
- Every request needs that token in a header. Another site open in your browser cannot send it. The page answers only
  requests addressed to `127.0.0.1` or `localhost` on its port.
- Files you drop, such as the `.p12` and the `.p8`, stay in memory until tapster stores them as secrets through the
  GitHub CLI. Apple's notary tool needs a file, so the `.p8` sits in a private temporary folder during that check only.
- Reading a project clone runs none of its git hooks or filters. **Commit** and **Push** run your own git setup, as if you
  typed the commands.
- Before it writes to the hub's `main`, tapster runs the hub's own check: if someone else changed `main` since your last
  push, it stops, because a write from you would mark their commits as reviewed.

## How tapster checks itself

On every change, tapster's own CI runs each stage with known fake credentials: the success path, GitHub errors, a broken
certificate and a rejected signature. It searches every log line for the fake values, in plain text and encoded. A
second run uses them as real secrets and fails if a tapster step prints anything the runner had to hide.

[`tapster doctor`](/reference/commands/#tapster-doctor) checks the settings this page depends on.
