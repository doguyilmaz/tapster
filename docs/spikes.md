# Phase 1 spikes

Run on 2026-10-19 on macOS 26 (Apple Silicon) with Bun 1.4.3, Homebrew 7.0.9, LibreSSL 3.3.6 and `gh`. They settle
the assumptions in spec §18. Scratch repositories: `doguyilmaz/tapster-spike` and
`doguyilmaz/homebrew-tapster-spike` (private, deleted afterwards).

## 1. Bun entitlements

Command: compile a small program with `bun build --compile`, sign it with
`codesign --force --options runtime --timestamp [--entitlements <plist>] --sign <Developer ID>` and run it. A JIT
heavy loop (3e8 iterations) shows whether JavaScriptCore can use its JIT.

| Entitlements | arm64 run | x86_64 run (Rosetta) |
| --- | --- | --- |
| none | runs, loop takes 11.0 s (JIT disabled, interpreter only) | not tested |
| `allow-jit` | runs, 1.2 s | runs, 1.4 s |
| `allow-jit` and `allow-unsigned-executable-memory` | runs, 1.2 s | not tested |

`allow-jit` alone also runs WebAssembly, `fetch` and regular expressions. `codesign --verify --strict` passes.

**Decision:** the `bun` preset is `com.apple.security.cs.allow-jit` only. `allow-unsigned-executable-memory` is a
weaker protection than `allow-jit` and nothing here needs it, so a package adds it through `entitlements` only when
it does (for example `bun:ffi` compiling C at run time). Without any entitlement a Bun binary still runs, but about
nine times slower, which a signature check would never notice.

## 2. Draft assets with staging names

Commands: `gh release create v0.0.1 a.txt checksums.txt --draft`, upload `tapster-staging--a.txt` to the draft's
`upload_url`, delete `a.txt`, then `PATCH` the staging asset's name to `a.txt`.

Observed:
- every asset has `state: "uploaded"` and `digest: "sha256:<hex>"`, both in the upload response and in the release
  listing;
- the staging name is kept exactly as uploaded;
- the rename succeeds and keeps the asset ID and the digest;
- an upload named `my file+x.txt` is stored as `my.file+x.txt`: GitHub replaces spaces with dots;
- a draft keeps `tag_name: "v0.0.1"` but its page shows `untagged-<hash>` until it is published, because
  `gh release create --draft` does not create the tag.

**Decision:** keep the prefix `tapster-staging--` and the digest field as designed. Renamed assets are reported as
waiting, never processed (Review Focus 2).

## 3. Environment with `deployment: false`

Setup: environment `t` with a custom branch policy for `main`, secret `S` and a workflow job with
`environment: { name: t, deployment: false }` that prints whether `S` is set. Dispatched on `main` and on `other`.

Observed:
- `main`: the job ran and printed `has-secret`;
- `other`: the job was rejected before any step ran ("The deployment was rejected or didn't satisfy other protection
  rules");
- `GET /deployments` returned 0 records.

**Decision:** the hub workflow uses `deployment: false` on every environment job. The branch policy still holds.

## 4. Homebrew: Linux blocks and `tap_migrations.json`

Cask with `on_macos` and `on_linux` blocks, each holding `on_arm` and `on_intel`:
- `brew style --cask` accepts it once each architecture block lists `sha256` before `url`. With `url` first it
  reports `Cask/StanzaOrder` and autocorrects to `sha256` first.
- `livecheck do skip "tapster" end` passes.
- `brew audit --cask --online` fails only on reachability: the private asset and homepage return 404. No other
  problem is reported.

Formula to cask in the same tap: installed `spk` as a formula from the tap, then replaced `spk.rb` with `Casks/spk.rb`
and `tap_migrations.json` (`{"spk": "doguyilmaz/tapster-spike/spk"}`) and ran `brew update`.
- Homebrew 7 notices the move but does not install the cask by itself: "Not automatically installing
  doguyilmaz/tapster-spike/spk because the migration target is not trusted." It prints
  `brew trust --cask …` and `brew install --cask …`.
- After both commands the formula is still installed. The cask skips its binary ("there is already a Binary at
  '/opt/homebrew/bin/spk' from formula spk; skipping link").
- `brew install user/tap/name` trusts that one entry automatically (`brew trust --json v1` lists it), so a person who
  installs a cask by its full name needs no extra step.

**Decision:** keep the `tap_migrations.json` entries for `ebb` and `lockstep`, because they make `brew update` print
the next step. The hub README and the migration release notes give the full command:
`brew uninstall --formula <name> && brew install --cask doguyilmaz/tap/<name>`. Casks list `sha256` before `url`
inside architecture blocks.

## 5. App manifest without a webhook

Pending: it needs the owner's click in the browser. A local page offers two manifests, one without `hook_attributes`
and one with an inactive webhook. The first App created becomes the CI App of the leak test, the second is deleted.
`init` keeps the inactive webhook until this result is in.

## 6. `.p12` re-wrap with LibreSSL

Commands as in the plan, plus a second certificate exported by OpenSSL 3.5 with its default encryption (PBES2,
PBKDF2, AES-256-CBC, SHA-256 MAC), which is what current macOS and OpenSSL produce.

Observed:
- `/usr/bin/openssl` (LibreSSL 3.3.6) reads both files with `-passin env:` and re-wraps them with `-passout env:`;
- `security import -P <one-time password>` imports the re-wrapped file;
- `security find-identity -p codesigning` lists the identity only when the certificate has the code signing usage
  (`extendedKeyUsage=critical,codeSigning`). It is then listed as `CSSMERR_TP_NOT_TRUSTED`. `-v` hides it.

**Decision:** the re-wrap works as designed. Test fixtures that must reach `codesign` need the code signing usage and
a trusted certificate. The leak test (Task 21) trusts its canary certificate on the runner with
`sudo security add-trusted-cert` so that signing runs and notarization fails as the spec expects, while tapster
itself keeps requiring a valid identity.

## 7. `notarytool` JSON

Moved into the end-to-end run (plan Task 22), which notarizes with the real key from the hub's environment. Nothing
here needs the key on this Mac. `parseNotary` reads `id` and `status`; the end-to-end run confirms both keys and the
Bun binary's notarization with `allow-jit` only.

## 9. Local dry run against real drafts

Two private fixture projects, `doguyilmaz/tapster-e2e-go` (GoReleaser) and `doguyilmaz/tapster-e2e-bun` (the Bun
template), were prepared with `tapster add` and tagged `v0.0.1`. Both release workflows built
the archives, attested them and opened drafts. tapster's own modules then ran on this Mac against those drafts with
the owner's `gh` token:
- `planPackage` found both drafts ready;
- every asset matched `checksums.txt` and its `digest`;
- attestation verification was skipped with a warning, because the repositories are private and the attestations API
  lists nothing for them;
- the darwin archives unpacked, each held exactly one Mach-O file named in `binaries`;
- `codesign` with the Developer ID and `verifySigned` passed, the Bun binary carrying only `allow-jit`;
- the repack was byte-stable when read and written again. `/usr/bin/tar` extracted it and both signed binaries ran
  (the Bun one with its JIT working).

## 8. Re-enabling a scheduled workflow

GitHub documents `PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable` but not whether it resets the 60-day
inactivity timer of a public repository. No source confirms it.

**Decision:** unknown, keep the heartbeat: the render job commits when the hub has had no commit for 30 days.
