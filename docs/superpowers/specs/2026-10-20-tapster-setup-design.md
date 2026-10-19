# tapster setup: a local app for the whole setup

## Goal

Someone who finds tapster on the GitHub Marketplace sets up a hub and adds their projects without learning a CLI. They
run one command, `bunx @doguyilmaz/tapster setup`, and a local app opens in their browser. It walks them through every
step, shows what each step changes and where each key goes, and does the work with buttons, file drops and forms that
their password manager understands. It finds the projects already cloned on their computer and adds them with a click.
The CLI keeps every capability for people who prefer it, and both share one implementation of each step.

The hub keeps itself healthy after setup: once a week it checks what it can and keeps one issue in the hub up to date
when something needs the owner.

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

- `tapster setup` starts it. Plain `tapster` in an interactive terminal does the same; with no terminal it prints the
  usage as today. `--no-open` prints the address without opening a browser. `--port <n>` picks the port.
- It listens on `127.0.0.1:8277` ("TAPS" on a phone keypad). Password managers store entries per address, so a stable
  port lets them fill the same entries next time. If the port is busy it says so and uses a free one.
- It opens `http://127.0.0.1:8277/#k=<token>`. The token sits in the fragment, so it never reaches a log or the history
  on the server side. The page keeps it in sessionStorage and removes it from the address bar.
- The terminal shows the address, says the app runs until Ctrl+C or "Close setup", and stops after two hours without a
  request.

### Security

- Every `/api` request carries `Authorization: Bearer <token>`, compared in constant time. No cookies, so other sites
  cannot ride a session (CSRF) and other local pages cannot read it.
