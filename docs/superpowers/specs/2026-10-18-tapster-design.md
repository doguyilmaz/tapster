# tapster: design, phase 1

Date: 2026-10-18 · Status: draft for review · Owner: Dogu Yilmaz

tapster turns one repository, the hub (`doguyilmaz/homebrew-tap`), into the single place that signs, notarizes and
publishes releases for all of a developer's projects. Project repositories only build and open a draft release. They
hold no secrets. Phase 1 covers command-line tools written in Go and in Bun/TypeScript.

## 1. Intent

### What the user asked for

- Every repository releases in its own way today. Signing secrets and tap tokens are copied repo by repo under
  different names (`HOMEBREW_TAP_TOKEN`, `HOMEBREW_TAP_GITHUB_TOKEN`), and keeping them in line is hard.
- One tool should hold that information, entered once and securely, and do the work the same way for every project.
- It should be generic, so others can set up their own hub with a config and their own repositories.
- It should guide the person through setup.
- It should cover Go, Bun/JS/TS and SwiftUI apps as far as possible, in phases.
- Secrets and passwords must never appear in any log of any workflow. With a single source the security bar is the
  highest; there must be no doubt about it.
- Attestation checks: add them, but a private repository or a plan without attestations must not fail the release.
  The user owns their Developer ID and their repositories.
- The hub keeps the name `homebrew-tap` and becomes the shared distribution area: Homebrew, Scoop, later appcasts and
  Linux repositories.

### Success criteria for phase 1

1. **Release without secrets.** A Go or Bun CLI releases by pushing a tag, and its repository holds no secrets.
   Within 15 minutes:
   - the release is published with Developer ID–signed, notarized macOS binaries;
   - the hub holds the cask, plus a Scoop manifest when there are Windows builds.
2. **One place for credentials.** The Apple and GitHub App credentials exist only in one GitHub environment of the
   hub.
3. **No leaks, proven.** tapster's own CI proves on every run that no secret, and no common encoding of one, appears
   in any log line.
4. **Migration done.** ebb, lockstep, aims, dothaven and konvoy release through the hub, and their tap tokens and
   Apple secrets are deleted.
5. **Plain explanations.** `tapster doctor` explains anything missing in plain language, with the command that fixes
   it.

### Assumptions (not stated by the user)

- **One account.** One GitHub account owns the hub and the projects. Organizations work the same way but are not
  tested in phase 1.
- **Public assets.** Release assets are downloadable without authentication, which means public project repositories.
  A cask that points at a private repository's release fails with 404 for everyone else. **ebb and lockstep are
  private today.**
- **macOS runners.** The hub is public, so macOS runners cost nothing.

## 2. Terms

| Term | Meaning |
| --- | --- |
| hub | The repository that holds the config, the credentials and the published package files (`homebrew-tap`). |
| project | A repository whose releases the hub publishes. |
| draft | A GitHub release that is not published yet. Only people and apps with write access see it. |
| ready | A draft whose `checksums.txt` exists and lists only files that are attached to the draft (§5). |
| App | A GitHub App the user creates for their own hub. It gives the hub short-lived access to the projects. |
| environment | A GitHub environment in the hub (`tapster`) that holds the credentials. Only workflows on `main` may use it. |

## 3. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Model | Pull: projects open drafts, the hub signs and publishes | Secrets in one place, and the signing job never runs project code. |
| Hub name | Keep `homebrew-tap` | `brew install user/tap/pkg` needs the `homebrew-` prefix. Scoop reads `bucket/` from any repo. |
| Access | The user's own GitHub App, created through the manifest flow | Tokens last one hour and are minted per run, and the user chooses which repositories the App can reach. No personal access tokens. |
| Language | TypeScript, developed and tested with Bun, shipped as a Node 24 JavaScript action and a CLI | GitHub Actions' native runtime: log masking and the API client come built in. |
| Signing | Apple's `codesign` and `notarytool` on a macOS runner | The same path Xcode uses, with the fewest surprises. One engine serves phase 2 apps as well. |
| Trigger | A schedule every 10 minutes plus manual dispatch. The webhook Worker comes in phase 3 | No dependency on Cloudflare in phase 1. A cheap Linux job checks for work and starts the macOS job only when there is some. |
| Attestation | `auto` by default; `required` or `off` per project | Verify when available, warn and continue when not (§12.6). |
| Package type | Casks for all prebuilt binaries | Homebrew's current policy; GoReleaser removed `brews`. |
| Windows | Scoop manifests in the hub's `bucket/` | aims already ships there. |

