# tapster service: setup that stays open and updates itself

## Why

Today `tapster setup` is a short-lived process. It opens a one-time link, it stops after two hours without use and every
tapster release means: stop setup, upgrade, start setup again, then write the hub files. For the owner, who also
releases tapster through tapster, that loop repeats on every release. Nobody wants to run it.

The goal: a setup page that is always there on this computer, shows "tapster 1.7.5 is available" and updates itself with
one click, then offers the hub's update the same way. Nothing that works today gets worse or goes away.

## What stays the same

- No server of ours. The page runs on this computer only; keys still go only to the user's own GitHub (and the
  doorbell key to their own Cloudflare).
- `bunx @doguyilmaz/tapster setup` keeps working as a one-shot session, as today.
- `tapster setup` without a service behaves as today and suggests `tapster service install` once.
- The hub keeps pinning tapster by commit. Moving the pin stays the owner's click.

## The service

`tapster service install | uninstall | status | logs`.

- macOS: a LaunchAgent `~/Library/LaunchAgents/com.doguyilmaz.tapster.plist` with `RunAtLoad` and `KeepAlive`. It runs the
  stable command path of the install (Homebrew's `bin/tapster` link, `~/.bun/bin/tapster` or npm's global bin), never a
  versioned path, so an upgrade takes effect on restart. Logs go to `~/Library/Logs/tapster/service.log`.
- Linux: a systemd user unit `~/.config/systemd/user/tapster.service`, `Restart=always`, enabled with
  `systemctl --user enable --now`.
- The service runs `tapster setup --service`: no browser opening, no one-time link in a terminal, no idle stop.
- It needs a stable install. From `bunx` (a temporary copy) `service install` refuses and names the ways to install:
  `brew install --cask doguyilmaz/tap/tapster` or `bun add -g @doguyilmaz/tapster`.
- Port: 8277. If something else holds it at install time, the service takes the next free port from 8278 to 8299
  and records it in `~/.config/tapster/service.json` (`{ port }`, mode 0600). `tapster setup` reads it.
- `service uninstall` stops and removes the agent or unit and the state folder. It leaves the install itself alone.

## Opening the page

`tapster setup` asks the service, over a Unix socket `~/.config/tapster/service.sock` (mode 0600, owner only), for a
pairing link and opens it. If no service answers, it starts the one-shot session as today. The CLI never talks to the
service over TCP.

## Sign-in to the page

- The page pairs once per browser: the pairing link carries a single-use code (as `#c=` today). `POST /api/claim`
  answers with a session cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, 30 days, rotated on each claim. JavaScript
  never sees it.
- Every `/api` request must carry `X-Tapster: 1` (a custom header, so another site cannot send it without a CORS
  preflight, which the service never grants) and an `Origin` equal to the page's own origin when present. The Host
  allowlist and CSP stay as they are.
- Idle lock: after 12 hours with no request, the session needs a new pairing (`tapster setup` gives one).
- Actions that write keys, merge to the hub's main, tag a release or update tapster ask for a confirm click on the
  page.
- The one-shot session uses the same cookie scheme, ending with the process.

What this protects against: other websites (CSRF and DNS rebinding) and other browsers or users on this computer.
What it cannot change: a program already running as this user can read `gh`'s token itself. The service must
never be a stronger door than that, so no endpoint returns a token, key or secret value, as today.

## Secrets in the service

- The GitHub token is read with `gh auth token` per request and kept at most 60 seconds in memory, never on disk.
- App, Apple, Sparkle, Linux and Cloudflare secrets stay in memory only for the request that sends them to GitHub or
  Cloudflare, as today. A held App key from the manifest flow expires after one hour.
- Logs carry no request bodies and pass through the existing mask.

## Updating tapster

- The service checks the latest tapster release on GitHub when the page loads and every six hours, using the user's
  token. A banner says "tapster 1.7.5 is available" with Update.
- Update runs the install's own upgrade (`brew update` then `brew upgrade --cask tapster`; `bun add -g
  @doguyilmaz/tapster@<version>`; `npm install -g @doguyilmaz/tapster@<version>`), as `tapster upgrade` does.
- Before restarting, the service checks the new command: it runs `tapster --version` and expects the new version.
  On macOS, for a signed binary, `codesign --verify` passes and the Team ID equals the running binary's Team ID.
  If any check fails, the old service keeps running and the page shows the error and the command to run.
- Then the service exits; launchd or systemd starts the new one. The page polls `/api/session` until it reports the
  new version and reloads itself.
- After that, the hub banner: "The hub runs tapster 1.7.4" with the hub code note (needed or optional) and Update the
  hub, which writes the hub files as the Hub files step does today.

## Tests

- Plist and unit text, the stable command path per install kind, the refusal from bunx, the port choice.
- Socket pairing: only the owner can connect, a code works once, a second claim rotates the cookie.
- Cookie and header checks: missing header, foreign Origin, wrong Host and an expired idle session are refused.
- Update: version check, Team ID mismatch refusal, the old service stays up when the upgrade fails, restart happens
  only after the checks pass. All commands run through an injected runner.
- The page reloads on a new version, without losing its place.
- The one-shot session still works end to end (the existing web tests).
