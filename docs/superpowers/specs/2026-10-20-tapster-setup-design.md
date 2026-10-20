# tapster setup: a local app for the whole setup

## Goal

Someone who finds tapster on the GitHub Marketplace sets up a hub and adds their projects without learning a CLI. They
run one command, `bunx @doguyilmaz/tapster setup`, and a local app opens in their browser. It walks them through every
step, shows what each step changes and where each key goes, and does the work with buttons, file drops and forms that
their password manager understands. It finds the projects already cloned on their computer and adds them with a click.
The CLI keeps every capability for people who prefer it, and both share one implementation of each step.

The hub keeps itself healthy after setup: every run checks what it can, and one issue in the hub opens when something
needs the owner and closes itself once it is fixed.

Nothing changes in where keys go: from the user's computer to their own GitHub (and, for the doorbell, Cloudflare)
account. tapster has no server.

## What the user said (2026-10-20)

- The Action should lead: someone adds it from the Marketplace and its README and run output tell them each step.
- CLI exposure minimal, CLI capability kept. Adding projects works through the CLI or the guided path.
- The web setup is essential: "not everyone should have to use the CLI". The Action's directions may split into the
  setup app and the CLI.
- Doctor as a weekly job in the user's own hub.
- Very good UI and UX that really helps; no cheap wizard, no AI slop in code or UI.
- Password manager friendly: entering or saving a secret should trigger the password manager.
- Connect it to local apps, better than the earlier tools (ebb, lockstep).
- Think of integrations; ship by the morning: merge and publish the Action.

Assumptions (the user was away): "local apps" means both serving the setup as a local web app (as ebb and lockstep do)
and connecting the user's local project clones to the hub. The wizard does not need a clone of the hub: it writes the
hub's files through GitHub's API.

## Why setup cannot run inside Actions

- Creating the GitHub App needs the owner's click on GitHub.
- The Apple certificate and notary key are files on the owner's computer.
- Protecting the hub (environment, rulesets, Actions policy) needs admin rights. Giving the hub's workflow those rights
  would let a stolen App key remove the protection that makes it harmless.

So the Action guides and checks; the setup app (or the CLI) on the owner's computer does the setup.

## 1. The setup app

### Start

- `tapster setup` starts it; plain `tapster` keeps printing the usage, which now starts with `tapster setup`.
  `--no-open` prints the address without opening a browser, `--port <n>` picks the port and `--tapster <commit>` pins a
  development build, as for `init`. On Windows it says that setup needs macOS or Linux.
- It listens on `127.0.0.1:8277` ("TAPS" on a phone keypad). Password managers store entries per address, so a stable
  port lets them fill the same entries next time. If the port is busy it says so and uses a free one.
- It opens `http://127.0.0.1:8277/#c=<code>`. The code works once: the page trades it for the session token
  (`POST /api/claim`), keeps the token in sessionStorage and removes the code from the address bar. A copy of the link in
  the browser history, the terminal or another user's process list is worthless once claimed. A second claim of the same
  code means someone else had the link: tapster ends every session, says so in the terminal and prints a fresh link.
- The terminal shows the address, says the app runs until Ctrl+C or "Close setup", opens a fresh link when the user
  presses Enter (a closed tab loses its session) and stops after two hours without a request.

### Security

- Every `/api` request carries `Authorization: Bearer <token>`, compared in constant time. No cookies, so other sites
  cannot ride a session (CSRF) and other local pages cannot read it.