## 4. Architecture

```
project repo (tag v1.2.3)                       hub: doguyilmaz/homebrew-tap
  CI builds, no secrets                         tapster.yml (what to publish)
  -> draft release + checksums.txt              environment "tapster" (all credentials)
                                                .github/workflows/tapster.yml
                                                  check job (ubuntu, every 10 min)
                                                    -> any draft ready? any cask behind?
                                                  publish job (macos, only when needed)
                                                    -> sign, notarize, repack
                                                    -> replace assets, publish release
                                                    -> render Casks/, bucket/, README
                                                    -> brew style + audit, commit
```

| Component | Lives in | Responsibility |
| --- | --- | --- |
| `tapster` action | `doguyilmaz/tapster` (`action.yml`, bundled `dist/`) | `check` and `publish` modes, called by the hub workflow. |
| `tapster` CLI | same repo, published to npm, run with `bunx tapster` | `init`, `add`, `doctor` (§14). |
| templates | same repo, `templates/` | Hub workflow, `tapster.yml` starter, project workflows for Go and Bun, entitlement presets. |
| hub workflow | hub, written by `tapster init` | Schedule, dispatch, concurrency, permissions, environment. |
| GitHub App | the user's account, created by `tapster init` | Contents read/write and attestations read on the project repositories. |

Inside the code, each unit has one job and is tested on its own:
- `config` parses and validates `tapster.yml`.
- `github` lists drafts, replaces assets, publishes, reads attestations.
- `manifest` parses and writes `checksums.txt`.
- `archive` unpacks and repacks safely.
- `sign` handles the keychain, `codesign` and `notarytool`.
- `render` writes casks, Scoop manifests and the README index.
- `secrets` masks values and cleans up temp files.
- `report` writes the job summary.

## 5. Project contract

A project hands a release to the hub by creating a **draft** for a tag matching `v*`.

1. Attach the build archives. Naming is free; `tapster.yml` maps file patterns to platforms.
2. Attach `checksums.txt` in GoReleaser's format: `<sha256>  <file name>`, one line per asset.
3. Leave the release as a draft. A draft marked prerelease stays a prerelease when published.

The hub treats a draft as **ready** when `checksums.txt` is attached and every file it lists is attached with the
same size. Upload order does not matter.

| Project type | What `tapster add` sets up |
| --- | --- |
| Go with GoReleaser | Sets `release.draft: true`. Removes `notarize`, `homebrew_casks`, `brews` and `scoops`; the hub does those. Keeps archives and checksums. |
| Bun/TS | Adds `.github/workflows/release.yml`. On tag it cross-compiles each target with `bun build --compile --target=…` on one Linux runner, packs `tar.gz` (`zip` for Windows), writes `checksums.txt` and runs `gh release create --draft`. The Bun version is pinned (≥ 1.3.13; 1.3.12 wrote broken signatures). |

## 6. Hub config: `tapster.yml`

