---
title: "Sign apps with another certificate"
description: "Sign an app or a tool with a Developer ID certificate other than the hub's, such as one of a client's team."
sidebar:
  order: 8
---

The hub signs every package with its own Developer ID certificate. An entry can name another certificate instead. Use
it for an app of another Apple team, such as one you publish for a client's account. Or for an app that should carry a
certificate of its own. Entries that name none keep the hub's certificate.

## 1. Name it in the entry

Give the certificate a **label**: up to 40 lowercase letters and digits, such as `acme`. The label `id` is reserved.
Then add `certificate: <label>` to each entry that signs with it. Several entries may share a label.

```yaml
version: 1
tap: you/tap
packages:
  - name: mytool
    repo: you/mytool
    binaries: [mytool]
    assets:
      darwin-arm64: "mytool_{version}_darwin_arm64.tar.gz"
  - name: acmeapp
    repo: you/AcmeApp
    kind: app
    app: AcmeApp.app
    bundle_id: com.acme.AcmeApp
    assets:
      darwin-arm64: "AcmeApp-{version}.app.tar.gz"
    dmg: { name: "AcmeApp-{version}.dmg" }
    certificate: acme
```

`mytool` signs with the hub's certificate and `acmeapp` with the certificate `acme`. A certificate signs macOS code
only, so the entry needs a `darwin-*` asset. `{team}` in the app's entitlements becomes the Team ID of its certificate.

In tapster setup, open the project under **Projects**, click **Edit** under **Configuration**, add the line and click
**Propose and merge**. In a clone of the hub, edit `tapster.yml` and commit it with the workflow change of step 2.

## 2. Store the certificate

Export it as a `.p12` as in [Get your Apple credentials](/tutorial/apple/#2-export-it-as-a-p12-file). Store it before
the entry's next release. Until then the hub publishes no release of that entry and says
`<name> signs with the certificate <label>, which this hub has not stored`.

**In tapster setup**, open **Optional extras**. Under **Certificates for single apps**, each label of the hub's
`tapster.yml` on `main` has a card. Click **Store this certificate**, drop the `.p12` and type its password. tapster
checks the file, stores it and passes the certificate to the hub workflow on `main`.

**In a clone of the hub**, with the label in its `tapster.yml`:

```sh
bunx @doguyilmaz/tapster init --certificate acme
```

tapster names the entries that use the label, asks for the `.p12` and its password and checks them. Then it adds the
certificate's lines to the sign steps of `.github/workflows/tapster.yml`.

:::tip[You should see]{icon="approve-check-circle"}
`Certificate acme stored for team <team>. It expires on <date>; the hub warns 30 days before.`
:::

Review the workflow change, commit it with `tapster.yml` and push.

The hub workflow has to run a tapster that knows `certificate:`. An older one refuses the entries that name a
certificate. When `init --certificate` says the hub runs an older tapster, run `tapster init --workflow` too. In tapster
setup, update the workflow under **Hub files** when the certificates section asks for it.

:::note[Where your keys go]{icon="padlock"}
The certificate and its notarization key become secrets of the hub's `tapster` environment, like the hub's own. Only
the steps that sign and notarize macOS code see them.
:::

## 3. The notarization key

Apple notarizes code only with an App Store Connect API key of the certificate's team.

- **A certificate of the hub's team** uses the hub's notarization key. tapster asks for no other.
- **A certificate of another team** needs a key of that team. Create it in that team's App Store Connect as in
  [Create an App Store Connect API key](/tutorial/apple/#3-create-an-app-store-connect-api-key).
  `init --certificate` asks for it right after the certificate. In tapster setup, its form opens on the certificate's
  card.

To replace only that key:

```sh
bunx @doguyilmaz/tapster init --certificate acme --notary
```

When a label's certificate moves to the hub's team, tapster removes the key stored for that label if the hub has a
notarization key of its own. The hub's key notarizes it from then on. A renewal within the same team keeps the label's
key.

## What the hub stores

The names are the hub's own with `_<LABEL>` at the end. For the label `acme`, the hub's `tapster` environment holds:

| Name | Kind | What it holds |
| --- | --- | --- |
| `MACOS_SIGN_P12_ACME` | secret | The `.p12`. |
| `MACOS_SIGN_PASSWORD_ACME` | secret | Its password. |
| `TAPSTER_TEAM_ID_ACME` | variable | The certificate's Team ID. |
| `TAPSTER_CERT_EXPIRES_ACME` | variable | The day it expires. |
| `MACOS_NOTARY_KEY_ACME` | secret | The `.p8` of another team's key. |
| `MACOS_NOTARY_KEY_ID_ACME` | secret | Its Key ID. |
| `MACOS_NOTARY_ISSUER_ID_ACME` | secret | Its Issuer ID. |

The hub workflow passes the secrets to the steps that sign and notarize macOS code only. `tapster doctor` checks that
every label your entries name is stored, has a notarization key and reaches the workflow. In tapster setup, the
certificate's card says **Not in the workflow** when the workflow on `main` does not pass it.

## Renew it

Renew the certificate at developer.apple.com and export it again. In tapster setup, click **Replace the certificate**
on its card. In a clone of the hub, run `init --certificate acme` again. A key stored for the label stays when the
team stays the same. The hub's issue and `tapster doctor` warn 30 days before a certificate expires.

## Before you move an installed app

An app that users installed changes its code signature's identity when it moves to a certificate of another team.

- macOS may ask users again for permissions they granted the app.
- An app that updates with Sparkle may change its team or its Sparkle key in one release, never both. Sparkle accepts
  a new team when the update carries the app's Sparkle key. It accepts a new Sparkle key when the update carries the
  same Developer ID. See [Rotate a Sparkle key](/guides/sparkle/#rotate-a-sparkle-key).