- Host must be `127.0.0.1:<port>` or `localhost:<port>`; anything else gets 421 (DNS rebinding).
- Headers on every response: a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`, `nosniff`,
  `no-referrer` and `no-store`.
- The only routes without the token: the page itself, its script, style and images, the claim, and the GitHub App
  callback, which needs the single-use state the app created for that flow. The manifest form submits in the same tab,
  so the page that GitHub sends back still holds the session.
- Uploaded files (`.p12`, `.p8`, `.pem`) stay in memory, size-limited. The notary check needs a file path for
  `notarytool`, so the `.p8` is written to a private temporary folder and removed right after. Secrets reach GitHub
  through `gh secret set` on stdin, as today.
- Folder inputs must be absolute paths of git clones; tapster runs `git` with arguments, never through a shell. Reading
  git runs with `-c core.fsmonitor= --no-ext-diff --no-textconv`. Files are read only when `lstat` says they are regular
  files under 1 MB, so a link to a device or a FIFO cannot hang the app.
- Before any write to the hub's `main` the app runs the hub's own foreign-commit check with the user's token. If someone
  else changed `main` since the owner's last push, it stops and lists the files: a write from the owner would otherwise
  mark those commits as reviewed. The hub entry's pull request is merged on GitHub, where the owner sees its files.
- The app never sends a secret back to the browser, except a Sparkle key the user asked to see in order to save it.

### Password managers

- Secret fields are real `<form>` elements with `name`, `autocomplete="current-password"` and a username field with
  `autocomplete="username"` whose value names the entry, such as `you/homebrew-tap: Developer ID certificate`, so the
  manager saves a meaningful entry and can tell entries apart.
- The form submits through a real submit button. The script prevents the navigation, sends the request, and on success
  removes the form and changes the address (`pushState`). Chrome detects a save when the form disappears, 1Password and
  Bitwarden react to the submit itself, Safari to a submit followed by an address change. No paste blocking, no custom
  password widgets, `spellcheck` off. Only one secret form is on the page at a time, so autofill cannot land in the
  wrong one.
- A Sparkle key that tapster creates is shown read-only with a copy button. To keep a copy in the password manager the
  user pastes it into the form's password field (a paste counts as typing, which is what triggers the save); tapster
  stores the key in the hub only when the pasted value equals it. `new-password` is not used, because managers would
  offer a generated password there and could save that instead.
- 1Password and Bitwarden match `127.0.0.1` without the port, so they offer these entries on other local pages too; the
  entry names start with the hub so they are recognizable.

### Layout and design

- The brand of the docs site: the courier octopus, the airmail stripe, orange for actions, wax red for seals. System UI
  font, mono only for names and commands. Light and dark.
- A header with the logo, the hub picker and the GitHub account. Three sections: **Setup**, **Projects**, **Health**.
- Setup is a route of stops, the way a parcel tracking page shows a delivery: done stops carry a seal, the current stop
  is open, later stops are quiet. Each open stop says what it does, what it changes on GitHub and where its key goes,
  then shows one primary action. Progress comes from GitHub's state, never from local flags, so a second run shows the
  truth.
- Waiting states (the App install, a hub run) poll the server every few seconds, back off, pause while the tab is
  hidden and continue on their own.
- Errors read as sentences: what happened and what to do, with the same reason and fix the CLI prints.
- Every screen works at phone width, with visible keyboard focus and reduced motion respected.

### The steps

1. **Account.** `gh` installed and signed in, with the scopes tapster needs (`repo`, `workflow`). If not, the exact
   command to run, a copy button and an automatic re-check.
2. **Hub.** Pick one of the repositories you own whose name starts with `homebrew-`, or create `homebrew-tap` (public
   by default, with the reason, created with a first commit). The current folder's repository is preselected when it is
   a tap. Organization repositories are not offered: tapster serves personal accounts.
3. **Protect.** One button runs the same protection as `tapster init`. The stop lists the protections and shows each
   as done when GitHub has it. Before it runs, it lists the hub's other workflows that use actions from anyone else
   (such as the `tests.yml` and `publish.yml` of `brew tap-new`): they stop running, and their commits would make the
   hub refuse to run. The hub files step can remove them.
4. **GitHub App.** The page explains the App and its permissions, then posts the manifest to GitHub. GitHub sends the
   user back to the app, which stores the App and its key in the hub and opens the install page. While the app holds
   the new key in memory it checks the installation every few seconds and says when it is done, or that the hub was
   picked by mistake.
5. **macOS.** "Will this hub sign macOS software?" Yes shows the two Apple stops, No skips them and says how to add
   them later. A hub that already has Apple credentials skips the question.
6. **Certificate.** Drop the `.p12`, type its password, tapster checks it with openssl (team, expiry, private key) and
   stores it. Shows the team and expiry when done, with a "Replace" action for renewals.
7. **Notary key.** Drop the `.p8`, Key ID and Issuer ID (with where to find them), checked with Apple on a Mac.
8. **Hub files.** The four files with their content (and a diff for a workflow that changes), written to `main` in one
   commit through the API, after the foreign-commit check. Existing files other than the workflow are kept. An empty
   repository gets its first commit through the contents API. Also the place to move the hub to this tapster version,
   to change the schedule and to remove the old tap workflows. A local clone of the hub needs a `git pull` afterwards;
   the page says so, and `init` refuses to read a clone that is behind `main`.
9. **First project.** Leads to Projects.

### Projects

- tapster finds the git clones on this computer whose `origin` is one of the user's own GitHub repositories. It looks
  in the current folder, its parent and the usual places (`~/Developer`, `~/Projects`, `~/projects`, `~/code`, `~/Code`,
  `~/src`, `~/dev`, `~/git`, `~/GitHub`, `~/repos`, `~/workspace`, `~/work`), three levels deep, skipping
  `node_modules`, hidden folders and `Library`, with a time and folder limit. Folders macOS guards with a privacy prompt
  (Documents, Desktop, Downloads) are read only when the user adds them. It reads `.git/config` and checks which build
  files exist; the page says so. A project's build files are read when the user opens it.
- Each clone shows its kind (GoReleaser Go tool, Bun tool, Mac app with Sparkle, or not supported and why) and its
  state: not in the hub, proposed (open pull request on the hub), in the hub, last version published.
- **Add** opens a sheet: what tapster changes in the clone (files) and on GitHub (ruleset, deploy key, pull request),
  the options as switches with their trade-offs (automatic tags, Dependabot, which workflow runs GoReleaser, replace an
  existing release workflow), then one button. The result shows each change, the diff of the clone, and the next steps
  as buttons:
  - **Commit** commits only the files tapster changed, with a fixed message, in the user's own environment (their hooks
    and commit signing apply). **Push** pushes the current branch with prompts turned off; when git needs a password
    or a passphrase it fails fast and the page gives the command to run in a terminal.
  - **Review the hub entry** opens tapster's pull request on the hub; the owner merges it there.
  - **Install the App on this project** opens GitHub's install page with the project selected.
  - **Release**: the tag command to copy and a link to watch the hub's runs.

### Health

- The `doctor` checks with their fixes, grouped as problems first. Fixes that the app can do have a button (restore the
  protection, rewrite the workflow); the others say what to do.
- The hub's health issue (section 3), when one is open.
- The hub's recent runs with their result, and a "Run the hub now" button.

### Extras (in Setup, after the main stops)

- Sparkle keys: stores a key from the keychain for each label in `tapster.yml`. The page shows it read-only, the user
  pastes it into a password form (so the password manager offers to keep the offline copy), tapster checks the paste
  and then stores it and passes it to the hub workflow. Making a new key stays a terminal step (`init --sparkle --new`).
- Linux packages and the doorbell show their state and the terminal command: they need gpg or a Cloudflare login
  through Wrangler.

### Architecture

- `src/web/server.ts`: the server, security checks and the routing table. Dependencies (GitHub client, `gh` secret
  writes, `git`, `openssl`, the keychain, the folder scan) are injected, so tests and the demo run against fakes.
- `src/web/api/*.ts`: one module per area (account and hub, setup steps, projects, health). Each handler validates its
  input with zod and calls the shared operations.
- `src/web/client/`: Preact 10 with signals. One stylesheet with tokens. Built by Bun into a string; in development
  and tests it is built on first request, and the release build inlines it with a Bun plugin, for `dist/cli.js` and
  the compiled binaries alike (`scripts/build.ts`).
- Shared operations move out of the prompts: certificate and notary checks take bytes and strings, `add` takes its
  answers and reports through a callback, hub files are planned once and either written to a clone (CLI) or committed
  through the API (app), doctor returns its checks. The CLI keeps its output and options.
- A demo (`bun run demo`, not shipped) starts the app on a fake GitHub with sample state, for screenshots and for the
  browser tests.

## 2. The Action leads the setup

- `mode` becomes optional with the default `guide`. The snippet the Marketplace shows (`uses: doguyilmaz/tapster@v1.x.y`)
  then runs the guide: a run summary that says what tapster is, what it can see of this repository from the run's own
  event (its name, whether it is public, the workflow that ran) and the next step, with both ways: the setup app
  (`bunx @doguyilmaz/tapster setup`) or the CLI. It runs before the hub guard, needs no token, no secrets and no
  checkout, and runs in any workflow. There is no token input: every hub step would receive it.
- When the real hub workflow runs before the setup is finished, the missing variable or secret errors say to finish
  the setup with `bunx @doguyilmaz/tapster setup` or the CLI command.
- The README leads with these two paths. The Marketplace listing is prepared from it; its field values go to the owner
  at that step.

## 3. The health issue

The user asked for a weekly doctor. A fixed weekly run would be fragile: the hub's concurrency group keeps one pending
run, so a tick or a doorbell ring cancels a queued weekly run, and it would be an extra billed run on private hubs. So
the check job decides on every run whether the issue needs a change, and the issue changes only when the findings do.

- The `check` job collects findings: failures (including a check that stops early), the certificate expiring within 30
  days and a newer tapster release. Choices the owner accepted (`protection: off`, the App on extra repositories) and
  per-run waiting notes are not findings.
- It reads the open issue that `github-actions[bot]` opened with the title "tapster: the hub needs attention" (its token
  gets `issues: read`) and compares a hash of the findings with the one the issue carries. It sets `report=true` when
  they differ, or when the issue is open and nothing is wrong.
- A `report` job runs only then. Its token can write issues and nothing else; it holds no keys. It opens the issue with
  each finding and its fix, edits it when the findings change and closes it with a comment once all is well. The
  findings reach it as an action input, never through a shell.
- Variable parts that a project can influence (tags, asset names, repository names) are written as code spans with
  backticks removed, HTML escaped and length capped, so a crafted draft cannot mention people or plant links.
- A hub with issues turned off gets a line in the run summary instead.
- The setup app's Health shows the open issue as plain text.

## 4. Docs

- The tutorial's hub and project steps show both ways in tabs, the setup app first, with screenshots from the demo.
- The README and the commands reference gain `tapster setup`. A troubleshooting entry covers a busy port and the
  token link.

## 5. AI assistants

- `tapster mcp` serves six tools over stdio: `hub_status`, `doctor`, `hub_runs`, `release_status`, `local_projects`
  (read only) and `run_hub`. They use the GitHub CLI sign-in, act only on the user's own hubs and never touch keys.
- Two skills in `skills/` (setup and release diagnosis), installable with `bunx skills add doguyilmaz/tapster`.

## Not in this round

- The doorbell's Cloudflare login inside the app (it stays a CLI step with a clear explanation).
- Tagging a release from the app (the app gives the command).
- Merging the hub entry from the app (GitHub shows the owner the exact files).
- Linux keys and the doorbell inside the page.
- Notifications to Slack or Discord when a release ships: an idea for later (`notify:` with a webhook secret).

## Testing

- Server: host check, token check, headers, the callback state, upload limits, every route's input validation.
- Operations: the existing CLI tests keep passing; new tests for the split certificate and notary checks, the hub file
  plan, the API commit, the folder scan and project inspection, the report job's issue logic and the guide summary.
- Browser: the demo app driven in headless Chrome through the main path, with screenshots at desktop and phone width in
  both themes, failing on any console error.
