# tapster phase 3: doorbell, docs site, Marketplace and Linux packages

Phase 1 ([2026-10-18-tapster-design.md](2026-10-18-tapster-design.md)) and phase 2
([2026-10-19-tapster-phase2-design.md](2026-10-19-tapster-phase2-design.md)) hold the base design. Their decisions
stand unless this document changes them. The decisions for this phase are in phase 1, §20.

## 1. Goals

1. **Fast releases.** A project that opens a draft rings the hub, which starts within a minute. The 10-minute
   schedule stays as the fallback.
2. **One narrow credential outside GitHub.** The Worker that answers the ring holds one key: that of a separate
   dispatch App that can only start workflows in the hub.
3. **Docs** at `https://tapster.doguyilmaz.com`, built from the README and deployed by tapster's CI.
4. **Marketplace.** tapster can be listed on the GitHub Marketplace.
5. **apt and dnf.** CLI packages with Linux builds install with `apt` and `dnf` from the hub's GitHub Pages site,
   signed with a key that lives only in the hub.
6. **No leaks, proven.** The leak test covers the Linux key. The Worker never logs a token.

Personal accounts only, as before.

## 2. Doorbell

### 2.1 Flow

1. The project's release workflow opens the draft as today. Its last step asks GitHub for an OIDC token whose audience
   is the doorbell's URL and POSTs it to that URL.
2. The Worker checks the token (§2.2). If it passes, it starts the hub's `tapster.yml` with `workflow_dispatch` on
   `main` (§2.3) and answers `202`.
3. The hub's concurrency group keeps one run going and one waiting, so a burst of rings collapses into at most two
   runs. The hub ignores dispatch inputs from the doorbell (it sends none).

No webhooks: personal accounts have no account-level webhooks. A release webhook also fires before the assets are
uploaded. The ring comes after the draft is complete.

### 2.2 Token checks

The Worker answers `401` with an empty body unless all of these hold:
- the `Authorization` header is `Bearer <jwt>` and the token is at most 8 KiB;
- the header says `alg: RS256` and names a `kid` found in GitHub's key set
  (`https://token.actions.githubusercontent.com/.well-known/jwks`, kept for an hour, fetched again once for an
  unknown `kid`);
- the RS256 signature verifies with that key (WebCrypto);
- `iss` is `https://token.actions.githubusercontent.com`;
- `aud` is a string equal to the origin of the request URL, so a token minted for another service never works here;
- `repository_owner_id` equals the hub owner's numeric id (`OWNER_ID`);
- `runner_environment` is `github-hosted`;
- `ref_type` is `tag` and `ref` starts with `refs/tags/v`;
- `event_name` is `push` or `workflow_dispatch`;
- `exp` is no more than 60 seconds in the past, `nbf` and `iat` no more than 60 seconds in the future;
- the token lives at most an hour (`exp - iat <= 3600`).

Any repository of the owner may ring. A ring only makes the hub look at its own `tapster.yml`, so a ring from an
unrelated repository costs one short check run. There is no replay store for the same reason.

### 2.3 Dispatch

With the token checked, the Worker:
1. signs an App JWT (RS256, `iat` now minus 60 s, `exp` now plus 9 minutes, `iss` the App id) with `APP_KEY`;
2. reads the installation on the hub (`GET /repos/{HUB}/installation`);
3. asks for a token limited to the hub and to `actions: write`
   (`POST /app/installations/{id}/access_tokens` with `repository_ids: [HUB_ID]`);
4. calls `POST /repos/{HUB}/actions/workflows/tapster.yml/dispatches` with `{"ref": "main"}`;
5. revokes the token (`DELETE /installation/token`).

A GitHub failure answers `502`. Requests carry `User-Agent: tapster-doorbell`, `Accept: application/vnd.github+json`
and `X-GitHub-Api-Version: 2022-11-28`. The Worker logs one line per request: the verified `repository` and `ref`
and the answer, never a token or a key.

