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
`homebrew_casks` (or `brews`) section: the description, homepage, license, shell completions, `uninstall launchctl`,
`zap trash` and caveats. Template values such as `{{ .Env.X }}` are left out.

Some things have no place in a tapster cask yet. Check for them before the switch-over release:

- **An `.app` inside a command line tool's archive.** The hub signs the binaries you list, not an app bundle next to
  them. The cask installs only the binaries.
- **Cask hooks** such as `postflight` or a `post install` command.
- **A release workflow that moves a branch** with the workflow's own token. `add` protects every branch of the
  project, so that step fails. Move the step to a tag or keep it on a branch that you push yourself.

A project that needs one of these keeps its own release for now.

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
