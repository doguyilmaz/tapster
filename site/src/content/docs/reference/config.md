---
title: "tapster.yml"
description: "Every key of the hub's tapster.yml."
sidebar:
  order: 2
---

`tapster.yml` sits at the root of your hub and lists the projects it publishes. `tapster init` creates it and
`tapster add` proposes each entry. The hub reads it from `main`. Unknown keys are errors. An entry with an error is
reported and skipped; the other entries still publish. `tapster doctor` shows every error.

```yaml
version: 1
tap: you/tap
linux: { maintainer: "Your Name <you@example.com>" }
packages:
  - name: mytool
    repo: you/mytool
    kind: go
    binaries: [mytool]
    assets:
      darwin-arm64: "mytool_{version}_darwin_arm64.tar.gz"
      darwin-amd64: "mytool_{version}_darwin_amd64.tar.gz"
      linux-amd64: "mytool_{version}_linux_amd64.tar.gz"
      windows-amd64: "mytool_{version}_windows_amd64.zip"
    completions: { zsh: completions/_mytool }
    scoop: true
    linux: true
```

YAML 1.2 rules apply: write `true` and `false`. `yes`, `no`, `on` and `off` are text.

## Top level

| Key | Required | What it is |
| --- | --- | --- |
| `version` | yes | Always `1`. |
| `tap` | yes | The tap's name as users type it, such as `you/tap`. |
| `linux` | for `linux: true` | `{ maintainer: "Name <address>" }`, the maintainer of every `.deb` and `.rpm`. Add `url` when the apt and dnf site lives elsewhere than `https://<you>.github.io/<hub>`. |
| `packages` | yes | The list of entries below. May be `[]`. |

## Every package

| Key | Default | What it is |
| --- | --- | --- |
| `name` | required | Lowercase letters, digits and `-`. Names the cask, the Scoop manifest and the Linux package. |
| `repo` | required | The project, `you/name`. It must belong to the hub's owner. |
| `kind` | `go` | `go`, `bun` or `app`. |
| `assets` | required | Platform to file name, with `{version}` for the version without its `v`. See [Platforms](#platforms). |
| `workflow` | `release.yml` | The project workflow that builds and attests the files. The hub checks attestations against it. |
| `description` | the repository's | The cask's description. Homebrew's rules apply, see [Descriptions](#descriptions). |
| `homepage` | the repository's page | The cask's and the Scoop manifest's homepage. |
| `license` | none | One SPDX identifier, such as `MIT`, for Scoop and the Linux packages. |
| `attestation` | `auto` | `auto` checks the build attestation of every file of a public project. `off` skips it. |
| `protection` | `on` | `on` refuses a project whose branches and tags are not protected. `dependabot` allows open `dependabot/...` branches, see [Dependabot](/guides/dependabot/). `off` turns the check off and warns on every run. |

## Command line tools

For `kind: go` and `kind: bun`.

| Key | Default | What it is |
| --- | --- | --- |
| `binaries` | required | Paths of the executables inside the archives. Each must be in every macOS archive. Every executable there must be listed. The hub signs and notarizes them. |
| `completions` | none | `{ bash, zsh, fish }`, paths of completion files inside the archives. |
| `scoop` | `false` | Write a Scoop manifest. Needs a `windows-*` asset. |
| `entitlements` | none | Extra signing entitlements, written in full: `com.apple.security.cs.` followed by `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables` or `disable-library-validation`. Bun tools get `allow-jit` by themselves. |
| `linux` | `false` | Build `.deb` and `.rpm` packages. Needs a `linux-*` asset and the top-level `linux`. See [apt and dnf](/guides/linux/). |
| `cask` | none | `uninstall` (`launchctl`, `quit`), `zap` (`trash` paths starting with `~/`) and `caveats` for the cask. |

## Mac apps

For `kind: app`. See [Mac apps with Sparkle](/guides/sparkle/).

| Key | Default | What it is |
| --- | --- | --- |
| `app` | required | The bundle's name, such as `MyApp.app`. The archive must hold only this bundle. |
| `bundle_id` | required | Must equal the app's `CFBundleIdentifier`. Nested code is identified below it. |
| `assets` | required | Exactly one `darwin-*` archive of the app. |
| `dmg` | required | `name` (such as `MyApp-{version}.dmg`), optional `volume`, `volume_icon` (a path inside the app) and `layout` (`window`, `icon_size`, `app`, `applications` in points). |
| `sparkle` | none | `key` (the label of the hub secret `SPARKLE_KEY_<LABEL>`), `public_key`, `feed` (default `appcast.xml`) and, during a key change, `next_key` and `next_public_key`. |
| `code` | none | Path inside the app to `{ identifier, entitlements }` for nested code. `{team}` in an entitlement becomes your Team ID. Entitlements not listed here are dropped. |
| `carry` | none | File name to `sha256:<digest>` for files every release keeps unchanged. |
| `cask` | none | As for tools, plus `binaries` (commands inside the app to link) and `auto_updates`. |

## Platforms

| Key | Signed by the hub | Goes to |
| --- | --- | --- |
| `darwin-universal` | yes | the cask, for every Mac |
| `darwin-arm64` | yes | the cask, Apple silicon |
| `darwin-amd64` | yes | the cask, Intel |
| `linux-amd64`, `linux-arm64` | no | the cask on Linux; `.deb` and `.rpm` with `linux: true` |
| `windows-amd64`, `windows-arm64` | no | the Scoop manifest with `scoop: true` |

macOS archives must be `.tar.gz`. A tool with only Windows builds gets a Scoop manifest and no cask.

## Descriptions

Homebrew refuses a description that:

- is empty or longer than 80 characters;
- starts with an article (`A`, `An`, `The`), a lowercase letter or the package name;
- names the platform (`macOS`, `Mac`);
- ends with a full stop;
- holds a symbol or emoji;
- says `command line` instead of `command-line`.

`tapster add` suggests a fix when it can.