- Host must be `127.0.0.1:<port>` or `localhost:<port>`; anything else gets 421 (DNS rebinding).
- Headers on every response: a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`, `nosniff`,
  `no-referrer` and `no-store`.
- The only routes without the token: the page itself, its script and style, and the GitHub App callback, which needs
  the single-use state the app created for that flow.
- Uploaded files (`.p12`, `.p8`, `.pem`) stay in memory, size-limited. The notary check needs a file path for
  `notarytool`, so the `.p8` is written to a private temporary folder and removed right after. Secrets reach GitHub
  through `gh secret set` on stdin, as today.
- Folder inputs must be absolute paths of git clones; tapster runs `git` with arguments, never through a shell.
- The app never sends a secret back to the browser, except a Sparkle key the user asked to see in order to save it.

### Password managers

- Secret fields are real `<form>` elements with `name` and `autocomplete` attributes: `current-password` for the
  `.p12` password, `new-password` for a key tapster creates and the user should keep, `username` for the account the
  entry belongs to.
- Each secret form has a username the user can see, such as `you/homebrew-tap: Developer ID certificate`, so the
  manager saves a meaningful entry and can tell entries apart.
- Successful forms are removed from the page after the request, which is how Chrome, Safari, 1Password and Bitwarden
  detect a submission in a single page app. No paste blocking, no custom password widgets.
- A Sparkle key that tapster creates is shown in a "save it in your password manager" form (`new-password`), next to
  a copy button, before it goes to the hub. The same key also stays in the keychain, as today.

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
2. **Hub.** Pick one of your repositories named `homebrew-*`, or create `homebrew-tap` (public by default, with the
   reason). The current folder's repository is preselected when it is a tap.
3. **Protect.** One button runs the same protection as `tapster init`. The stop lists the four protections and shows
   each as done when GitHub has it.
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
   commit through the API. Also the place to move the hub to this tapster version and to change the schedule.
9. **First project.** Leads to Projects.

### Projects

- tapster finds the git clones on this computer whose `origin` is one of the user's own GitHub repositories. It looks
  in the current folder, its parent and the usual places (`~/Developer`, `~/Projects`, `~/projects`, `~/code`, `~/Code`,
  `~/src`, `~/dev`, `~/git`, `~/GitHub`, `~/Documents/GitHub`, `~/repos`, `~/workspace`, `~/work`), three levels deep,
  skipping `node_modules`, hidden folders and `Library`, with a time and folder limit. The user can add any folder.
  It reads `.git/config` and a few build files only; the page says so.
- Each clone shows its kind (GoReleaser Go tool, Bun tool, Mac app with Sparkle, or not supported and why) and its
  state: not in the hub, proposed (open pull request on the hub), in the hub, last version published.
- **Add** opens a sheet: what tapster changes in the clone (files) and on GitHub (ruleset, deploy key, pull request),
  the options as switches with their trade-offs (automatic tags, Dependabot, which workflow runs GoReleaser, replace an
  existing release workflow), then one button. The result shows each change, the diff of the clone, and the next steps
  as buttons:
  - **Commit and push** commits only the files tapster changed, with a fixed message, and pushes the current branch.
  - **Merge the hub entry** merges tapster's pull request on the hub after showing the entry.
  - **Install the App on this project** opens GitHub's install page with the project selected.
  - **Release**: the tag command to copy and a link to watch the hub's runs.

### Health

- The `doctor` checks with their fixes, grouped as problems first. Fixes that the app can do have a button (restore the
  protection, rewrite the workflow); the others say what to do.
- The hub's weekly report (section 3), when there is an open one.
- The hub's recent runs with their result, and a "Run the hub now" button.

### Extras (in Setup, after the main stops)

- Linux packages: makes the signing key (needs gpg) and turns on Pages, as `init --linux`.
- Sparkle keys: create a key for an app (keychain plus the password manager form) or store one from the keychain.
- Doorbell: needs a Cloudflare login through wrangler, which is interactive; the stop explains it and gives the command.

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

- `mode` becomes optional with the default `guide`. The snippet the Marketplace shows (`uses: doguyilmaz/tapster@v1`)
  then runs the guide: a run summary that says what tapster is, what it can see of this repository (a tap, public,
  `tapster.yml`, the hub workflow) and the next step, with both ways: the setup app (`bunx @doguyilmaz/tapster setup`) or
  the CLI. It needs no secrets and no checkout and runs in any workflow.
- When the real hub workflow runs before the setup is finished, the missing variable or secret errors say to finish
  the setup with `bunx @doguyilmaz/tapster setup` or the CLI command.
- The README leads with these two paths. The Marketplace listing is prepared from it; its field values go to the owner
  at that step.

## 3. The weekly health report

- The hub workflow gets a second schedule, once a week (Monday 07:17 UTC), and a `report` input for manual runs.
- The `check` job records its findings (failures and warnings, never per-run waiting notes) as an output, also when it
  fails early.
- A new `report` job runs only on the weekly schedule or with `report`, after `check`. It holds no keys: its token can
  write issues only. It keeps one issue titled "tapster: the hub needs attention": opens it with the findings and the
  fix for each, edits it when they change, closes it with a comment when all is well. It also says when a newer tapster
  is out. A failed or cancelled `check` without findings is itself a finding.
- On the other schedule runs the `report` job is skipped, so private hubs pay no extra minutes.
- `doctor` and the setup app's Health show the open issue.

## 4. Docs

- The tutorial's hub and project steps show both ways in tabs, the setup app first, with screenshots from the demo.
- The README and the commands reference gain `tapster setup`. A troubleshooting entry covers a busy port and the
  token link.

## Not in this round

- The doorbell's Cloudflare login inside the app (it stays a CLI step with a clear explanation).
- Tagging a release from the app (the app gives the command).
- MCP server, skills and AI integration: next, from the backlog.
- Notifications to Slack or Discord when a release ships: an idea for later (`notify:` with a webhook secret).

## Testing

- Server: host check, token check, headers, the callback state, upload limits, every route's input validation.
- Operations: the existing CLI tests keep passing; new tests for the split certificate and notary checks, the hub file
  plan, the API commit, the folder scan and project inspection, the report job's issue logic and the guide summary.
- Browser: the demo app driven in headless Chrome through the main path, with screenshots at desktop and phone width in
  both themes, failing on any console error.
