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
| `app` | none | An app at the top of every macOS archive, see [An app in a tool's archive](#an-app-in-a-tools-archive). |
| `cask` | none | `uninstall` (`launchctl`, `quit`), `zap` (`trash` paths starting with `~/`), `caveats` and `postflight` for the cask, see [A command after install](#a-command-after-install). |

### An app in a tool's archive

Some tools ship an app beside the binary, so macOS shows them with a name and an icon in Login Items, notifications
and privacy settings. Name it under `app`:

```yaml
version: 1
tap: you/tap
packages:
  - name: mytool
    repo: you/mytool
    binaries: [mytool]
    assets:
      darwin-universal: "mytool_{version}_darwin_universal.tar.gz"
    app:
      name: MyTool.app
      bundle_id: com.you.mytool
      binaries: [Contents/MacOS/mytool]
```

| Key | Default | What it is |
| --- | --- | --- |
| `app.name` | required | The app's folder at the top of the archive. |
| `app.bundle_id` | required | Must equal the app's `CFBundleIdentifier`. Nested code is identified below it. |
| `app.binaries` | none | Paths inside the app that the cask links as commands. A command linked from the app replaces the archive's binary of the same name. |
| `app.entitlements` | none | Entitlements for the app's main executable, from the same list as `entitlements`. The app gets none of the tool's, not even the Bun preset. |

The hub checks the app as it checks a Mac app, signs it inside out with the hardened runtime, notarizes it with the
binaries and staples it. Other code in the app gets no entitlements. The archive must hold no other
copy of the app, its symlinks must stay inside it and the app may not carry an update feed: Homebrew updates the
tool.

#### With Linux builds

A tool with an app may also map `linux-*` assets. Each Linux archive is a `.tar.gz` that holds the bare binaries and no
app. Its name may not contain the app's name. The hub signs the app in the macOS archives only and leaves the
Linux archives as they are. The cask keeps the app on macOS and links the bare binary on Linux:

```ruby
  on_macos do
    # sha256 and url of the macOS archives
    app "MyTool.app"
    binary "#{appdir}/MyTool.app/Contents/MacOS/mytool"

    uninstall launchctl: "com.you.mytool.agent"
  end
  on_linux do
    # sha256 and url of the Linux archives
    binary "mytool"
  end
```

`cask.uninstall` goes into `on_macos` with the app, because `launchctl` and `quit` exist only on macOS. Other
binaries, completions, `zap`, `caveats` and `postflight` stay outside the blocks and apply to both, so
`cask.postflight` must run one of `binaries`. The cask has no `depends_on :macos`, so Homebrew on Linux installs it. A tool with an app and no `linux-*` assets gets the same cask
as before.

### A command after install

```yaml
    cask:
      postflight: { binary: mytool, args: [setup, --quiet] }
```

After every install and upgrade Homebrew runs the command, one the cask links (one of `binaries` or `app.binaries`;
for a Mac app, one of `cask.binaries`), with up to 10 arguments of letters, digits and `._:=@%+,/-`. A failure does not
stop the install. Homebrew runs it in its sandbox: no network, no access to your home folder and a temporary `HOME`.
The cask renders it as `postflight_steps`, which needs Homebrew 7 or newer.

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
| `cask` | none | As for tools, plus `binaries` (commands inside the app to link) and `auto_updates`. A `postflight` command must be one of `binaries`. |

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
