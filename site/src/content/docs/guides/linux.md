---
title: "apt and dnf"
description: "Publish Linux packages from your hub's GitHub Pages site."
sidebar:
  order: 4
---

Your hub can turn the Linux archives of a command line tool into `.deb` and `.rpm` packages. It serves them as apt and
dnf repositories from the hub's GitHub Pages site, signed with a key of your own.

## 1. Mark the tool in tapster.yml

In your hub's `tapster.yml`, name a maintainer once and set `linux: true` on each tool with Linux builds:

```yaml
linux: { maintainer: "Your Name <you@example.com>" }
packages:
  - name: mytool
    # the rest of the entry stays as it is
    linux: true
```

The project's releases must include Linux archives. tapster's Bun workflow builds them. With GoReleaser, keep `linux` in
the build's `goos` list.

## 2. Make the signing key

You need GnuPG (`brew install gnupg`). On Linux you also need `secret-tool`, so tapster can keep a copy of the key.
In a clone of your hub:

```sh
bunx @doguyilmaz/tapster init --linux
```

tapster makes the key, stores it in the hub and turns on GitHub Pages for the hub.

:::note[Where your keys go]{icon="padlock"}
The key is a secret of your hub's `tapster` environment. tapster also keeps it in your login keychain (or the Secret
Service on Linux), because GitHub never gives a secret back. Nothing else holds it.
:::

Commit and push `tapster.yml`.

## 3. Release

At the next release of the tool, the hub builds a `.deb` and an `.rpm` for each architecture from the published Linux
archives. A second job, the only one that holds the key, checks every package against those archives, signs the rpms
and the repository metadata and publishes the site.

:::tip[You should see]{icon="approve-check-circle"}
Your hub's Pages site, at `https://<you>.github.io/<hub>/`, shows the two commands users run to add the repository.
:::

## Rotate the key

```sh
bunx @doguyilmaz/tapster init --rotate linux
```

The new key signs next to the old one, so users can fetch it before the old one stops. Once they have had time to update,
stop signing with the old key:

```sh
bunx @doguyilmaz/tapster init --rotate linux --finish
```
