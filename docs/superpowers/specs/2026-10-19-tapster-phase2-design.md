# tapster: design, phase 2 (SwiftUI apps)

Date: 2026-10-19 · Status: revised after adversarial review, for implementation planning · Owner: Dogu Yilmaz

Phase 2 moves the three Sparkle apps (battistics, hafifpix and recesso) onto the hub. A project builds its app with
an ad-hoc signature and hands it over as a draft. The hub signs every piece of code inside it with the Developer ID
under identifiers the hub chooses, builds the DMG, notarizes and staples it, signs the update and the feed with the
Sparkle key, attaches the DMG and the signed appcast to the project's own release and renders the cask. The phase 1
spec (`2026-10-18-tapster-design.md`) still holds; this document adds to it. "§1.n" means section n of the phase 1
spec.

## 1. Intent

### What the user asked for (§1.20)

- battistics, hafifpix and recesso release through the hub. recesso becomes public before it migrates.
- Installed copies keep reading `https://github.com/doguyilmaz/<app>/releases/latest/download/<feed>`. That address
  stays: the hub attaches the signed appcast to the project's own release. No custom domain, no bridging update.
- The Sparkle EdDSA private keys move into the hub's environment. `doctor` checks them and `init` never prints them.
- DMGs stay the distribution format. hafifpix ships a CLI inside the app (`Contents/Resources/bin/hafif`), which the
  signing order must cover.

### What the research found (2026-10-19)

- **Two Sparkle keys.** battistics and hafifpix share one key. recesso has its own.
- **Feed names differ.** battistics reads `appcast-2.xml` and also ships a frozen `appcast.xml` for builds older than
  1.1.0. hafifpix and recesso read `appcast.xml`.
- **Nested code.** All three embed Sparkle 2 (`Autoupdate`, `Updater.app`, `Downloader.xpc` and `Installer.xpc` inside
  `Sparkle.framework/Versions/B`). battistics has a root launch daemon (`Contents/MacOS/BattisticsPowerHelper`) that
  trusts any client with identifier `com.doguyilmaz.Battistics` signed by the team. hafifpix has 12 dylibs in
  `Contents/Frameworks` and 8 tools plus a resource bundle in `Contents/Resources/bin`. More nested executables are
  coming in battistics.
- **Builds must stay in the projects.** They need XcodeGen, Homebrew engines, `actool` and `xcstringstool`. They edit
  `Sparkle.framework` before signing. The hub never runs project code.
- **Entitlements.** Only the battistics helper has one (`com.apple.application-identifier`). No provisioning profiles.
- **Versions.** In all three, `CFBundleShortVersionString` and `CFBundleVersion` both equal the tag version.
- **arm64 only**, minimum macOS 14 or 15. Today's DMGs are signed, notarized and stapled; the apps inside are not
  stapled separately.
- **Sparkle accepts an update** when its EdDSA signature verifies or when its Apple code signature satisfies the
  installed app's designated requirement. The Developer ID identity is therefore an update credential too.
- **Signed feeds.** Sparkle 2.9 and later verify a feed signature when the app sets `SURequireSignedFeed`. All three
  apps embed 2.9.4 or later. Sparkle refuses to start when `SURequireSignedFeed` is set without
  `SUVerifyUpdateBeforeExtraction`, so both are set together. After `SUSignedFeedFailureExpirationInterval` (20 days by
  default) of feed failures Sparkle falls back to an unsigned "safe mode" feed.
- **Install source.** Sparkle's installer looks through an update for a directory named like the installed app or a
  bundle with its bundle identifier. With `SUVerifyUpdateBeforeExtraction` it accepts a validly signed bundle whose
  EdDSA key matches. A nested app named like another app is therefore an attack, not a curiosity.

### Success criteria

1. **Release without secrets.** Pushing a tag makes the project build an ad-hoc signed app, attest it and open a draft.
   Typically within 20 minutes the release is published with a Developer ID signed, notarized and stapled DMG and a
   signed appcast that verifies against the app's `SUPublicEDKey`.
2. **Installed copies keep updating.** The feed address, the key and the version scheme do not change. The first
   hub-published release of each app updates an installed copy through Sparkle.
3. **One place for credentials.** The Sparkle keys exist only in the hub's environment and in the owner's offline
   backup. The hub refuses a key that differs from the pinned public key.
