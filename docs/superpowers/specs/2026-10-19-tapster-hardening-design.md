# tapster hardening: trust boundaries, setup and everyday use

The three phase specs stand. This document changes them where the first real end-to-end run on the test hub and two
independent audits (usability and security, 2026-10-19) showed gaps. Every section names the finding it answers.

## 1. Goals

1. **A stolen App key cannot get code signed.** The hub's GitHub App can write to every project, so its key must not
   be enough to make the hub sign, notarize or Sparkle-sign anything.
2. **Only the owner decides what the hub signs and which tapster runs.** The hub's `main` branch and the pinned tapster
   version change only through the owner.
3. **Setup survives mistakes.** Every `init` step can be run again and skips what is already done; every `doctor`
   finding names the exact command that fixes it.
4. **Adding a project later is one command and one click.**
5. **Nothing fails silently.** A draft the hub will not publish says why, on the draft and in the run.
6. **Keys tapster creates are never lost.** A key that cannot be replaced is also saved in the owner's own keychain.
7. **Only what is needed runs.** No Apple credentials or macOS runners for hubs that ship no macOS software.

## 2. Protecting projects

Finding: a leaked App key can push a `v*` tag (or a commit for the owner's next tag) to a project; the project's own
release workflow then builds and attests the attacker's code and the hub signs it.

- `tapster add` creates two rulesets on the project, both with the repository admin role as the only bypass actor:
  - **tags:** target `tag`, all tags (`~ALL`); creation, update and deletion restricted;
  - **branches:** target `branch`, all branches (`~ALL`); creation, update, deletion and non-fast-forward restricted.
  The owner (admin) keeps pushing and tagging as before. The App, `GITHUB_TOKEN` and other bots cannot create or move
  any tag or branch, so they cannot start a project workflow on code of their own (a push to a new branch would run
  every workflow without a branch filter). GitHub refuses Dependabot as a bypass actor on personal repositories
  (verified, 422), so `add --allow-dependabot` excludes `refs/heads/dependabot/**` from the branch ruleset instead and
  says what that opens; `check` accepts that one exclusion only when the hub's entry says `protection: dependabot`,
  and `doctor` keeps reporting it.
- Before planning a package, `check` reads the project's rulesets with the installation token (metadata read is
  enough): `GET /rulesets?targets=tag` and `?targets=branch`, then each ruleset. It refuses the package ("failed",
  with the `tapster add` command that fixes it) unless a tag ruleset and a branch ruleset are active, cover
  all tags and all branches, hold the rules above and answer `current_user_can_bypass: never` for the App.
  GitHub returns the bypass list only to admins, so "the App cannot bypass" is what the hub checks.
- Rulesets need a public repository or a paid plan for private ones. `add` and `check` say so plainly when GitHub
  refuses to create them. They do the same when `GET /rules/branches/<default>` shows no rules although the ruleset
  exists. The owner then has three choices: make the project public, move to a plan that enforces rulesets or set
  `protection: off` on the package to accept the risk in writing. `doctor` keeps reporting the last one.
- The App can still create drafts and upload files to them, and `fetch` reads the draft again before it downloads. `check` therefore takes a draft only when its tag exists
  (the ruleset keeps the App from creating tags, and publishing a draft whose tag is missing would create it) and when
  the draft and every file on it come from `github-actions[bot]` or the owner. Files uploaded by the App itself, or by
  any other App, make the draft invalid. Attestations prove the same for public projects; this check also covers
  private ones, which GitHub gives no attestations on personal accounts.
- Releases stay automatic where the owner wants them. On a personal account GitHub refuses GitHub Actions as a bypass
  actor, but accepts deploy keys. `tapster add --auto-tag` creates an Ed25519 deploy key with write access, stores its
  private half as `TAPSTER_TAG_KEY` in a `release` environment that only the default branch may use, adds `DeployKey`
  to both rulesets' bypass list and prints the step that pushes the tag with it. A tag pushed with a deploy key starts
  the release workflow (one pushed with `GITHUB_TOKEN` does not), so the attestation stays bound to the tag. The App
  cannot read the key, add deploy keys or push code to any branch, so only the owner's code on the default branch can
  tag. battistics moves to this during its migration.
- The same two rulesets protect `doguyilmaz/tapster` itself, set once by hand and checked by its CI.

## 3. Which tapster runs

Finding: `init --workflow`, `--sparkle` and `--linux` pinned "the latest tapster release", so a tag on tapster
(through a leaked App key, since the hub publishes tapster) could take over every hub secret and the npm package.

- The CLI carries its own version and commit SHA, written into the build by tapster's release and npm workflows. The
  hub workflow is always pinned to that exact SHA; nothing asks GitHub for "latest".
- A CLI built from a checkout (development) has no SHA and refuses to write a workflow unless `--tapster <sha>` is
  given; it then checks that the commit is on tapster's `main`.
