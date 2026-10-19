# tapster hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps the first real end-to-end run and the two audits found: a stolen App key must not be enough to
get code signed, setup must survive mistakes, adding a project must be one command, failures must be visible and keys
tapster creates must never be lost.

**Architecture:** Changes land on branch `hardening` (stacked on `phase-3`). Rules live in the action (check, sign,
render, commit) and the CLI (init, add, doctor); the hub workflow template gains an attest job and a commit job.

**Tech Stack:** Bun, TypeScript strict, zod, GitHub REST API, macOS `security`, Linux `secret-tool`, gpg.

**Spec:** `docs/superpowers/specs/2026-10-19-tapster-hardening-design.md`

## Global Constraints

- Ruleset bypass actor: `{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }` (admin).
- Tag ruleset rules: `creation`, `update`, `deletion` on `refs/tags/v*`. Branch ruleset: `update`, `deletion`,
  `non_fast_forward` on `~DEFAULT_BRANCH`.
- The hub accepts a project only when its rulesets answer `current_user_can_bypass: "never"` to the App's token.
- Actions policy: `allowed_actions: selected`, `sha_pinning_required: true`, `github_owned_allowed: true`,
  `verified_allowed: false`, `patterns_allowed: ["<tapster repo>@*"]`.
- Secrets never on a command line: keychain writes go through `security -i` on stdin with `-X <hex>`; Linux through
  `secret-tool store` on stdin.
- Writing rules for public text; commits one line, the user's identity, no trailers.

## Review Focus

1. **A personal account on the free plan with private projects**: `add` and `check` explain the ruleset limit and the
   `protection: off` choice instead of failing obscurely. Task 3.
2. **A hub whose pin was changed by hand** (old template, new action): every step is refused with
   `tapster init --workflow`, nothing half runs. Task 4.
3. **A draft note written by the hub when the project owner already wrote release notes**: tapster replaces only its
   own block. Task 9.
4. **`init` interrupted after the App exists** resumes without a second App. Task 7.
5. **A keychain item for the label already exists** (`--sparkle --new`): refused, nothing overwritten. Task 10.

---

### Task 1: Per-package validation

**Files:** Modify `src/config.ts`, `src/action/context.ts`, `src/action/check.ts`, `src/cli/doctor.ts`; Test
`tests/config-split.test.ts`.

**Interfaces:** `parseHub(text, owner): { config: HubConfig; invalid: { name: string; reason: string }[] }`;
`parseConfig` keeps its behavior for the CLI's strict uses.

- [ ] Failing tests: one bad package among good ones is reported with its reason and the rest load; a cross-package
  conflict (duplicate binary, overlapping bundle ids) marks every package involved; a bad top level still fails as a
  whole; check records each invalid package as failed.
- [ ] Implement, green, commit "Let one bad package fail alone".

### Task 2: Pin the tapster that the CLI is

**Files:** Create `src/version.ts`; Modify `src/cli/init.ts`, `.github/workflows/{release,npm}.yml`, `package.json`;
Test `tests/version.test.ts`, `tests/init.test.ts`.

**Interfaces:** `TAPSTER = { version: string; sha: string | null }` (build writes it); `pinFor(gh, flag?)` returns the
embedded SHA, or for a development build the `--tapster <sha>` value after checking it is on tapster's `main`
(`GET /repos/doguyilmaz/tapster/compare/<sha>...main` status `ahead` or `identical`); `patchSparkleEnv(text, labels)`.

- [ ] Failing tests: no "latest" lookup remains; a development build without `--tapster` refuses; `--sparkle` and
  `--linux` change only the sparkle `env:` line; `init --workflow` reports the old and the new pin.
- [ ] Implement (release and npm workflows write `src/version.ts` before building; the npm package ships
  `dist/cli.js` bundled by Bun with no dependencies), green, commit "Pin the hub to the tapster that wrote it".

### Task 3: Project rulesets

**Files:** Create `src/rulesets.ts`; Modify `src/action/check.ts`, `src/cli/add.ts`, `src/config.ts`
(`protection: off`); Test `tests/rulesets.test.ts`.

**Interfaces:** `TAG_RULESET`, `BRANCH_RULESET` bodies; `protectionProblems(gh, repo): Promise<string[]>` (empty when
protected); `createProtection(gh, repo): Promise<"created" | "exists" | "unavailable">`.

