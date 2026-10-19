# tapster phase 3: doorbell, docs site, Marketplace and Linux packages

Phase 1 ([2026-10-18-tapster-design.md](2026-10-18-tapster-design.md)) and phase 2
([2026-10-19-tapster-phase2-design.md](2026-10-19-tapster-phase2-design.md)) hold the base design. Their decisions
stand unless this document changes them. The decisions for this phase are in phase 1, §20.

## 1. Goals

1. **Fast releases.** A project that opens a draft rings the hub, which starts within a minute. The 10-minute
   schedule stays as the fallback.
2. **One narrow credential outside GitHub.** The Worker that answers the ring holds one key: that of a separate
   dispatch App that can only start workflows in the hub.
3. **Docs** at `https://tapster.doguyilmaz.com`, built from the README and served by GitHub Pages.
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
  (`https://token.actions.githubusercontent.com/.well-known/jwks`, kept for an hour; an unknown `kid` fetches it again
  at most once every 5 minutes, so random tokens cannot make the Worker hammer GitHub);
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
2. asks for a token limited to the hub and to `actions: write`
   (`POST /app/installations/{INSTALLATION_ID}/access_tokens` with `repository_ids: [HUB_ID]`);
3. calls `POST /repos/{HUB}/actions/workflows/tapster.yml/dispatches` with `{"ref": "main"}`;
4. revokes the token (`DELETE /installation/token`), also when the dispatch failed.

A GitHub failure answers `502`. Requests carry `User-Agent: tapster-doorbell`, `Accept: application/vnd.github+json`
and `X-GitHub-Api-Version: 2022-11-28`. The Worker logs one line per request: the verified `repository` and `ref`
and the answer, never a token or a key.

Variables: `APP_ID`, `INSTALLATION_ID`, `HUB` (`owner/repo`), `HUB_ID`, `OWNER_ID`. Secret: `APP_KEY` (PKCS#8 PEM).
The Worker has no dependencies.

### 2.4 The dispatch App

A second App, separate from the hub's App: private, `Actions: write` and `Metadata: read`, no events, no webhook,
installed on the hub only. The hub's App keeps no `Actions` access. This App gets nothing on the projects. Its key lives only in
the Worker.

### 2.5 Setup: `tapster init --doorbell`

Run in the hub clone with `gh` signed in. Wrangler `4.151.1` is pinned with its lockfile in
`templates/wrangler/`; `init` installs it in a temporary folder with `bun install --frozen-lockfile --ignore-scripts`
and uses that copy for every Wrangler command, `login` included.
1. If the hub already has `TAPSTER_DOORBELL_APP_ID`, stop: `init --rotate doorbell` replaces the key. Deleting the
   App starts over.
2. Run `wrangler whoami`; if it fails, run `wrangler login` (browser).
3. Create the dispatch App with the manifest flow. The user clicks "Create GitHub App" and installs it on the hub;
   `init` reads the installation id with the App's JWT.
4. Convert the key to PKCS#8 in memory.
5. Write the Worker and a `wrangler.jsonc` with the five variables, run `wrangler deploy` with
   `WRANGLER_OUTPUT_FILE_PATH` set and `wrangler secret put APP_KEY` (stdin). Read the `workers.dev` URL from the
   output file and keep its origin. An account without a `workers.dev` subdomain gets a message naming the dashboard
   page that creates one.
6. Store `TAPSTER_DOORBELL` (the origin) and `TAPSTER_DOORBELL_APP_ID` in the hub's `tapster` environment and
   `TAPSTER_DOORBELL` in every project repository listed in `tapster.yml`. Delete the folder.

`init --rotate doorbell` asks for a new key file from the App's settings page, as `--rotate app` does. It then runs
`wrangler secret put` again.

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

A failed ring never fails the release; the schedule picks the draft up. tapster's own release workflow rings its
hub the same way.

### 2.7 Threats

| Threat | Handling |
| --- | --- |
| A token from someone else's workflow | `repository_owner_id` and `aud` checks. |
| A token from the owner's unrelated repository or a replay | One extra check run; runs collapse in the concurrency group. |
| The Cloudflare account is taken over | With `Actions: write` on the hub the attacker can start, cancel or rerun hub runs (reruns of runs up to 30 days old use their old commit and may turn on debug logging), disable the workflow (which stops the schedule and the rings) and delete run logs and artifacts. The token cannot read secrets, push or touch projects. The `tapster` environment opens only on `main`. `doctor` reports a disabled workflow. |
| The Worker logs a token | It logs only verified claims; the leak review checks the code. |

## 3. Docs site

### 3.1 Content

`site/build.ts` turns `README.md` into `index.html` with Bun's own Markdown renderer (`Bun.markdown.html` with heading
ids and raw HTML turned off). Relative links become links to the file on GitHub; any link that is not `https:`, an
anchor or a relative path is dropped. The page has inline CSS with a light and a dark scheme, no scripts and no
external requests.

### 3.2 Deploy