- `init --sparkle` and `--linux` change only the lines they own (the sparkle step's `env:`), never the pin.
  `init --workflow` is the one command that rewrites the workflow. It prints the old and the new pin.
- tapster's own releases keep the ruleset of §2.

## 4. Who can write to the hub

Finding: jobs that hold a writing token also run code that does not need it (Homebrew in render, the attestation
action in sign); the App installed on the hub only produced a warning.

- **check** stops the whole run (fails closed) when the App is installed on the hub: it fails before it writes any
  output, so no later job runs. Package failures turn the run red but keep the other packages' outputs, so one bad
  draft cannot stop the rest. It also lists the installation's
  repositories next to `tapster.yml` and warns about extra ones.
- **sign** keeps `contents: write` only for the publish step's state commits. It loses `id-token` and `attestations`.
  Publish outputs the SHA-256 lines of the files to attest.
- **attest** (new job, ubuntu, `id-token: write`, `attestations: write`, no checkout) writes those lines to a file and
  runs `actions/attest-build-provenance` with `subject-checksums`; the lines pass through `env`, never into the script. It is skipped when publish asked for nothing.
- **render** runs on ubuntu and runs no Homebrew: Homebrew is third-party code that has no business next to a writing
  token. `brew style` and `brew audit` move to tapster's own CI, which renders fixture casks for every package kind and
  audits them on macOS on every change and once a week.
- **check** refuses to run when the last commit that touched `tapster.yml` or `.github/` on the hub was made by a bot,
  since the jobs' `GITHUB_TOKEN` can commit to the hub but only the owner may change what it signs.
- The action refuses to run unless `GITHUB_WORKFLOW_REF` is `<hub>/.github/workflows/tapster.yml@refs/heads/main`
  and the event is `schedule` or `workflow_dispatch`. Every step passes `template: 2`; a workflow written for another
  tapster version is refused with `tapster init --workflow` as the fix, so a pin changed by hand never runs half a
  pipeline.
- `gh attestation verify` in fetch gets a separate installation token with `attestations: read` only.

## 5. Settings the security depends on

Finding: `doctor` read the local clone, compared the environment name case-sensitively, checked the hub ruleset by
name only and did not look at the actions policy, collaborators or deploy keys.

- `init` also sets the hub's actions policy: allowed actions `selected`, GitHub-owned actions and
  `doguyilmaz/tapster@*` only, SHA pinning required.
- `doctor` reads `tapster.yml` and the workflows from `main` through the API. When the hub pins the tapster that runs
  `doctor`, it renders the workflow from the template with the labels found in the file and reports any byte that
  differs; otherwise it says which tapster the hub pins and which one is running, and that `init --workflow` moves
  the hub to the running one. It compares environment
  names without case, inspects every ruleset's enforcement, rules and bypass list, lists collaborators and deploy keys,
  checks the actions policy and the project rulesets of §2. It also checks that a scheduled run happened in the last day.

## 6. Supply chain outside the hub

- tapster's own `release.yml` splits the same way: a `build` job without write permissions installs, tests and builds;
  a `release` job attests the built files and opens the draft.
- The Bun template splits like the app template: a `build` job with `contents: read` installs and builds; a `release`
  job without third-party code writes `checksums.txt`, attests and opens the draft.
- The npm package ships one bundled file built by Bun (`dist/cli.js`) with no runtime dependencies. The release
  binaries and the bundle carry the version and SHA of §3.
- The CLI removes its temporary folders on Ctrl-C as well as on errors.
- The phase 2 and phase 3 specs are corrected: a variable deleted from `process.env` stays visible in the process's
  initial environment to processes of the same user; the isolation that holds is between jobs, not between steps.

## 7. Setting up a hub

Findings: `init` could not be resumed, gave no guidance on where credentials come from, checked nothing until the first
release and always asked for Apple credentials.

- `init` runs as a list of steps, each skipped when done: protect the hub, create the App (skipped when
  `TAPSTER_APP_ID` exists and its key is stored), Apple certificate, notary key, files. Every step can be redone alone
  with `init --rotate <name>`.
- Apple credentials are asked only when the owner says the hub will sign macOS software (default yes);
  `init --rotate certificate` and `--rotate notary` add them later. `doctor` asks for them only when a package ships
  macOS code, and a macOS package on a hub without them fails with that command.
- The check job picks the runner for sign: macOS only when this run signs macOS code, ubuntu otherwise. The workflow
  accepts no other value.
- Prompts say where each file comes from. Paths accept quotes and escaped spaces from drag and drop. A missing file is a
  clear error, not "unexpected error".
- The certificate must be a "Developer ID Application" certificate; its expiry is stored as `TAPSTER_CERT_EXPIRES` and
  `check` warns 30 days ahead. On macOS, `init` checks the notary key with `notarytool history` before storing it.
- The App install page is opened with the instruction "Only select repositories" and the reason (the App must not be
  on the hub).
- Environments, environment secrets and deployment branch rules need a public hub or GitHub Pro. `init` says so when
  GitHub refuses them on a private hub, instead of failing on the first secret.

## 8. Adding a project

Findings: `add` printed incomplete entries (no assets before the first release, missing `kind`, placeholders), one bad
entry stopped the whole hub. A new project touched about six places.

- `tapster add [--hub owner/repo]` (the hub is asked for once and remembered in the project's git config):
  1. writes or adapts the project's release workflow, ring step included, without `--force` when only the ring step is
     missing;
  2. creates the project rulesets of §2 (the admin role's built-in id is 5, actor type `RepositoryRole`);
  3. builds the hub entry from what tapster knows (Bun: the template's asset names; Go: GoReleaser's archive template
     or the latest release or draft; apps: project.yml or the pbxproj), validates it with the hub's parser and opens a
     pull request on the hub with it;
  4. sets `TAPSTER_DOORBELL` on the project when the hub has a doorbell;
  5. adds the project to the App's installation with the owner's token
     (`PUT /user/installations/<id>/repositories/<repo id>`); when GitHub refuses that, it opens
     `https://github.com/apps/<slug>/installations/new/permissions?suggested_target_id=<owner id>&repository_ids[]=<repo id>`
     and says that the hub reports a missing installation by name.
- The hub validates each package on its own: a bad package fails with its reason, the others keep working. Cross-package
  conflicts fail every package involved.
- The Bun binary name comes from `package.json` `bin`; Go projects may name another workflow file with `--workflow`.

## 9. Seeing what happens

Findings: drafts the hub would never publish were reported as "waiting" in a green run; the hub's steps had no names.

- A draft that is invalid (bad tag, app prerelease, unlisted asset, two drafts) fails the run. A draft that has waited
  longer than an hour for uploads or attestations fails too.
- The hub writes the reason into the draft's release notes between `<!-- tapster -->` markers, replacing its own
  earlier note, so the project owner sees it where they work.
- Every step in the hub workflow has a name.

## 10. Keys kept by the owner

Finding: a Sparkle key or Linux key that exists only as a GitHub secret is lost for good if the owner never kept a
copy. GitHub never returns secrets.

- `init --sparkle <label> --new` generates an Ed25519 key in tapster's own code (the 32-byte seed Sparkle's
  `generate_keys` stores today) and stores it in the login keychain under Sparkle's service `https://sparkle-project.org`
  and account `<label>`, through `security -i` on stdin so the key never appears on a command line. It refuses when that
  account already exists. It then stores the hub secret, prints the public key for `SUPublicEDKey` and asks the owner
  to confirm an offline backup.
- `init --linux` stores the armored key in the keychain too (service `tapster-linux-key`, account the hub). On Linux the
  CLI uses Secret Service (`secret-tool store`, secret on stdin). On other systems tapster refuses to create keys it
  could not keep, with the reason.
- Linux key rotation keeps the previous key as `TAPSTER_LINUX_KEY_PREVIOUS` for a transition: apt's `Release` and dnf's
  `repomd.xml` are signed by both keys and both public keys are published. Packages carry one signature, from the new
  key, so dnf asks once to import it.
- Sparkle documents key changes: an update may change the EdDSA key or the Developer ID certificate, not both. With
  `SUVerifyUpdateBeforeExtraction` it does so only through a Developer ID signed DMG, which the hub always produces. An app moving
  to the hub may therefore get a new key from `--new` instead of recovering an old one. Copies that already require
  signed feeds reject a feed signed by the new key until `SUSignedFeedFailureExpirationInterval` (20 days) passes, so
  for those the old key signs the feed during the change, as phase 2 §6.1 describes.

## 11. The CLI

- Every command answers `--help` and refuses unknown arguments before changing anything.
- Messages fit where they run: a missing `gh` says to install the GitHub CLI; 401, 403 and 404 hints name the token in
  use (the user's or the App's).
- Private projects get one consistent message: the hub publishes them, casks and apt/dnf need them public.
- The README documents every command, upgrading, rotation and that tapster serves personal accounts only.

## 12. The schedule

Finding: on the test hub the 10-minute schedule had not run once in hours, while manual runs worked. GitHub documents
scheduled runs as best effort; community reports describe new repositories whose schedules never start.

- The doorbell Worker also runs on a Cloudflare cron trigger (free plan) and dispatches the hub on the same interval,
  so a hub with a doorbell does not depend on GitHub's scheduler. It skips a tick when a run started within the
  interval, so the two never double the runs. It re-enables the workflow only when GitHub paused it for inactivity
  (`disabled_inactivity`); a workflow the owner disabled stays off.
- Every run is a check job. On a private hub each one is billed as at least a minute, so 10 minutes costs about 4,300
  minutes a month, more than the free 2,000. `init` keeps 10 minutes for public hubs and proposes every hour for
  private ones (`--every <minutes>`, also used by the Worker) and says why. The doorbell keeps releases immediate.
- `doctor` reports a hub without a scheduled or Worker-started run in the last day and points to the doorbell.

## 13. Testing

Unit tests for every rule above, the template and job wiring, the ruleset checks against fake API answers, the
per-package validation, the draft notes, the key storage commands (without real keys) and the CLI argument handling.
Then the phase 1 end-to-end run again on the test hub, including a stolen-App-key simulation: an installation token that
tries to create a `v*` tag on a fixture must be refused by GitHub.

## 14. Out of scope here

The MCP server, skills, AI integration, the local setup web UI and a `tapster status` command stay in the queued work
after the technical side is confirmed.
