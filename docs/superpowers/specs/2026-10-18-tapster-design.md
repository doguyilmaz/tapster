# tapster: design, phase 1

Date: 2026-10-18 · Status: revised after adversarial review, for implementation planning · Owner: Dogu Yilmaz

tapster turns one repository, the hub (`doguyilmaz/homebrew-tap`), into the single place that signs, notarizes and
publishes releases for all of a developer's projects. Project repositories only build and open a draft release. They
hold no secrets. Phase 1 covers command-line tools written in Go and in Bun/TypeScript.

## 1. Intent

### What the user asked for

- Every repository releases in its own way today. Signing secrets and tap tokens are copied repo by repo under
  different names and keeping them in line is hard.
- One tool should hold that information, entered once and securely and do the work the same way for every project.
- It should be generic, so others can set up their own hub with a config and their own repositories.
- It should guide the person through setup.
- It should cover Go, Bun/JS/TS and SwiftUI apps as far as possible, in phases.
- Secrets and passwords must never appear in any log of any workflow. With a single source the security bar is the
  highest; there must be no doubt about it.
- Attestation checks: add them, but a private repository or a plan without attestations must not fail the release.
  The user owns their Developer ID and their repositories.
- The hub keeps the name `homebrew-tap` and becomes the shared distribution area: Homebrew, Scoop, later appcasts and
  Linux repositories.
- ebb and lockstep, private today, become public and they migrate when they are.

### Success criteria for phase 1

1. **Release without secrets.**
   - A Go or Bun CLI releases by pushing a tag and its repository holds no secrets.
   - Typically within 15 minutes, the release is published with Developer ID–signed, notarized macOS binaries.
   - The hub holds the cask, plus a Scoop manifest when there are Windows builds.
   - GitHub may delay scheduled runs, so the time is a target, not a guarantee.
2. **One place for credentials.** The Apple credentials and the GitHub App key exist only in one GitHub environment of
   the hub.
3. **No leaks, proven.** tapster's CI proves that nothing prints a credential, on the success path and on every
   failure path (§12.3).
4. **Migration done.** ebb, lockstep, aims, dothaven and konvoy release through the hub. Their tap tokens and Apple
   secrets are deleted.
5. **Plain explanations.** `tapster doctor` explains anything missing in plain language, with the command that fixes
   it.

### Assumptions (not stated by the user)

- **One account.** One GitHub account owns the hub and every project. tapster rejects a `repo` whose owner differs.
- **Public projects.** Projects are public, so their release assets download without authentication and attestations
  are free.
- **macOS runners.** The hub is public, so macOS runners cost nothing.

## 2. Terms

| Term | Meaning |
| --- | --- |
| hub | The repository that holds the config, the credentials and the published package files (`homebrew-tap`). |
| project | A repository whose releases the hub publishes. |
| draft | A GitHub release that is not published yet. Only people and apps with write access see it. |
| ready | A draft that passes §5's checks without anything being downloaded. |
| App | A GitHub App the user creates for their own hub. It gives the hub short-lived access to the projects. |
| environment | A GitHub environment in the hub (`tapster`) holding the credentials. Only workflows on `main` may open it. |
| state | `.tapster/state.json` in the hub: each release tapster publishes, with its ID, `checksums.txt` digest and status (`publishing` or `published`). |

## 3. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Model | Pull: projects open drafts, the hub signs and publishes | Secrets live in one place and the signing job never runs project code. |
| Hub name | Keep `homebrew-tap` | `brew install user/tap/pkg` needs the `homebrew-` prefix. Scoop reads `bucket/` from any repository. |
| Access | The user's own GitHub App, created through the manifest flow | One token per work item, limited to one repository, revoked when done. No personal access tokens. |
| Language | TypeScript, developed and tested with Bun, shipped as a Node 24 JavaScript action and an npm CLI (`@doguyilmaz/tapster`). Runtime dependencies: `@actions/core`, `yaml` and `zod` only; GitHub is called with plain `fetch`. | GitHub Actions' native runtime. The user's main language. Fewest dependencies in the job that holds the keys. |
| Signing | Apple's `codesign` and `notarytool` on a macOS runner, called by absolute path | The path Xcode uses. One engine serves phase 2 apps too. |
| Trigger | Schedule every 10 minutes plus manual dispatch; the webhook Worker comes in phase 3 | No Cloudflare dependency in phase 1. A cheap Linux job finds work; macOS starts only when there is some. |
| Attestation | `auto` by default: required where the platform provides it (public repositories), skipped with a warning where it cannot (private repositories without the plan). `off` per project. | Real protection for public projects, no failure where attestations are impossible. |
| Package type | Casks for all prebuilt binaries | Homebrew's current policy; GoReleaser removed `brews`. |
| Windows | Scoop manifests in the hub's `bucket/` | aims already ships there. |