```yaml
version: 1
tap: doguyilmaz/tap                 # how users refer to it; the repo is doguyilmaz/homebrew-tap
packages:
  - name: ebb
    repo: doguyilmaz/ebb
    description: See where your Mac's disk space went and win it back safely
    homepage: https://github.com/doguyilmaz/ebb
    license: MIT
    binaries: [ebb]                 # paths inside each archive
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    cask:
      uninstall: { launchctl: [com.doguyilmaz.ebb] }
      zap: { trash: ["~/.config/ebb", "~/.local/state/ebb"] }
  - name: aims
    repo: doguyilmaz/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      darwin-amd64: "aims_{version}_darwin_amd64.tar.gz"
      linux-arm64: "aims_{version}_linux_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
      windows-amd64: "aims_{version}_windows_amd64.zip"
    completions: { bash: completions/aims.bash, zsh: completions/aims.zsh, fish: completions/aims.fish }
    scoop: true
  - name: konvoy
    repo: doguyilmaz/konvoy
    kind: bun                       # picks the bun entitlement preset
    binaries: [konvoy]
    assets:
      darwin-arm64: "konvoy_darwin_arm64.tar.gz"
      darwin-amd64: "konvoy_darwin_amd64.tar.gz"
      linux-arm64: "konvoy_linux_arm64.tar.gz"
      linux-amd64: "konvoy_linux_amd64.tar.gz"
```

**Field rules:**
- **Required:** `name`, `repo` and `assets`.
- **`kind`:** `go` (the default) or `bun`.
- **`attestation`:** `auto` (the default), `required` or `off`.
- **`entitlements`:** adds to the preset of `kind`.
- **`prerelease`:** `skip` (the default) leaves casks on the latest stable version.

The config is validated against a published JSON Schema. An unknown key is an error, not a warning.

## 7. What a run does

The run works as a reconcile loop, so a run that fails halfway is finished by the next one.

**Check job** (ubuntu, every 10 minutes and on dispatch; a dispatch can name one package and tag). It runs in
environment `tapster` but receives only `TAPSTER_APP_ID` and `TAPSTER_APP_PRIVATE_KEY`; the Apple credentials reach
only the publish job:
1. Mint one App installation token in memory and mask it.
2. For each package, list releases and note two cases:
   - drafts that are ready;
   - the newest published stable release, when it is newer than the version in the package's cask.
3. If there is nothing to do, exit in seconds. Otherwise pass the work list (package, tag, kind of work) to the publish
   job. The list contains no secrets.

**Publish job** (macOS, environment `tapster`), for each work item, isolated from the others:
1. **Download and verify.** Download every asset of the draft and check it against `checksums.txt`. A mismatch stops
   this item.
2. **Attestation.** Check it per the package setting (§12.6).
3. **Unpack.** Unpack the darwin archives safely (§12.5) and find the configured binaries; each must be Mach-O.
4. **Sign** each binary (§8), and verify it with `codesign --verify --strict` and `codesign -dv`. The authority must
   be "Developer ID Application" and the runtime flag must be set.
5. **Notarize.** Zip the signed binaries of the release and send them with
   `notarytool submit --wait --timeout 30m --output-format json`. Only `Accepted` passes. Otherwise fetch the
   notarization log and put its issues in the summary.
6. **Repack** each archive with the same name, the same file order and modes, and a fixed mtime. Recompute
   `checksums.txt`; linux and windows entries carry over unchanged.
7. **Replace assets.** Replace the changed assets on the draft, then publish it. Prerelease and make-latest flags are
   kept.
8. **Wait for downloads.** Wait until every asset URL answers `200` to an unauthenticated request; retry with
   backoff for up to 5 minutes. Right after publishing, URLs can return 404, which konvoy hit.
9. **Render** `Casks/<name>.rb`, `bucket/<name>.json` (when Windows assets exist) and the README index (§10).
10. **Validate** with `brew style` and `brew audit --cask --online` against the hub tapped from its checkout.
11. **Commit** `"<name> <tag>"` to the hub with the workflow's own token. Rebase and retry if `main` moved.

**Cask is behind** (a published release with no newer draft): only steps 9–11 run, using the published
`checksums.txt`.

**Failure:** any failure before step 7 leaves the draft untouched, so nothing unsigned is ever published. A failure
after step 7 is finished by the next run, through the "cask is behind" path.