Variables: `APP_ID`, `HUB` (`owner/repo`), `HUB_ID`, `OWNER_ID`. Secret: `APP_KEY` (PKCS#8 PEM). The Worker has no
dependencies.

### 2.4 The dispatch App

A second App, separate from the hub's App: `Actions: write` and `Metadata: read`, no events, no webhook, installed on
the hub only. The hub's App keeps no `Actions` access. This App gets nothing on the projects. Its key lives only in
the Worker.

### 2.5 Setup: `tapster init --doorbell`

Run in the hub clone, with `gh` signed in and Wrangler signed in (`bunx wrangler@4.151.1 login`; `init` explains
this when `wrangler whoami` fails):
1. Create the dispatch App with the manifest flow (the user clicks "Create GitHub App" and installs it on the hub).
2. Convert its key to PKCS#8 in memory.
3. In a temporary folder, write the Worker, a `wrangler.jsonc` with the four variables and the pinned Wrangler
   `package.json` and `bun.lock` (§3.2); run `bun install --frozen-lockfile`, `wrangler deploy` and
   `wrangler secret put APP_KEY` (the key goes through stdin). Delete the folder.
4. Read the `workers.dev` URL from Wrangler's output and store it as the variable `TAPSTER_DOORBELL` in the hub's
   `tapster` environment and in every project repository listed in `tapster.yml`.

`doctor` checks that every project has `TAPSTER_DOORBELL` equal to the hub's, when the hub has one.

### 2.6 The ring step

`tapster add` and the templates add this as the last step of the job that opens the draft (it already has
`id-token: write` for the attestation):

```yaml
- name: Ring the tapster hub
  if: ${{ vars.TAPSTER_DOORBELL != '' }}
  continue-on-error: true
  env: { DOORBELL: "${{ vars.TAPSTER_DOORBELL }}" }
  run: |
    set -euo pipefail
    token=$(curl -fsS -G --data-urlencode "audience=$DOORBELL" \
      -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL" | jq -r .value)
    echo "::add-mask::$token"
    curl -fsS -X POST -H "Authorization: Bearer $token" "$DOORBELL"
```

A failed ring never fails the release; the schedule picks the draft up.

### 2.7 Threats

| Threat | Handling |
| --- | --- |
| A token from someone else's workflow | `repository_owner_id` and `aud` checks. |
| A token from the owner's unrelated repository or a replay | One extra check run; runs collapse in the concurrency group. |
| The Cloudflare account is taken over | The attacker can start, rerun or cancel hub runs. The dispatch token cannot read secrets, push or touch projects. The `tapster` environment opens only on `main`. |
| The Worker logs a token | It logs only verified claims; the leak review checks the code. |

## 3. Docs site

### 3.1 Content

`site/build.ts` turns `README.md` into `site/dist/index.html` with a small Markdown converter for what the README
uses: headings, paragraphs, lists, fenced code, inline code, bold and links. All text is HTML-escaped. Relative links
become links to the file on GitHub. The page has inline CSS with a light and a dark scheme, no scripts and no external
requests.

### 3.2 Deploy

- `site/wrangler.jsonc` describes an assets-only Worker `tapster-docs` with the custom domain
  `tapster.doguyilmaz.com`.
- Wrangler `4.151.1` is pinned in `templates/wrangler/package.json` with its `bun.lock`, used by the docs workflow and
  by `init --doorbell`.
- `.github/workflows/docs.yml` runs by hand and on pushes to `main` that touch `README.md` or `site/`. It builds the
  page and runs `wrangler deploy` in a `docs` environment holding `CLOUDFLARE_API_TOKEN` (Workers Scripts edit and
  Workers Routes edit on `doguyilmaz.com`) and `CLOUDFLARE_ACCOUNT_ID`. The job has `contents: read` only.

## 4. Marketplace

`action.yml` gets `name: Tapster Release Hub` (the name `tapster` belongs to an existing GitHub user), `author` and
`branding` (`icon: package`, `color: orange`). Listing happens when the owner ticks "Publish this Action to the GitHub
Marketplace" on a release of the public repository.

## 5. Linux packages

### 5.1 Config

```yaml
linux:
  maintainer: "Dogu Yilmaz <dogu@example.com>"
  url: https://doguyilmaz.github.io/homebrew-tap   # optional; this is the default
packages:
  - name: aims
    linux: true
    assets:
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
      linux-arm64: "aims_{version}_linux_arm64.tar.gz"
```

- `linux: true` is allowed on CLI packages with at least one Linux asset.
- The hub's `linux.maintainer` (`Name <address>`) is required once any package sets it. `linux.url` defaults to the
  hub's GitHub Pages address.
- Only the latest stable release of each package is served. Prereleases are not packaged.

### 5.2 What a run does

Three jobs follow the sign job:

| Job | Runner | Credentials | Work |
| --- | --- | --- | --- |
| `linux-build` | ubuntu-24.04 | none | Builds every `.deb` and `.rpm` from verified release archives. |
| `linux-sign` | ubuntu-24.04 | `TAPSTER_LINUX_KEY` (`tapster` environment) | Signs the packages, writes and signs the repository metadata, uploads the site. |
| `linux-pages` | ubuntu-24.04 | `pages: write` (`github-pages` environment) | Deploys the site. |

`check` sets the output `linux` when a Linux package has work or when the live `tapster-linux.json` differs from the
latest stable releases in the state. The jobs run when it is set and skip otherwise.

### 5.3 linux-build (no credentials)

For each Linux package, from the state on `main`:
1. Take the latest published stable entry. Download its `checksums.txt` from the public release; its SHA-256 must
   equal the digest in the state.
2. Download each Linux archive and check it against `checksums.txt`. Read it with tapster's tar reader and take the
   `binaries` and `completions` it lists.
3. Write an nfpm config from validated values and run nfpm `v2.47.0` (downloaded by tapster, SHA-256 pinned) for
   `deb` and `rpm`. Files: binaries at `/usr/bin/<name>`, bash completion at
   `/usr/share/bash-completion/completions/<name>`, zsh at `/usr/share/zsh/vendor-completions/_<name>` (deb) or
   `/usr/share/zsh/site-functions/_<name>` (rpm), fish at `/usr/share/fish/vendor_completions.d/<name>.fish`.
   Architectures: `amd64`/`arm64` for deb, `x86_64`/`aarch64` for rpm. Release `1`.
4. Write `tapster-linux.json` (`{"packages": {"aims": "0.1.5"}}`). If it equals the live one, set `changed=false` and
   stop. Otherwise upload the packages and the manifest as an artifact for one day.

### 5.4 linux-sign (Linux key)

A step before tapster's installs `apt-utils`, `rpm` and `createrepo-c` from Ubuntu. tapster then:
1. Checks the artifact: exactly the expected package files for the packages and versions in the state, nothing else.
2. Imports `TAPSTER_LINUX_KEY` (an armored RSA-4096 signing key without passphrase) through stdin into a temporary
   `GNUPGHOME`. Only `gpg` and `rpmsign` see that folder.
3. Signs every `.rpm` with `rpmsign --addsign` (SHA-512), then runs `createrepo_c` per architecture and signs
   `repodata/repomd.xml` (`repomd.xml.asc`, detached, armored, SHA-512).
4. Writes `apt/dists/stable/main/binary-{amd64,arm64}/Packages` with `apt-ftparchive` (paths relative to `apt/`),
   gzips them, writes `Release` (Origin and Label `<owner> tapster`, Suite and Codename `stable`, Components `main`,
   no `Valid-Until`) and signs it as `InRelease` and `Release.gpg` (SHA-512).
5. Exports the public key as `<owner>-tapster.asc` and `<owner>-tapster.pgp`, writes `rpm/<owner>-tapster.repo` and
   an `index.html` with the install commands (§5.6).
6. Stops the agent and deletes the folder, then uploads the site with `actions/upload-pages-artifact`.

Layout:

```
index.html  tapster-linux.json  <owner>-tapster.asc  <owner>-tapster.pgp
apt/dists/stable/{Release,InRelease,Release.gpg}
apt/dists/stable/main/binary-{amd64,arm64}/Packages{,.gz}
apt/pool/main/<name>_<version>_<arch>.deb
rpm/<owner>-tapster.repo
rpm/{x86_64,aarch64}/<name>-<version>-1.<arch>.rpm
rpm/{x86_64,aarch64}/repodata/{repomd.xml,repomd.xml.asc,...}
```

### 5.5 linux-pages

`actions/deploy-pages` publishes the artifact. `tapster init --linux` sets the hub's Pages source to GitHub Actions.

### 5.6 For users

```sh
# apt (Debian, Ubuntu)
sudo curl -fsSLo /etc/apt/keyrings/<owner>-tapster.pgp <url>/<owner>-tapster.pgp
printf 'Types: deb\nURIs: <url>/apt\nSuites: stable\nComponents: main\nSigned-By: /etc/apt/keyrings/<owner>-tapster.pgp\n' \
  | sudo tee /etc/apt/sources.list.d/<owner>-tapster.sources
sudo apt update && sudo apt install aims

# dnf (Fedora, RHEL)
sudo curl -fsSLo /etc/yum.repos.d/<owner>-tapster.repo <url>/rpm/<owner>-tapster.repo
sudo dnf install aims
```

The `.repo` file sets `baseurl=<url>/rpm/$basearch`, `gpgcheck=1`, `repo_gpgcheck=1` and
`gpgkey=<url>/<owner>-tapster.asc`.

### 5.7 Setup: `tapster init --linux`

1. Generate an RSA-4096 sign-only key without expiry with the local `gpg` in a temporary `GNUPGHOME`.
2. Store the armored secret key as `TAPSTER_LINUX_KEY` in the `tapster` environment (stdin), print the fingerprint
   and delete the folder. The key is not kept anywhere else: losing it means generating a new one. Users then run the
   install commands again.
3. Set the hub's Pages source to GitHub Actions and rewrite the hub workflow.

`doctor` checks the secret, `linux.maintainer` and the Pages source once a package sets `linux: true`.

### 5.8 Threats

| Threat | Handling |
| --- | --- |
| A changed archive between publish and packaging | `checksums.txt` must match the digest recorded at publish; each archive must match `checksums.txt`. |
| nfpm or an Ubuntu tool is compromised | nfpm runs without credentials. The signing job runs only Ubuntu's own tools. They never get the key's environment. |
| The key leaks | It lives in the `tapster` environment, reaches only `gpg` through stdin and a temporary folder. The leak test covers it. Rotate with `init --linux`. |
| An old repository state is replayed to users | Accepted: `Release` has no `Valid-Until`, as most third-party repositories. |

## 6. Testing

- **Unit:** JWT checks (every claim, every failure, an unknown `kid` fetched once, a forged signature), the dispatch
  sequence against a fake GitHub, the Markdown converter (escaping and every construct the README uses), config
  validation, the nfpm config writer, the artifact layout check, the `tapster-linux.json` comparison, the templates.
- **CI end to end (tapster's own CI):** build a fixture package through `linux-build`'s code from a local archive, sign
  it through `linux-sign`'s code with a key made in the job, serve the site locally and install the package with
  `apt` in `ubuntu:24.04` and with `dnf` in `fedora:42` containers.
- **Leak test:** a plain and a masked run of `linux-sign` with a canary key, with stage markers.
- **Owner end to end:** deploy the doorbell and check that a tag push publishes within two minutes; deploy the docs;
  enable Linux packages on the hub and install one with apt and dnf.

## 7. Owner steps

Cloudflare: `wrangler login`, an API token for the docs workflow and the `docs` environment secrets. GitHub: clicking
"Create GitHub App" for the dispatch App and installing it on the hub; running `init --doorbell` and `init --linux`;
making tapster public and publishing it to the Marketplace.

## 8. Out of scope

- Webhooks and organization accounts.
- Older package versions in the Linux repositories, prereleases and other distributions' formats (apk, pacman).
- A custom domain for the Linux repositories (set `linux.url` and the Pages domain by hand).