## 4. Architecture

```
project repo (tag v1.2.3)                        hub: doguyilmaz/homebrew-tap
  CI builds, attests, no secrets                 tapster.yml, .tapster/state.json
  -> draft release + checksums.txt               workflow tapster.yml (schedule + dispatch only)
                                                   check    ubuntu  env tapster, App key only
                                                   fetch    macos   env tapster, App key only
                                                   sign     macos   env tapster, Apple keys only
                                                   publish  macos   env tapster, App key only
                                                   render   macos   NO environment, GITHUB_TOKEN only
```

The five stages run as separate jobs or as separate steps with separate `env:`, so no stage holds a credential it
does not use:

| Stage | Runner | Credentials | Does |
| --- | --- | --- | --- |
| check | ubuntu | App key | Finds ready drafts. Outputs a work list (package name, tag, release ID) with no secrets. |
| fetch | macOS | App key | Downloads, verifies checksums and attestations, unpacks safely, collects the Mach-O files. |
| sign | macOS (same job as fetch, its own step) | Apple keys | Signs and notarizes the collected Mach-O files. Touches nothing else. |
| publish | macOS (same job, its own step) | App key | Repacks, replaces assets with staging and rename, publishes, records state, attests its own outputs. |
| render | macOS (native Homebrew for casks) | none (job `GITHUB_TOKEN`, `contents: write`) | Renders casks and Scoop manifests from published releases in state, runs `brew style`/`audit`, commits through the Git Data API. |

Render holds no secret because Ruby (Homebrew) and network content run there (§12.5).

**Repository layout of tapster:**
- `action.yml` and a bundled `dist/`, with modes `check`, `fetch`, `sign`, `publish` and `render`.
- `src/` with one module per concern:
  - `config`: parse and validate `tapster.yml`.
  - `github`: releases, assets, Git Data commits, attestations.
  - `token`: App JWT and installation tokens.
  - `checksums`: parse and write `checksums.txt`.
  - `archive`: safe unpack and deterministic repack.
  - `keychain`: temporary keychain.
  - `sign`: `codesign` and `notarytool`.
  - `render`: cask and Scoop manifest.
  - `run`: child processes.
  - `mask`: secret registry.
  - `report`: job summary.
- `cli/` with `init`, `add` and `doctor`.
- `templates/` with the hub workflow, the `tapster.yml` starter, the Go and Bun project workflows and the entitlement
  presets.

## 5. Project contract

A project hands a release to the hub as a **draft** for a tag matching `^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`. Any other
tag is ignored and reported. The draft must:
- attach the build archives;
- attach `checksums.txt` in GoReleaser format, `<sha256>  <file name>` per line, covering every other asset;
- be the only release for that tag and the tag must exist.

**Ready** means:
- every asset has `state: "uploaded"`;
- every asset's `digest` (GitHub reports `sha256:` for each asset) matches its `checksums.txt` line;
- `checksums.txt` lists no file that is missing and no file twice.

No download is needed to decide readiness. Two drafts for one tag are an error that stops the package until resolved.

Projects attest their archives with `actions/attest-build-provenance` (no secret; needs `id-token: write` and
`attestations: write`).

