# tapster phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A doorbell Worker that starts the hub within a minute, a docs site, Marketplace metadata and signed apt and
dnf repositories for CLI packages.

**Architecture:** The doorbell is a dependency-free Cloudflare Worker in `src/doorbell/worker.ts`, deployed per hub by
`tapster init --doorbell`. The docs page is generated from the README by `site/build.ts` and deployed as Workers static
assets. Linux packages are built by nfpm in a job without credentials and signed by Ubuntu's `gpg`, `rpmsign`,
`createrepo_c` and `apt-ftparchive` in a second job, then deployed to GitHub Pages.

**Tech Stack:** Bun, TypeScript strict, zod, WebCrypto (Worker), Wrangler 4.151.1, nfpm 2.47.0, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-tapster-phase3-design.md`

## Global Constraints

- Wrangler `4.151.1`, locked in `templates/wrangler/bun.lock`.
- nfpm `v2.47.0`: `nfpm_2.47.0_Linux_x86_64.tar.gz` SHA-256
  `0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783`.
- `actions/upload-pages-artifact` v5.0.0 `fc324d3547104276b827a68afc52ff2a11cc49c9`; `actions/deploy-pages` v5.0.1
  `368f82528645a54fb793d4d04e342629a3f51346`.
- Worker: no dependencies, no token or key in logs or responses.
- Linux signing tools: `/usr/bin/gpg`, `/usr/bin/gpgconf`, `/usr/bin/rpmsign`, `/usr/bin/createrepo_c`,
  `/usr/bin/apt-ftparchive`. Only `gpg` and `rpmsign` get `GNUPGHOME`.
- Writing rules for public text: no em dashes, no comma before "and"/"or", no exaggeration.
- Commits: one line, the user's identity, no trailers.

## Review Focus

1. **A token with `aud` as an array or with extra audiences** must be refused; only a string equal to the request
   origin passes. Task 2.
2. **A JWKS fetch that fails** must answer 401 or 502 without throwing an unhandled error. It must never cache an empty
   key set. Task 2.
3. **A Linux archive that lacks a listed binary or completion** stops that package with a clear reason while the other
   packages still build. Task 6.
4. **A hub with no Linux packages** never runs the Linux jobs and never needs the key or Pages. Task 8.
5. **README constructs the converter does not know** (a table, a nested list deeper than one level) render as escaped
   text rather than broken HTML. Task 4.

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
Promise<Claims>` throws `DoorbellError(reason)`; `KeySource = (kid: string) => Promise<JsonWebKey | null>`;
`jwksSource(fetch)` caches for an hour and refetches once for an unknown kid; `dispatch(env, fetch)` runs §2.3;
default export `{ fetch(request, env) }`.

- [ ] Failing tests with a generated RSA key and a fake JWKS: a valid token passes; each claim of spec §2.2 broken in
  turn fails; `aud` as an array fails; `alg: none` and HS256 fail; a signature by another key fails; an unknown kid
  triggers one refetch; a 9 KiB token fails; the dispatch sequence calls the four GitHub endpoints in order with the
  hub id and `actions: write`; it revokes the token even when the dispatch fails; the handler answers 405, 401 with
  an empty body, 202 and 502; nothing logged contains the token or the key.
- [ ] Implement, green, commit "Ring the hub from a release with a checked GitHub token".

### Task 3: Doorbell setup, ring steps and doctor

**Files:** Create `templates/wrangler/{package.json,bun.lock}`; Modify `src/cli/init.ts`, `src/cli/add.ts`,
`src/cli/doctor.ts`, `templates/project/{bun-release.yml,app-release.yml}`; Test `tests/init.test.ts`,
`tests/add.test.ts`, `tests/doctor.test.ts`.

**Interfaces:** `doorbellManifest(owner, hub, redirect)`; `doorbellConfig(vars): string` (wrangler.jsonc);
`workerUrl(wranglerOutput: string): string | null`; `RING_STEP` shared by the templates and `adaptReleaseWorkflow`;
`doorbellCheck(hubValue: string | null, projectValues: Record<string, string | null>): Check`.

