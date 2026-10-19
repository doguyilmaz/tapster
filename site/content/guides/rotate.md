---
title: Rotate a key
section: Guides
order: 8
description: Replace a certificate or key that expires, leaked or is due for a change.
---

Each key has its own command. Run it in a clone of your hub. The old key keeps working until the new one is stored, so
releases do not stop in between.

| Key | Command | When |
| --- | --- | --- |
| Developer ID certificate | `init --rotate certificate` | Before it expires. `doctor` warns 30 days ahead. |
| App Store Connect API key | `init --rotate notary` | When you revoke the old key or it leaked. |
| tapster App key | `init --rotate app` | When it leaked or at your own interval. |
| Doorbell App key | `init --rotate doorbell` | When it leaked or after an upgrade. See [Faster releases](/guides/doorbell#rotate-its-key). |
| Linux signing key | `init --rotate linux` | See [apt and dnf](/guides/linux#rotate-the-key). |
| Sparkle key | `next_key` in `tapster.yml` | See [Mac apps with Sparkle](/guides/sparkle#rotate-a-sparkle-key). |

## The Apple certificate

Renew the certificate in your Apple Developer account, export it as a `.p12` as in
[Get your Apple credentials](/tutorial/apple), then run:

```sh
bunx @doguyilmaz/tapster init --rotate certificate
```

tapster asks for the file and its password, checks them and replaces the secrets. Releases already published stay valid:
notarized software keeps working after its certificate expires.

## The notarization key

Create a new key in App Store Connect, then run:

```sh
bunx @doguyilmaz/tapster init --rotate notary
```

Once tapster says `Notarization key stored`, revoke the old key in App Store Connect.

## The tapster App key

```sh
bunx @doguyilmaz/tapster init --rotate app
```

1. tapster opens the App's settings page. Scroll to **Private keys** and click **Generate a private key**. Your browser
   downloads a `.pem` file.
2. Drag the file into the terminal and press Enter.

> [!SEE]
> `Stored the new key (SHA256:...).`
>
> `Now delete every other key on that page so the old one stops working. Then delete <path>.`

tapster checks that the key belongs to the hub's App before it stores it.