4. **No identity can be borrowed.** No package's build can get code signed under another package's identifier.
5. **No leaks, proven.** The leak test (§1.12.3) covers the Sparkle keys, including a malformed key.
6. **Migration done.** battistics, hafifpix and recesso release through the hub with signed feeds required. Their
   signing, notary, Sparkle and tap secrets are deleted and their `update-tap.sh` scripts removed.

## 2. Project contract for apps

A project with `kind: app` hands over a draft for a stable tag matching §1.5. Prereleases are refused for apps,
because the feed would never serve them. The draft attaches:
- the app archive: a `tar.gz` holding exactly one top-level `<App>.app` directory, built in the Release
  configuration, signed ad hoc and made with `tar --no-mac-metadata --no-xattrs -czf`;
- `checksums.txt` covering every other asset (§1.5);
- the carried files listed in `carry` (§3) with exactly the pinned digests. Any other asset stops the item.

The app template (§9) builds on a tag push or on `workflow_dispatch` run on a tag ref, in a job with `contents: read`.
A second job, which runs no third-party code, attests the archive and opens the draft.

When fetching, the hub checks the following and stops the item on any mismatch:
- `CFBundleShortVersionString` and `CFBundleVersion` both equal the tag without `v`;
- `CFBundleIdentifier` equals `bundle_id`;
- with Sparkle: `SUFeedURL` equals `https://github.com/<repo>/releases/latest/download/<feed>`; `SUPublicEDKey`
  equals `sparkle.public_key` or, during a rotation, `sparkle.next_public_key`; `SURequireSignedFeed` and
  `SUVerifyUpdateBeforeExtraction` are both true; `SUSignedFeedFailureExpirationInterval` is absent or at least 20 days;
  `SUPublicDSAKey`, `SUPublicDSAKeyFile` and `NSUpdateSecurityPolicy` are absent; the embedded `Sparkle.framework` is
  2.9.0 or newer;
- no localized Info.plist in the app (`InfoPlist.strings`, `InfoPlist.loctable` and the like, in `Contents/Resources` or
  an `.lproj` folder) mentions any key tapster checks in any encoding or behind an escape, because Sparkle reads
  localized values;
- without a `sparkle` section, the app sets neither `SUFeedURL` nor `SUPublicEDKey`, so it cannot keep an update channel
  the hub does not sign;
- these values read the same through tapster's parser and `/usr/bin/plutil -extract`. Duplicate keys and DTD
  entities are refused;
- the archive holds exactly one top-level `<App>.app`;
- every `CFBundleIdentifier` in a nested Info.plist (with or without an executable) is in the app's namespace or in
  `org.sparkle-project.` inside `Contents/Frameworks/Sparkle.framework/Versions/<V>/`. A resource bundle without an
  identifier (as Swift packages build them) passes, since Sparkle can only match it by name, which the next rule checks;
- no Info.plist is a symlink;
- no nested bundle carries `SUFeedURL`, `SUPublicEDKey` or a DSA key;
- no nested bundle or symlink is named like any app in `tapster.yml`, this one included (`<App>.app` or the same
  `CFBundleName`);
- every path in `code` matches code tapster finds;
- no two items get the same identifier;
- no file is named `embedded.provisionprofile`.

## 3. Hub config additions

```yaml
  - name: battistics
    repo: doguyilmaz/battistics
    kind: app
    app: Battistics.app
    bundle_id: com.doguyilmaz.Battistics
    assets:
      darwin-arm64: "Battistics-{version}.app.tar.gz"
    carry:
      appcast.xml: "sha256:<digest of the frozen legacy feed>"
    dmg:
      name: "Battistics-{version}.dmg"
      volume: Battistics
    sparkle:
      key: shared
      feed: appcast-2.xml
      public_key: "j6ODlGaJePRaQypW8ezxZQBAwj2+TkAo0Sg/51fPN8o="
    code:
      Contents/MacOS/BattisticsPowerHelper:
        identifier: com.doguyilmaz.Battistics.PowerHelper
        entitlements: { com.apple.application-identifier: "{team}.com.doguyilmaz.Battistics.PowerHelper" }
    cask:
      uninstall: { launchctl: [com.doguyilmaz.Battistics.PowerHelper], quit: [com.doguyilmaz.Battistics] }
  - name: hafifpix
    repo: doguyilmaz/hafifpix
    kind: app
    app: HafifPix.app
    bundle_id: com.doguyilmaz.HafifPix
    assets:
      darwin-arm64: "HafifPix-{version}.app.tar.gz"
    dmg:
      name: "HafifPix-{version}.dmg"
      volume: HafifPix
      volume_icon: Contents/Resources/AppIcon.icns
      layout: { window: [200, 120, 780, 500], icon_size: 110, app: [150, 170], applications: [430, 170] }
    sparkle:
      key: shared
      public_key: "j6ODlGaJePRaQypW8ezxZQBAwj2+TkAo0Sg/51fPN8o="
    cask:
      binaries: [Contents/Resources/bin/hafif]
```

