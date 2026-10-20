# tapster: an app inside a tool's archive, a post-install command and branch moves

Date: 2026-10-20 · Status: for implementation · Owner: Dogu Yilmaz

ebb (`doguyilmaz/ebb`) is a Go tool built with GoReleaser. Three things in its release keep it from moving to a hub:

1. **An app inside the tool's archive.** The universal archive holds the bare `ebb` binary and `ebb.app`, which
   `scripts/macapp.sh` builds around the same binary in a GoReleaser hook. macOS shows ebb with its icon in Login Items,
   notifications and privacy settings and keeps Full Disk Access across upgrades only when the background service runs
   from a signed app. The old cask installs `app "ebb.app"` and links `ebb` from inside it. Today the hub refuses the
   archive, because `ebb.app/Contents/MacOS/ebb` is a Mach-O file not listed in `binaries`. Listing it would sign the
   file but not the bundle and a CLI cask renders only `binary` lines.
2. **A cask hook.** After every install and upgrade the old cask runs
   `system_command "#{HOMEBREW_PREFIX}/bin/ebb", args: ["daemon", "restore"], must_succeed: false`, which sets the
   background service up again when the person had it on. `uninstall launchctl:` and `zap trash:` already map to
   `cask.uninstall` and `cask.zap`.
3. **A release workflow that moves a branch.** After GoReleaser it runs
   `gh api -X PATCH repos/$GITHUB_REPOSITORY/git/refs/heads/release` with the workflow's `GITHUB_TOKEN`, so Workers
   Builds deploys the hosted page from `release` and the page never runs ahead of the latest release. `tapster add`
   protects every branch so that only an admin (and, with `--auto-tag`, deploy keys) may move it, so this step fails.

## 1. An app inside a tool's archive

### Config

A `go` or `bun` package may name one app that sits at the top of every macOS archive:

```yaml
  - name: ebb
    repo: doguyilmaz/ebb
    binaries: [ebb]
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    app:
      name: ebb.app
      bundle_id: com.doguyilmaz.ebb
      binaries: [Contents/MacOS/ebb]
    cask:
      uninstall: { launchctl: [com.doguyilmaz.ebb] }
      zap: { trash: ["~/.config/ebb", "~/.local/state/ebb"] }
      postflight: { binary: ebb, args: [daemon, restore] }
```

- `app.name`: the folder at the top of the archive, as for `kind: app` (`^[A-Za-z0-9 ._-]+\.app$`).
- `app.bundle_id`: must equal the app's `CFBundleIdentifier`. It pins the identity the hub signs, so neither the
  project nor a stolen App key can choose it.
- `app.binaries`: paths inside the app that the cask links into the PATH, default none.

The config refuses: `app` without a `darwin-*` asset; `app` with a `linux-*` asset (the cask's `app` stanza is
macOS only; see open questions); a `binaries` entry inside the app (the hub signs the bundle as a whole); a bundle id
that overlaps another package's, of either kind; and an app binary whose name another package ships.

`kind: app` stays the way to publish a Mac app with a DMG and Sparkle. `app` on a tool is for an app that wraps the
tool and ships in the tool's archive.

### Fetch (App key only, no Apple keys)

For each macOS archive, after the checksum and attestation checks of today:

- entries whose first path part is `app.name` belong to the app; a first part that equals it in another spelling of
  case is refused, because macOS folds case and would merge the two folders after signing;
- a symlink inside the app must resolve inside the app;
- every other Mach-O file must be listed in `binaries`, as today;
- the app is unpacked next to the binaries and checked with the app checks of `kind: app`, minus what only a DMG and
  Sparkle need: `CFBundleIdentifier` equals `app.bundle_id`; no `SUFeedURL`, `SUPublicEDKey`, `SUPublicDSAKey*` or
  `NSUpdateSecurityPolicy` (the hub signs no feed for a tool, so the app may not update itself); nested bundles carry
  identifiers below `app.bundle_id`; no `Info-*.plist`, no symlinked `Info.plist`, no localized override of a checked
  key, no installer package, nothing named like an app the hub publishes; `app.binaries` are Mach-O files in the app.
