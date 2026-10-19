# tapster phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A doorbell Worker that starts the hub within a minute, a docs site, Marketplace metadata and signed apt and
dnf repositories for CLI packages.

**Architecture:** The doorbell is a dependency-free Cloudflare Worker in `src/doorbell/worker.ts`, deployed per hub by
`tapster init --doorbell`. The docs page is generated from the README by `site/build.ts` with `Bun.markdown` and served
by GitHub Pages. Linux packages are built reproducibly by nfpm in a job without credentials; a second job checks every
package against the release archives itself, signs the rpms deterministically and writes and signs the metadata with
Ubuntu's `gpg`, `rpmsign`, `createrepo_c` and `apt-ftparchive`; a third deploys GitHub Pages.

**Tech Stack:** Bun, TypeScript strict, zod, WebCrypto (Worker), Wrangler 4.151.1, nfpm 2.47.0, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-tapster-phase3-design.md`

## Global Constraints

- Wrangler `4.151.1`, locked in `templates/wrangler/bun.lock`, installed with `--ignore-scripts`, used only by
  `init --doorbell` and `init --rotate doorbell`.
- nfpm `v2.47.0`: `nfpm_2.47.0_Linux_x86_64.tar.gz` SHA-256
  `0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783`.
- `actions/upload-pages-artifact` v5.0.0 `fc324d3547104276b827a68afc52ff2a11cc49c9`; `actions/deploy-pages` v5.0.1
  `368f82528645a54fb793d4d04e342629a3f51346`.
- Worker: no dependencies, no token or key in logs or responses.
- Linux tools: `/usr/bin/gpg`, `/usr/bin/gpgconf`, `/usr/bin/rpmsign`, `/usr/bin/rpm`, `/usr/bin/rpm2archive`,
  `/usr/bin/dpkg-deb`, `/usr/bin/createrepo_c`, `/usr/bin/apt-ftparchive`. Only `gpg`, `gpgconf` and `rpmsign` get
  `GNUPGHOME`. The key is on disk only while they run.
- nfpm runs with `SOURCE_DATE_EPOCH=315532800`; rpms are signed with gpg's clock at the key's creation time
  (`_gpg_sign_cmd_extra_args --faked-system-time <created>!`).
- Writing rules for public text: no em dashes, no comma before "and"/"or", no exaggeration.
- Commits: one line, the user's identity, no trailers.

## Review Focus

1. **A token with `aud` as an array or with extra audiences** must be refused; only a string equal to the request
   origin passes. Task 2.
2. **A JWKS fetch that fails** must answer 401 or 502 without throwing an unhandled error. It must never cache an empty
   key set. Task 2.
3. **A Linux archive that lacks a listed binary or completion** stops the Linux build with a clear reason; the live
   site stays. Task 6.
4. **A hub with no Linux packages** never runs the Linux jobs and never needs the key or Pages. Task 8.
5. **A package that nfpm built with extra content** (a maintainer script, a dependency, an extra or changed file) is
   refused by linux-sign before anything is signed. Task 7.

---

### Task 1: Config for Linux packages

**Files:** Modify `src/config.ts`; Test `tests/config-linux.test.ts`.

**Interfaces:** hub field `linux?: { maintainer: string; url?: string }`; CLI package field `linux: boolean` (default
false); `linuxUrl(config: HubConfig, hub: string): string` returns `url` or `https://<owner>.github.io/<repo>`.

- [ ] Failing tests: `linux: true` without a Linux asset is refused; with one and without `linux.maintainer` is refused;
  a maintainer without `<address>` is refused; apps cannot set `linux`; `linuxUrl` default and override.
- [ ] Implement, green, commit "Configure Linux packages in tapster.yml".

### Task 2: Doorbell Worker

**Files:** Create `src/doorbell/worker.ts`, `src/doorbell/jwt.ts`; Test `tests/doorbell.test.ts`.

**Interfaces:** `verifyOidc(token: string, origin: string, ownerId: string, keys: KeySource, now: number):
Promise<Claims>` throws `DoorbellError(status, reason)`; `KeySource = (kid: string) => Promise<Jwk | null>`;
`jwksSource(fetch, clock)` caches for an hour and refetches for an unknown kid at most every 5 minutes;
`dispatch(env, fetch, now)` runs §2.3 with `INSTALLATION_ID`; default export `{ fetch(request, env) }`.

- [ ] Failing tests with a generated RSA key and a fake JWKS: a valid token passes; each claim of spec §2.2 broken in
  turn fails; `aud` as an array fails; `alg: none` and HS256 fail; a signature by another key fails; an unknown kid
  triggers one refetch; a 9 KiB token fails; the dispatch sequence calls the four GitHub endpoints in order with the
  hub id and `actions: write`; it revokes the token even when the dispatch fails; the handler answers 405, 401 with
  an empty body, 202 and 502; nothing logged contains the token or the key.
- [ ] Implement, green, commit "Ring the hub from a release with a checked GitHub token".

### Task 3: Doorbell setup, ring steps and doctor

**Files:** Create `templates/wrangler/{package.json,bun.lock}`, `src/cli/doorbell.ts`; Modify `src/cli/init.ts`,
`src/cli/add.ts`, `src/cli/doctor.ts`, `templates/project/{bun-release.yml,app-release.yml}`,
`.github/workflows/release.yml`; Test `tests/doorbell-setup.test.ts`, `tests/add.test.ts`, `tests/doctor.test.ts`.