**Concurrency:** one run at a time per hub (`concurrency: tapster`, never cancel in progress).

## 8. Signing

- **Keychain:** a temporary keychain in `$RUNNER_TEMP` with a random password. It is created at the start of the job
  and deleted in `finally` and in an `if: always()` step.
- **Identity:** the `.p12` is imported with `-T /usr/bin/codesign` only. The identity is read from the keychain; the
  first "Developer ID Application" identity wins.
- **Command:**
  `codesign --force --options runtime --timestamp --sign <identity> [--entitlements <file>] <binary>`.
  Universal binaries are signed in one call.
- **Entitlement presets:**
  - `go`: none.
  - `bun`: `allow-jit` and `allow-unsigned-executable-memory`.
  - `allow-dyld-environment-variables` and `disable-library-validation` are left out unless the package lists them,
    because they reopen library injection under the hardened runtime. The minimal Bun set is checked by a spike in
    plan task 1. konvoy uses all five today.
- **Notarization credentials:** the App Store Connect API key (`.p8`, key ID, issuer ID). It is stored with
  `notarytool store-credentials` into the temporary keychain, so no command line ever carries it.
- **Stapling:** not possible for bare Mach-O binaries. Gatekeeper checks the ticket online at first launch, which is
  why step 8 waits and why notarization must be `Accepted` before publishing.

## 9. Publishing

- **Assets:** a changed asset is deleted and uploaded again under the same name. `checksums.txt` is always replaced.
- **Publishing:** `draft: false` is sent in one update. Under immutable releases, nothing changes after this point,
  which is the flow GitHub recommends.
- **Tokens:** the App token is minted again whenever the job has run 45 minutes, because tokens expire after one
  hour.

## 10. Output files

- **Cask:** `on_macos`/`on_linux` and `on_arm`/`on_intel` blocks built from `assets`. Plus `binary` stanzas,
  completions, `uninstall`, `zap` and `caveats` from the config, `livecheck { skip }`, and `depends_on macos:` when
  set.
- **Scoop:** `bucket/<name>.json` with a `version`, an `architecture` block (`64bit`, `arm64`) holding `url` and
  `hash`, and `bin`.
- **README:** the index between `<!-- tapster:index -->` markers lists name, type, version, install command and
  source repository. The rest of the README is the user's.
- **Format:** files are generated byte for byte the same for the same input, and golden-file tests hold that.

## 11. Commits in the hub

One commit per package version: `"<name> <tag>"`, author `github-actions[bot]`. Manual edits to generated files are
overwritten, and the summary says so. Hand-written casks, such as the Swift apps' until phase 2, are left alone: the
hub only writes files for packages listed in `tapster.yml`.

## 12. Security

### 12.1 Secret inventory

All of the following live in the hub environment `tapster`. Its deployment branch rule is `main` only, so no other
branch, tag or pull request can open them. No reviewer approval is needed, so automation is kept.