- The app's version is not compared with the tag. ebb stamps it without the prerelease suffix and nothing the hub
  writes reads it.

### Sign (Apple keys only)

1. Sign and verify the listed binaries, as today.
2. Sign the app inside out with the code of `kind: app` (`findCode`, `signApp`): nested code first, the bundle last,
   each with `--options runtime --timestamp`. Bundles keep their `CFBundleIdentifier`; loose Mach-O files get
   `<bundle_id>.<file name>`. The bundle's main executable gets the tool's entitlements (the preset of its kind plus
   `entitlements`); other code gets none. Entitlements the build put in are dropped and reported, as for apps.
3. Verify with `verifyApp`: `codesign --verify --strict --deep`, then every piece is a Developer ID signature of the
   configured team with the hardened runtime and the planned identifier.
4. Notarize the binaries and the app in the one `notarytool` submission per release of today. The folders are copied
   with `ditto`, which keeps symlinks as they are; `fs.cp` would rewrite them and break the seal.
5. Staple the app (`stapler staple`, `stapler validate`) and require `spctl -a -t execute` to report
   "Notarized Developer ID". A stapled app opens offline on first launch. Bare binaries cannot be stapled, as today.

### Publish (App key only)

The archive is repacked as today. The app's folder is replaced by the signed and stapled tree (files, folders and
symlinks, read back from disk), the listed binaries by their signed copies; every other entry stays as it was.
`checksums.txt` is rewritten and the hub attests the repacked archive. The project's attestation of the original
archive covers the unsigned app, checked in fetch.

### Cask

```ruby
  depends_on :macos

  app "ebb.app"
  binary "#{appdir}/ebb.app/Contents/MacOS/ebb"
```

`app` comes first, then a `binary` line for each of `binaries` whose name no app binary takes, then the app binaries.
A command linked from the app takes the name, because it runs with the app's identity: ebb's service must run from
`ebb.app`. Homebrew 7's style requires `depends_on :macos` beside `app`.

## 2. A post-install command

Homebrew 7 deprecates `postflight do ... end` blocks (Ruby, unsandboxed) for declarative `postflight_steps`, which it
runs in its sandbox: no network, the home folder unreadable and `HOME` a temporary folder. `brew style` rejects the
old block, so tapster renders the new one. `cask.postflight: { binary, args }` for both kinds renders:

```ruby
  postflight_steps do
    run "bin/ebb",
        base:         :homebrew_prefix,
        args:         ["daemon", "restore"],
        must_succeed: false
  end
```

- `binary` must be the name of a command the cask links: one of `binaries` or `app.binaries` for a tool,
  `cask.binaries` for an app. So the hook runs only code the hub checked and signed (or, on Linux, attested).
- `args`: at most 10 of `A-Z a-z 0-9 . _ : = @ % + , / -`, together short enough for one cask line (90 characters).
  `run` takes an argument list, so no shell reads them and the Ruby escaper writes them as plain strings.
- `must_succeed: false` is fixed: a hook never fails an install.
- No other step, no `sudo`, no writable paths, no network, no free text and never Ruby from the config.

The entry sits in `tapster.yml` on the hub's protected `main`, so only the owner can change the command. The render
job holds no key.

**Consequence for ebb.** `ebb daemon restore` reads `~/.local/state/ebb` and writes `~/Library/LaunchAgents`. In
Homebrew 7's sandbox it sees an empty temporary home and does nothing, so the hook no longer brings the service back
after an upgrade. That is true for any tap, with or without tapster. ebb should restore the service itself the next
time it runs (it knows the person wanted it on) or ask the person to run `ebb daemon install` after an upgrade.

## 3. `tapster add` for a GoReleaser project

add already carries the description, homepage, license, completions, `uninstall launchctl`, `zap trash` and caveats
of GoReleaser's Homebrew section (`goreleaserCask`). The same function now also carries:

| GoReleaser | Hub entry |
| --- | --- |
| `custom_block` line `app "X.app"` | `app.name` |
| `binaries` under `#{appdir}/X.app/` | `app.binaries` |
| `uninstall.quit` | `cask.uninstall.quit` |
| `hooks.post.install` of the form `system_command "#{HOMEBREW_PREFIX}/bin/NAME", args: [...], must_succeed: false` | `cask.postflight` |