| Project type | `tapster add`, run inside the project, writes |
| --- | --- |
| Go with GoReleaser | Sets `release.draft: true` and `checksum.name_template: checksums.txt`. Removes `notarize`, `homebrew_casks`, `brews` and `scoops`. Adds an attestation step to the release workflow. Explains each change. |
| Bun/TS | Adds `.github/workflows/release.yml`. It cross-compiles each target with `bun build --compile --target=…` on one Linux runner, packs `tar.gz` (`zip` for Windows), writes `checksums.txt`, attests the archives and runs `gh release create --draft`. Bun is pinned at ≥ 1.3.13. |

`add` changes local files only. The person reviews and commits them.

## 6. Hub config: `tapster.yml`

```yaml
version: 1
tap: doguyilmaz/tap
packages:
  - name: ebb
    repo: doguyilmaz/ebb
    binaries: [ebb]
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
    kind: bun
    binaries: [konvoy]
    assets:
      darwin-arm64: "konvoy_darwin_arm64.tar.gz"
      darwin-amd64: "konvoy_darwin_amd64.tar.gz"
      linux-arm64: "konvoy_linux_arm64.tar.gz"
      linux-amd64: "konvoy_linux_amd64.tar.gz"
```

**Fields:**
- **Required:** `name` (`^[a-z0-9][a-z0-9-]*$`), `repo` (same owner as the hub) and `assets`.
- **`{version}`:** the tag without the leading `v`.
- **`description` and `homepage`:** default to the repository's description and URL.
- **`kind`:** `go` (the default) or `bun`.
- **`attestation`:** `auto` (the default) or `off`.
- **`workflow`:** the project workflow file that builds and attests releases, `release.yml` by default. Attestations
  must come from it.
- **`entitlements`:** adds to the preset of `kind`.
- Unknown keys are errors.

Casks follow the newest stable release; prereleases are signed and published but get no cask.

## 7. What a run does

### check (ubuntu)

1. Mint a JWT and list installations.
2. For each package, mint an installation token limited to that repository with `contents: write` and
   `attestations: read` and mask it.
3. List the package's releases and find ready drafts (§5). Note drafts that tapster started earlier (§9 resume).
4. Revoke the token.
5. Output the work list: package name, tag and release ID, re-validated by the next job. The App ID is a Variable,
   not a secret, so a masked number never empties the output (§12.4).
6. Stop when the list is empty.

### fetch, sign and publish (macOS, one job, three steps)

Each work item is isolated: one failing never stops the others.

**fetch** (step env: App key):
1. Download every asset and verify each against `checksums.txt` and against the asset `digest`.
2. Attestation (§12.6).
3. Unpack the darwin archives into one directory per archive, with the checks in §12.7.
4. Every file listed in `binaries` must be Mach-O. Any other Mach-O file in a darwin archive stops the item.
   Darwin archives must be `tar.gz`; tapster reads them in its own code, so no external tool parses untrusted input.

**sign** (step env: Apple keys only):
5. Set up the keychain (§8).
6. Sign every collected Mach-O file and verify it: the authority is "Developer ID Application", the Team ID matches
   the certificate's and the runtime flag is set.
7. Zip each archive's signed files under that archive's own directory and submit them in one `notarytool` call per
   release. Wait, with a 30-minute timeout. Only `Accepted` passes. Otherwise fetch the notarization log and summarize
   its issues.
8. Tear down the keychain.

**publish** (step env: App key):
9. Repack each darwin archive deterministically (§10) and recompute `checksums.txt`. Linux and Windows entries carry
   over unchanged.
10. Re-list the draft's assets. If any ID or digest changed since fetch, stop the item; the project is still
    uploading or changed the draft.
11. Record the release in the state as `publishing` (a hub commit through the Git Data API with the job's
    `GITHUB_TOKEN`).
12. Upload each repacked archive and the new `checksums.txt` under staging names (`tapster-staging--<name>`). Then,
    one by one with `checksums.txt` last, delete the original and rename the staging asset to the original name.
13. Publish with `draft: false` and `make_latest: "true"` only when this is the highest stable version, `"false"`
    otherwise.
14. Wait until every asset URL answers `200` to an unauthenticated request, retrying with backoff for up to 5
    minutes.
15. Mark the state entry `published`. A run that finds a `publishing` entry whose release is already published and
    whose `checksums.txt` digest matches marks it `published`; one whose release is still a draft resumes it.
