# tapster

tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your
projects. Each project only builds and opens a draft release. It holds no signing certificate, no notary key and no
tap token.

It covers command line tools written in Go (with GoReleaser) or Bun. Releases get Developer ID signatures, Apple
notarization, a Homebrew cask and, with Windows builds, a Scoop manifest. It also covers macOS apps that update
through Sparkle: the hub signs every piece of code in the app, builds and notarizes the DMG and signs the update feed.
Command line tools with Linux builds can also ship to apt and dnf from the hub's GitHub Pages site.

## How it works

```
project (push tag v1.2.3)              hub: you/homebrew-tap
  builds, attests, no secrets          runs tapster on a schedule or when rung
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
[docs/superpowers/specs/2026-10-18-tapster-design.md](docs/superpowers/specs/2026-10-18-tapster-design.md). Apps are in
[docs/superpowers/specs/2026-10-19-tapster-phase2-design.md](docs/superpowers/specs/2026-10-19-tapster-phase2-design.md),
the doorbell and Linux packages in
[docs/superpowers/specs/2026-10-19-tapster-phase3-design.md](docs/superpowers/specs/2026-10-19-tapster-phase3-design.md).

## Set up a hub

You need [Bun](https://bun.sh) and the GitHub CLI (`gh auth login`). tapster serves repositories of a personal
account. To sign software for macOS you also need a Developer ID Application certificate exported as `.p12` and an App
Store Connect API key (`.p8`); a hub that ships only Linux or Windows builds needs neither.

```sh
gh repo clone you/homebrew-tap && cd homebrew-tap
bunx @doguyilmaz/tapster init
```

`init` protects the hub, creates a GitHub App for it and stores the App key and, if you sign for macOS, your Apple
credentials as secrets of a `tapster` environment that only the `main` branch can open. It checks the certificate type
and expiry and, on macOS, asks Apple whether the notary key works before storing it. It never prints them. Then it
writes `tapster.yml`, the workflow and a README; review and commit them. If it stops halfway, run it again: it skips
what is done. A private hub needs GitHub Pro for environments.

The workflow pins the exact tapster that ran `init`. The hub looks for drafts every 10 minutes. A private hub looks
every hour, because GitHub bills each of its runs as at least a minute; `--every <minutes>` changes it. To move a hub to a newer
tapster, run `bunx @doguyilmaz/tapster@<version> init --workflow` and review the diff. If the hub has a doorbell, run
`init --rotate doorbell` too, so the Worker gets the same version and schedule. A hub that moves to this version from
an earlier one refuses each project until you run `tapster add` in it once, which protects its branches and tags.

## Add a project

Inside a clone of the project:

```sh
bunx @doguyilmaz/tapster add
```

- **Go with GoReleaser:** `add` turns on draft releases, names the checksum file `checksums.txt`, removes
  `notarize`, `homebrew_casks`, `brews` and `scoops`. It adds an attestation step to the release workflow
  (`--workflow` names it if it is not `release.yml`).
- **Bun:** `add` writes a release workflow whose build job cross-compiles every target without write access; a second
  job attests the archives and opens the draft.

`add` asks once which hub publishes the project and remembers it. It then:

1. protects the project so that only you can create, move or delete its branches and tags (a stolen App key could
   otherwise tag code that the hub would sign; bots like Dependabot then need a bypass entry);
2. opens a pull request on the hub with the project's entry, checked the way the hub checks it;
3. installs the hub's App on the project or opens the install page with the project selected;
4. points the release workflow at the doorbell, if the hub has one.

Releases that a workflow tags by itself still work: `add --auto-tag` gives the project a deploy key that only its
default branch can use and prints the step that pushes the tag with it.

## Apps

An app project builds the app in its own workflow and signs it ad hoc. It hands the app over as
`<App>-<version>.app.tar.gz` in a draft release. `tapster add` finds an XcodeGen `project.yml` or an `Info.plist`
with `SUFeedURL`, writes that workflow and prints the hub entry. The build job can only read the repository. A second
job attests the archive and opens the draft.

The hub then:

1. checks the app before anything is signed: both version keys equal the tag, the bundle id, the feed address, the
   pinned public key, the embedded Sparkle version and every nested bundle's identifier and name;
2. signs every piece of code inside out with identifiers and entitlements it chooses itself (`code` in `tapster.yml`);
3. builds the DMG without Finder, then signs, notarizes and staples it;
4. signs the DMG and the appcast with the app's Sparkle key;
5. publishes the DMG, the feed and `checksums.txt`, removes the unsigned archive and writes the cask.

The app must ask Sparkle for signed feeds. Set both keys in its `Info.plist`:

```xml
<key>SURequireSignedFeed</key><true/>
<key>SUVerifyUpdateBeforeExtraction</key><true/>
```

Store each Sparkle key once, from the Mac that holds it in its login keychain:

```sh
bunx @doguyilmaz/tapster init --sparkle <label> --account <keychain account>
```

It reads the key without showing it, checks it against the public key pinned in `tapster.yml`, asks you to confirm an
offline backup and stores it as the `SPARKLE_KEY_<LABEL>` secret. For a new app, `init --sparkle <label> --new` makes
the key, keeps it in your login keychain where Sparkle's own tools find it and prints the public key for
`SUPublicEDKey`. Apps that share a key share a label. Files that must
stay in every release unchanged, such as a frozen feed for old builds, go under `carry` with their digest.

## Faster releases

The hub checks for drafts every 10 minutes. To start it within a minute instead, deploy the doorbell, a small
Cloudflare Worker on the free plan:

```sh
bunx @doguyilmaz/tapster init --doorbell
```

It signs you in to Cloudflare with Wrangler, creates a second GitHub App that may only start the hub's workflow, deploys
the Worker with that App's key and tells every project where the doorbell is. A project's release workflow then rings
it after opening the draft: it sends a short-lived GitHub token that proves which repository and tag it comes from, and
the Worker starts the hub. The Worker also starts the hub on the schedule's interval when no run started in that time,
because GitHub runs schedules on a best effort basis. It turns the workflow back on if GitHub paused it for
inactivity; a workflow you disabled stays off.

## apt and dnf

Set `linux: true` on a command line tool with Linux builds and name a maintainer once:

```yaml
linux: { maintainer: "Your Name <you@example.com>" }
packages:
  - name: aims
    linux: true
