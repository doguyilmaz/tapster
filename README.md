# tapster

tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your
projects. Each project only builds and opens a draft release. It holds no signing certificate, no notary key and no
tap token.

It covers command line tools written in Go (with GoReleaser) or Bun. Releases get Developer ID signatures, Apple
notarization, a Homebrew cask and, with Windows builds, a Scoop manifest.

## How it works

```
project (push tag v1.2.3)              hub: you/homebrew-tap
  builds, attests, no secrets          runs tapster every 10 minutes
  -> draft release + checksums.txt  -> signs and notarizes the macOS binaries
                                       replaces the archives, publishes the release
                                       writes Casks/<name>.rb and bucket/<name>.json
```

1. A project pushes a tag. Its workflow builds the archives, attests them and opens a draft release with
   `checksums.txt`.
2. The hub's `tapster` workflow finds drafts that are ready. It downloads them and checks every file against
   `checksums.txt` and the project's build attestation. Then it signs and notarizes the macOS binaries.
3. It swaps the signed archives into the draft, publishes the release and commits the cask and the Scoop manifest to
   the hub.

The design, including the security model, is in
[docs/superpowers/specs/2026-10-18-tapster-design.md](docs/superpowers/specs/2026-10-18-tapster-design.md).

## Set up a hub

You need a macOS machine with Xcode command line tools, [Bun](https://bun.sh) and the GitHub CLI (`gh auth login`).
You also need a Developer ID Application certificate exported as `.p12` and an App Store Connect API key (`.p8`).

```sh
gh repo clone you/homebrew-tap && cd homebrew-tap
bunx @doguyilmaz/tapster init
```

`init` creates a GitHub App for the hub. Your browser opens and you click "Create GitHub App", then pick the projects
it may publish. It stores the App key and your Apple credentials as secrets of a `tapster` environment that only the
`main` branch can open. It never prints them. Then it writes `tapster.yml`, the workflow and a README. Review and
commit them.

## Add a project

Inside a clone of the project:

```sh
bunx @doguyilmaz/tapster add
```

- **Go with GoReleaser:** `add` turns on draft releases, names the checksum file `checksums.txt`, removes
  `notarize`, `homebrew_casks`, `brews` and `scoops`. It also adds an attestation step to the release workflow.
- **Bun:** `add` writes a release workflow that cross-compiles every target, packs the archives, attests them and
  opens the draft.

`add` changes local files only and explains each change. It prints the entry to paste into the hub's `tapster.yml`.
Commit, push and tag a release.

## Check the setup

```sh
bunx @doguyilmaz/tapster doctor
```

`doctor` runs in the hub clone and explains anything missing in plain words, with the command that fixes it.

## Security

- **One place for credentials.** The Apple certificate, the notary key and the App key live only in the hub's
  `tapster` environment. Only workflows on `main` can open it. Projects hold nothing.
- **Nothing printed.** tapster reads each credential once, registers it and every derived value with the runner's
  masking and removes it from the environment. On every change its CI runs each stage with known fake credentials:
  the success path, GitHub errors (404, 422, 5xx and dropped connections), a broken certificate and a rejected
  signature. It searches every log line for the fake values, in plain text and encoded. A second run uses them as real
  secrets and fails if a tapster step prints anything the runner had to mask.
- **Short-lived access.** The hub reaches each project with an App token limited to that repository, revoked when the
  work is done.
- **Only checked builds are signed.** Every file must match `checksums.txt`. Public projects must attest their
  archives in their own release workflow. The hub verifies that before signing.
- **Rendering holds no credential.** The job that runs Homebrew to check the casks has only the hub's own workflow
  token.

## Limits

- Signing needs macOS runners, which are free for public repositories.
- A cask can only point at a public project, because Homebrew downloads without a token.
- The schedule runs every 10 minutes when GitHub keeps to it. You can also start the workflow by hand.

## License

MIT