The docs live on tapster's own GitHub Pages, not on Cloudflare: a docs token would be able to redeploy the doorbell
Worker in the same account and read its key. `.github/workflows/docs.yml` runs by hand and on pushes to `main` that
touch `README.md` or `site/`: a build job (`contents: read`) uploads the page with `actions/upload-pages-artifact`, a
deploy job (`pages: write`, `id-token: write`, environment `github-pages`) runs `actions/deploy-pages`. The custom
domain is a Pages setting plus a DNS-only `CNAME tapster -> doguyilmaz.github.io` record.

## 4. Marketplace

`action.yml` gets `name: Tapster Release Hub` (the name `tapster` belongs to an existing GitHub user), `author` and
`branding` (`icon: package`, `color: orange`). Listing happens when the owner ticks "Publish this Action to the GitHub
Marketplace" on a release of the public repository. Whether later releases published by the hub through the API
update the listing is not documented; the first owner release checks it.

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

| Job | Credentials | Work |
| --- | --- | --- |
| `linux-build` | none (`contents: read`) | Builds every `.deb` and `.rpm` from verified release archives. |
| `linux-sign` | `TAPSTER_LINUX_KEY` (`tapster` environment, `contents: read`) | Checks every package against the archives itself, signs the rpms, writes and signs the metadata. |
| `linux-pages` | `pages: write`, `id-token: write` (`github-pages` environment) | Uploads and deploys the site. |

All run on ubuntu-24.04. `check` sets the output `linux` when a work item belongs to a Linux package or when the run was
started by hand with the input `linux` set. Each Linux job runs only when its predecessor succeeded
(`!cancelled() && needs.<job>.result == 'success'`), `linux-sign` only when `linux-build` reports `changed`. A failed
build therefore runs again with the next release or by hand, not every 10 minutes.

### 5.3 linux-build (no credentials)

For each Linux package, from the state on `main`:
1. Take the latest published stable entry. Download its `checksums.txt` from the public release; its SHA-256 must
   equal the digest in the state.
2. Download each Linux archive and check it against `checksums.txt`. Read it with tapster's tar reader and take the
   `binaries` and `completions` it lists.
3. Write an nfpm config from validated values and run nfpm `v2.47.0` (downloaded by tapster, SHA-256 pinned) for
   `deb` and `rpm` with `SOURCE_DATE_EPOCH=315532800`, so the same release always builds the same bytes. Files:
   binaries at `/usr/bin/<name>` (`0755`), bash completion at `/usr/share/bash-completion/completions/<name>`, zsh at
   `/usr/share/zsh/vendor-completions/_<name>` (deb) or `/usr/share/zsh/site-functions/_<name>` (rpm), fish at
   `/usr/share/fish/vendor_completions.d/<name>.fish` (all `0644`). nfpm gets `amd64` or `arm64` and names the rpm
   architecture itself. Release `1`.
4. Write `tapster-linux.json` (`{"packages": {"aims": "0.1.5"}}`). If it equals the live one, set `changed=false`.
   Otherwise upload the packages and the manifest as an artifact for one day.

Any failure stops the whole build: the live site stays as it is rather than losing a package.

### 5.4 linux-sign (Linux key)

The job runs checkout, a step that installs `apt-utils`, `rpm`, `dpkg` and `createrepo-c` from Ubuntu, the artifact
download, tapster and the artifact upload. tapster:
1. **Decides what each package must be on its own.** It reads the artifact's `tapster-linux.json`; every listed
   version must be a published stable entry of a `linux: true` package in the state on `main`. It downloads
   `checksums.txt` and the archives again and checks them as in §5.3.
2. **Checks the artifact.** Exactly the expected package files, nothing else, no symlinks. For each `.deb`
   (`dpkg-deb -f`, `--ctrl-tarfile`, `--fsys-tarfile`): `Package`, `Version` (`<version>-1`), `Architecture` and
   `Maintainer` as configured, no `Depends`, `Pre-Depends` or `Conflicts`, a control archive holding only `control`
   and `md5sums`. The data archive holds exactly the expected files with the expected modes, owned by root, each
   equal to the file in the release archive. For each `.rpm` (`rpm -qp`, `rpm2archive`): name, version, release,
   architecture, no scripts or triggers, no requirements beyond `rpmlib(...)`, the same file list, modes and contents.
3. **Signs the rpms.** It imports `TAPSTER_LINUX_KEY` (an armored RSA-4096 signing key without passphrase) through
   stdin into a temporary `GNUPGHOME` under `/tmp`, signs every `.rpm` with `rpmsign --addsign` (SHA-512), with gpg's
   clock set to the key's creation time so that a package signs to the same bytes every time, stops the agent and
   deletes the folder.
4. **Writes the metadata without the key.** `createrepo_c` per architecture. `apt-ftparchive` writes
   `apt/dists/stable/main/binary-{amd64,arm64}/Packages` (paths relative to `apt/`), tapster gzips them and copies
   both into `by-hash/SHA256/<digest>`. `apt-ftparchive release` writes `Release` with Origin and Label
   `<owner> tapster`, Suite and Codename `stable`, Architectures `amd64 arm64`, Components `main`,
   `Acquire-By-Hash: yes`, SHA-256 and SHA-512 only and no `Valid-Until`.
