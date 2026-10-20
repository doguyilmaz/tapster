---
title: "Bun projects"
description: "The release workflow tapster writes for command line tools written for Bun."
sidebar:
  order: 2
---

A command line tool written for Bun needs a `package.json` with a `bin` entry and a `bun.lock`. `tapster add` writes
`.github/workflows/release.yml` for it.

## What the workflow does

It runs on tags like `v1.2.3` and `v1.2.3-rc.1`.

1. **Build**, with read access only: installs the dependencies from `bun.lock` and compiles the `bin` entry for five
   platforms with `bun build --compile`: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` and `windows-x64`. It
   packs each into `mytool_<version>_<os>_<arch>.tar.gz` (`.zip` for Windows).
2. **Release**: writes `checksums.txt`, attests the archives and opens the draft with `gh release create --draft`. Tags
   with a `-` become prereleases.
3. **Ring the tapster hub**, for the [doorbell](/guides/doorbell/).

The hub entry names those five archives and sets `scoop: true` for the Windows build. The hub signs the macOS binaries
with the JIT entitlement that Bun's runtime needs.

## Your own workflow

If the project already has a `release.yml` that opens a draft with `gh release create ... --draft`, tapster keeps it and
only adds the ring step. The hub entry then comes from the project's latest release, so run `tapster add` again after
the first draft. To replace your workflow with tapster's, run `tapster add --force`.

The hub needs the draft to hold `checksums.txt` and, for a public project, an attestation of each file made by that
workflow. See [Troubleshooting](/reference/troubleshooting/) if the hub waits for either.