**Fields for `kind: app`:**
- **Required:** `app` (`^[A-Za-z0-9 ._-]+\.app$`), `bundle_id` (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`), `dmg.name` (asset
  name rules of §1.6, ending in `.dmg`) and exactly one darwin asset (`darwin-arm64`, `darwin-amd64` or
  `darwin-universal`). Linux and Windows assets are refused.
- **`carry`:** asset names mapped to `sha256:<hex>`. Carried files must not hold macOS code (the phase 1 check of
  unsigned assets) and must not share a name with an output.
- **`dmg.volume`:** `^[A-Za-z0-9 ._-]{1,27}$`, default the app name without `.app`. **`dmg.volume_icon`:** a path inside
  the app. **`dmg.layout`:** the Finder window as `[left, top, right, bottom]` (the bounds the projects' AppleScript uses today; Finder measures from the bottom of the screen, so tapster converts with a reference height of 900 points), the icon size and the positions of the app and
  the `Applications` link, integers from 0 to 5000.
- **`sparkle`:** `key` (`^[a-z0-9]+$`, the secret `SPARKLE_KEY_<LABEL>`), `feed` (default `appcast.xml`) and
  `public_key` (base64 of 32 bytes). For a rotation, `next_key` and `next_public_key` (§6.1).
- **`code`:** per-path settings (paths relative to the `.app`, `.` for the app itself, each must match code tapster
  discovers): `identifier` and `entitlements` (key to boolean, string or list of strings; `{team}` in a string becomes the Team ID).
- **`cask.binaries`:** paths inside the app linked as commands. **`cask.auto_updates`:** default `true` with Sparkle.
- `binaries`, `completions`, `scoop` and `entitlements` do not apply to apps and are errors.

**Across packages** `parseConfig` refuses:
- two packages whose `bundle_id`s are equal or where one followed by `.` starts the other, compared without case;
- a CLI binary name equal to an app's `bundle_id` or starting with one followed by `.`;
- the same CLI binary name in two packages (already enforced in phase 1), including `cask.binaries` of apps.

## 4. What a run does for apps

The sign job (§1.4) gains three steps between `sign` and `publish`. Each step has its own `env:`.

| Step | Credentials | Apps | CLIs |
| --- | --- | --- | --- |
| fetch | App key | Downloads and verifies as §1.7, checks the carried files, unpacks the app (§6.4), checks §2. | as phase 1 |
| sign | Apple keys | Signs every piece of code inside out under hub identifiers (§5) and verifies. | as phase 1 |
| package | none | Builds the DMG from the signed app (§4.1). | nothing |
| seal | Apple keys | Signs, notarizes and staples the DMG. | nothing |
| sparkle | Sparkle keys | Signs the stapled DMG and the feed (§8.2). | nothing |
| publish | App key | Swaps the outputs in (§7), records the app facts in the state, publishes. | as phase 1 |

### 4.1 package (no credentials)

1. Stage the signed app, a symlink `Applications -> /Applications`, `.metadata_never_index` and, when configured, the
   volume icon as `.VolumeIcon.icns` and a `.DS_Store` that tapster writes itself from `dmg.layout`.
2. `hdiutil create -srcfolder <stage> -volname <volume> -fs HFS+ -format UDRW`, retried up to three times because
   `hdiutil` fails now and then on hosted runners.
3. With a volume icon, attach the image with `-nobrowse -noautoopen`, set the custom-icon flag on the volume root with
   `xattr` (`com.apple.FinderInfo`), detach.
4. `hdiutil convert -format UDZO -imagekey zlib-level=9`.
5. Attach the final image with `-readonly -nobrowse -noautoopen`, run `codesign --verify --deep --strict` on the app
   inside, detach.
tapster never drives Finder or AppleScript and never mounts an image a project made. No image is browsable.

### 4.2 seal (Apple keys)

1. Keychain as §1.8.
2. `codesign --force --timestamp --sign <sha1> <dmg>`.
3. `notarytool submit` as §1.8, `xcrun stapler staple <dmg>` and `xcrun stapler validate <dmg>`.
4. `spctl -a -t open --context context:primary-signature <dmg>` must report `Notarized Developer ID`.

### 4.3 sparkle (Sparkle keys)

1. Read every `SPARKLE_KEY_*` variable once (§1.12.2). Decode each to 32 bytes (a seed) or 96 bytes (Sparkle's older
   format: a 64-byte expanded private key and the 32-byte public key). Anything else stops the step without printing
   the value.
2. The DMG is signed with the key whose public half equals the app's `SUPublicEDKey` (the current key or the next key
   during a rotation). The feed is always signed with the current key, which installed copies know. A key whose public
   half differs from the configured one stops the item: "the Sparkle key `<label>` does not belong to this app;
   installed copies would reject the update".
3. Render the appcast (§8.2), sign it and append the signature block. Verify every signature before use.

## 5. Signing an app

### 5.1 Finding the code

Walk the unpacked app without following symlinks:
- a **bundle** is a directory with `Contents/Info.plist` (or, for a framework, a `Versions/<V>` directory with
  `Resources/Info.plist`) whose `CFBundleExecutable` names a regular Mach-O file inside it. Bundles are recognized by
  this structure, not by their extension;
- every other regular Mach-O file is **loose code**: dylibs, tools, helpers.
Sign in order of path depth, deepest first; bundles are signed as bundles, loose code as files.

### 5.2 Identifiers are the hub's choice

Every signature gets an explicit `--identifier`:
- the app: `bundle_id`;
- a nested bundle: its `CFBundleIdentifier`, which must start with `bundle_id.` or (inside
  `Contents/Frameworks/Sparkle.framework/Versions/<V>/`) with `org.sparkle-project.`. When `code` sets an identifier
  for a bundle, it must equal the bundle's `CFBundleIdentifier`;
- loose code: the `code` identifier when set, otherwise `bundle_id.` followed by the file name.
Any other identifier stops the item. The identifiers a release used are recorded in the state.

### 5.3 Entitlements are the hub's choice

- The entitlements a signature gets come only from `code` for that path.
- The ad-hoc signature's entitlements are read with `codesign -d --entitlements - --xml`. Any that `code` does not set
  with the same value is not signed and the summary warns about it, so a missing setting shows up without blocking a
  release. Security does not depend on these values: only `code` reaches the signature.
- tapster writes the entitlements plist itself from validated values.

### 5.4 One signature and the check

`codesign --force --options runtime --timestamp --keychain <kc> --sign <sha1> --identifier <id> [--entitlements
<file>] <path>`. After the app: `codesign --verify --strict --deep`. For every item: the authority, the Team ID, the
runtime flag and the identifier (§1.8).

## 6. Security

### 6.1 Threats added in phase 2

| Threat | Handling |
| --- | --- |
| A build borrows another package's identity (for example the identifier battistics' root daemon trusts) | Identifiers are chosen by the hub (§5.2) and kept apart across packages (§3). |
| A build adds entitlements | Entitlements come only from `code` (§5.3). |
| A project publishes a release outside the hub, so `releases/latest` serves its feed | Feeds are signed with the Sparkle key and the apps require signed feeds (§2). The build job holds no write token (§9). `check` warns when the latest release of an app is not one tapster published. After 20 days of feed failures Sparkle's safe mode reads an unsigned feed; the update itself must still carry the EdDSA signature or the same team's Developer ID, so the owner has those 20 days to act on the warning. |
| A nested app named like another app is installed in its place (Sparkle's install-source search) | Refused at fetch (§2). Every bundle's identifier is checked, not only bundles with code. |
| Team-wide trust on users' Macs | Sparkle's installer accepts connections from any process signed by the team, which includes every CLI the hub signs. This is inherent to sharing one Developer ID; identifiers kept apart (§5.2) limit what else a borrowed identity could reach. |
| A nested app carries its own Sparkle key | Refused (§2). |
| A leaked or retired Sparkle key | Rotate it: set `next_key` and `next_public_key`, store the new secret and publish a release whose app carries the new public key. Its DMG is signed with the new key and its feed with the old one; Sparkle accepts the change because the DMG carries the same team's Developer ID. Then make the new key the current one. Copies that skip that release wait for safe mode (20 days), so the old key's offline backup stays until the rotation is done. |
| A wrong Sparkle key strands installed copies | Pinned public key in config, checked at fetch and at signing. |
| Finder or system services parse project files while credentials are near | No Finder, no AppleScript, no browsable mounts (§4.1). |
| A carried file is changed or holds code | Digests pinned in `carry`; macOS code refused among carried files. |

### 6.2 Sparkle keys

- Secrets `SPARKLE_KEY_<LABEL>` in the `tapster` environment, passed only to the sparkle step.
- The key never reaches a command line or a file. Signing happens in tapster's code with Node `crypto` (seed keys) or
  tapster's Ed25519 for expanded keys. The expanded-key path is tested byte for byte against Node's Ed25519 on random
  keys and the RFC 8032 vectors, which proves its nonce derivation.
- The owner keeps an offline backup. `init --sparkle` asks for confirmation that one exists.

### 6.3 What runs where

No step with credentials runs project code. `codesign`, `notarytool` and `stapler` read the project's Mach-O files, as
in phase 1. `plutil` reads the app's Info.plist in fetch (App key only) to confirm tapster's reading.

### 6.4 Unpacking an app

- The archive rules of §1.12.7 hold, with one change: a symlink may point through other symlinks of the archive, as
  framework links do (`Sparkle -> Versions/Current/Sparkle`). tapster resolves the whole chain inside the archive (at
  most 40 links) and rejects any chain that leaves the archive or loops. An entry whose own path passes through a
  symlink is still rejected.
- Writing to disk creates directories, then files with exclusive create, then symlinks last. Nothing is written through
  a symlink. File modes are masked to `0755`.
- Info.plist files are read by tapster's own parser, at most 1 MiB each.

## 7. Publishing

- New assets: the DMG, the signed feed and the new `checksums.txt` (listing the DMG, the feed and the carried files).
- Order of the swap: upload all staging files; rename the DMG and the feed; delete the app archive; delete the old
  `checksums.txt` and rename the new one last. That rename is the commit point.
- Resume (§1.9) also handles removals: after verifying the staged files against the recorded digest, the configured app
  archive is deleted if it is still there. Any other asset outside the new `checksums.txt` stops the item without
  touching it.
- The `publishing` state entry, written before the swap, already holds the app facts render needs: `macos` (the
  symbol from `LSMinimumSystemVersion`) and the identifiers used. `published` keeps them. They are required for apps.

## 8. Output files

### 8.1 App cask

```ruby
cask "hafifpix" do
  version "1.3.1"
  sha256 "<sha256 of the DMG>"

  url "https://github.com/doguyilmaz/hafifpix/releases/download/v#{version}/HafifPix-#{version}.dmg"
  name "HafifPix"
  desc "<description>"
  homepage "<homepage>"

  livecheck do
    skip "tapster"
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "HafifPix.app"
  binary "#{appdir}/HafifPix.app/Contents/Resources/bin/hafif"

  uninstall quit: "com.doguyilmaz.HafifPix"

  zap trash: [...]
end
```

- `depends_on macos` is the bare symbol, which Homebrew reads as "this version or newer". The symbol comes from the
  state (11 big_sur, 12 monterey, 13 ventura, 14 sonoma, 15 sequoia, 26 tahoe).
- `depends_on arch` is `:arm64` for `darwin-arm64`, `:x86_64` for `darwin-amd64`, nothing for universal.
- The stanza order follows `brew style`, which render runs per cask (§1.7.19).

### 8.2 Appcast

```xml
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>HafifPix</title>
    <item>
      <title>1.3.1</title>
      <pubDate>Sun, 19 Oct 2026 10:00:00 +0000</pubDate>
      <sparkle:version>1.3.1</sparkle:version>
      <sparkle:shortVersionString>1.3.1</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <enclosure url="https://github.com/doguyilmaz/hafifpix/releases/download/v1.3.1/HafifPix-1.3.1.dmg"
        length="12345678" type="application/octet-stream" sparkle:edSignature="<base64>"/>
    </item>
  </channel>
</rss>
<!-- sparkle-signatures:
edSignature: <base64 of the Ed25519 signature over every byte above this comment>
length: <number of those bytes>
-->
```

- One item, the release being published, as `generate_appcast` produces today.
- `hardwareRequirements` only for an arm64-only app. `pubDate` is the tag date in RFC 822 form.
- The signature block is the one Sparkle's `sign_update` appends (`common_cli/Signing.swift`). Every value is
  XML-escaped and validated.

## 9. CLI and templates

- **App template** (`templates/project/app-release.yml`): job `build` (`contents: read`) runs the project's build
  command with an ad-hoc identity and `CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO`, packs the app and uploads it as a
  workflow artifact. Job `release` (`contents: write`, `id-token: write`, `attestations: write`) downloads it, writes
  `checksums.txt`, attests every listed file with `subject-checksums` and opens the draft. Triggers: tag push and
  `workflow_dispatch`, which refuses any ref that is not a tag.
- **`tapster init --sparkle <label> --account <keychain account>`** reads the key from the login keychain in-process
  (`security find-generic-password -s https://sparkle-project.org -a <account> -w`), so the key never appears on
  screen or on disk. It derives the public key, shows which packages pin it, asks for confirmation that an offline
  backup exists (required), stores the secret and rewrites the hub workflow's sparkle step for every configured label.
- **`tapster init --workflow`** rewrites the hub workflow from the template, the pins and the labels.
- **`tapster add`** in an app project (an `.xcodeproj`, a `project.yml` or a `Package.swift` next to an `Info.plist`
  with `SUFeedURL`) writes the app template and prints the hub entry with `bundle_id`, the feed, the public key and
  the asset names it found.
- **`tapster doctor`** also checks that every `sparkle.key` label has its secret and its line in the workflow.

## 10. Testing

- **Unit tests:** plist parsing (XML and binary, hostile input, duplicates); code discovery by structure and signing
  order; the identifier policy across packages; the entitlement policy; symlink chain resolution and safe writing;
  Ed25519 for both key formats (RFC 8032 vectors and byte equality with Node on random expanded keys); appcast and
  signed-feed golden files checked against Sparkle's extraction rules; the `.DS_Store` writer; the swap with removals
  and its resume; app cask golden files.
- **macOS CI:** a test builds a small app with `clang` (a framework with versioned links, an XPC service, a nested app,
  loose dylibs, a tool in `Resources/bin` and a helper with an embedded Info.plist), unpacks it through tapster, signs
  it ad hoc in tapster's order with tapster's identifiers and checks `codesign --verify --strict --deep` and every
  identifier. It also builds the DMG with the package step's code and verifies the app inside the image.
- **Leak test:** plain and masked Sparkle keys reach the sparkle step's success, its key mismatch failure and a
  malformed key.
- **End to end:** a Sparkle fixture app on the test hub with real credentials: `spctl`, `stapler validate`, the feed
  signature, an older installed build with both keys updating in place and a build from before the hub updating to the
  first hub release.

## 11. Migration

Order: hafifpix (simplest Sparkle setup, public), battistics (helper, two feeds), recesso (own key, after it is
public). For each:
1. Confirm where the Sparkle key lives (login keychain account) and that an offline backup exists. Store it with
   `tapster init --sparkle <label> --account <account>`.
2. In the project: set `SURequireSignedFeed` and `SUVerifyUpdateBeforeExtraction` to true in the Info.plist, replace the release workflow's signing,
   notarizing, DMG, appcast and tap steps with the app template's jobs, keep the project's version and changelog
   logic. battistics' automatic tagging must start the release with `workflow_dispatch` on the new tag, so the build
   runs on the tag ref and its attestation names it.
3. Add the hub entry and release a patch version. Check the DMG, the signed feed, an in-place Sparkle update and the
   cask.
4. Delete `MACOS_*`, `APPLE_ID`, `APPLE_TEAM_ID`, `NOTARY_PASSWORD`, `SPARKLE_PRIVATE_KEY` and
   `HOMEBREW_TAP_GITHUB_TOKEN`. Remove `update-tap.sh`.

## 12. Out of scope

- Mac App Store builds, provisioning profiles and restricted entitlements that need one.
- Delta updates, beta channels and release notes inside the appcast.
- DMG background images.
- Building apps in the hub.