5. **Signs the metadata.** It imports the key again, writes `InRelease` and `Release.gpg` (SHA-512) and exports the
   public key as `<owner>-tapster.asc` and `<owner>-tapster.pgp`, stops the agent and deletes the folder.
6. Writes `rpm/<owner>-tapster.repo` and an `index.html` with the install commands and the key's fingerprint (§5.6).

Only `gpg`, `gpgconf` and `rpmsign` get `GNUPGHOME`; `createrepo_c` and `apt-ftparchive` run when no key is on disk.

Layout:

```
index.html  tapster-linux.json  <owner>-tapster.asc  <owner>-tapster.pgp
apt/dists/stable/{Release,InRelease,Release.gpg}
apt/dists/stable/main/binary-{amd64,arm64}/{Packages,Packages.gz,by-hash/SHA256/<digest>}
apt/pool/main/<name>_<version>-1_<arch>.deb
rpm/<owner>-tapster.repo
rpm/{x86_64,aarch64}/<name>-<version>-1.<arch>.rpm
rpm/{x86_64,aarch64}/repodata/...
```

### 5.5 linux-pages

Downloads the signed site, runs `actions/upload-pages-artifact` and `actions/deploy-pages`. `tapster init --linux`
sets the hub's Pages source to GitHub Actions.

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

The `.repo` file sets `baseurl=<url>/rpm/$basearch`, `gpgcheck=1`, `gpgkey=<url>/<owner>-tapster.asc` and
`metadata_expire=1h`. It does not set `repo_gpgcheck`: dnf5 and GNOME Software have broken on it repeatedly, and
Fedora's own repositories rely on package signatures too.

### 5.7 Setup: `tapster init --linux`

1. Generate an RSA-4096 sign-only key without expiry with the local `gpg` (`brew install gnupg` when it is missing) in a
   temporary `GNUPGHOME` under `/tmp`.
2. Store the armored secret key as `TAPSTER_LINUX_KEY` in the `tapster` environment (stdin), print the fingerprint
   and delete the folder. The key is not kept anywhere else: losing it means generating a new one. Users then run the
   install commands again.
3. Set the hub's Pages source to GitHub Actions and rewrite the hub workflow.

`doctor` checks the secret, `linux.maintainer`, the Pages source and that the Pages address equals `linux.url` (or its
default) once a package sets `linux: true`.

### 5.8 Threats

| Threat | Handling |
| --- | --- |
| A changed archive between publish and packaging | `checksums.txt` must match the digest recorded at publish; each archive must match `checksums.txt`. Both jobs check. |
| nfpm or anything in `linux-build` is compromised | `linux-sign` trusts nothing from it: it rebuilds what each package must contain from the release archives and refuses any other content, metadata or script. |
| An Ubuntu tool in `linux-sign` is compromised | Out of scope; the job runs only Ubuntu's own packages and keeps the key on disk only while `gpg` and `rpmsign` run. |
| The key leaks | It lives in the `tapster` environment and reaches only `gpg` through stdin and a temporary folder. The leak test covers it. Rotate with `init --linux`. |
| An old repository state is replayed to users | Accepted: `Release` has no `Valid-Until` and `repomd.xml` is not signed, as for most third-party repositories. Packages stay signed. |
| A new release replaces an old package while a user's metadata is cached | Only the latest version is served. apt users run `apt update`; dnf refreshes within an hour. |

## 6. Testing

- **Unit:** JWT checks (every claim, every failure, the refetch limit, a forged signature), the dispatch sequence
  against a fake GitHub, the docs page (escaping, link rewriting), config validation, the nfpm config writer, the
  package checks (an extra file, a changed binary, a maintainer script, a dependency), the artifact layout check, the
  `tapster-linux.json` comparison, the templates and the job conditions.
- **CI end to end (tapster's own CI):** build a fixture package through `linux-build`'s code from a local archive, sign
  it through `linux-sign`'s code with a key made in the job, serve the site locally and install the package with
  `apt` in `ubuntu:24.04` (with `i386` added as a foreign architecture) and with `dnf` in `fedora:42` containers.
  Building and signing twice gives the same package bytes.
- **Leak test:** a plain and a masked run of `linux-sign` with a canary key, with stage markers.
- **Owner end to end:** deploy the doorbell and check that a tag push publishes within two minutes; deploy the docs;
  enable Linux packages on the hub and install one with apt and dnf.

## 7. Owner steps

Cloudflare: `wrangler login` during `init --doorbell` and a DNS-only `CNAME tapster -> doguyilmaz.github.io`. GitHub:
clicking "Create GitHub App" for the dispatch App and installing it on the hub; running `init --doorbell` and
`init --linux`; making tapster public, turning on its Pages with the custom domain and publishing it to the
Marketplace; adding tapster to the hub with `linux: true`.

## 8. Out of scope

- Webhooks and organization accounts.
- Older package versions in the Linux repositories, prereleases and other distributions' formats (apk, pacman).
- A custom domain for the Linux repositories (set `linux.url` and the Pages domain by hand).
