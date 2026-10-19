# End to end test for apps

This runs once with real credentials before the first migration. It needs the test hub from phase 1
(`doguyilmaz/homebrew-tapster-test` with its `tapster` environment) and about an hour.

## 1. A fixture app

1. Make a small Sparkle app in a new public repository `doguyilmaz/tapster-sparkle-fixture`: one window, Sparkle 2.9
   or newer from Swift Package Manager, `SUFeedURL` set to
   `https://github.com/doguyilmaz/tapster-sparkle-fixture/releases/latest/download/appcast.xml`, `SUPublicEDKey` set
   to a new test key and both `SURequireSignedFeed` and `SUVerifyUpdateBeforeExtraction` set to true.
2. Create the test key with Sparkle's `generate_keys --account tapster-e2e`. Export a backup with `generate_keys
   --account tapster-e2e -x <file>` and keep the file until the test is done.
3. Run `bunx @doguyilmaz/tapster add` in the fixture. Commit the workflow it writes and paste the entry into the test
   hub's `tapster.yml` with the label `e2e`.
4. In the test hub run `bunx @doguyilmaz/tapster init --sparkle e2e --account tapster-e2e`, commit the workflow change
   and push.

## 2. A release through the hub

1. Tag `v1.0.0` in the fixture and push the tag. The release workflow opens a draft with the app archive.
2. Start the test hub's workflow by hand or wait for the schedule. The run should publish `Fixture-1.0.0.dmg`,
   `appcast.xml` and `checksums.txt` and remove the archive.
3. Download the DMG and check it:

   ```sh
   spctl -a -t open --context context:primary-signature -v Fixture-1.0.0.dmg
   xcrun stapler validate Fixture-1.0.0.dmg
   ```

   `spctl` must say `Notarized Developer ID`.
4. Check the feed signature with Sparkle's tool: `sign_update --verify appcast.xml <edSignature>` with the signature
   from the `sparkle-signatures` block.
5. Install the cask from the test tap and open the app.

## 3. Updates in place

1. Tag `v1.0.1`. When the hub has published it, choose "Check for Updates" in the installed `v1.0.0`. Sparkle must
   install `v1.0.1` without a warning.
2. Build a copy of the fixture from before the hub (signed and notarized by hand, with the same key, without
   `SURequireSignedFeed`), install it and check that it updates to the latest hub release.
3. Rotate the key: create a second key, set `next_key` and `next_public_key` in the hub, store it with
   `init --sparkle`, ship `v1.0.2` with the new public key in the app and check that `v1.0.1` updates to it. Then make
   the new key the current one, ship `v1.0.3` and check again.

## 4. Clean up

Delete the fixture repository, its releases and the `SPARKLE_KEY_E2E*` secrets, remove the keys from the login
keychain and delete the backup files.
