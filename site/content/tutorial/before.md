---
title: Before you start
section: Tutorial
order: 1
step: 1
description: What you need to set up a tapster hub and what you will have at the end.
---

At the end of this tutorial you have:

- a **hub**: your Homebrew tap, which signs, notarizes and publishes releases;
- one **project** that releases through it;
- a release that anyone can install with `brew install`.

## What you need

- **A personal GitHub account.** tapster serves repositories of a personal account, not of an organization.
- **Bun and the GitHub CLI** on your computer:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  brew install gh
  gh auth login
  ```

- **A project to publish:** a Go tool built with GoReleaser, a command line tool written for Bun or a Mac app that
  updates with Sparkle.
- **For macOS builds, an Apple Developer Program membership and a Mac.** Without them your hub can still publish Linux
  and Windows builds. The next step shows how to get the two Apple files.

You do not install tapster. Every command in this tutorial runs the latest release with `bunx`:

```sh
bunx @doguyilmaz/tapster --version
```

> [!SEE]
> `tapster 1.0.0 (61cd09df0198)` or a newer version.

## Your tap becomes the hub

A Homebrew tap is a GitHub repository whose name starts with `homebrew-`, such as `you/homebrew-tap`. Users add it with
`brew tap you/tap`. tapster turns that repository into your hub. If you have no tap yet, create one:

```sh
gh repo create homebrew-tap --public --clone
```

Keep the hub **public**. GitHub gives public repositories free macOS runners, which signing needs. It also gives them
the protected environment that holds your keys. A private hub needs GitHub Pro. Its runs use your plan's Actions minutes.

## Where things run

There are only two places:

1. **Your computer** runs the `tapster` command while you set things up.
2. **Your hub's GitHub Actions** run tapster for each release.

> [!KEYS]
> tapster has no server. Your keys go from your computer to your own GitHub repository. If you add the doorbell, one key
> also goes to your own Cloudflare account. No one else, including tapster's author, ever receives them.
