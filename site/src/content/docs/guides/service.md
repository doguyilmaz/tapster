---
title: "Keep setup running"
description: "Run tapster setup as a service on your computer, so its page is always there and updates tapster with one click."
sidebar:
  order: 11
---

`tapster setup` normally runs while you need it and stops after two hours without use. The tapster service keeps it
running on your computer instead: it starts when you log in, its page is always one `tapster setup` away and it tells
you when a new tapster is out. Your keys still go only to your own GitHub account and your own Cloudflare account.

## Install it

The service needs tapster installed, because `bunx` runs a temporary copy. Install it with Homebrew or Bun:

```sh
brew install --cask doguyilmaz/tap/tapster
```

```sh
bun add -g @doguyilmaz/tapster
```

Then install the service:

```sh
tapster service install
```

:::tip[You should see]{icon="approve-check-circle"}
`tapster setup now runs at http://127.0.0.1:8277 and starts when you log in. Open it with tapster setup.`
:::

On macOS this adds a LaunchAgent, `~/Library/LaunchAgents/com.doguyilmaz.tapster.plist`. On Linux it adds a systemd user
unit, `~/.config/systemd/user/tapster.service`. Both run `tapster setup --service` from the path your install keeps
across upgrades. If another program holds port 8277, the service takes the next free port up to 8299 and keeps it in
`~/.config/tapster/service.json`.

## Open the page

```sh
tapster setup
```

With the service running, `tapster setup` asks it for a link that works once and opens it. The page then stays signed in
in that browser for up to 30 days. After 12 hours without a click it locks. Then run `tapster setup` again.

## Update tapster

When a new release is out, the page says `tapster 1.7.5 is available`. Click **Update**, then confirm. tapster:

1. runs the upgrade of your install: `brew update` and `brew upgrade --cask tapster` for Homebrew,
   `bun add -g @doguyilmaz/tapster@<version>` for Bun, `npm install -g @doguyilmaz/tapster@<version>` for npm;
2. checks that the new `tapster --version` reports that version;
3. on macOS, checks that the new binary's signature is valid and comes from the same Apple Team ID as the running one;
4. restarts. The page waits for the new version and reloads where you were.

If a check fails, the running version stays. The page shows the reason and the command to run yourself.

## Update the hub

The hub keeps running the tapster version its workflow pins until you move it. After an update the page says
`The hub runs tapster 1.7.4` and whether the new version changes the code that runs in the hub. **Update the hub** lists
the files it changes and writes them to `main` in one commit, as the Hub files step does. You confirm first.

## Check on it

```sh
tapster service status
tapster service logs
```

`status` says which version runs and at which address. `logs` shows the recent log: on macOS from
`~/Library/Logs/tapster/service.log`, on Linux from the journal.

## Uninstall it

```sh
tapster service uninstall
```

This stops the service and removes the LaunchAgent or the unit and `~/.config/tapster`. tapster itself stays installed and
`tapster setup` works as before.

See [Security](/reference/security/#the-setup-page) for what the service lets a program on your computer do.