| Secret | Used for |
| --- | --- |
| `MACOS_SIGN_P12`, `MACOS_SIGN_PASSWORD` | Developer ID Application certificate |
| `MACOS_NOTARY_KEY`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER_ID` | Notarization |
| `TAPSTER_APP_ID`, `TAPSTER_APP_PRIVATE_KEY` | Minting installation tokens |

Projects hold none of these, and they have no tap token.

### 12.2 Logs never show a secret

- **Only real secrets.** Credentials are GitHub Secrets, never Variables. Only Secrets are masked.
- **Derived values masked first.** Every value derived at runtime is passed to `core.setSecret` before anything else
  can print it. That covers decoded key material, the installation token, the keychain password and its base64 form.
- **Narrow exposure.** Secrets reach only the step that needs them, through `env:` on that step, never job-level
  `env:`.
- **No secrets on command lines.** Child processes start with an argument array and no shell. Values reach them
  through stdin, environment or 0600 files in `$RUNNER_TEMP`.
- **Quiet output.** Output from `security`, `codesign` and `notarytool` is captured and filtered before it is
  logged. Nothing prints its environment. There is no `set -x`, and debug logging (`ACTIONS_STEP_DEBUG`) prints
  nothing extra from tapster.
- **Nothing persists.** Secrets never go into step outputs, artifacts, caches or the job summary.
- **Canary test.** tapster's CI runs the action with a fake environment whose secrets are known canary values. It
  then downloads the logs of that run through the API and fails if any log line contains a canary or its base64,
  hex or URL encodings. This runs on every push and pull request.

### 12.3 The signing job runs no project code

- **What the job installs.** The publish job checks out the hub, installs tapster's bundled action (no install step:
  `dist/` is committed) and uses tools that ship with macOS plus Homebrew.
- **What it never does.** It never runs `npm`, `bun install` or a build from a project. Downloaded binaries are
  signed, never executed.

### 12.4 Supply chain

- **Dependencies.** tapster has few runtime dependencies (`@actions/core`, `@octokit/*`), locked in `bun.lock`.
  Installs use `--frozen-lockfile --ignore-scripts`.
- **Bundle.** `dist/` is built reproducibly. CI fails when `dist/` does not match a fresh build.
- **Pinning.** Every third-party action in templates and CI is pinned by commit SHA, and Dependabot keeps the pins
  current.
- **Releases.** tapster's own releases are immutable and carry build provenance attestations.

### 12.5 Archive safety

Before extracting, tapster rejects any entry that is:
- an absolute path, or a path containing `..`;
- a symlink or hardlink pointing outside the archive;
- a device file or FIFO;
- larger than 1 GiB uncompressed, or would push the total past 4 GiB.

### 12.6 Attestation

| Mode | Behaviour |
| --- | --- |
| `auto` | If the project's attestation API answers, each asset's digest must have a valid build provenance attestation from that repository's workflow. If the API reports attestations unavailable (private repository without the plan, or none recorded), log a warning and continue. |
| `required` | Missing or invalid attestations stop the item. |
| `off` | No check. |

### 12.7 Threats

| Threat | Handling |
| --- | --- |
| Logs expose a credential | §12.2, proven by the canary test. |
| A project's CI or dependency is compromised and its binary gets signed | Attestation in `auto`/`required`. Otherwise the user's responsibility, as agreed. |
| A malicious package inside tapster | Few dependencies, lockfile, `--ignore-scripts`, reviewed `dist/`. |
| Someone pushes a workflow change to the hub | The environment opens only on `main`; protect `main` (recommended by `doctor`). |
| Leaked App key | It can write to the installed repositories for as long as it is valid. Revoke it in App settings, and `tapster init --rotate` sets a new one. |
| A private project's cask is unusable | `doctor` warns before migration. |

## 13. Errors and reporting

- **Isolation.** Each work item succeeds or fails on its own. The job fails at the end if any item failed, so GitHub
  sends its usual failure notification.
- **Summary.** The job summary lists every item with its result. Failures carry a plain-language reason and the fix,
  for example "notarization rejected: binary not signed with the hardened runtime" or "checksums.txt lists
  `x.tar.gz`, which is not attached yet".
- **Retries.** Network calls retry with backoff. Notarization and the download wait have hard timeouts.

## 14. CLI

### `tapster init` (run once, in a clone of the hub)

1. **Create the App.** Start a local server, open the GitHub App manifest form with the right permissions, receive
   the code and convert it to the App's ID and private key. The key goes straight into the hub secret through `gh`
   over stdin and never touches the disk.
2. **Install the App.** Open the App's install page so the person can pick repositories.
3. **Create the environment.** Create `tapster` with the `main` deployment branch rule.
4. **Store credentials.** Ask for the `.p12` path and password and the `.p8` path, key ID and issuer ID, and store
   them as environment secrets (hidden input, stdin only).
5. **Write files.** Write `tapster.yml` and `.github/workflows/tapster.yml`, then commit.

`init --rotate` repeats step 1 or 4 for one credential.

### `tapster add <owner/repo>`

1. **Detect the project type** from `go.mod` with `.goreleaser.y*ml`, or from `package.json` with a Bun lockfile.
2. **Prepare the project.** Write the project-side change from §5 as a pull request in the project, plus a
   `tapster.yml` entry in the hub with assets guessed from the latest release.
3. **Check access.** If the App is not installed on that repository, open the install page.

### `tapster doctor`

Each check reports ok or a plain-language fix:
- the config parses;
- the environment exists with the branch rule;
- all secrets in §12.1 are present (names only);
- the App is installed on every listed repository;
- every listed repository is public, or its cask cannot work;
- `main` is protected;
- the schedule is enabled;
- no project still has old secrets (`HOMEBREW_TAP_*`, `MACOS_*`).

## 15. Testing

- **Unit tests (`bun test`):**
  - config validation;
  - checksums parse and write;
  - archive safety, with crafted malicious archives;
  - cask and Scoop rendering, as golden files;
  - ready detection;
  - reconcile decisions from recorded API fixtures.
- **Canary test** (§12.2): in CI, against a private test hub.
- **End to end:**
  - a private test hub (`doguyilmaz/homebrew-tapster-test`) and a private fixture project, with one Go and one Bun
    CLI;
  - real signing and notarization, triggered by hand;
  - checks: the binary verifies, `spctl` accepts the downloaded and quarantined binary, `brew install --cask` from
    the test hub works on the macOS runner.
- **Spikes before building** (plan task 1):
  - the minimal Bun entitlements;
  - replacing assets on drafts with an App token;
  - `brew audit --cask --online` against a tap made from a local path;
  - `notarytool --output-format json` fields.

## 16. Migration

The order is aims (public, Go, Scoop), konvoy (public, Bun), dothaven, then lockstep and ebb once they are public.
For each project:
1. Run `tapster add`, merge the project pull request, release a patch version, and check the cask and the binary.
2. Delete the project's `MACOS_*` and `HOMEBREW_TAP_*` secrets.

**Hub cleanup:**
- Remove the root `ebb.rb` and `lockstep.rb` formulae.
- Add `tap_migrations.json` entries so existing `lockstep` installs move to the cask.
- Generate the README index.

## 17. Phases

| Phase | Scope |
| --- | --- |
| 1 (this spec) | Go and Bun CLIs, casks, Scoop, `init`/`add`/`doctor`, canary test, migration of the five CLIs. |
| 2 | SwiftUI apps: Release build ad-hoc signed in the project; in the hub, Sparkle-order re-signing with `codesign`, DMG, notarize and staple, Sparkle EdDSA signature, appcast under a custom domain. |
| 3 | Instant trigger with a Cloudflare Worker, verified webhooks and optional OIDC from project CI. tapster made public, Marketplace listing, docs for others. Linux package repositories if wanted. |

**Out of scope for phase 1:**
- app bundles, DMGs and pkgs;
- Windows Authenticode signing;
- formulae;
- organizations;
- the Worker.

## 18. Risks

- **The schedule can stop.** GitHub disables scheduled workflows in public repositories after 60 days without
  activity. Each run updates `.tapster/heartbeat` only when nothing was committed for 30 days, and `doctor` checks
  that the schedule is enabled. Phase 3's webhook removes the dependency.
- **Development cost.** tapster has to be public before the public hub can use it. Until then it is developed
  against the private test hub, which uses paid macOS minutes, so the test hub runs only on manual dispatch.
- **Bun signing regressed once** (1.3.12). The Bun version is pinned in the template, and the hub verifies every
  signature.
- **No fixes after publishing.** Immutable releases leave nothing to repair after publish, which is why every check
  runs before step 7.