- [ ] Failing tests against fake API answers: a missing tag ruleset, an inactive one, one that does not cover
  `refs/tags/v*`, one missing `creation`, one the App can bypass, and an unenforced plan each give a reason; two good
  rulesets give none; `protection: off` skips the check and is reported; create posts the exact bodies and maps 403/422
  plan errors to "unavailable".
- [ ] Failing tests for the draft origin: a draft whose tag does not exist waits ("the tag is not pushed yet"); a draft
  created by a bot other than `github-actions[bot]`, or holding a file uploaded by one, is invalid and names the
  uploader; the owner and `github-actions[bot]` pass; resumed drafts (the hub's own staged files) are not judged by
  uploader.
- [ ] tapster's own repository gets the same two rulesets (by hand, owner's token) and its CI checks them.
- [ ] Implement, green, commit "Refuse projects whose tags a stolen App key could move".

### Task 4: The action runs only from the hub workflow on main

**Files:** Modify `src/action/main.ts`, `src/action/check.ts`, `action.yml`, `templates/hub/tapster.yml`; Create
`src/action/guard.ts`; Test `tests/guard.test.ts`, `tests/check.test.ts`.

**Interfaces:** `guardRun(env, inputs): void` throws `TapsterError`; `TEMPLATE = 2`.

- [ ] Failing tests: another workflow file, another branch, `pull_request`, `push` or `workflow_run` events are refused
  before any secret is read; the hub workflow on main with `schedule` or `workflow_dispatch` passes; a missing or
  different `template` input is refused with `tapster init --workflow`; check fails the run when the App is installed
  on the hub and warns about installation repositories that `tapster.yml` does not list.
- [ ] Implement, green, commit "Run only from the hub workflow on main".

### Task 5: Attest in its own job

**Files:** Modify `templates/hub/tapster.yml`, `src/action/publish.ts`, `src/action/fetch.ts` (attestations token);
Test `tests/hub-workflow.test.ts`, `tests/attest.test.ts`.

- [ ] Failing tests: the sign job has `contents: write` only; the new `attest` job has `id-token: write` and
  `attestations: write`, no checkout, writes the `attest-checksums` output to a file for `subject-checksums` and is
  skipped unless publish set `attest`; fetch's `gh attestation verify` gets a token minted with `attestations: read`
  only.
- [ ] Implement, green, commit "Attest in a job of its own".

### Task 6: Render reads, commit writes

**Files:** Modify `src/action/render.ts`, `src/action/main.ts`, `templates/hub/tapster.yml`; Create
`src/action/commit.ts`; Test `tests/render-commit.test.ts`.

**Interfaces:** render mode outputs `passed` (JSON `{ path: sha256 }`), `changes` (bool); commit mode recomputes the
same changes with tapster's code and commits only paths whose bytes match `passed`, plus state and heartbeat.

- [ ] Failing tests: render never writes and its job has `contents: read`; commit drops a file whose bytes differ
  from the audited ones and reports it; state and heartbeat still commit; the commit job runs no Homebrew.
- [ ] Implement, green, commit "Keep Homebrew away from the hub's write token".

### Task 7: init as resumable steps

**Files:** Modify `src/cli/init.ts`, `src/cli/prompt.ts`, `src/cli/main.ts`; Create `src/cli/paths.ts`; Test
`tests/init-steps.test.ts`.

**Interfaces:** `initSteps(state)` returns the steps still to do from the hub's variables and secrets;
`cleanPath(input)` handles quotes and escaped spaces; certificate check `checkCertificate(subject, notAfter)`.

- [ ] Failing tests: check outputs `macos` true only when the run signs macOS code or renders casks, and the template
  maps it to `macos-15` or `ubuntu-24.04` only; a macOS package on a hub without Apple credentials fails with
  `tapster init --rotate certificate`; an existing `TAPSTER_APP_ID` with a stored key skips App creation; stored certificate and notary
  steps are skipped unless rotated; drag-and-drop paths with quotes and `\ ` resolve; a missing file names the path; a
  non "Developer ID Application" certificate is refused; the expiry is stored; "no macOS" skips both Apple steps; the
  App page message says "Only select repositories".
- [ ] Implement (on macOS the notary key is checked with `xcrun notarytool history`), green, commit "Let init resume
  and check credentials before storing them".

### Task 8: add does the whole job

**Files:** Modify `src/cli/add.ts`; Create `src/cli/hubpr.ts`; Test `tests/add-hub.test.ts`, `tests/add.test.ts`.