16. Attest the repacked archives in the hub (`actions/attest-build-provenance`), so the signed outputs have provenance
    of their own.

### render (macOS, no environment; runs only when check reports work, a `publishing` entry or a cask behind the state)

17. For each package, take the newest stable release recorded in the state as `published`. Releases published any other way are
    never rendered; the summary reports them.
18. Read the published `checksums.txt`, check its digest against the state and render the cask and the Scoop
    manifest (§10). When the rendered files equal the committed ones, stop here.
19. Run `brew style` and `brew audit --cask --online`. Run them on a local commit of the hub, because
    `brew tap <path>` clones only committed content.
20. Commit through the Git Data API (`"<name> <tag>"`), which makes the commits verified. On conflict, rebase and
    retry.

### Concurrency and failure

- **Concurrency:** one run at a time per hub (`concurrency: tapster`, no cancel in progress). A dispatch that gets
  dropped is not lost: the next scheduled run reconciles the same state.
- **Failure:** nothing unsigned is ever published, because publishing happens only after step 12.

## 8. Signing

- **Keychain:**
  - A temporary keychain in `$RUNNER_TEMP` with a random one-time password.
  - No auto-lock (`set-keychain-settings` without `-t`).
  - `set-key-partition-list -S apple-tool:,apple:,codesign:`, so `codesign` never prompts.
  - Added to the search list and the original list is restored in teardown.
  - Teardown deletes the keychain in `finally` and again in an `if: always()` step.
- **Certificate:**
  - The `.p12` is first re-wrapped with `/usr/bin/openssl pkcs12`. The real password comes in through `-passin env:`
    on that child alone; the copy gets a random one-time password.
  - `security import` then reads that copy with `-P <one-time password>`. The real password never reaches a command
    line.
- **Identity:** the identity is selected by its SHA-1 hash after `security find-identity -v -p codesigning`. Its Team
  ID must equal the one recorded at `init`.
- **Command:**
  `/usr/bin/codesign --force --options runtime --timestamp --sign <sha1> [--entitlements <file>] <file>`.
  Universal binaries are signed in one call.
- **Entitlement presets:**
  - `go`: none.
  - `bun`: `allow-jit` and `allow-unsigned-executable-memory`; plan task 1 verifies this minimal set.
  - `allow-dyld-environment-variables` and `disable-library-validation` only when a package lists them, because they
    reopen library injection under the hardened runtime.
- **Notarization:**
  - `/usr/bin/xcrun notarytool submit <zip> --key <0600 file> --key-id <id> --issuer <id> --wait --timeout 30m`
    with `--output-format json`.
  - The key ID and issuer ID are identifiers, not secrets, but are masked anyway.
- **Stapling:** not possible for bare Mach-O. Gatekeeper checks the ticket online at first launch.

## 9. Publishing and resume

- **Resume.** A draft is resumed rather than rejected when it has staging assets or when its darwin binaries are
  already signed with the configured Team ID. The next run finishes the staging renames and the publish.
- **Assets.** Replaced only through the staging-and-rename sequence in §7.12.
- **Immutable releases.** Nothing changes after publish, which is why every check runs before it.

## 10. Output files

- **Validation before writing.** Every value is validated and escaped before it reaches a file:
  - versions come only from tags matching §5;
  - names match the `name` pattern;
  - URLs are built from the repository and the asset name; asset names allow only `[A-Za-z0-9._-]`;
  - free text (description, caveats) goes through a Ruby string literal escaper and JSON through `JSON.stringify`.
- **Cask:** `version` and `on_macos`/`on_linux` with `on_arm`/`on_intel` blocks from `assets`, each holding `url`
  and `sha256`. Plus `name`, `desc`, `homepage`, `livecheck { skip "tapster" }`, `binary` stanzas, completions, and
  `uninstall`/`zap`/`caveats` from the config. Linux blocks depend on the spike in plan task 1.
- **Scoop:** `bucket/<name>.json` with `version`, `description`, `homepage`, `license`, an `architecture` block
  (`64bit`, `arm64`) holding `url` and `hash` and `bin`.
