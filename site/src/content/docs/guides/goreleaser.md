---
title: "Move a GoReleaser project"
description: "Hand signing, notarization and the cask of a GoReleaser project over to the hub."
sidebar:
  order: 1
---

A Go project that releases with GoReleaser keeps doing so. `tapster add` changes it so that GoReleaser builds and
opens a draft. The hub does what needs keys: signing, notarization and the cask.

## What add changes

In `.goreleaser.yaml`:

```yaml
release:
  draft: true                      # the hub publishes after signing
checksum:
  name_template: checksums.txt     # the name the hub reads
# removed: notarize, homebrew_casks, brews, scoops
```

In the workflow that runs `goreleaser/goreleaser-action` (`release.yml` unless you pass `--workflow ci.yml`):

- the `MACOS_*` and `HOMEBREW_TAP_*` variables leave the GoReleaser step;
- the job gets `contents: write`, `id-token: write` and `attestations: write`;
- a step named **Attest the archives for tapster** attests the files listed in `dist/checksums.txt`;
- a step named **Ring the tapster hub** follows, for the [doorbell](/guides/doorbell/).

When you name another workflow with `--workflow`, the hub entry records it, because the hub checks which workflow made
each attestation.

## What moves into the hub entry

The hub writes the cask from its own entry in `tapster.yml`. `add` fills that entry from GoReleaser's
`homebrew_casks` (or `brews`) section. Template values such as `{{ .Env.X }}` are left out.

| In GoReleaser | In the hub entry |
| --- | --- |
| `description`, `homepage`, `license` and `completions` | the same keys |
| `custom_block` with `app "MyTool.app"` | `app.name` |
| `binaries` under `#{appdir}/MyTool.app/` | `app.binaries` |
| `uninstall` with `launchctl` and `quit` | `cask.uninstall` |
| `zap` with `trash` | `cask.zap` |
| `caveats` | `cask.caveats` |
| `hooks.post.install` that runs one of the tool's commands | `cask.postflight` |

The app's bundle id comes from an `Info.plist` in the project that names the app. tapster lists what it does not
carry, such as other hooks or other lines of `custom_block`. A hook is carried only in this form:

```ruby
system_command "#{HOMEBREW_PREFIX}/bin/mytool", args: ["setup"], must_succeed: false
```

The new cask runs it as Homebrew's `postflight_steps`, in Homebrew's sandbox: without network or your home folder. A
command that needs them does nothing there, so let the tool do that work the next time it runs. See
[`tapster.yml`](/reference/config/#a-command-after-install).

When the archive holds an app, the hub signs, notarizes and staples it. A build hook that signed or notarized the app
with the old secrets must now sign it ad hoc only:

```sh
codesign --force --sign - dist/MyTool.app
```

## Archive names

The hub needs to know the archive of each platform. tapster takes the names from the project's latest release. A
project with no release yet gets GoReleaser's default names:

```yaml
    assets:
      darwin-arm64: "mytool_{version}_darwin_arm64.tar.gz"
      darwin-amd64: "mytool_{version}_darwin_amd64.tar.gz"
      linux-amd64: "mytool_{version}_linux_amd64.tar.gz"
```

macOS archives must be `.tar.gz`. Windows builds may stay `.zip`; with them the entry also gets `scoop: true`. A
project with `universal_binaries` gets one `darwin-universal` archive. If you set your own `name_template` for archives
and have no release yet, tapster cannot guess the names: run `tapster add` again after the first draft.

## A branch that follows releases

A release workflow that moves a branch after GoReleaser, for example so that a site deploys from it, fails after
`tapster add`: the project's rules let only you move branches. `tapster add` names such a step. Instead:

1. Run `tapster add --auto-tag`. It makes a deploy key that only the default branch's workflows can use and lets
   deploy keys pass the rules. See [workflow tags](/guides/auto-tag/).
2. Remove the step and add a workflow that moves the branch once the hub has published:

```yaml
name: Follow releases
on:
  release: { types: [published] }
  workflow_dispatch:
permissions: {}
jobs:
  dispatch:
    if: github.event_name == 'release'
    runs-on: ubuntu-24.04
    permissions: { actions: write }
    steps:
      - run: gh workflow run follow.yml --repo "$GITHUB_REPOSITORY" --ref main
        env: { GH_TOKEN: "${{ github.token }}" }
  move:
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    environment: release
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<commit> # <version>
        with: { ssh-key: "${{ secrets.TAPSTER_TAG_KEY }}", fetch-depth: 0 }
      - name: Move the release branch to the latest release
        env: { GH_TOKEN: "${{ github.token }}" }
        run: |
          tag=$(gh release view --repo "$GITHUB_REPOSITORY" --json tagName --jq .tagName)
          git push origin "$(git rev-parse "$tag^{commit}"):refs/heads/release"
```

Save it as `.github/workflows/follow.yml`. The hub publishes with its App, which starts the `dispatch` job. That job
runs on the tag, which the `release` environment does not admit, so it starts `move` on `main`. `move` reads the
latest published release itself, so the branch never runs ahead of what users can install.

Without a workflow you can push the branch yourself with the tag:
`git push origin v1.2.3 "v1.2.3^{commit}:refs/heads/release"`. The site then goes live before the hub publishes.

## The switch-over release

1. Run `tapster add`, merge the hub's pull request and push the project's changes, as in
   [Add a project](/tutorial/project/).
2. Push the next tag. GoReleaser opens a draft and the hub publishes it.
3. The hub writes `Casks/mytool.rb`. If GoReleaser wrote the cask to the same tap before, the hub's version replaces
   it. If GoReleaser wrote a formula (`brews`), delete `Formula/mytool.rb` from the tap: Homebrew installs a formula
   before a cask of the same name.
4. Once the release is published, delete the secrets the project no longer needs. `tapster add` lists them:

   ```sh
   gh secret delete MACOS_SIGN_P12 --repo you/mytool
   gh secret delete HOMEBREW_TAP_GITHUB_TOKEN --repo you/mytool
   ```

:::note[Where your keys go]{icon="padlock"}
After the switch, the project holds no certificate, no notary key and no token for the tap. `tapster doctor` checks
that each project holds no release secrets.
:::