**Interfaces:** `entryFor(project): string` always complete and validated with `parseHub`; `openHubPr(gh, hub, entry)`;
`installLink(slug, ownerId, repoId)`; hub remembered as `git config tapster.hub`.

- [ ] Failing tests: Bun entries use the template's asset names and the `bin` name; Go entries use GoReleaser's
  archive template or the latest release or draft; `kind` is always present; an entry that fails validation is never
  printed or proposed; the hub PR body holds the entry; a missing ring step is added without `--force`; the doorbell
  variable is set when the hub has one; `--help` changes nothing.
- [ ] Implement, green, commit "Add a project to the hub in one command".

### Task 9: Failures are visible

**Files:** Modify `src/plan.ts`, `src/action/check.ts`, `templates/hub/tapster.yml`; Create `src/draftnote.ts`; Test
`tests/draftnote.test.ts`, `tests/plan.test.ts`.

**Interfaces:** `withNote(body, note | null): string` replaces only the `<!-- tapster -->` block;
`DraftStatus` gains `since` for waits.

- [ ] Failing tests: invalid drafts fail the run; a wait older than an hour fails; the note replaces only tapster's
  block and keeps the owner's text; every hub step has a `name`.
- [ ] Implement, green, commit "Say on the draft why the hub will not publish it".

### Task 10: Keys the owner keeps

**Files:** Create `src/cli/keystore.ts`; Modify `src/cli/init.ts`, `src/linux/sign.ts`, `templates/hub/tapster.yml`;
Test `tests/keystore.test.ts`, `tests/linux-sign.test.ts`.

**Interfaces:** `keychainScript(service, account, label, secretHex)` (the `security -i` stdin); `storeLocal(...)`;
`init --sparkle <label> --new`; `init --linux` stores locally; `TAPSTER_LINUX_KEY_PREVIOUS` signs `Release` too and its
public key is published next to the current one.

- [ ] Failing tests: the stdin script holds the key only as hex and no argv contains it; an existing account is
  refused; Linux uses `secret-tool store` with the secret on stdin; other systems refuse `--new`; the linux-sign step
  passes both keys to gpg with two `-u` and exports both public keys.
- [ ] Implement, green, commit "Keep the keys tapster creates in the owner's keychain".

### Task 11: Schedule and doorbell cron

**Files:** Modify `src/doorbell/worker.ts`, `src/cli/doorbell.ts`, `src/cli/init.ts` (`--every`),
`templates/hub/tapster.yml`, `src/cli/doctor.ts`; Test `tests/doorbell.test.ts`, `tests/doorbell-setup.test.ts`.

- [ ] Failing tests: the Worker's `scheduled` handler enables the workflow and dispatches; a ring enables before
  dispatching; the wrangler config carries the cron for `--every`; init writes the cron for the interval; doctor reports
  no scheduled or Worker-started run in a day.
- [ ] Implement, green, commit "Keep the hub running when GitHub's scheduler does not".

### Task 12: doctor and the hub's settings

**Files:** Modify `src/cli/doctor.ts`, `src/cli/init.ts` (actions policy); Test `tests/doctor.test.ts`.

- [ ] Failing tests: files are read from `main` through the API; a byte change in the workflow is reported with
  `init --workflow`; environment names compare without case; a ruleset with rules removed, enforcement off or bypass
  actors is reported; collaborators and deploy keys are listed; the actions policy is checked and set by init; Apple
  checks only when a package ships macOS code; every finding names its exact command; private projects get one
  consistent message.
- [ ] Implement, green, commit "Check every setting the hub's security depends on".

### Task 13: Bun template split, CLI polish, docs

**Files:** Modify `templates/project/bun-release.yml`, `src/cli/*.ts`, `src/github.ts`, `src/run.ts`, `README.md`,
specs (phase 2 §6.3, phase 3 §5.8 wording); Test `tests/add.test.ts`, `tests/cli-args.test.ts`.

- [ ] Failing tests: the Bun template has a read-only build job and a release job without third-party code; every
  command answers `--help`; unknown arguments are refused before any change; a missing `gh` says to install it; token
  hints name the right token; temporary folders are removed on SIGINT.
- [ ] Implement, docs, green, commit "Split the Bun template and tidy the CLI".

### Task 14: End to end again

- [ ] Release tapster v0.2.0 from `hardening`, rewrite the test hub workflow, run `add` against both fixtures, then:
  a normal release, a stolen-App-key simulation (a token for the CI App tries to create a `v*` tag on a fixture and
  must be refused by GitHub), an invalid draft that must fail with a note, and the leak scan.