- **Archives:** repacked with:
  - `COPYFILE_DISABLE=1` and `/usr/bin/tar --no-mac-metadata --no-xattrs`;
  - owner and group 0, sorted entries, mtime from the release's tag date, `gzip -n`;
  - for zip, `zip -X -y`.
- **Golden files.** The same input produces the same bytes and golden-file tests hold that.

## 11. Hub repository

- **Layout:**
  - `Casks/` and `bucket/` for generated files;
  - `tapster.yml` and `.tapster/state.json`;
  - `.github/workflows/tapster.yml`;
  - a static `README.md` that `init` writes, explaining the layout and how to install.
- **What tapster writes.** Only files of packages listed in `tapster.yml`. Hand-written casks, such as the Swift apps'
  until phase 2, are left alone.
- **Formula migration.** `tap_migrations.json` moves an old formula to its cask in the same tap; plan task 1 checks
  that this works.
- **Protection.** A ruleset on `main` blocks force-push and deletion, which still allows the render job's API
  commits.

## 12. Security

### 12.1 Credentials

The environment `tapster` holds the following. Its deployment branch policy is `{"type": "branch", "name": "main"}`.
No reviewer approval is required.

| Secret | Used by |
| --- | --- |
| `MACOS_SIGN_P12`, `MACOS_SIGN_PASSWORD` | sign step |
| `MACOS_NOTARY_KEY`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER_ID` | sign step |
| `TAPSTER_APP_PRIVATE_KEY` | check, fetch and publish steps |

`TAPSTER_APP_ID` and `TAPSTER_TEAM_ID` are Variables (public identifiers). Projects hold no credentials and no tap
token.

### 12.2 Keeping credentials out of logs

- **Only secrets.** Credentials are GitHub Secrets, never Variables and never action `inputs`. They reach the action
  through the step's `env:` only.
- **Read once.** On start, the action reads each credential from `process.env`, registers it and every derived value
  with `core.setSecret` and deletes it from `process.env`. Derived values include decoded key bytes, the JWT, each
  installation token, the one-time passwords, key and issuer IDs and base64 and hex forms.
- **Mask-aware token minting.** Tokens are minted by tapster's own code (Node `crypto` for the JWT, a REST call for the
  token). Each token is masked before use and revoked with `DELETE /installation/token` in `finally`. There is no
  `@octokit/auth-app`, whose automatic re-minting bypasses masking.
- **Process spawning.** All child processes go through one wrapper:
  - Absolute tool paths only (`/usr/bin/codesign`, `/usr/bin/security`, `/usr/bin/xcrun`, `/usr/bin/openssl`,
    `/usr/bin/tar`, `/usr/bin/zip`, `/usr/bin/unzip`, `/usr/bin/gzip`), never `PATH`.
  - An allowlisted environment: `PATH=/usr/bin:/bin`, `HOME` and `TMPDIR`, plus the one variable a call needs, such
    as `-passin env:`.
  - stdout and stderr are captured. They pass through a filter that drops lines naming the keychain or matching any
    registered value, before a short excerpt is logged.
  - Errors carry only the tool name and the exit code, never argv. `@actions/exec` and `execFile` error messages are
    not used.
- **Values on command lines.** These are the only ones and each is a one-time value or an identifier, masked
  beforehand: the keychain password (`create-keychain`, `unlock-keychain`, `set-key-partition-list`), the one-time
  `.p12` password (`security import -P`) and the notary key ID and issuer ID.
- **Error handling.** HTTP errors are reduced to method, path and status. Request and response bodies are never
  logged.
- **Nothing persists.** Nothing is printed with `console.*`: all logging goes through `report`, which applies the
  filter.
  - Step outputs carry only package names, tags and release IDs and are re-validated by the receiving job.
  - No artifacts, caches or job summaries contain credentials.
- **No tracing.** `set -x` is never used. `ACTIONS_STEP_DEBUG` adds no output from tapster.
- **Self-hosted runners** are refused: the action checks `runner.environment === "github-hosted"`.

### 12.3 Leak test (CI of tapster)

Masking hides an exact secret, so a test that only searches logs for a secret it set always passes. The test
therefore has two parts:

1. **Canary run.** The whole pipeline runs with the canaries as plain environment values, not secrets, so nothing
   masks them.
   - The fixtures are a self-signed `.p12` (`codesign` works with it; notarization then fails as expected), a
     generated `.p8` and a test App on a fixture repository.
   - A later job (`needs:`, `if: always()`) downloads each job's log through `GET /actions/jobs/{id}/logs`. It fails
     if any line contains a canary as plain text, base64 (three offsets), hex, URL encoding or any 10-character
     window of one.
   - Variants force each failure path: wrong `.p12` password, notary 401, GitHub 404, 422 and 5xx, a dropped
     connection, a malformed `checksums.txt`, a malicious archive.
2. **Masked run.** The same pipeline runs with the canaries as real secrets. The log check fails on any `***` outside
   the step-header `env:` block, because a `***` means something printed a secret and masking caught it.

Both run on every pull request and on every push to `main`, including the macOS stages. Until tapster is public,
these cost paid macOS minutes and that is accepted.

### 12.4 Trust boundaries in the hub

- **Workflow.**
  - Triggers: `schedule` and `workflow_dispatch` only.
  - Workflow-level `permissions: {}`, with each job granting only what it needs.
  - `persist-credentials: false` on checkout.
  - Dispatch inputs reach code only through `with:`, never `${{ inputs.* }}` inside `run:`.
- **Environment use.** No other hub workflow may reference the environment. `doctor` fails if one does or if
  `tapster.yml` has another trigger: `pull_request_target`, `issue_comment` and `workflow_run` run with the default
  branch's ref and would pass the branch rule.
- **Default token.** The repository's default workflow token is set to read-only.
- **App.** Not public, no webhook in phase 1, no `workflows` permission. Repository permissions are `contents: write`
  (needed even to list drafts) and `attestations: read`. Not installed on the hub itself.
- **Variables.** The App ID and the Team ID are Variables, because a masked short number would also blank out release
  and asset IDs in outputs.

### 12.5 Rendering runs Ruby, so it holds no credential

Homebrew loads a cask as Ruby and `brew audit --online` fetches URLs. The render job therefore runs without the
environment. It has only its job token with `contents: write` on the hub and it renders only validated and escaped
values (§10).

### 12.6 Attestation

| Mode | Behaviour |
| --- | --- |
| `auto` | **Public repository:** each archive must pass `gh attestation verify <file> --repo <repo> --signer-workflow <repo>/.github/workflows/<workflow> --source-ref refs/tags/<tag> --deny-self-hosted-runners`. Failing stops the item. **Private repository** where the API reports attestations unavailable: warn and continue. |
| `off` | No check. The summary says so on every release. |

### 12.7 Archive safety

Before extracting, tapster rejects any entry that is:
- an absolute path or a path with `..` after normalization;
- a symlink or hardlink whose target, resolved from the entry's own directory, leaves the archive;
- a device file or FIFO;
- over 1 GiB uncompressed or pushing the total past 4 GiB;
- a duplicate path.

Archives are parsed in the fetch step, which holds no Apple key.

### 12.8 Threats

| Threat | Handling |
| --- | --- |
| Logs expose a credential | §12.2, proven on success and failure paths by §12.3. |
| A tag name injects code into a cask | Strict tag pattern, escaping and render without credentials (§10, §12.5). |
| A compromised project build gets signed | Attestation required for public projects (§12.6). Otherwise the user's responsibility, as agreed. |
| A release published outside tapster gets a cask | Render uses only releases recorded in the state as `published` (§7.17). |
| A project changes a draft during processing | Re-list and compare before mutating (§7.10). |
| A malicious package inside tapster | Three runtime dependencies (`@actions/core`, `yaml`, `zod`), exact versions, lockfile, `--ignore-scripts`, reproducible `dist/` checked in CI, pinned actions. |
| A workflow change to the hub gets the credentials | Branch-only environment, trigger allowlist and `doctor` checks (§12.4) and the `main` ruleset. |
| A leaked App key | It can write to the installed repositories until revoked. `tapster init --rotate app` makes a new key and deletes the old one. |
| A leaked Apple key | Revoke it in App Store Connect or with Apple; `init --rotate notary` or `init --rotate certificate`. |

## 13. Errors and reporting

- **Isolation.** Each work item succeeds or fails on its own. The run fails at the end if any item failed, so GitHub
  sends its usual failure notification.
- **Summary.** The job summary lists every item with its result. Failures carry a plain-language reason and the fix,
  for example "notarization rejected: binary not signed with the hardened runtime" or "checksums.txt lists
  `x.tar.gz`, which is not uploaded yet".
- **Retries.** Network calls retry with backoff. Notarization and the download wait have hard timeouts.

## 14. CLI

### `tapster init` (once, in a clone of the hub)

1. **Create the App.** Start a local server, open the GitHub App manifest form and check the returned `state`.
   Exchange the code for the App's ID and key. The key goes straight into the environment secret over stdin to `gh`
   and `client_secret` and `webhook_secret` are discarded unprinted.
2. **Install the App.** Open the App's install page so the person picks the project repositories.
3. **Create the environment.** Create `tapster` with the branch policy and set the repository's default workflow
   token to read-only.
4. **Store credentials.** Ask for the `.p12` path and password and the `.p8` path, key ID and issuer ID, with hidden
   input. Store them over stdin. Read the Team ID from the certificate and save it as a Variable.
5. **Write files.** Write `tapster.yml`, the workflow, `README.md` and `.tapster/state.json` and add the `main`
   ruleset. The person commits.

`init --rotate <app|certificate|notary>` replaces one credential and, for the App, deletes the old key.

### `tapster add` (inside a project clone)

1. **Detect the project type**: `go.mod` with `.goreleaser.y*ml` or `package.json` with a Bun lockfile.
2. **Write the changes** from §5 to local files and explain each one.
3. **Print the `tapster.yml` entry** to paste into the hub, with assets inferred from the latest release.
4. **Check access.** If the App is not installed on the repository, print its install link.

### `tapster doctor` (in the hub clone)

Each check reports ok or a plain-language fix:
- the config parses and every repository has the same owner as the hub and is public;
- the environment exists with the branch policy;
- all secrets in §12.1 exist (names only), along with the Variables;
- the App is installed on every listed repository and not on the hub;
- the default token is read-only and the ruleset is present;
- `tapster.yml` triggers are only `schedule` and `workflow_dispatch` and no other workflow references the
  environment;
- the schedule is enabled;
- no project still holds `HOMEBREW_TAP_*` or `MACOS_*` secrets.

## 15. Testing

- **Unit tests (`bun test`):**
  - config validation and tag and name patterns;
  - Ruby and JSON escaping, including hostile strings;
  - checksums parsing;
  - readiness and resume decisions from recorded API fixtures;
  - archive safety, with crafted malicious archives;
  - deterministic repacking;
  - cask and Scoop output, as golden files;
  - the spawn wrapper's environment allowlist and error redaction;
  - the mask registry.
- **Leak test:** §12.3.
- **End to end:**
  - a private test hub (`doguyilmaz/homebrew-tapster-test`) and fixture projects with one Go and one Bun CLI, using
    the real credentials, triggered by hand;
  - checks: the downloaded binary passes `codesign -R=notarized --check-notarization` and
    `spctl -a -t install` ("Notarized Developer ID") and `brew install --cask` from the test hub works on a macOS
    runner.

## 16. Migration

The order is aims (public, Go, Scoop), konvoy (public, Bun), dothaven, then lockstep and ebb once they are public.
For each project:
1. Run `tapster add` and commit.
2. Add the hub entry.
3. Release a patch version and check the cask and the binary.
4. Delete the project's `MACOS_*` and `HOMEBREW_TAP_*` secrets.

**Hub cleanup:** remove the root `ebb.rb` and `lockstep.rb` formulae and add the `tap_migrations.json` entries.

## 17. Phases

| Phase | Scope |
| --- | --- |
| 1 (this spec) | Go and Bun CLIs, casks, Scoop, `init`/`add`/`doctor`, leak test. tapster becomes public (the public hub can only use a public action), then the five CLIs migrate. |
| 2 | SwiftUI apps (battistics, hafifpix, recesso): Release build ad-hoc signed in the project; in the hub, Sparkle-order re-signing with `codesign`, DMG, notarize and staple, Sparkle EdDSA signature and the appcast attached to the project's own release (§20). |
| 3 | A Cloudflare Worker that takes verified release webhooks and OIDC calls from project CI and starts the hub run at once. Marketplace listing and a docs site for others. apt and rpm repositories from the hub. |

**Out of scope for phase 1:**
- app bundles, DMGs and pkgs;
- Windows Authenticode signing;
- formulae;
- organizations;
- the Worker;
- automatic pull requests from `add`;
- a published JSON Schema.

## 18. Plan task 1: spikes

These assumptions decide details of the design and are verified before building:
- **Bun entitlements:** the minimal set for a signed Bun binary that runs and notarizes.
- **Drafts and an App token:** staging upload, delete and rename of assets on a draft and the asset `digest` field.
- **Deployments:** whether `deployment: false` on environment jobs keeps the branch policy enforced (it avoids
  thousands of deployment records).
- **Homebrew:** casks with `on_linux` blocks in current Homebrew and `tap_migrations.json` from formula to cask in the
  same tap.
- **Validation:** `brew audit --cask --online` against a tap made from a local commit.
- **Notarization:** the fields of `notarytool --output-format json`.
- **Schedule:** whether `PUT …/workflows/{id}/enable` resets the 60-day inactivity timer. If it does not, keep a
  heartbeat commit when nothing was committed for 30 days.

## 19. Risks

- **The schedule is best effort.** GitHub delays or drops scheduled runs. Mitigations:
  - an off-hour cron offset;
  - manual dispatch;
  - the phase 3 webhook trigger.
- **Development cost.** Until tapster is public, the public hub cannot use it and macOS CI minutes are paid. It goes
  public once the leak test and the end-to-end test pass.
- **Bun signing regressed once (1.3.12).** Bun is pinned in the template and every signature is verified.
- **No fixes after publishing.** Immutable releases leave nothing to repair after publish, so every check runs before
  it.

## 20. Decisions for all phases (2026-10-19)

The user asked to build phases 1, 2 and 3 in one go and answered these questions up front.

- **How the work runs.**
  - One native session in this repository works through phase 1's plan, then writes and follows a spec and plan for
    phase 2 and for phase 3. There is no review stop between phases; spec and plan approval stays delegated to self
    review plus an adversarial review, as for phase 1.
  - Ask the user only before outward steps: making tapster public, each project's migration release and deleting a
    project's old secrets.
  - Scratch and test repositories and test GitHub Apps are created and deleted as the plans say, without asking each
    time. Creating an App still needs the user's click in the browser.
- **CLI distribution.** Both a cask in the hub (released through tapster itself) and npm as `@doguyilmaz/tapster`
  (npm account `doguyilmaz`). npm publishing uses trusted publishing from GitHub Actions, so no npm token exists.
- **Phase 2.**
  - Apps: battistics, hafifpix and recesso. recesso becomes public before it migrates.
  - All three use Sparkle. Installed copies read
    `https://github.com/doguyilmaz/<app>/releases/latest/download/appcast.xml`. That address stays: the hub attaches
    the signed `appcast.xml` to the project's own release. No custom domain and no bridging update.
  - The Sparkle EdDSA private key, shared by the three apps today as each repository's `SPARKLE_PRIVATE_KEY`, moves
    into the hub's environment. Losing it strands every installed copy, so `doctor` checks it and `init` never prints it.
  - DMGs stay the distribution format. hafifpix ships a CLI inside the app (`Contents/Resources/bin/hafif`), which
    the nested signing order must cover.
- **Phase 3.**
  - The Worker runs on Cloudflare's free plan (100,000 requests a day; tapster needs a few per release). It verifies
    GitHub's webhook signature or the project's OIDC token before it starts a hub run. The credential it uses to start
    the run is its only secret; the phase 3 spec decides its scope.
  - Marketplace listing and a docs site at `tapster.doguyilmaz.com`.
  - apt and rpm repositories served from the hub.
  - Personal accounts only. Organizations stay out of scope.
