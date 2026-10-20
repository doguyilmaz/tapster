---
title: "Mac apps with Sparkle"
description: "Let the hub sign, notarize and publish a Mac app that updates through Sparkle."
sidebar:
  order: 3
---

For a Mac app, the project builds the app and signs it ad hoc. The hub does the rest:

1. it checks the app before anything is signed: both version keys must equal the tag;
2. it checks that the bundle id, the feed address, the Sparkle key and every nested bundle are what `tapster.yml` says;
3. it signs every piece of code inside out with identifiers and entitlements it chooses itself;
4. it builds the DMG without Finder, then signs, notarizes and staples it;
5. it signs the DMG and the update feed with the app's Sparkle key;
6. it publishes the DMG, the feed and `checksums.txt` and writes the cask.

## What the app needs

In the app's `Info.plist`:

| Key | Value |
| --- | --- |
| `SUFeedURL` | `https://github.com/you/MyApp/releases/latest/download/appcast.xml` |
| `SUPublicEDKey` | the public half of the app's Sparkle key |
| `SURequireSignedFeed` | `true` |
| `SUVerifyUpdateBeforeExtraction` | `true` |
| `CFBundleShortVersionString` and `CFBundleVersion` | the tag's version, such as `1.2.3` for `v1.2.3` |
| `LSMinimumSystemVersion` | macOS 11, 12, 13, 14, 15 or 26 |

The app must embed Sparkle 2.9.0 or newer. Apps are released from tags like `v1.2.3`. Prereleases are not published,
because the feed would never offer them.

## 1. The Sparkle key

Every app signs its updates with a Sparkle key. tapster calls each key by a **label**: the project's name in lowercase
letters and digits, such as `myapp` for `my-app`.

**A new app** gets a new key. In a clone of your hub:

```sh
bunx @doguyilmaz/tapster init --sparkle myapp --new
```

:::tip[You should see]{icon="approve-check-circle"}
`Its public key is <key>. Put it in the app as SUPublicEDKey and in tapster.yml as sparkle.public_key.`
:::

Put that public key into the app's `SUPublicEDKey` now, before step 2. tapster then asks you to confirm an offline copy
of the key and stores it in the hub.

**An app that already ships with a key** keeps it. You store it after step 2.

:::note[Where your keys go]{icon="padlock"}
The Sparkle key becomes a secret of the hub's `tapster` environment and goes nowhere else. Only the step that signs the
feed sees it. A key that tapster makes also stays in your login keychain. If the key is lost, installed copies can never update again,
so keep an offline copy, for example in your password manager.
:::

Both commands change one line in the hub's workflow. Commit and push it.

## 2. Add the app

In a clone of the app:

```sh
bunx @doguyilmaz/tapster add
```

tapster finds the app through its `SUFeedURL`, in an XcodeGen `project.yml` or an `Info.plist`. It writes
`.github/workflows/release.yml`. The build runs `make app` when your `Makefile` has an `app` target. Otherwise
tapster says so. Then set the build command and the app's path in that file yourself. The build must sign the app ad hoc.

The hub entry it proposes looks like this:

```yaml
  - name: myapp
    repo: you/MyApp
    kind: app
    app: MyApp.app
    bundle_id: com.you.MyApp
    assets:
      darwin-arm64: "MyApp-{version}.app.tar.gz"
    dmg: { name: "MyApp-{version}.dmg" }
    sparkle: { key: myapp, public_key: "<SUPublicEDKey>" }
```

If tapster could not find the bundle id or the public key, the entry holds a placeholder and is printed instead of
proposed. Fill it in and add it to the hub's `tapster.yml` yourself. Then follow [Commit, merge and install](/tutorial/project/#2-commit-merge-and-install).

**For an app that already ships with a key**, store that key once the entry is merged and before the first tag. In
tapster setup, open **Optional extras**: under **Sparkle keys**, click **Read it from my keychain**, paste the key it
shows into the form below it and click **Store in the hub**. Your password manager offers to save the key at that point,
which is the offline copy you need. tapster also passes the key to the hub workflow for you.

Or, in a clone of your hub:

```sh
git pull
bunx @doguyilmaz/tapster init --sparkle myapp --account ed25519
```

`ed25519` is the account Sparkle's `generate_keys` uses unless you named another. macOS asks whether tapster may read
the key; choose **Allow**. tapster checks that the key's public half matches `sparkle.public_key` in `tapster.yml`, then
asks `Do you keep an offline backup of this key? Type yes to store it in the hub:`. Commit and push the workflow line it
changes.

## Nested code and entitlements

The hub chooses the identifier and the entitlements of every piece of code it signs. For helpers, login items or
frameworks that need their own, list them under `code`:

```yaml
    code:
      Contents/Library/LoginItems/MyHelper.app:
        identifier: com.you.MyApp.Helper
        entitlements: { com.apple.security.app-sandbox: true }
```

Files that must stay in every release unchanged, such as a frozen feed for old builds, go under `carry` with their
digest. See [tapster.yml](/reference/config/) for every key.

## Rotate a Sparkle key

A leaked or retired key is replaced over two releases, so installed copies follow along:

1. Make a key with a new label: `tapster init --sparkle myapp2 --new`.
2. In the app's entry, set `next_key: myapp2` and `next_public_key` to its public key. Put that public key into the
   app's `SUPublicEDKey`.
3. Release. The hub signs the DMG with the new key and the feed with the old one. Sparkle accepts the change because
   the DMG carries your Developer ID.
4. Make the new key the current one: set `key` and `public_key` to the new values and remove `next_key` and
   `next_public_key`. From the next release on, the hub signs the feed with the new key too.
5. Run `tapster init --workflow` so the workflow stops passing the old key, then delete its secret:
   `gh secret delete SPARKLE_KEY_MYAPP --env tapster`.

Copies that skip the release in step 3 recover after 20 days, when Sparkle falls back to your Developer ID. Keep the
old key's offline copy until then.