- [ ] Failing tests: the manifest asks for `actions: write` and `metadata: read` only; the wrangler config holds the
  four variables and no secret; `workerUrl` reads the URL from Wrangler's deploy output; both templates and an adapted
  GoReleaser workflow end with the ring step; the step is added once; `doorbellCheck` names projects whose
  variable is missing or different.
- [ ] Implement `init --doorbell` as spec §2.5, green, commit "Set up the doorbell from the CLI".

### Task 4: Docs site

**Files:** Create `site/markdown.ts`, `site/build.ts`, `site/wrangler.jsonc`, `.github/workflows/docs.yml`; Test
`tests/site.test.ts`.

**Interfaces:** `markdownToHtml(md: string, linkBase: string): string`; `page(title: string, body: string): string`.

- [ ] Failing tests: headings get ids; paragraphs, lists, fenced code (escaped), inline code, bold and links render;
  relative links point at GitHub; `<script>` in text is escaped; a table renders as escaped text; the built page of
  the real README has no unescaped `<` outside tags it wrote.
- [ ] Implement, green, commit "Build the docs site from the README".

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
  maps paths per packager; a missing binary in the archive stops that package only; a checksums file that differs from
  the state stops the package; the manifest comparison sets `changed`.
- [ ] Implement, green, commit "Build deb and rpm packages from published Linux archives".

### Task 7: linux-sign

**Files:** Create `src/linux/sign.ts`, `src/linux/site.ts`; Modify `src/run.ts` (tools); Test `tests/linux-sign.test.ts`.

**Interfaces:** `expectedFiles(targets): string[]`; `checkTree(dir, expected)`; `releaseOptions(owner): string[]`;
`repoFile(owner, url): string`; `indexHtml(owner, url, names): string`; `signLinux(ctx): Promise<void>`.

- [ ] Failing tests: an extra or missing file in the artifact is refused; the repo file and index carry the URL and
  the key names; the gpg and rpmsign argument lists never contain the key; `GNUPGHOME` reaches only gpg and rpmsign.
- [ ] Implement, green, commit "Sign the Linux packages and their repositories".

### Task 8: Hub workflow, check output and init --linux

**Files:** Modify `templates/hub/tapster.yml`, `templates/pins.json`, `action.yml`, `src/action/{main,check}.ts`,
`src/cli/{init,doctor}.ts`; Test `tests/hub-workflow.test.ts`, `tests/modes-linux.test.ts`, `tests/doctor.test.ts`.

- [ ] Failing tests: the three jobs exist with the permissions and environments of spec §5.2 and skip unless
  `needs.check.outputs.linux == 'true'`; `linux-sign` installs the tools before tapster's step and only that step gets
  `TAPSTER_LINUX_KEY`; check's `linux` output is false for a hub without Linux packages; doctor reports a missing
  secret, maintainer or Pages source.
- [ ] Implement `init --linux` as spec §5.7, green, commit "Run the Linux jobs from the hub workflow".

### Task 9: Linux end to end in CI

**Files:** Create `tests/linux/e2e.ts`; Modify `.github/workflows/ci.yml`.

- [ ] A job builds a fixture archive, runs the build and sign code against it with a key made in the job, serves the
  site on localhost and installs the package in `ubuntu:24.04` with apt and in `fedora:42` with dnf (both with
  signature checks on). Commit "Install a hub-built package with apt and dnf in CI".

### Task 10: Leak test for the Linux key

**Files:** Modify `.github/workflows/leak.yml`, `tests/leak/*`.

- [ ] Jobs `plain-linux` and `masked-linux` run `linux-sign` with a canary key (plain env and secret), with stage
  markers for success and a malformed key. Commit "Cover the Linux key in the leak test".

### Task 11: Documentation

- [ ] README sections for the doorbell and Linux packages; commit "Explain the doorbell and Linux packages".

### Task 12 (owner): Deploy and check

As spec §6 (owner end to end) and §7.
