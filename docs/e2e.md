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

# End to end test for the doorbell and Linux packages

## 5. The doorbell

1. In the test hub run `bunx @doguyilmaz/tapster init --doorbell`. Sign in to Cloudflare when Wrangler asks, click
   "Create GitHub App" and install the new App on the test hub only.
2. Run `bunx @doguyilmaz/tapster doctor` in the test hub; every project must have `TAPSTER_DOORBELL`.
3. Tag a fixture release. The hub's workflow must start within a minute of the draft opening, with the event
   `workflow_dispatch`. The fixture's "Ring the tapster hub" step answers `202`.
4. Send the Worker a token from a repository of another account (for example a fork in a second account): it must
   answer `401`.

## 6. apt and dnf

1. Set `linux: true` on the CLI fixture in the test hub, add `linux.maintainer` and run
   `bunx @doguyilmaz/tapster init --linux`. Commit and push.
2. Start the hub's workflow by hand with `linux` ticked. `linux-build`, `linux-sign` and `linux-pages` must pass.
3. Follow the commands on the site's front page in an Ubuntu and a Fedora machine or container. Both must install and
   run the fixture.
4. Start the workflow again with `linux` ticked: `linux-build` must report that the live repositories are current.

## 7. Clean up

If the test hub keeps no doorbell, delete the doorbell App, the `tapster-doorbell` Worker and the `TAPSTER_DOORBELL*`
variables. If it keeps no Linux packages, delete the `TAPSTER_LINUX_KEY` secret.