**Interfaces:** `doorbellManifest(owner, hub, redirect)`; `doorbellConfig(vars): string` (wrangler.jsonc);
`workerOrigin(outputFile: string): string | null` (reads Wrangler's ND-JSON output); `RING_STEP` shared by the
templates and `adaptReleaseWorkflow`; `doorbellCheck(hubValue: string | null, projectValues: Record<string, string |
null>): Check`.

- [ ] Failing tests: the manifest is private and asks for `actions: write` and `metadata: read` only; the wrangler
  config holds the five variables and no secret; `workerOrigin` reads the origin from an ND-JSON output file and
  returns null without a workers.dev URL; both templates, tapster's own release workflow and an adapted GoReleaser
  workflow end with the ring step; the step is added once; `doorbellCheck` names projects whose variable is missing
  or different.
- [ ] Implement `init --doorbell` and `init --rotate doorbell` as spec §2.5, green, commit "Set up the doorbell from
  the CLI".

### Task 4: Docs site

**Files:** Create `site/page.ts`, `site/build.ts`, `.github/workflows/docs.yml`; Test `tests/site.test.ts`.

**Interfaces:** `renderReadme(md: string, linkBase: string): string` (Bun.markdown plus link rewriting);
`page(title: string, body: string): string`.

- [ ] Failing tests: headings get ids; raw HTML is escaped; relative links point at GitHub; `javascript:` links are
  dropped; the real README builds into a page without scripts.
- [ ] Implement, green, commit "Serve the docs site from GitHub Pages". (The first version, a Workers site with a
  hand-written converter, was replaced after the design review.)

### Task 5: Marketplace metadata

**Files:** Modify `action.yml`; Test `tests/action-meta.test.ts`.

- [ ] Failing test: name `Tapster Release Hub`, description at most 125 characters, branding icon and color set.
- [ ] Implement, commit "Describe tapster for the Marketplace".

### Task 6: linux-build

**Files:** Create `src/linux/build.ts`, `src/linux/nfpm.ts`, `src/action/linux.ts`; Modify `src/run.ts`; Test
`tests/linux-build.test.ts`.

**Interfaces:** `linuxTargets(config, state): Target[]` (`{ pkg, tag, version, assets: { platform, name }[] }`);
`nfpmConfig(t: { pkg, version, arch, maintainer, files: { src, dst, mode }[] }): string`; `manifestJson(targets):
string`; `buildLinux(ctx, fetchImpl): Promise<{ changed: boolean; dir: string }>`; nfpm download verified against the
pinned SHA-256.

- [ ] Failing tests: targets skip prereleases and packages without `linux`; the nfpm config quotes every value and
  maps paths per packager; a missing binary in the archive stops the build; a checksums file that differs from the
  state stops the build; the manifest comparison sets `changed`; nfpm gets `SOURCE_DATE_EPOCH`.
- [ ] Implement, green, commit "Build deb and rpm packages from published Linux archives".

### Task 7: linux-sign

**Files:** Create `src/linux/sign.ts`, `src/linux/site.ts`; Modify `src/run.ts` (tools); Test `tests/linux-sign.test.ts`.

**Interfaces:** `expectedFiles(targets): string[]`; `checkTree(dir, expected)`; `checkDeb(file, expect, inspect)` and
`checkRpm(file, expect, inspect)` with an injected tool runner; `releaseOptions(owner): string[]`;
`repoFile(owner, url): string`; `indexHtml(owner, url, fingerprint, names): string`; `signLinux(ctx): Promise<void>`.

- [ ] Failing tests: an extra or missing file in the artifact is refused; a deb with a `postinst`, a `Depends` line, an
  extra file, a wrong mode or a changed binary is refused; an rpm with a script, a requirement or a changed file is
  refused; a manifest version that is not published is refused; the repo file and index carry the URL, the key names
  and the fingerprint; the gpg and rpmsign argument lists never contain the key; `GNUPGHOME` reaches only gpg, gpgconf
  and rpmsign.
- [ ] Implement, green, commit "Sign the Linux packages and their repositories".

### Task 8: Hub workflow, check output and init --linux

**Files:** Modify `templates/hub/tapster.yml`, `templates/pins.json`, `action.yml`, `src/action/{main,check}.ts`,
`src/cli/{init,doctor}.ts`; Test `tests/hub-workflow.test.ts`, `tests/modes-linux.test.ts`, `tests/doctor.test.ts`.

- [ ] Failing tests: the three jobs exist with the permissions and environments of spec §5.2; each runs only when its
  predecessor succeeded and `linux-sign` only when `changed`; `linux-sign` installs the tools before tapster's step and
  only that step gets `TAPSTER_LINUX_KEY`; check's `linux` output follows work items and the dispatch input and is
  false for a hub without Linux packages; doctor reports a missing secret, maintainer, Pages source or a Pages address
  other than `linux.url`.
- [ ] Implement `init --linux` as spec §5.7, green, commit "Run the Linux jobs from the hub workflow".

### Task 9: Linux end to end in CI

**Files:** Create `tests/linux/e2e.ts`; Modify `.github/workflows/ci.yml`.

- [ ] A job builds a fixture archive, runs the build and sign code against it with a key made in the job (twice, the
  package bytes must match), serves the site on localhost and installs the package in `ubuntu:24.04` with i386 added
  and in `fedora:42` with dnf (signature checks on). Commit "Install a hub-built package with apt and dnf in CI".

### Task 10: Leak test for the Linux key

**Files:** Modify `.github/workflows/leak.yml`, `tests/leak/*`.

- [ ] Jobs `plain-linux` and `masked-linux` run `linux-sign` with a canary key (plain env and secret), with stage
  markers for success and a malformed key. Commit "Cover the Linux key in the leak test".

### Task 11: Documentation

- [ ] README sections for the doorbell and Linux packages; commit "Explain the doorbell and Linux packages".

### Task 12 (owner): Deploy and check

As spec §6 (owner end to end) and §7.