The bundle id comes from an `Info.plist` in the project whose `CFBundleExecutable` or `CFBundleName` names the app.
When none is found the entry says `<bundle id>` and add prints it for the owner to complete. Anything else in the
cask entry (other custom lines, other hooks) is listed as not carried. Without Apple credentials in the hub the `app`
block is left out, as the macOS archives are.

A release workflow step that moves a branch with the workflow's token is reported, with a link to section 4. A carried
hook is reported with a reminder that it runs in Homebrew's sandbox.

The project keeps building the app. A build hook that signs or notarizes it with the old secrets must sign ad hoc
instead (`codesign --force --sign -`); the hub signs it with the Developer ID.

## 4. A branch that follows releases

No new exception is needed. Recommended for ebb:

1. Run `tapster add --auto-tag`. It makes the deploy key `tapster tags` and lets deploy keys pass the branch rules.
   Its private half lives in the project's `release` environment, which only `main` may use.
2. Replace the PATCH step with a workflow that reacts to the hub's publication:

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
      - name: Move release to the latest release
        env: { GH_TOKEN: "${{ github.token }}" }
        run: |
          tag=$(gh release view --repo "$GITHUB_REPOSITORY" --json tagName --jq .tagName)
          git push origin "$(git rev-parse "$tag^{commit}"):refs/heads/release"
```

Why two jobs: the hub publishes with its App token, so `release: published` starts a run, but that run's ref is the
tag and the `release` environment admits only `main`. `workflow_dispatch` is one of the two events the workflow token
may start; that run is on `main`. The move job reads the latest published release itself and takes nothing from
the event, so a stray dispatch moves the branch only to what is already published. The page still never runs ahead of
the latest release, now the one the hub published.

Simpler, without a workflow: the owner pushes the branch with the tag
(`git push origin v1.2.3 "v1.2.3^{commit}:refs/heads/release"`), using the admin bypass. The page then goes live before
the hub publishes and stays ahead if the hub refuses the draft.

Not recommended: opening the branch rules to the workflow token, a tag policy on the `release` environment or a
Cloudflare token in the project.

## Security

- **Nothing unchecked is signed.** Every Mach-O file in a macOS archive is either listed in `binaries` or inside the
  configured app, which is checked in fetch and again by `findCode` and the identifier plan before the first
  `codesign`. A symlink cannot reach code outside the app.
- **A stolen App key stays harmless.** The bundle id, the linked commands and the hook live in the hub's `tapster.yml`
  on protected `main`. The App key cannot change them, cannot create tags and cannot forge the project's attestation.
- **Hooks cannot run arbitrary commands.** Only one of the package's own signed commands with fixed, narrow
  arguments.
- **Branch moves** use the existing `--auto-tag` model: a deploy key in an environment only `main` can open, used by a
  workflow that runs only reviewed code on `main`.

## Open questions

- A tool with an app and Linux builds: rendering `app` inside `on_macos` needs a check against `brew style` first.
- Per-path identifiers and entitlements for code inside a tool's app (`code` of `kind: app`): left out until a project
  needs them.
- `postflight_steps` needs Homebrew 7. A user on an older Homebrew with auto-update off cannot load such a cask.
- Whether `writable_paths` for a hook (Homebrew's way to let a step write in the home folder) is worth a narrow
  config key. Not added: ebb would still see a temporary `HOME` and could not reach launchd reliably from the sandbox.

## Testing

- Config: the new keys, every refusal above and the bundle id overlap across kinds.
- Render: ebb's cask as a golden file, which CI checks with `brew style` and `brew audit`.
- Fetch: an ebb-like archive unpacks; an unlisted Mach-O outside the app, a missing app, a second spelling of the
  app folder and a symlink out of the app are refused; the app checks without the version check.
- Sign and publish, on macOS: the app is signed ad hoc under the configured identifier with the tool's entitlements,
  repacked, unpacked again and passes `codesign --verify --strict --deep`; the other entries keep their bytes.
- add: ebb's `.goreleaser.yaml` gives the entry above; the branch move step is reported.