```

Then make the signing key and turn on GitHub Pages for the hub:

```sh
bunx @doguyilmaz/tapster init --linux
```

The key also stays in your login keychain (or the Secret Service on Linux), because GitHub never gives secrets back.
`init --rotate linux` makes a new one; the old key keeps signing next to it until `init --rotate linux --finish`, so
apt and dnf users can fetch the new key first.

After each release the hub builds a `.deb` and an `.rpm` per architecture from the published Linux archives. A second
job, which holds the key, checks every package against those archives itself, signs the rpms and the repository
metadata and publishes the site. The site's front page shows users the two commands to add the repository.

## Check the setup

```sh
bunx @doguyilmaz/tapster doctor
```

`doctor` runs in the hub clone. It reads the hub as it is on GitHub's `main` branch and checks every setting the hub's
security depends on: the workflow against the template, the environment, the rulesets, the Actions policy, who else
can push, the projects' protection and whether the hub ran in the last day. Each finding names the command that fixes
it.

A draft the hub will not publish turns the run red once and gets the reason at the top of its release notes, where the
project's owner sees it.

## Security

- **One place for credentials.** The Apple certificate, the notary key and the App key live only in the hub's
  `tapster` environment. Only workflows on `main` can open it. Projects hold nothing.
- **A stolen App key is not enough.** The App can write to the projects, so every project lets only you create or move
  branches and tags. The hub signs a draft only when its tag exists and the draft and its files come from the
  project's own workflow. tapster runs only from the hub workflow on `main`, stops when the App is installed on the hub
  and stops when anyone but you changed `tapster.yml` or a workflow since your last push.
- **Nothing printed.** tapster reads each credential once, registers it and every derived value with the runner's
  masking and removes it from the environment. On every change its CI runs each stage with known fake credentials:
  the success path, GitHub errors (404, 422, 5xx and dropped connections), a broken certificate and a rejected
  signature. It searches every log line for the fake values, in plain text and encoded. A second run uses them as real
  secrets and fails if a tapster step prints anything the runner had to mask.
- **Short-lived access.** The hub reaches each project with an App token limited to that repository, revoked when the
  work is done. Checking attestations gets a token that can only read them.
- **Only checked builds are signed.** Every file must match `checksums.txt`. Public projects must attest their
  archives in their own release workflow. The hub verifies that before signing and checks the files once more right
  before it publishes.
- **Only tapster's code sits next to a writing token.** Signing jobs hold no attestation rights; a separate job attests.
  The hub runs no Homebrew; tapster's own CI checks the casks it renders with `brew style` and `brew audit`. The hub
  allows only GitHub's actions and tapster's, pinned by commit.
- **Sparkle keys stay in the hub.** Only the step that signs the feed sees them. The key never reaches a command line
  or a file. The hub refuses a key whose public half differs from the one installed copies trust.
- **Keys tapster makes are kept.** Sparkle and Linux keys that tapster creates are also saved in your keychain, where
  every app must ask before reading them.
- **Packages are checked before they are signed.** The job that builds the Linux packages has no key. The job that signs
  them rebuilds what each one must contain from the release and refuses scripts, dependencies, extra files or changed
  files.
- **The doorbell can only knock.** Its App may start the hub's workflow and nothing else. It accepts only GitHub's own
  tokens from your repositories, made for its address.

## Limits

- tapster serves personal accounts, not organizations.
- Signing macOS code needs macOS runners, which are free for public repositories. Runs that sign nothing for macOS use
  Ubuntu.
- The hub publishes private projects too, but a cask, a Scoop manifest or an apt and dnf package can only point at a
  public project, because users download without a token.
- Homebrew asks users to trust a tap before it loads casks from it (`brew trust you/tap`); the hub's README says so.

## License

MIT
