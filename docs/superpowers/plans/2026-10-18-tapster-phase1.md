# tapster phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Action plus CLI that makes the public hub `doguyilmaz/homebrew-tap` sign, notarize and publish the
releases of Go and Bun CLIs from their draft releases, and write their casks and Scoop manifests. Project repositories
hold no credentials.

**Architecture:**
- The action has six modes: `check`, `fetch`, `sign`, `publish`, `render` and `cleanup`. A hub workflow on a schedule
  calls them as jobs and steps with separate credentials.
- All logic is plain TypeScript modules with one concern each, tested with `bun test` and bundled to one Node 24 file
  (`dist/index.js`).
- The CLI (`init`, `add`, `doctor`) reuses the same modules and runs with Bun.

**Tech Stack:**
- TypeScript (strict) and Bun ≥ 1.4 for development, tests and the CLI.
- Node 24 for the action runtime.
- Runtime dependencies: `@actions/core`, `yaml` and `zod` only.
- Apple's `codesign`, `security`, `openssl` (LibreSSL), `ditto` and `xcrun notarytool`; GitHub REST over `fetch`;
  `gh` for attestations.

**Spec:** `docs/superpowers/specs/2026-10-18-tapster-design.md`. Read it before each task; section numbers below
(§n) refer to it.

## Global Constraints

**Dependencies and runtime**
- Runtime dependencies are exactly `@actions/core`, `yaml` and `zod`, added with `bun add --exact`. Installs use
  `bun install --frozen-lockfile --ignore-scripts`.
- Code under `src/` except `src/cli/` must run on Node 24: use only `node:*` modules, never Bun APIs.

**Inputs and patterns**
- Tags: `^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$`.
- Package names: `^[a-z0-9][a-z0-9-]*$`.
- `{version}` is the tag without the leading `v`.
- Darwin assets must be `.tar.gz`. Asset names may only contain `[A-Za-z0-9._-]` plus the `{version}` placeholder.
- Staging asset prefix: `tapster-staging--`.

**Child processes and secrets**
- Tools are called by absolute path only: `/usr/bin/codesign`, `/usr/bin/security`, `/usr/bin/xcrun`,
  `/usr/bin/openssl`, `/usr/bin/ditto`, `/usr/bin/git`. `gh` is resolved from the fixed list in `src/run.ts`.
- Child processes get an allowlisted environment (`PATH=/usr/bin:/bin`, `HOME` and `TMPDIR`, plus what the call
  passes). No `@actions/exec`, no `execFile`, no shell.
- Credentials are read once with `readSecret()`, which registers the value and its encodings for masking and removes
  it from `process.env`. Every derived secret value is passed to `register()` before use.
- Action code never calls `console.*`. All logging goes through `src/report.ts`, which scrubs registered values. The
  CLI (`src/cli/`) may print, but never secrets.
- Errors carry `reason` and `fix` (`TapsterError`). They never include request bodies, argv, URLs with query strings,
  or raw tool output that was not scrubbed.
- The action refuses to run unless `RUNNER_ENVIRONMENT === "github-hosted"`.

**Workflows and commits**
- Every third-party action in workflows and templates is pinned by full commit SHA with the tag as a comment.
- The hub workflow has only `schedule` and `workflow_dispatch` triggers and `permissions: {}` at workflow level.
- Commits: one-line message, no body, the user's git identity, no `Co-Authored-By` trailer.

## Review Focus

These failure modes are implied by the spec but no other test covers them. Each has a test in the task that owns the
code:
1. **CRLF checksums.** A `checksums.txt` written on Windows (CRLF, trailing spaces, a `*` binary marker) must parse.
   Task 6.
2. **Renamed assets.** GitHub renames assets with spaces or odd characters, so a configured name may never appear.
   The draft must be reported as waiting, with the missing name, never processed half-way. Task 10.
3. **No macOS assets.** A package with only Linux or Windows assets has nothing to sign. Sign must skip notarization,
   and publish must still swap `checksums.txt` and publish. Task 17.
4. **More than 100 releases.** A drafted release must still be found, so pagination is needed. Task 7.
5. **Notarization timeout.** A submission still "In Progress" after the timeout is a failure that leaves the draft
   untouched, and the next run submits again. Task 13.

## File Structure

```
tapster/
  action.yml                      action metadata (node24, dist/index.js)
  package.json, tsconfig.json, bunfig.toml, bun.lock, .gitignore, LICENSE, README.md
  dist/index.js                   bundled action (committed, checked by CI)
  src/
    errors.ts                     TapsterError, GitHubError
    mask.ts                       secret registry: register, readSecret, scrub
    report.ts                     logging, per-item results, job summary
    run.ts                        child process wrapper, tool paths, gh lookup
    config.ts                     tapster.yml schema, tags, semver, asset names
    checksums.ts                  checksums.txt parse/write, sha256
    github.ts                     REST client: releases, assets, contents
    token.ts                      App JWT, installation tokens
    state.ts                      .tapster/state.json model
    hubcommit.ts                  commits to the hub through the Git Data API
    plan.ts                       draft readiness and the work list
    archive.ts                    tar.gz read/write, Mach-O detection, safety
    keychain.ts                   temporary keychain lifecycle (macOS)
    sign.ts                       codesign, verification, notarytool
    attest.ts                     gh attestation verify
    publish.ts                    staging swap, publish, download wait
    render.ts                     Ruby escaping, cask and Scoop rendering
    workdir.ts                    files shared by fetch/sign/publish steps
    action/
      main.ts                     mode dispatch
      context.ts                  hub repo, config, work list parsing
      check.ts  fetch.ts  sign.ts  publish.ts  render.ts  cleanup.ts
    cli/
      main.ts  prompt.ts  gh.ts  doctor.ts  init.ts  add.ts
  templates/
    hub/tapster.yml               hub workflow
    hub/README.md                 hub readme
    project/bun-release.yml       Bun project release workflow
    pins.json                     pinned action SHAs used by templates
  tests/
    helpers/rawtar.ts             builds malicious tar archives for tests
    golden/                       expected cask and Scoop files
    *.test.ts                     one per module
    leak/scan.ts, leak/run-scan.ts
  .github/workflows/ci.yml, leak.yml
  docs/spikes.md                  results of Task 1
```

---

### Task 1: Spikes

These spikes settle the assumptions in spec §18 before any code depends on them. They use throwaway repositories and
leave a written record.

**Files:**
- Create: `docs/spikes.md`

**Interfaces:**
- Produces: decisions later tasks read from `docs/spikes.md`: the Bun entitlement set, the staging prefix, the digest
  field, `deployment: false`, Linux casks, `tap_migrations`, the manifest without a webhook, and the `.p12` re-wrap.

- [ ] **Step 1: Create private scratch repositories**

```bash
gh repo create doguyilmaz/tapster-spike --private --add-readme
gh repo create doguyilmaz/homebrew-tapster-spike --private --add-readme
```
Expected: both URLs printed.

- [ ] **Step 2: Bun entitlements.** On this Mac, sign a compiled Bun binary with the minimal set and run it.

```bash
mkdir -p /tmp/bunspike && cd /tmp/bunspike
printf 'console.log(JSON.stringify({ok: true, jit: [1,2,3].map(x => x*2)}));\n' > a.ts
bun build a.ts --compile --outfile a
cat > ent.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
EOF
codesign --force --options runtime --timestamp --entitlements ent.plist \
  --sign "Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)" a
./a && codesign --verify --strict --verbose=2 a
```
Expected: `{"ok":true,...}` and `valid on disk`. If the binary crashes, add `disable-executable-page-protection`, then
the other keys one at a time, and record the smallest working set.

- [ ] **Step 3: Draft assets with staging names.** Use the user's token; the semantics match an App token with
  `contents: write`.

```bash
cd /tmp && rm -rf spk && mkdir spk && cd spk && echo hi > a.txt && sha256sum a.txt > checksums.txt 2>/dev/null || shasum -a 256 a.txt > checksums.txt
gh release create v0.0.1 a.txt checksums.txt --draft --repo doguyilmaz/tapster-spike --title v0.0.1 --target main
gh api repos/doguyilmaz/tapster-spike/releases --jq '.[0].assets[] | {id,name,state,digest}'
REL=$(gh api repos/doguyilmaz/tapster-spike/releases --jq '.[0].id')
UP=$(gh api repos/doguyilmaz/tapster-spike/releases/$REL --jq .upload_url | sed 's/{.*//')
gh api -X POST "$UP?name=tapster-staging--a.txt" --input a.txt -H 'Content-Type: application/octet-stream' --jq '{id,name}'
OLD=$(gh api repos/doguyilmaz/tapster-spike/releases/$REL --jq '.assets[] | select(.name=="a.txt") | .id')
NEW=$(gh api repos/doguyilmaz/tapster-spike/releases/$REL --jq '.assets[] | select(.name=="tapster-staging--a.txt") | .id')
gh api -X DELETE repos/doguyilmaz/tapster-spike/releases/assets/$OLD
gh api -X PATCH repos/doguyilmaz/tapster-spike/releases/assets/$NEW -f name=a.txt --jq '{id,name,digest}'
```
Expected:
- `digest` reads `sha256:<hex>`;
- the staging name is kept as uploaded (not rewritten by GitHub);
- the rename succeeds.

Record any difference. If GitHub rewrites the prefix, pick a prefix it keeps and record it.

- [ ] **Step 4: Environment with `deployment: false`.** In `doguyilmaz/tapster-spike`:
  - create environment `t` with a `main` branch policy and secret `S=hello`;
  - add a workflow that has one job with `environment: { name: t, deployment: false }` printing `[ -n "$S" ] && echo has-secret`;
  - dispatch it on `main`, and on a branch `other`.

```bash
gh api -X PUT repos/doguyilmaz/tapster-spike/environments/t -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/doguyilmaz/tapster-spike/environments/t/deployment-branch-policies -f name=main -f type=branch
gh secret set S --env t --body hello --repo doguyilmaz/tapster-spike
```
Expected: `main` prints `has-secret`; `other` is rejected by the branch policy. Record whether a deployment record was
created (`gh api repos/doguyilmaz/tapster-spike/deployments --jq length`).

- [ ] **Step 5: Linux casks and `tap_migrations`.**
  - In `homebrew-tapster-spike`, add `Casks/spk.rb` with `on_macos` and `on_linux` blocks pointing at the Step 3 asset.
  - Add `spk.rb` as a formula at the root, then replace it with `tap_migrations.json` (`{"spk": "doguyilmaz/tapster-spike/spk"}`).
  - Run `brew tap doguyilmaz/tapster-spike <clone path>`, `brew style --cask doguyilmaz/tapster-spike/spk` and
    `brew audit --cask --online doguyilmaz/tapster-spike/spk` on this Mac.

Expected: style passes; audit fails only because the asset is private. Record the exact output.

- [ ] **Step 6: App manifest without a webhook.**
  - Start a one-off local server.
  - Post a manifest with `"hook_attributes": {"url": "https://example.com/none", "active": false}`.
  - Then do it again with `hook_attributes` omitted.

The person clicks "Create" each time. Record which one GitHub accepts. Delete both Apps afterwards.

- [ ] **Step 7: `.p12` re-wrap with LibreSSL.**

```bash
cd /tmp && rm -rf p12spike && mkdir p12spike && cd p12spike
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj "/CN=tapster spike/OU=SPIKE00001"
/usr/bin/openssl pkcs12 -export -in c.pem -inkey k.pem -out in.p12 -passout pass:real-password
P=real-password O=one-time-password /usr/bin/openssl pkcs12 -in in.p12 -passin env:P -passout env:O -out key.pem
O=one-time-password /usr/bin/openssl pkcs12 -export -in key.pem -passin env:O -passout env:O -out wrapped.p12
security create-keychain -p kc spike.keychain-db && security import wrapped.p12 -k spike.keychain-db -P one-time-password -T /usr/bin/codesign
security find-identity -p codesigning spike.keychain-db; security delete-keychain spike.keychain-db
```
Expected: the import succeeds and the identity is listed (as not trusted). Record the result.

- [ ] **Step 8: `notarytool` JSON.** Notarize the Step 2 binary and record the stdout JSON keys of `submit` and `log`.

```bash
cd /tmp/bunspike && ditto -c -k --keepParent a a.zip
xcrun notarytool submit a.zip --key "$P8" --key-id "$KEY_ID" --issuer "$ISSUER" --wait --timeout 30m --output-format json
```
`P8`, `KEY_ID` and `ISSUER` are set by the person in their own shell; nothing is pasted into the session.

Expected: JSON with `id`, `status` and `message`. Record the key names exactly.

- [ ] **Step 9: Schedule re-enable.** Read the docs for
  `PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable` and record whether enabling resets the 60-day timer. If it
  is not documented, record "unknown, keep heartbeat".

- [ ] **Step 10: Write `docs/spikes.md`.** One section per step with the command, the observed result and the
  decision. Delete the scratch repositories:

```bash
gh repo delete doguyilmaz/tapster-spike --yes && gh repo delete doguyilmaz/homebrew-tapster-spike --yes
```

- [ ] **Step 11: Apply the decisions.**
  - If any result differs from the spec, edit the spec section and the affected task in this plan before starting
    Task 2.
  - Commit: `git add docs && git commit -m "Record the phase 1 spikes"`

---

### Task 2: Project scaffold and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `LICENSE`, `README.md`, `action.yml`,
  `.github/workflows/ci.yml`, `templates/pins.json`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: the scripts `bun test`, `bun run typecheck` and `bun run build:action`, and the `dist/` check in CI.

- [ ] **Step 1: Create the GitHub repository and the package**

```bash
cd ~/Developer/FORK/tapster
gh repo create doguyilmaz/tapster --private --source . --push
```

`package.json`:
```json
{
  "name": "@doguyilmaz/tapster",
  "version": "0.0.0",
  "description": "Sign, notarize and publish the releases of all your projects from one Homebrew tap",
  "license": "MIT",
  "type": "module",
  "bin": { "tapster": "./src/cli/main.ts" },
  "files": ["src", "templates", "README.md", "LICENSE"],
  "engines": { "bun": ">=1.4.0" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "build:action": "bun build ./src/action/main.ts --target=node --format=esm --minify --outfile dist/index.js"
  }
}
```

```bash
bun add --exact @actions/core yaml zod
bun add --exact --dev typescript @types/bun
```

- [ ] **Step 2: Config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["ESNext"], "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "types": ["bun-types"], "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "verbatimModuleSyntax": true, "resolveJsonModule": true
  },
  "include": ["src", "tests"]
}
```
`bunfig.toml`:
```toml
[install]
exact = true
```
`.gitignore`:
```
node_modules/
.DS_Store
coverage/
```
`LICENSE`: the MIT text with "Copyright (c) 2026 Dogu Yilmaz" (copy from `~/Developer/FORK/lockstep/LICENSE`, replace
the project name).

`action.yml`:
```yaml
name: tapster
description: Sign, notarize and publish releases from a Homebrew tap hub
inputs:
  mode:
    description: check | fetch | sign | publish | render | cleanup
    required: true
  work:
    description: Work list from the check job (JSON)
    required: false
    default: "[]"
  package:
    description: Limit the check to one package
    required: false
    default: ""
  config:
    description: Path of the hub config
    required: false
    default: tapster.yml
outputs:
  work:
    description: Work list (JSON, check mode)
  render:
    description: "true when the render job has something to do (check mode)"
runs:
  using: node24
  main: dist/index.js
```

- [ ] **Step 3: Pinned action SHAs.** Resolve each tag once and write `templates/pins.json`:

```bash
for r in actions/checkout:v5 actions/attest-build-provenance:v3 oven-sh/setup-bun:v2; do
  repo=${r%%:*}; tag=${r##*:}
  echo "$repo $tag $(git ls-remote https://github.com/$repo "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f1)"
done
```
```json
{
  "actions/checkout": { "tag": "v5", "sha": "<40-char sha from the command>" },
  "actions/attest-build-provenance": { "tag": "v3", "sha": "<40-char sha>" },
  "oven-sh/setup-bun": { "tag": "v2", "sha": "<40-char sha>" }
}
```
Write the real SHAs from the command output; a placeholder left in this file fails the test in Step 4.

- [ ] **Step 4: Smoke test**

`tests/smoke.test.ts`:
```ts
import { expect, test } from "bun:test";
import pins from "../templates/pins.json";

test("every pinned action is a full commit sha", () => {
  for (const [name, pin] of Object.entries(pins)) {
    expect(pin.sha, name).toMatch(/^[0-9a-f]{40}$/);
  }
});
```
Run: `bun test`
Expected: PASS (1 test).

- [ ] **Step 5: CI workflow** (`.github/workflows/ci.yml`). Write the SHAs from `templates/pins.json`.

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
permissions: {}
jobs:
  test:
    runs-on: ubuntu-24.04
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<checkout sha> # v5
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@<setup-bun sha> # v2
        with: { bun-version: 1.4.3 }
      - run: bun install --frozen-lockfile --ignore-scripts
      - run: bun run typecheck
      - run: bun test
      - name: dist/ matches the source
        run: bun run build:action && git diff --exit-code dist/
  macos:
    runs-on: macos-15
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<checkout sha> # v5
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@<setup-bun sha> # v2
        with: { bun-version: 1.4.3 }
      - run: bun install --frozen-lockfile --ignore-scripts
      - run: bun test
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Scaffold tapster with CI" && git push
```

---

### Task 3: Errors, secret registry and reporting

**Files:**
- Create: `src/errors.ts`, `src/mask.ts`, `src/report.ts`
- Test: `tests/mask.test.ts`, `tests/report.test.ts`

**Interfaces:**
- Produces:
  - `class TapsterError extends Error { reason: string; fix: string }` and
    `class GitHubError extends TapsterError { status: number }`.
  - `register(value: string): void`, `variants(value: string): string[]`, `scrub(text: string): string`,
    `readSecret(name: string): string`, `requireVar(name: string): string`, `resetMaskForTests(): void`.
  - `info(msg)`, `warn(msg)`, `record(row: Row)`, `failure(item: string, err: unknown)`, `writeSummary()`,
    `failedCount()`, `rowsForTests()`, `resetReportForTests()`.
  - `type Row = { item: string; result: "published" | "rendered" | "skipped" | "failed" | "waiting"; detail: string }`.

- [ ] **Step 1: Write the failing tests**

`tests/mask.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { readSecret, register, resetMaskForTests, scrub, variants } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(resetMaskForTests);

test("scrub hides a registered value and its encodings", () => {
  const secret = "s3cr3t-value\nsecond-line";
  register(secret);
  const b64 = Buffer.from(secret).toString("base64");
  const hex = Buffer.from(secret).toString("hex");
  const text = `a ${secret} b ${b64} c ${hex} d ${encodeURIComponent(secret)} e second-line`;
  const out = scrub(text);
  expect(out).not.toContain("s3cr3t");
  expect(out).not.toContain(b64);
  expect(out).not.toContain(hex);
  expect(out).not.toContain("second-line");
});

test("short values are not used as masks", () => {
  expect(variants("ab")).toEqual([]);
});

test("readSecret registers and removes the variable", () => {
  process.env.TAPSTER_TEST_SECRET = "value-from-env";
  expect(readSecret("TAPSTER_TEST_SECRET")).toBe("value-from-env");
  expect(process.env.TAPSTER_TEST_SECRET).toBeUndefined();
  expect(scrub("x value-from-env y")).toBe("x *** y");
});

test("a missing secret explains how to add it", () => {
  delete process.env.TAPSTER_MISSING;
  expect(() => readSecret("TAPSTER_MISSING")).toThrow(TapsterError);
});
```

`tests/report.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { failure, failedCount, record, resetReportForTests, rowsForTests } from "../src/report";
import { register, resetMaskForTests } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(() => { resetReportForTests(); resetMaskForTests(); });

test("records are scrubbed", () => {
  register("hidden-token-123");
  record({ item: "aims v1.0.0", result: "published", detail: "used hidden-token-123" });
  expect(rowsForTests()[0]!.detail).toBe("used ***");
});

test("unknown errors never print their message", () => {
  failure("aims", new Error("Unexpected token in JSON at position 3: secret-fragment"));
  const row = rowsForTests()[0]!;
  expect(row.result).toBe("failed");
  expect(row.detail).not.toContain("secret-fragment");
  expect(failedCount()).toBe(1);
});

test("tapster errors print reason and fix", () => {
  failure("aims", new TapsterError("notarization invalid", "Fix the build."));
  expect(rowsForTests()[0]!.detail).toBe("notarization invalid. Fix the build.");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/mask.test.ts tests/report.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/errors.ts`:
```ts
export class TapsterError extends Error {
  constructor(readonly reason: string, readonly fix: string) {
    super(reason);
    this.name = "TapsterError";
  }
}

export class GitHubError extends TapsterError {
  constructor(reason: string, fix: string, readonly status: number) {
    super(reason, fix);
    this.name = "GitHubError";
  }
}
```

`src/mask.ts`:
```ts
import * as core from "@actions/core";
import { TapsterError } from "./errors";

const MIN = 4;
const registered = new Set<string>();

export function variants(value: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length >= MIN) out.add(v);
  };
  add(value);
  const bytes = Buffer.from(value, "utf8");
  add(bytes.toString("base64"));
  add(bytes.toString("hex"));
  add(bytes.toString("hex").toUpperCase());
  add(encodeURIComponent(value));
  for (const line of value.split(/\r?\n/)) add(line.trim());
  return [...out];
}

export function register(value: string): void {
  for (const v of variants(value)) {
    if (registered.has(v)) continue;
    registered.add(v);
    core.setSecret(v);
  }
}

export function scrub(text: string): string {
  let out = text;
  for (const v of [...registered].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}

export function readSecret(name: string): string {
  const value = process.env[name];
  delete process.env[name];
  if (!value) {
    throw new TapsterError(`${name} is not set`, `Add ${name} to the hub's "tapster" environment; tapster doctor shows how.`);
  }
  register(value);
  return value;
}

export function requireVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new TapsterError(`${name} is not set`, `Add the ${name} variable to the "tapster" environment.`);
  return value;
}

export function resetMaskForTests(): void {
  registered.clear();
}
```

`src/report.ts`:
```ts
import * as core from "@actions/core";
import { TapsterError } from "./errors";
import { scrub } from "./mask";

export type Row = { item: string; result: "published" | "rendered" | "skipped" | "failed" | "waiting"; detail: string };

const rows: Row[] = [];

export const info = (msg: string) => core.info(scrub(msg));
export const warn = (msg: string) => core.warning(scrub(msg));

export function record(row: Row): void {
  const clean = { ...row, item: scrub(row.item), detail: scrub(row.detail) };
  rows.push(clean);
  info(`${clean.item}: ${clean.result}${clean.detail ? ` (${clean.detail})` : ""}`);
}

export function failure(item: string, err: unknown): void {
  const e =
    err instanceof TapsterError
      ? err
      : new TapsterError(
          `unexpected ${err instanceof Error ? err.name : "error"}`,
          "Re-run the workflow; if it fails again, open an issue with the run link.",
        );
  record({ item, result: "failed", detail: `${e.reason}. ${e.fix}` });
  core.error(scrub(`${item}: ${e.reason}`));
}

export async function writeSummary(): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY || rows.length === 0) return;
  await core.summary
    .addHeading("tapster", 2)
    .addTable([
      [
        { data: "Item", header: true },
        { data: "Result", header: true },
        { data: "Detail", header: true },
      ],
      ...rows.map((r) => [r.item, r.result, r.detail]),
    ])
    .write();
}

export const failedCount = () => rows.filter((r) => r.result === "failed").length;
export const rowsForTests = () => rows;
export const resetReportForTests = () => {
  rows.length = 0;
};
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/mask.test.ts tests/report.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Mask secrets and report results without printing them"
```

---

### Task 4: Child process wrapper

**Files:**
- Create: `src/run.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: `scrub` (Task 3), `TapsterError` (Task 3).
- Produces:
  - `TOOLS` (record of absolute paths) and `type Tool = keyof typeof TOOLS`.
  - `run(tool: Tool, args: string[], opts?: RunOptions): Promise<RunResult>` and
    `runPath(path: string, label: string, args: string[], opts?: RunOptions): Promise<RunResult>`.
  - `childEnv(extra?: Record<string, string>): Record<string, string>`, `excerpt(text: string, max?: number): string`
    and `ghPath(): string`.
  - `RunOptions = { env?: Record<string, string>; stdin?: string | Uint8Array; allowFail?: boolean; cwd?: string }`
    and `RunResult = { code: number; stdout: string; stderr: string }`.

- [ ] **Step 1: Write the failing test**

`tests/run.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { childEnv, excerpt, runPath } from "../src/run";
import { register, resetMaskForTests } from "../src/mask";
import { TapsterError } from "../src/errors";

afterEach(resetMaskForTests);

test("children get only the allowlisted environment", async () => {
  process.env.TAPSTER_SHOULD_NOT_LEAK = "leak";
  const res = await runPath("/usr/bin/env", "env", [], { env: { EXTRA: "1" } });
  const keys = res.stdout.trim().split("\n").map((l) => l.split("=")[0]).sort();
  expect(keys).toEqual(["EXTRA", "HOME", "PATH", "TMPDIR"]);
  delete process.env.TAPSTER_SHOULD_NOT_LEAK;
});

test("a failing tool never puts its arguments in the error", async () => {
  register("secret-argument-value");
  let err: unknown;
  try {
    await runPath("/bin/sh", "sh", ["-c", "echo secret-argument-value >&2; exit 3", "secret-argument-value"]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TapsterError);
  const e = err as TapsterError;
  expect(e.reason).toBe("sh exited with 3");
  expect(`${e.reason} ${e.fix}`).not.toContain("secret-argument-value");
});

test("allowFail returns the code instead of throwing", async () => {
  const res = await runPath("/bin/sh", "sh", ["-c", "exit 4"], { allowFail: true });
  expect(res.code).toBe(4);
});

test("stdin reaches the child", async () => {
  const res = await runPath("/bin/cat", "cat", [], { stdin: "from-stdin" });
  expect(res.stdout).toBe("from-stdin");
});

test("excerpt drops keychain lines and scrubs", () => {
  register("tok-123456");
  expect(excerpt("a\nlogin.keychain-db x\nb tok-123456\n")).toBe("a | b ***");
});

test("childEnv uses a fixed PATH", () => {
  expect(childEnv().PATH).toBe("/usr/bin:/bin");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/run.ts`

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { TapsterError } from "./errors";
import { scrub } from "./mask";

export const TOOLS = {
  codesign: "/usr/bin/codesign",
  security: "/usr/bin/security",
  xcrun: "/usr/bin/xcrun",
  openssl: "/usr/bin/openssl",
  ditto: "/usr/bin/ditto",
  git: "/usr/bin/git",
} as const;
export type Tool = keyof typeof TOOLS;

const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export type RunOptions = { env?: Record<string, string>; stdin?: string | Uint8Array; allowFail?: boolean; cwd?: string };
export type RunResult = { code: number; stdout: string; stderr: string };

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
    ...extra,
  };
}

export function excerpt(text: string, max = 5): string {
  return scrub(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !/keychain/i.test(l))
    .slice(-max)
    .join(" | ");
}

export function ghPath(): string {
  const found = GH.find((p) => existsSync(p));
  if (!found) throw new TapsterError("gh is not installed on this runner", "Use a GitHub-hosted runner image, which ships gh.");
  return found;
}

export function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runPath(TOOLS[tool], tool, args, opts);
}

export function runPath(path: string, label: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { env: childEnv(opts.env), cwd: opts.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", () => reject(new TapsterError(`${label} could not start`, `Check that ${path} exists on this runner.`)));
    child.on("close", (code) => {
      const res = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new TapsterError(`${label} exited with ${res.code}`, excerpt(res.stderr) || "No error output."));
        return;
      }
      resolve(res);
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/run.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Run tools by absolute path with an allowlisted environment"
```

---
### Task 5: Config, tags and versions

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `TapsterError` (Task 3).
- Produces:
  - Constants: `PLATFORMS`, `type Platform`, `TAG`, `NAME`, `ENTITLEMENTS`.
  - Types: `type PackageConfig`, `type HubConfig`, `type Semver = { major: number; minor: number; patch: number; pre: string | null }`.
  - `parseConfig(text: string, hubOwner: string): HubConfig`.
  - `parseTag(tag: string): Semver | null` and `compareSemver(a: Semver, b: Semver): number`.
  - `versionOf(tag: string): string` and `assetName(pkg: PackageConfig, platform: Platform, version: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
import { expect, test } from "bun:test";
import { assetName, compareSemver, parseConfig, parseTag } from "../src/config";
import { TapsterError } from "../src/errors";

const good = `
version: 1
tap: doguyilmaz/tap
packages:
  - name: aims
    repo: doguyilmaz/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      windows-amd64: "aims_{version}_windows_amd64.zip"
    scoop: true
`;

test("a valid config parses with defaults", () => {
  const c = parseConfig(good, "doguyilmaz");
  const p = c.packages[0]!;
  expect(p.kind).toBe("go");
  expect(p.attestation).toBe("auto");
  expect(p.workflow).toBe("release.yml");
  expect(assetName(p, "darwin-arm64", "1.2.3")).toBe("aims_1.2.3_darwin_arm64.tar.gz");
});

test.each([
  ["unknown key", good.replace("scoop: true", "scoop: true\n    shiny: 1")],
  ["foreign owner", good.replace("repo: doguyilmaz/aims", "repo: someone/aims")],
  ["darwin zip", good.replace("darwin_arm64.tar.gz", "darwin_arm64.zip")],
  ["ruby in asset", good.replace("aims_{version}_darwin", "aims_#{x}_darwin")],
  ["other placeholder", good.replace("{version}_darwin", "{tag}_darwin")],
  ["bad name", good.replace("name: aims", "name: Aims")],
  ["dotdot binary", good.replace("binaries: [aims]", "binaries: [../aims]")],
  ["quote in zap", `${good}\n    cask: { zap: { trash: ["~/x\\"y"] } }`],
])("rejects %s", (_, text) => {
  expect(() => parseConfig(text, "doguyilmaz")).toThrow(TapsterError);
});

test("tags", () => {
  expect(parseTag("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  expect(parseTag("v1.2.3-rc.1")?.pre).toBe("rc.1");
  for (const bad of ["1.2.3", "v1.2", "v1.2.3#{`x`}", "v1.2.3-", "v1.2.3 ", "v01.2.3x"]) expect(parseTag(bad)).toBeNull();
});

test("semver order", () => {
  const s = (t: string) => parseTag(t)!;
  expect(compareSemver(s("v1.10.0"), s("v1.9.9"))).toBeGreaterThan(0);
  expect(compareSemver(s("v1.0.0"), s("v1.0.0-rc.1"))).toBeGreaterThan(0);
  expect(compareSemver(s("v1.0.0-rc.2"), s("v1.0.0-rc.10"))).toBeLessThan(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/config.ts`

```ts
import { parse } from "yaml";
import { z } from "zod";
import { TapsterError } from "./errors";

export const PLATFORMS = ["darwin-universal", "darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64", "windows-amd64", "windows-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
] as const;

const relPath = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((p) => !p.split("/").includes(".."), "must stay inside the archive");
const label = z.string().regex(/^[A-Za-z0-9.-]+$/);

const pkg = z
  .object({
    name: z.string().regex(NAME),
    repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    kind: z.enum(["go", "bun"]).default("go"),
    workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/).default("release.yml"),
    binaries: z.array(relPath).min(1),
    assets: z.partialRecord(z.enum(PLATFORMS), z.string().regex(/^[A-Za-z0-9._{}-]+$/)),
    description: z.string().min(1).max(200).optional(),
    homepage: z.url().optional(),
    license: z.string().regex(/^[A-Za-z0-9.+-]+$/).optional(),
    completions: z.object({ bash: relPath.optional(), zsh: relPath.optional(), fish: relPath.optional() }).strict().optional(),
    scoop: z.boolean().default(false),
    attestation: z.enum(["auto", "off"]).default("auto"),
    entitlements: z.array(z.enum(ENTITLEMENTS)).default([]),
    cask: z
      .object({
        uninstall: z.object({ launchctl: z.array(label).optional(), quit: z.array(label).optional() }).strict().optional(),
        zap: z.object({ trash: z.array(z.string().regex(/^~\/[A-Za-z0-9 ._\/-]+$/)) }).strict().optional(),
        caveats: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const hub = z
  .object({
    version: z.literal(1),
    tap: z.string().regex(/^[A-Za-z0-9-]+\/[a-z0-9-]+$/),
    packages: z.array(pkg),
  })
  .strict();

export type PackageConfig = z.infer<typeof pkg>;
export type HubConfig = z.infer<typeof hub>;
export type Semver = { major: number; minor: number; patch: number; pre: string | null };

export function parseConfig(text: string, hubOwner: string): HubConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    throw new TapsterError("tapster.yml is not valid YAML", "Fix the YAML syntax; tapster doctor shows the line.");
  }
  const result = hub.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new TapsterError(`tapster.yml is invalid: ${issues}`, "Fix the listed fields.");
  }
  const names = new Set<string>();
  for (const p of result.data.packages) {
    if (names.has(p.name)) throw new TapsterError(`package ${p.name} is listed twice`, "Keep one entry per package.");
    names.add(p.name);
    if (p.repo.split("/")[0]!.toLowerCase() !== hubOwner.toLowerCase()) {
      throw new TapsterError(`${p.name}: ${p.repo} is not owned by ${hubOwner}`, "tapster publishes only repositories of the hub's owner.");
    }
    const entries = Object.entries(p.assets);
    if (entries.length === 0) throw new TapsterError(`${p.name}: assets is empty`, "Map at least one platform to an asset name.");
    for (const [platform, name] of entries) {
      if (name.replaceAll("{version}", "").includes("{") || name.replaceAll("{version}", "").includes("}")) {
        throw new TapsterError(`${p.name}: ${name} uses a placeholder other than {version}`, "Only {version} is replaced in asset names.");
      }
      if (platform.startsWith("darwin") && !name.endsWith(".tar.gz")) {
        throw new TapsterError(`${p.name}: the ${platform} asset must be a .tar.gz`, "Pack macOS builds as tar.gz; tapster reads them itself.");
      }
    }
  }
  return result.data;
}

export function parseTag(tag: string): Semver | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const x = a.pre.split(".");
  const y = b.pre.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const versionOf = (tag: string) => tag.slice(1);

export function assetName(p: PackageConfig, platform: Platform, version: string): string | undefined {
  return p.assets[platform]?.replaceAll("{version}", version);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/config.test.ts`
Expected: PASS. If `z.partialRecord` or `z.url` is missing, the installed zod is older than 4; reinstall with
`bun add --exact zod@4`.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Validate tapster.yml, tags and asset names"
```

---

### Task 6: checksums.txt

**Files:**
- Create: `src/checksums.ts`
- Test: `tests/checksums.test.ts`

**Interfaces:**
- Consumes: `TapsterError`.
- Produces:
  - `type ChecksumLine = { sha256: string; name: string }`.
  - `parseChecksums(text: string): ChecksumLine[]`, `writeChecksums(lines: ChecksumLine[]): string` and
    `sha256(data: Uint8Array): string`.

- [ ] **Step 1: Write the failing test**

`tests/checksums.test.ts`:
```ts
import { expect, test } from "bun:test";
import { parseChecksums, sha256, writeChecksums } from "../src/checksums";
import { TapsterError } from "../src/errors";

const h = "a".repeat(64);
const g = "b".repeat(64);

test("parses GoReleaser output", () => {
  expect(parseChecksums(`${h}  aims_1.0.0_darwin_arm64.tar.gz\n${g}  aims_1.0.0_linux_amd64.tar.gz\n`)).toEqual([
    { sha256: h, name: "aims_1.0.0_darwin_arm64.tar.gz" },
    { sha256: g, name: "aims_1.0.0_linux_amd64.tar.gz" },
  ]);
});

test("review focus 1: CRLF, trailing spaces and binary markers parse", () => {
  expect(parseChecksums(`${h.toUpperCase()} *a.zip  \r\n\r\n${g}  b.tar.gz\r\n`)).toEqual([
    { sha256: h, name: "a.zip" },
    { sha256: g, name: "b.tar.gz" },
  ]);
});

test.each([
  ["duplicate", `${h}  a.zip\n${g}  a.zip\n`],
  ["short hash", `abc  a.zip\n`],
  ["path", `${h}  dir/a.zip\n`],
  ["empty", "\n\n"],
])("rejects %s", (_, text) => {
  expect(() => parseChecksums(text)).toThrow(TapsterError);
});

test("writes sorted lines", () => {
  expect(writeChecksums([{ sha256: g, name: "b" }, { sha256: h, name: "a" }])).toBe(`${h}  a\n${g}  b\n`);
});

test("sha256", () => {
  expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/checksums.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/checksums.ts`

```ts
import { createHash } from "node:crypto";
import { TapsterError } from "./errors";

export type ChecksumLine = { sha256: string; name: string };

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export function parseChecksums(text: string): ChecksumLine[] {
  const out: ChecksumLine[] = [];
  const names = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^([0-9a-fA-F]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new TapsterError(`checksums.txt line ${i + 1} is malformed`, 'Each line must be "<sha256>  <file name>".');
    const name = m[2]!;
    if (names.has(name)) throw new TapsterError(`checksums.txt lists ${name} twice`, "List each file once.");
    names.add(name);
    out.push({ sha256: m[1]!.toLowerCase(), name });
  }
  if (out.length === 0) throw new TapsterError("checksums.txt is empty", "List every release file with its sha256.");
  return out;
}

export function writeChecksums(lines: ChecksumLine[]): string {
  return `${[...lines]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => `${l.sha256}  ${l.name}`)
    .join("\n")}\n`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/checksums.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Parse and write checksums.txt"
```

---

### Task 7: GitHub REST client

**Files:**
- Create: `src/github.ts`
- Test: `tests/github.test.ts`

**Interfaces:**
- Consumes: `GitHubError`, `TapsterError`.
- Produces:
  - Types: `type Asset = { id: number; name: string; size: number; state: string; digest: string | null; browser_download_url: string }`,
    `type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; upload_url: string; assets: Asset[] }`,
    `type Repo = { id: number; private: boolean; description: string | null; html_url: string; default_branch: string }`
    and `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`.
  - `class GitHub`, built with `new GitHub(token: string, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>)`.
  - Methods: `request`, `json<T>(method, path, body?)`, `listReleases(repo)`, `getRelease(repo, id)`,
    `getRepo(repo)`, `downloadAsset(repo, assetId)`, `uploadAsset(release, name, data)`, `deleteAsset(repo, id)`,
    `renameAsset(repo, id, name)` and `updateRelease(repo, id, patch)`.

- [ ] **Step 1: Write the failing test**

`tests/github.test.ts`:
```ts
import { expect, test } from "bun:test";
import { GitHub, type FetchLike } from "../src/github";
import { GitHubError } from "../src/errors";

type Call = { url: string; init: RequestInit };

function fake(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const noSleep = async () => {};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("sends auth and API headers", async () => {
  const f = fake([json({ id: 1, private: false })]);
  await new GitHub("tok-abc", f.fetch, noSleep).getRepo("o/r");
  const h = f.calls[0]!.init.headers as Record<string, string>;
  expect(f.calls[0]!.url).toBe("https://api.github.com/repos/o/r");
  expect(h.Authorization).toBe("Bearer tok-abc");
  expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
});

test("retries 5xx and network errors, then succeeds", async () => {
  const f = fake([new Error("reset"), json({}, 502), json({ id: 2 })]);
  expect((await new GitHub("t", f.fetch, noSleep).getRepo("o/r")).id).toBe(2);
  expect(f.calls.length).toBe(3);
});

test("errors carry status and path, never bodies or tokens", async () => {
  const f = fake([json({ message: "secret body" }, 404)]);
  let err: unknown;
  try {
    await new GitHub("tok-xyz", f.fetch, noSleep).getRepo("o/r");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GitHubError);
  const e = err as GitHubError;
  expect(e.status).toBe(404);
  expect(e.reason).toBe("GitHub GET /repos/o/r returned 404");
  expect(`${e.reason}${e.fix}`).not.toContain("secret body");
});

test("review focus 4: releases are paginated past 100", async () => {
  const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: start + i, tag_name: `v0.0.${start + i}`, draft: false, assets: [] }));
  const f = fake([json(page(100, 0)), json(page(3, 100))]);
  const all = await new GitHub("t", f.fetch, noSleep).listReleases("o/r");
  expect(all.length).toBe(103);
  expect(f.calls[1]!.url).toContain("page=2");
});

test("asset downloads follow the redirect without the token", async () => {
  const f = fake([
    new Response(null, { status: 302, headers: { location: "https://objects.example/x?X-Amz-Signature=sig" } }),
    new Response("bytes"),
  ]);
  const data = await new GitHub("tok", f.fetch, noSleep).downloadAsset("o/r", 7);
  expect(data.toString()).toBe("bytes");
  expect((f.calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("uploads go to the release upload url", async () => {
  const f = fake([json({ id: 9, name: "tapster-staging--a" })]);
  const release = { id: 1, upload_url: "https://uploads.github.com/repos/o/r/releases/1/assets{?name,label}" } as never;
  await new GitHub("t", f.fetch, noSleep).uploadAsset(release, "tapster-staging--a", new Uint8Array([1]));
  expect(f.calls[0]!.url).toBe("https://uploads.github.com/repos/o/r/releases/1/assets?name=tapster-staging--a");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/github.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/github.ts`

```ts
import { GitHubError } from "./errors";

export type Asset = { id: number; name: string; size: number; state: string; digest: string | null; browser_download_url: string };
export type Release = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  upload_url: string;
  assets: Asset[];
};
export type Repo = { id: number; private: boolean; description: string | null; html_url: string; default_branch: string };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const HINTS: Record<number, string> = {
  401: "The credential was rejected; rotate it with tapster init --rotate.",
  403: "Access denied: check the App's permissions and that it is installed on this repository.",
  404: "Not found, or the App is not installed on this repository.",
  409: "GitHub reported a conflict; the next run retries.",
  422: "GitHub rejected the request.",
};

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(url)";
  }
}

type RequestInitLite = { body?: unknown; raw?: Uint8Array; contentType?: string; accept?: string; auth?: boolean };

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async request(method: string, url: string, init: RequestInitLite = {}): Promise<Response> {
    const full = url.startsWith("https://") ? url : `https://api.github.com${url}`;
    const headers: Record<string, string> = {
      Accept: init.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tapster",
    };
    if (init.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    if (init.contentType) headers["Content-Type"] = init.contentType;
    else if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(full, { method, headers, body, redirect: "manual" });
      } catch {
        if (attempt < 4) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new GitHubError(`GitHub ${method} ${pathOf(full)}: network error`, "GitHub did not answer; the next run retries.", 0);
      }
      if ((res.status >= 500 || res.status === 429) && attempt < 4) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) {
        await res.body?.cancel();
        throw new GitHubError(`GitHub ${method} ${pathOf(full)} returned ${res.status}`, HINTS[res.status] ?? "The next run retries.", res.status);
      }
      return res;
    }
  }

  async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.request(method, url, body === undefined ? {} : { body });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listReleases(repo: string): Promise<Release[]> {
    const out: Release[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<Release[]>("GET", `/repos/${repo}/releases?per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  getRelease = (repo: string, id: number) => this.json<Release>("GET", `/repos/${repo}/releases/${id}`);
  getRepo = (repo: string) => this.json<Repo>("GET", `/repos/${repo}`);

  async downloadAsset(repo: string, assetId: number): Promise<Buffer> {
    const res = await this.request("GET", `/repos/${repo}/releases/assets/${assetId}`, { accept: "application/octet-stream" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new GitHubError(`GitHub sent a redirect without a location for asset ${assetId}`, "The next run retries.", res.status);
      const next = await this.request("GET", location, { auth: false, accept: "application/octet-stream" });
      return Buffer.from(await next.arrayBuffer());
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async uploadAsset(release: Release, name: string, data: Uint8Array): Promise<Asset> {
    const base = release.upload_url.replace(/\{.*\}$/, "");
    const res = await this.request("POST", `${base}?name=${encodeURIComponent(name)}`, { raw: data, contentType: "application/octet-stream" });
    return (await res.json()) as Asset;
  }

  deleteAsset = (repo: string, id: number) => this.request("DELETE", `/repos/${repo}/releases/assets/${id}`).then(() => undefined);
  renameAsset = (repo: string, id: number, name: string) => this.json<Asset>("PATCH", `/repos/${repo}/releases/assets/${id}`, { name });
  updateRelease = (repo: string, id: number, patch: { draft?: boolean; make_latest?: "true" | "false" }) =>
    this.json<Release>("PATCH", `/repos/${repo}/releases/${id}`, patch);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/github.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Talk to GitHub with retries and errors that hold no bodies"
```

---

### Task 8: App JWT and installation tokens

**Files:**
- Create: `src/token.ts`
- Test: `tests/token.test.ts`

**Interfaces:**
- Consumes: `GitHub`, `FetchLike` (Task 7); `register` (Task 3).
- Produces:
  - `appJwt(appId: string, pem: string, now?: number): string`.
  - `installationToken(appId: string, pem: string, repo: string, permissions: Record<string, "read" | "write">, fetchImpl?: FetchLike): Promise<InstallationToken>`.
  - `type InstallationToken = { token: string; revoke(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`tests/token.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, installationToken } from "../src/token";
import { resetMaskForTests, scrub } from "../src/mask";

afterEach(resetMaskForTests);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("the JWT is RS256, short-lived and masked", () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const jwt = appJwt("12345", pem, now);
  const [h, p, s] = jwt.split(".");
  expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  expect(payload.iss).toBe("12345");
  expect(payload.exp - payload.iat).toBe(540);
  expect(scrub(jwt)).toBe("***");
});

test("installation tokens are scoped, masked and revocable", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/o/aims/installation")) return Response.json({ id: 77 });
    if (url.endsWith("/app/installations/77/access_tokens")) return Response.json({ token: "ghs_installationtoken" }, { status: 201 });
    if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const tok = await installationToken("12345", pem, "o/aims", { contents: "write" }, fetchImpl);
  expect(tok.token).toBe("ghs_installationtoken");
  expect(scrub("x ghs_installationtoken")).toBe("x ***");
  const body = JSON.parse(calls[1]!.init!.body as string);
  expect(body).toEqual({ repositories: ["aims"], permissions: { contents: "write" } });
  await tok.revoke();
  expect(calls.at(-1)!.init!.method).toBe("DELETE");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/token.ts`

```ts
import { createSign } from "node:crypto";
import { GitHub, type FetchLike } from "./github";
import { register } from "./mask";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem).toString("base64url");
  const jwt = `${head}.${body}.${sig}`;
  register(jwt);
  return jwt;
}

export type InstallationToken = { token: string; revoke(): Promise<void> };

export async function installationToken(
  appId: string,
  pem: string,
  repo: string,
  permissions: Record<string, "read" | "write">,
  fetchImpl?: FetchLike,
): Promise<InstallationToken> {
  const app = new GitHub(appJwt(appId, pem), fetchImpl);
  const installation = await app.json<{ id: number }>("GET", `/repos/${repo}/installation`);
  const { token } = await app.json<{ token: string }>("POST", `/app/installations/${installation.id}/access_tokens`, {
    repositories: [repo.split("/")[1]],
    permissions,
  });
  register(token);
  const gh = new GitHub(token, fetchImpl);
  return {
    token,
    revoke: async () => {
      await gh.request("DELETE", "/installation/token").catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Mint and revoke per-repository App tokens"
```

---

### Task 9: State file and hub commits

**Files:**
- Create: `src/state.ts`, `src/hubcommit.ts`
- Test: `tests/state.test.ts`, `tests/hubcommit.test.ts`

**Interfaces:**
- Consumes: `NAME`, `TAG`, `parseTag`, `compareSemver` (Task 5); `GitHub` (Task 7); `GitHubError`, `TapsterError`.
- Produces:
  - Types: `type StateEntry = { tag: string; releaseId: number; checksums: string; status: "publishing" | "published" }`
    and `type State = { version: 1; packages: Record<string, StateEntry[]> }`.
  - State functions: `emptyState()`, `parseState(text: string | null): State`, `serializeState(s: State): string`,
    `upsert(s: State, pkg: string, e: StateEntry): State` and `latestPublished(s: State, pkg: string): StateEntry | undefined`.
  - Commits: `type FileChange = { path: string; content: string | null }` and
    `commitToHub(gh: GitHub, hub: string, message: string, build: (read: (path: string) => Promise<string | null>) => Promise<FileChange[]>): Promise<"committed" | "unchanged">`.
  - `STATE_PATH = ".tapster/state.json"`.

- [ ] **Step 1: Write the failing tests**

`tests/state.test.ts`:
```ts
import { expect, test } from "bun:test";
import { latestPublished, parseState, serializeState, upsert } from "../src/state";
import { TapsterError } from "../src/errors";

const sum = "c".repeat(64);

test("upsert replaces by release id and keeps the newest first", () => {
  let s = parseState(null);
  s = upsert(s, "aims", { tag: "v1.0.0", releaseId: 1, checksums: sum, status: "publishing" });
  s = upsert(s, "aims", { tag: "v1.0.0", releaseId: 1, checksums: sum, status: "published" });
  s = upsert(s, "aims", { tag: "v1.1.0-rc.1", releaseId: 2, checksums: sum, status: "published" });
  s = upsert(s, "aims", { tag: "v0.9.0", releaseId: 3, checksums: sum, status: "published" });
  expect(s.packages.aims!.map((e) => e.tag)).toEqual(["v1.1.0-rc.1", "v1.0.0", "v0.9.0"]);
  expect(latestPublished(s, "aims")!.tag).toBe("v1.0.0");
});

test("serialization is stable and round-trips", () => {
  const s = upsert(parseState(null), "b", { tag: "v1.0.0", releaseId: 9, checksums: sum, status: "published" });
  const text = serializeState(s);
  expect(serializeState(parseState(text))).toBe(text);
  expect(text.endsWith("\n")).toBe(true);
});

test("a damaged state is an error with a fix", () => {
  expect(() => parseState('{"version":1,"packages":{"x":[{"tag":"v1.0.0#{}"}]}}')).toThrow(TapsterError);
  expect(() => parseState("not json")).toThrow(TapsterError);
});
```

`tests/hubcommit.test.ts`:
```ts
import { expect, test } from "bun:test";
import { commitToHub } from "../src/hubcommit";
import { GitHub } from "../src/github";

function hubFake(conflicts: number) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let left = conflicts;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const path = new URL(url).pathname + new URL(url).search;
    if (path.startsWith("/repos/o/hub/git/ref/heads/main")) return Response.json({ object: { sha: "head1" } });
    if (path.startsWith("/repos/o/hub/git/commits/head1")) return Response.json({ tree: { sha: "tree1" } });
    if (path.startsWith("/repos/o/hub/contents/")) return new Response(null, { status: 404 });
    if (path === "/repos/o/hub/git/trees") return Response.json({ sha: "tree2" }, { status: 201 });
    if (path === "/repos/o/hub/git/commits") return Response.json({ sha: "commit2" }, { status: 201 });
    if (path === "/repos/o/hub/git/refs/heads/main") {
      if (left-- > 0) return new Response(null, { status: 422 });
      return Response.json({ object: { sha: "commit2" } });
    }
    return new Response(null, { status: 500 });
  };
  return { gh: new GitHub("t", fetchImpl, async () => {}), calls };
}

test("commits through the Git Data API and retries a moved branch", async () => {
  const f = hubFake(1);
  const result = await commitToHub(f.gh, "o/hub", "aims v1.0.0", async (read) => {
    expect(await read(".tapster/state.json")).toBeNull();
    return [{ path: "Casks/aims.rb", content: "cask" }];
  });
  expect(result).toBe("committed");
  const patches = f.calls.filter((c) => c.method === "PATCH");
  expect(patches.length).toBe(2);
  expect(patches[1]!.body).toEqual({ sha: "commit2", force: false });
});

test("no changes, no commit", async () => {
  const f = hubFake(0);
  expect(await commitToHub(f.gh, "o/hub", "x", async () => [])).toBe("unchanged");
  expect(f.calls.some((c) => c.method === "POST")).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/state.test.ts tests/hubcommit.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/state.ts`:
```ts
import { z } from "zod";
import { NAME, TAG, compareSemver, parseTag } from "./config";
import { TapsterError } from "./errors";

export const STATE_PATH = ".tapster/state.json";
const KEEP = 20;

const entry = z
  .object({
    tag: z.string().regex(TAG),
    releaseId: z.number().int().positive(),
    checksums: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["publishing", "published"]),
  })
  .strict();
const schema = z.object({ version: z.literal(1), packages: z.record(z.string().regex(NAME), z.array(entry)) }).strict();

export type StateEntry = z.infer<typeof entry>;
export type State = z.infer<typeof schema>;

export const emptyState = (): State => ({ version: 1, packages: {} });

const damaged = () => new TapsterError(".tapster/state.json is damaged", "Restore it from the hub's git history.");

export function parseState(text: string | null): State {
  if (text === null) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw damaged();
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw damaged();
  return r.data;
}

const byNewest = (a: StateEntry, b: StateEntry) => compareSemver(parseTag(b.tag)!, parseTag(a.tag)!);

export function upsert(s: State, pkg: string, e: StateEntry): State {
  const list = (s.packages[pkg] ?? []).filter((x) => x.releaseId !== e.releaseId && x.tag !== e.tag);
  return { ...s, packages: { ...s.packages, [pkg]: [...list, e].sort(byNewest).slice(0, KEEP) } };
}

export function latestPublished(s: State, pkg: string): StateEntry | undefined {
  return (s.packages[pkg] ?? []).filter((e) => e.status === "published" && parseTag(e.tag)!.pre === null).sort(byNewest)[0];
}

export function serializeState(s: State): string {
  const packages = Object.fromEntries(Object.keys(s.packages).sort().map((k) => [k, [...s.packages[k]!].sort(byNewest)]));
  return `${JSON.stringify({ version: 1, packages }, null, 2)}\n`;
}
```

`src/hubcommit.ts`:
```ts
import { GitHubError, TapsterError } from "./errors";
import type { GitHub } from "./github";

export type FileChange = { path: string; content: string | null };

export async function commitToHub(
  gh: GitHub,
  hub: string,
  message: string,
  build: (read: (path: string) => Promise<string | null>) => Promise<FileChange[]>,
): Promise<"committed" | "unchanged"> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await gh.json<{ object: { sha: string } }>("GET", `/repos/${hub}/git/ref/heads/main`);
    const head = ref.object.sha;
    const commit = await gh.json<{ tree: { sha: string } }>("GET", `/repos/${hub}/git/commits/${head}`);
    const read = async (path: string): Promise<string | null> => {
      try {
        const file = await gh.json<{ content: string }>("GET", `/repos/${hub}/contents/${path}?ref=${head}`);
        return Buffer.from(file.content, "base64").toString("utf8");
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    };
    const changes = await build(read);
    if (changes.length === 0) return "unchanged";
    const tree = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: changes.map((c) => ({ path: c.path, mode: "100644", type: "blob", ...(c.content === null ? { sha: null } : { content: c.content }) })),
    });
    const next = await gh.json<{ sha: string }>("POST", `/repos/${hub}/git/commits`, { message, tree: tree.sha, parents: [head] });
    try {
      await gh.json("PATCH", `/repos/${hub}/git/refs/heads/main`, { sha: next.sha, force: false });
      return "committed";
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) continue;
      throw e;
    }
  }
  throw new TapsterError("the hub's main branch kept moving", "The next run retries.");
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/state.test.ts tests/hubcommit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Keep the publishing state in the hub and commit through the Git Data API"
```

---

### Task 10: Draft readiness and the work list

**Files:**
- Create: `src/plan.ts`
- Test: `tests/plan.test.ts`

**Interfaces:**
- Consumes: `PackageConfig`, `Platform`, `parseTag`, `versionOf`, `assetName` (Task 5); `ChecksumLine` (Task 6);
  `Release` (Task 7).
- Produces:
  - `STAGING = "tapster-staging--"`.
  - Types: `type DraftStatus = { kind: "ready" } | { kind: "resume" } | { kind: "waiting"; reason: string } | { kind: "invalid"; reason: string }`
    and `type WorkItem = { package: string; tag: string; releaseId: number; resume: boolean }`.
  - `draftStatus(r: Release, pkg: PackageConfig, checksums: ChecksumLine[] | null): DraftStatus` and
    `planPackage(pkg: PackageConfig, releases: Release[], checksumsOf: (r: Release) => Promise<ChecksumLine[] | null>): Promise<{ items: WorkItem[]; notes: string[] }>`.

- [ ] **Step 1: Write the failing test**

`tests/plan.test.ts`:
```ts
import { expect, test } from "bun:test";
import { draftStatus, planPackage } from "../src/plan";
import { parseConfig } from "../src/config";
import type { Release } from "../src/github";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
`,
  "o",
).packages[0]!;
const d = "1".repeat(64);
const e = "2".repeat(64);
const asset = (id: number, name: string, digest: string | null, state = "uploaded") => ({ id, name, size: 1, state, digest: digest && `sha256:${digest}`, browser_download_url: "" });
const release = (assets: ReturnType<typeof asset>[], tag = "v1.0.0", draft = true): Release => ({ id: 1, tag_name: tag, draft, prerelease: false, created_at: "", published_at: null, upload_url: "", assets });
const sums = [{ sha256: d, name: "aims_1.0.0_darwin_arm64.tar.gz" }, { sha256: e, name: "aims_1.0.0_linux_amd64.tar.gz" }];
const full = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims_1.0.0_linux_amd64.tar.gz", e), asset(3, "checksums.txt", null)];

test("ready when every asset is uploaded and matches", () => {
  expect(draftStatus(release(full), cfg, sums)).toEqual({ kind: "ready" });
});

test("waiting while uploads are open or checksums are missing", () => {
  expect(draftStatus(release([...full.slice(0, 2), asset(3, "checksums.txt", null, "starter")]), cfg, sums).kind).toBe("waiting");
  expect(draftStatus(release(full.slice(0, 2)), cfg, null).kind).toBe("waiting");
});

test("review focus 2: a renamed asset leaves the draft waiting with the name", () => {
  const renamed = [asset(1, "aims_1.0.0_darwin_arm64.tar.gz", d), asset(2, "aims.1.0.0.linux.amd64.tar.gz", e), asset(3, "checksums.txt", null)];
  const s = draftStatus(release(renamed), cfg, sums);
  expect(s).toEqual({ kind: "waiting", reason: "aims_1.0.0_linux_amd64.tar.gz is not attached yet" });
});

test("invalid on digest mismatch, unlisted assets or a bad tag", () => {
  expect(draftStatus(release([asset(1, "aims_1.0.0_darwin_arm64.tar.gz", e), ...full.slice(1)]), cfg, sums).kind).toBe("invalid");
  expect(draftStatus(release([...full, asset(9, "extra.bin", d)]), cfg, sums).kind).toBe("invalid");
  expect(draftStatus(release(full, "v1.0.0#{x}"), cfg, sums).kind).toBe("invalid");
});

test("staging assets mean resume", () => {
  expect(draftStatus(release([...full, asset(8, "tapster-staging--checksums.txt", null)]), cfg, sums)).toEqual({ kind: "resume" });
});

test("two drafts for one tag stop the package", async () => {
  const r1 = release(full);
  const r2 = { ...release(full), id: 2 };
  const plan = await planPackage(cfg, [r1, r2], async () => sums);
  expect(plan.items).toEqual([]);
  expect(plan.notes[0]).toContain("two drafts");
});

test("published releases are not work", async () => {
  const plan = await planPackage(cfg, [release(full, "v1.0.0", false)], async () => sums);
  expect(plan.items).toEqual([]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/plan.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/plan.ts`

```ts
import type { ChecksumLine } from "./checksums";
import { type PackageConfig, type Platform, assetName, parseTag, versionOf } from "./config";
import type { Release } from "./github";

export const STAGING = "tapster-staging--";

export type DraftStatus = { kind: "ready" } | { kind: "resume" } | { kind: "waiting"; reason: string } | { kind: "invalid"; reason: string };
export type WorkItem = { package: string; tag: string; releaseId: number; resume: boolean };

export function draftStatus(r: Release, pkg: PackageConfig, checksums: ChecksumLine[] | null): DraftStatus {
  if (!parseTag(r.tag_name)) return { kind: "invalid", reason: `tag ${r.tag_name} is not like v1.2.3` };
  if (r.assets.some((a) => a.name.startsWith(STAGING))) return { kind: "resume" };
  if (r.assets.some((a) => a.state !== "uploaded")) return { kind: "waiting", reason: "assets are still uploading" };
  if (!r.assets.some((a) => a.name === "checksums.txt")) return { kind: "waiting", reason: "checksums.txt is not attached yet" };
  const version = versionOf(r.tag_name);
  for (const platform of Object.keys(pkg.assets) as Platform[]) {
    const name = assetName(pkg, platform, version)!;
    if (!r.assets.some((a) => a.name === name)) return { kind: "waiting", reason: `${name} is not attached yet` };
  }
  if (!checksums) return { kind: "waiting", reason: "checksums.txt could not be read yet" };
  for (const a of r.assets) {
    if (a.name === "checksums.txt") continue;
    const line = checksums.find((l) => l.name === a.name);
    if (!line) return { kind: "invalid", reason: `${a.name} is attached but not listed in checksums.txt` };
    if (a.digest && a.digest !== `sha256:${line.sha256}`) return { kind: "invalid", reason: `${a.name} does not match checksums.txt` };
  }
  for (const l of checksums) {
    if (!r.assets.some((a) => a.name === l.name)) return { kind: "waiting", reason: `${l.name} is listed but not attached yet` };
  }
  return { kind: "ready" };
}

export async function planPackage(
  pkg: PackageConfig,
  releases: Release[],
  checksumsOf: (r: Release) => Promise<ChecksumLine[] | null>,
): Promise<{ items: WorkItem[]; notes: string[] }> {
  const items: WorkItem[] = [];
  const notes: string[] = [];
  const drafts = releases.filter((r) => r.draft);
  const byTag = new Map<string, Release[]>();
  for (const r of drafts) byTag.set(r.tag_name, [...(byTag.get(r.tag_name) ?? []), r]);
  for (const [tag, list] of byTag) {
    if (list.length > 1) {
      notes.push(`${tag}: two drafts exist for this tag; delete one`);
      continue;
    }
    const r = list[0]!;
    const ready = r.assets.some((a) => a.name === "checksums.txt") && r.assets.every((a) => a.state === "uploaded");
    const status = draftStatus(r, pkg, ready ? await checksumsOf(r) : null);
    if (status.kind === "ready" || status.kind === "resume") items.push({ package: pkg.name, tag, releaseId: r.id, resume: status.kind === "resume" });
    else notes.push(`${tag}: ${status.reason}`);
  }
  return { items, notes };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Decide which drafts are ready, waiting or resumed"
```

---
### Task 11: Safe tar.gz reading, deterministic writing, Mach-O detection

**Files:**
- Create: `src/archive.ts`, `tests/helpers/rawtar.ts`
- Test: `tests/archive.test.ts`

**Interfaces:**
- Consumes: `TapsterError`.
- Produces:
  - `type TarEntry = { name: string; type: "file" | "dir" | "symlink"; mode: number; data: Buffer; linkname?: string }`.
  - `type Limits = { entryBytes: number; totalBytes: number }` and the default `LIMITS` (1 GiB per entry, 2 GiB in
    total, the largest safe size for one Node buffer).
  - `readTarGz(gz: Buffer, limits?: Limits): TarEntry[]`, `writeTarGz(entries: TarEntry[], mtime: number): Buffer` and
    `isMachO(data: Buffer): boolean`.

- [ ] **Step 1: Test helper that builds raw (also malicious) archives**

`tests/helpers/rawtar.ts`:
```ts
import { gzipSync } from "node:zlib";

export type Raw = { name: string; type?: string; data?: string; linkname?: string; mode?: number };

function field(h: Buffer, off: number, len: number, value: string) {
  h.write(value, off, Math.min(len, Buffer.byteLength(value)), "utf8");
}

export function rawTarGz(entries: Raw[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const h = Buffer.alloc(512);
    field(h, 0, 100, e.name);
    field(h, 100, 8, `${(e.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    field(h, 108, 8, "0000000\0");
    field(h, 116, 8, "0000000\0");
    field(h, 124, 12, `${data.length.toString(8).padStart(11, "0")}\0`);
    field(h, 136, 12, "00000000000\0");
    h.fill(0x20, 148, 156);
    field(h, 156, 1, e.type ?? "0");
    field(h, 157, 100, e.linkname ?? "");
    field(h, 257, 6, "ustar\0");
    field(h, 263, 2, "00");
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
```

- [ ] **Step 2: Write the failing test**

`tests/archive.test.ts`:
```ts
import { expect, test } from "bun:test";
import { isMachO, readTarGz, writeTarGz } from "../src/archive";
import { TapsterError } from "../src/errors";
import { rawTarGz } from "./helpers/rawtar";

test("reads files, folders and inner symlinks", () => {
  const entries = readTarGz(
    rawTarGz([
      { name: "./bin/", type: "5", mode: 0o755 },
      { name: "./bin/aims", data: "binary", mode: 0o755 },
      { name: "./bin/link", type: "2", linkname: "aims" },
    ]),
  );
  expect(entries.map((e) => [e.name, e.type])).toEqual([
    ["bin", "dir"],
    ["bin/aims", "file"],
    ["bin/link", "symlink"],
  ]);
  expect(entries[1]!.mode).toBe(0o755);
});

test.each([
  ["absolute path", [{ name: "/etc/passwd", data: "x" }]],
  ["dot-dot", [{ name: "a/../../x", data: "x" }]],
  ["escaping symlink", [{ name: "a/l", type: "2", linkname: "../../etc" }]],
  ["absolute symlink", [{ name: "l", type: "2", linkname: "/etc/passwd" }]],
  ["hardlink", [{ name: "h", type: "1", linkname: "a" }]],
  ["fifo", [{ name: "f", type: "6" }]],
  ["device", [{ name: "d", type: "3" }]],
  ["duplicate", [{ name: "a", data: "1" }, { name: "./a", data: "2" }]],
])("rejects %s", (_, entries) => {
  expect(() => readTarGz(rawTarGz(entries))).toThrow(TapsterError);
});

test("enforces size limits", () => {
  expect(() => readTarGz(rawTarGz([{ name: "a", data: "x".repeat(2000) }]), { entryBytes: 1000, totalBytes: 1 << 20 })).toThrow(TapsterError);
  expect(() => readTarGz(rawTarGz([{ name: "a", data: "x".repeat(4000) }]), { entryBytes: 1 << 20, totalBytes: 2048 })).toThrow(TapsterError);
});

test("writing is deterministic and round-trips, including long names", () => {
  const long = `${"d".repeat(120)}/aims`;
  const entries = [
    { name: "b", type: "file" as const, mode: 0o755, data: Buffer.from("two") },
    { name: long, type: "file" as const, mode: 0o644, data: Buffer.from("one") },
    { name: "l", type: "symlink" as const, mode: 0o777, data: Buffer.alloc(0), linkname: "b" },
  ];
  const a = writeTarGz(entries, 1_700_000_000);
  const b = writeTarGz([...entries].reverse(), 1_700_000_000);
  expect(a.equals(b)).toBe(true);
  const back = readTarGz(a);
  expect(back.map((e) => e.name)).toEqual(["b", long, "l"]);
  expect(back[1]!.data.toString()).toBe("one");
  expect(back[2]!.linkname).toBe("b");
});

test("Mach-O detection", () => {
  const be = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(n, 0);
    b.writeUInt32BE(2, 4);
    return b;
  };
  expect(isMachO(be(0xcffaedfe))).toBe(true);
  expect(isMachO(be(0xfeedfacf))).toBe(true);
  expect(isMachO(be(0xcafebabe))).toBe(true);
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
  expect(isMachO(javaClass)).toBe(false);
  expect(isMachO(Buffer.from("#!/bin/sh\n"))).toBe(false);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test tests/archive.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement** `src/archive.ts`

```ts
import { posix } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { TapsterError } from "./errors";

export type TarEntry = { name: string; type: "file" | "dir" | "symlink"; mode: number; data: Buffer; linkname?: string };
export type Limits = { entryBytes: number; totalBytes: number };
export const LIMITS: Limits = { entryBytes: 1 << 30, totalBytes: 2 * (1 << 30) - 1 };

const bad = (what: string) => new TapsterError(`the archive ${what}`, "Rebuild the release; tapster accepts plain files, folders and symlinks that stay inside the archive.");

const cstr = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString("utf8");
};

function octal(h: Buffer, off: number, len: number): number {
  if (h[off]! & 0x80) throw bad("uses a number format tapster does not read");
  const s = cstr(h.subarray(off, off + len)).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw bad("has a damaged header");
  return Number.parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = Number(data.subarray(off, space).toString());
    if (!Number.isInteger(len) || len <= 0) throw bad("has a damaged extended header");
    const record = data.subarray(space + 1, off + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    off += len;
  }
  return out;
}

function safeName(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/")) throw bad(`has an absolute or empty path (${trimmed || "empty"})`);
  const norm = posix.normalize(trimmed).replace(/^(\.\/)+/, "");
  if (norm === "." || norm === ".." || norm.startsWith("../") || norm.split("/").includes("..")) throw bad(`has a path that leaves it (${trimmed})`);
  return norm;
}

function checkLink(name: string, target: string) {
  if (target === "" || target.startsWith("/")) throw bad(`has a symlink ${name} pointing outside`);
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved === ".." || resolved.startsWith("../")) throw bad(`has a symlink ${name} pointing outside`);
}

export function readTarGz(gz: Buffer, limits: Limits = LIMITS): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: limits.totalBytes });
  } catch {
    throw bad("is not a valid tar.gz or is larger than allowed");
  }
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw bad("has a damaged header");
    const size = octal(h, 124, 12);
    if (size > limits.entryBytes) throw bad("holds a file larger than allowed");
    const type = String.fromCharCode(h[156]!);
    const start = off + 512;
    if (start + size > tar.length) throw bad("is truncated");
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    if (type === "K") {
      longLink = cstr(data);
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    const prefix = cstr(h.subarray(345, 500));
    const base = cstr(h.subarray(0, 100));
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const rawLink = pax.linkpath ?? longLink ?? cstr(h.subarray(157, 257));
    pax = {};
    longName = null;
    longLink = null;
    const kind = type === "0" || type === "\0" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : null;
    if (!kind) throw bad(`holds ${rawName}, which is not a file, folder or symlink`);
    const name = safeName(rawName);
    if (seen.has(name)) throw bad(`lists ${name} twice`);
    seen.add(name);
    if (kind === "symlink") checkLink(name, rawLink);
    entries.push({ name, type: kind, mode: octal(h, 100, 8) & 0o7777, data: Buffer.from(data), ...(kind === "symlink" ? { linkname: rawLink } : {}) });
  }
  return entries;
}

function put(h: Buffer, off: number, len: number, value: string) {
  h.write(value, off, Math.min(len, Buffer.byteLength(value)), "utf8");
}

function header(name: string, mode: number, size: number, mtime: number, type: string, linkname: string): Buffer {
  const h = Buffer.alloc(512);
  put(h, 0, 100, name);
  put(h, 100, 8, `${mode.toString(8).padStart(7, "0")}\0`);
  put(h, 108, 8, "0000000\0");
  put(h, 116, 8, "0000000\0");
  put(h, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  put(h, 136, 12, `${mtime.toString(8).padStart(11, "0")}\0`);
  h.fill(0x20, 148, 156);
  put(h, 156, 1, type);
  put(h, 157, 100, linkname);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len++;
  return `${len}${body}`;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

export function writeTarGz(entries: TarEntry[], mtime: number): Buffer {
  const blocks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const name = e.type === "dir" ? `${e.name}/` : e.name;
    const link = e.linkname ?? "";
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(link) > 100) {
      const body = Buffer.from(paxRecord("path", name) + (link ? paxRecord("linkpath", link) : ""));
      blocks.push(header("PaxHeader", 0o644, body.length, mtime, "x", ""), body, pad(body.length));
    }
    const data = e.type === "file" ? e.data : Buffer.alloc(0);
    const type = e.type === "file" ? "0" : e.type === "dir" ? "5" : "2";
    blocks.push(header(name.slice(0, 100), e.mode & 0o7777, data.length, mtime, type, link.slice(0, 100)), data, pad(data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function isMachO(data: Buffer): boolean {
  if (data.length < 8) return false;
  const magic = data.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = data.readUInt32BE(4);
    return count > 0 && count < 32;
  }
  return false;
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/archive.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src tests && git commit -m "Read tar.gz archives safely and write them deterministically"
```

---

### Task 12: Temporary keychain (macOS)

**Files:**
- Create: `src/keychain.ts`
- Test: `tests/keychain.test.ts`

**Interfaces:**
- Consumes: `run` (Task 4); `register` (Task 3); `TapsterError`.
- Produces:
  - `type Identity = { sha1: string; name: string; teamId: string }`.
  - `type Keychain = { path: string; identity: string; teamId: string; close(): Promise<void> }`.
  - `parseIdentities(out: string): Identity[]` and `parseKeychainList(out: string): string[]`.
  - `openKeychain(p12Base64: string, p12Password: string, expectedTeamId: string, root: string): Promise<Keychain>`.

- [ ] **Step 1: Write the failing test**

`tests/keychain.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeychain, parseIdentities, parseKeychainList } from "../src/keychain";
import { run } from "../src/run";
import { TapsterError } from "../src/errors";

test("parses find-identity output", () => {
  const out = `
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Dogu Yilmaz (83LUCZ63JD)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)"
     2 valid identities found`;
  expect(parseIdentities(out)).toEqual([
    { sha1: "0123456789ABCDEF0123456789ABCDEF01234567", name: "Apple Development: Dogu Yilmaz (83LUCZ63JD)", teamId: "83LUCZ63JD" },
    { sha1: "89ABCDEF0123456789ABCDEF0123456789ABCDEF", name: "Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)", teamId: "5MYT4VYJFC" },
  ]);
});

test("parses the keychain search list", () => {
  expect(parseKeychainList(`    "/Users/me/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n`)).toEqual([
    "/Users/me/Library/Keychains/login.keychain-db",
    "/Library/Keychains/System.keychain",
  ]);
});

test.skipIf(process.platform !== "darwin")("a self-signed identity is rejected and the keychain is gone afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-test-"));
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=Developer ID Application: Test (TEST000001)/OU=TEST000001"]);
  await run("openssl", ["pkcs12", "-export", "-in", join(dir, "c.pem"), "-inkey", join(dir, "k.pem"), "-out", join(dir, "t.p12"), "-passout", "pass:pw-test"]);
  const p12 = Buffer.from(await Bun.file(join(dir, "t.p12")).arrayBuffer()).toString("base64");
  const before = (await run("security", ["list-keychains", "-d", "user"])).stdout;
  await expect(openKeychain(p12, "pw-test", "TEST000001", dir)).rejects.toBeInstanceOf(TapsterError);
  expect((await run("security", ["list-keychains", "-d", "user"])).stdout).toBe(before);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/keychain.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/keychain.ts`

```ts
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapsterError } from "./errors";
import { register } from "./mask";
import { run } from "./run";

export type Identity = { sha1: string; name: string; teamId: string };
export type Keychain = { path: string; identity: string; teamId: string; close(): Promise<void> };

export function parseIdentities(out: string): Identity[] {
  const ids: Identity[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (!m) continue;
    const team = /\(([A-Z0-9]{10})\)$/.exec(m[2]!);
    if (team) ids.push({ sha1: m[1]!, name: m[2]!, teamId: team[1]! });
  }
  return ids;
}

export function parseKeychainList(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export async function openKeychain(p12Base64: string, p12Password: string, expectedTeamId: string, root: string): Promise<Keychain> {
  const dir = await mkdtemp(join(root, "kc-"));
  await chmod(dir, 0o700);
  const path = join(dir, "tapster.keychain-db");
  const kcPass = randomBytes(24).toString("hex");
  const oneTime = randomBytes(24).toString("hex");
  register(kcPass);
  register(oneTime);
  const previous = parseKeychainList((await run("security", ["list-keychains", "-d", "user"])).stdout);
  const close = async () => {
    await run("security", ["list-keychains", "-d", "user", "-s", ...previous], { allowFail: true });
    await run("security", ["delete-keychain", path], { allowFail: true });
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const input = join(dir, "in.p12");
    const pem = join(dir, "key.pem");
    const wrapped = join(dir, "wrapped.p12");
    await writeFile(input, Buffer.from(p12Base64, "base64"), { mode: 0o600 });
    await run("openssl", ["pkcs12", "-in", input, "-passin", "env:TAPSTER_P12_IN", "-passout", "env:TAPSTER_P12_ONE", "-out", pem], {
      env: { TAPSTER_P12_IN: p12Password, TAPSTER_P12_ONE: oneTime },
    });
    await run("openssl", ["pkcs12", "-export", "-in", pem, "-passin", "env:TAPSTER_P12_ONE", "-passout", "env:TAPSTER_P12_ONE", "-out", wrapped], {
      env: { TAPSTER_P12_ONE: oneTime },
    });
    await rm(input);
    await rm(pem);
    await run("security", ["create-keychain", "-p", kcPass, path]);
    await run("security", ["set-keychain-settings", path]);
    await run("security", ["unlock-keychain", "-p", kcPass, path]);
    await run("security", ["import", wrapped, "-k", path, "-P", oneTime, "-T", "/usr/bin/codesign"]);
    await rm(wrapped);
    await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", kcPass, path]);
    await run("security", ["list-keychains", "-d", "user", "-s", path, ...previous]);
    const found = parseIdentities((await run("security", ["find-identity", "-v", "-p", "codesigning", path])).stdout);
    const id = found.find((i) => i.name.startsWith("Developer ID Application:"));
    if (!id) throw new TapsterError("the certificate holds no valid Developer ID Application identity", "Export the Developer ID Application certificate with its private key as .p12; tapster init --rotate certificate.");
    if (id.teamId !== expectedTeamId) throw new TapsterError(`the certificate belongs to team ${id.teamId}, not ${expectedTeamId}`, "Use the team's certificate, or update TAPSTER_TEAM_ID with tapster init --rotate certificate.");
    return { path, identity: id.sha1, teamId: id.teamId, close };
  } catch (e) {
    await close();
    throw e;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/keychain.test.ts`
Expected: PASS on macOS (3 tests); the third test is skipped elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Hold the signing certificate in a temporary keychain"
```

---

### Task 13: Signing and notarization

**Files:**
- Create: `src/sign.ts`
- Test: `tests/sign.test.ts`

**Interfaces:**
- Consumes: `Keychain` (Task 12); `run` (Task 4); `register`; `TapsterError`.
- Produces:
  - `PRESETS: Record<"go" | "bun", string[]>` and `entitlementsPlist(keys: string[]): string`.
  - `signFile(kc: Keychain, file: string, entitlements: string | null): Promise<void>`.
  - `type SignatureInfo = { authority: string[]; teamId: string | null; runtime: boolean }`,
    `parseSignature(text: string): SignatureInfo` and `verifySigned(file: string, teamId: string): Promise<void>`.
  - `type NotaryKey = { p8Path: string; keyId: string; issuer: string }`,
    `type NotaryResult = { id: string; status: string }`, `parseNotary(stdout: string): NotaryResult` and
    `notarize(zip: string, key: NotaryKey): Promise<NotaryResult>`.
  - `zipForNotary(dir: string, out: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/sign.test.ts`:
```ts
import { expect, test } from "bun:test";
import { entitlementsPlist, parseNotary, parseSignature, PRESETS } from "../src/sign";
import { TapsterError } from "../src/errors";

test("presets", () => {
  expect(PRESETS.go).toEqual([]);
  expect(PRESETS.bun).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
});

test("entitlements plist lists the keys", () => {
  const xml = entitlementsPlist(PRESETS.bun);
  expect(xml).toContain("<key>com.apple.security.cs.allow-jit</key><true/>");
  expect(xml.startsWith("<?xml")).toBe(true);
});

test("parses codesign -dvv output", () => {
  const info = parseSignature(`Executable=/x/ebb
CodeDirectory v=20500 size=96335 flags=0x10000(runtime) hashes=3005+2 location=embedded
Authority=Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=5MYT4VYJFC`);
  expect(info).toEqual({
    authority: ["Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC)", "Developer ID Certification Authority", "Apple Root CA"],
    teamId: "5MYT4VYJFC",
    runtime: true,
  });
});

test("parses notarytool json", () => {
  expect(parseNotary('{"id":"abc-123","status":"Accepted","message":"Processing complete"}')).toEqual({ id: "abc-123", status: "Accepted" });
});

test("review focus 5: a timeout reads as In Progress", () => {
  expect(parseNotary('{"id":"abc","status":"In Progress"}').status).toBe("In Progress");
});

test("unreadable notarytool output never echoes it", () => {
  let err: unknown;
  try {
    parseNotary("Error: secret-ish output");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TapsterError);
  expect(JSON.stringify(err)).not.toContain("secret-ish");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/sign.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/sign.ts`

```ts
import { basename } from "node:path";
import { TapsterError } from "./errors";
import type { Keychain } from "./keychain";
import { register } from "./mask";
import { run } from "./run";

export const PRESETS: Record<"go" | "bun", string[]> = {
  go: [],
  bun: ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"],
};

export function entitlementsPlist(keys: string[]): string {
  const body = keys.map((k) => `<key>${k}</key><true/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`;
}

export async function signFile(kc: Keychain, file: string, entitlements: string | null): Promise<void> {
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--keychain",
    kc.path,
    "--sign",
    kc.identity,
    ...(entitlements ? ["--entitlements", entitlements] : []),
    file,
  ]);
}

export type SignatureInfo = { authority: string[]; teamId: string | null; runtime: boolean };

export function parseSignature(text: string): SignatureInfo {
  const lines = text.split("\n");
  return {
    authority: lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice("Authority=".length)),
    teamId: lines.find((l) => l.startsWith("TeamIdentifier="))?.slice("TeamIdentifier=".length) ?? null,
    runtime: lines.some((l) => /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(l)),
  };
}

export async function verifySigned(file: string, teamId: string): Promise<void> {
  await run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  const info = parseSignature((await run("codesign", ["-dvv", file])).stderr);
  if (!info.authority[0]?.startsWith("Developer ID Application:") || info.teamId !== teamId || !info.runtime) {
    throw new TapsterError(`${basename(file)} is not signed as expected`, "It needs a Developer ID Application signature of the configured team with the hardened runtime.");
  }
}

export type NotaryKey = { p8Path: string; keyId: string; issuer: string };
export type NotaryResult = { id: string; status: string };

export function parseNotary(stdout: string): NotaryResult {
  try {
    const j = JSON.parse(stdout) as { id?: unknown; status?: unknown };
    if (typeof j.id === "string" && typeof j.status === "string") return { id: j.id, status: j.status };
  } catch {
    // fall through to the error below without quoting the output
  }
  throw new TapsterError("notarytool returned output tapster could not read", "Re-run the workflow; if it repeats, check the App Store Connect key.");
}

async function notaryIssues(id: string, key: NotaryKey): Promise<string> {
  const res = await run("xcrun", ["notarytool", "log", id, "--key", key.p8Path, "--key-id", key.keyId, "--issuer", key.issuer], { allowFail: true });
  try {
    const log = JSON.parse(res.stdout) as { issues?: { path?: string; message?: string }[] | null };
    return (log.issues ?? [])
      .slice(0, 3)
      .map((i) => `${i.path ? `${basename(i.path)}: ` : ""}${i.message ?? ""}`.trim())
      .join("; ");
  } catch {
    return "";
  }
}

export async function notarize(zip: string, key: NotaryKey): Promise<NotaryResult> {
  register(key.keyId);
  register(key.issuer);
  const res = await run(
    "xcrun",
    ["notarytool", "submit", zip, "--key", key.p8Path, "--key-id", key.keyId, "--issuer", key.issuer, "--wait", "--timeout", "30m", "--output-format", "json"],
    { allowFail: true },
  );
  const result = parseNotary(res.stdout);
  if (result.status !== "Accepted") {
    const issues = result.status === "In Progress" ? "" : await notaryIssues(result.id, key);
    throw new TapsterError(
      `notarization ${result.status.toLowerCase()}${issues ? `: ${issues}` : ""}`,
      result.status === "In Progress" ? "Apple took longer than 30 minutes; the draft is untouched and the next run submits again." : "The draft is untouched; fix the build and release again.",
    );
  }
  return result;
}

export async function zipForNotary(dir: string, out: string): Promise<void> {
  await run("ditto", ["-c", "-k", "--keepParent", dir, out]);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/sign.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Sign with the hardened runtime and notarize with an API key"
```

---

### Task 14: Attestation check

**Files:**
- Create: `src/attest.ts`
- Test: `tests/attest.test.ts`

**Interfaces:**
- Consumes: `runPath`, `ghPath` (Task 4); `PackageConfig` (Task 5); `TapsterError`.
- Produces:
  - `type AttestOutcome = "verified" | "skipped" | "off"`.
  - `attestArgs(file: string, repo: string, workflow: string, tag: string): string[]`.
  - `decide(code: number, stderr: string, isPrivate: boolean): "verified" | "skipped" | "failed"`.
  - `verifyAttestation(file: string, pkg: PackageConfig, tag: string, isPrivate: boolean, token: string): Promise<AttestOutcome>`.

- [ ] **Step 1: Write the failing test**

`tests/attest.test.ts`:
```ts
import { expect, test } from "bun:test";
import { attestArgs, decide } from "../src/attest";

test("verification pins repository, workflow, tag and hosted runners", () => {
  expect(attestArgs("/w/a.tar.gz", "o/aims", "release.yml", "v1.0.0")).toEqual([
    "attestation", "verify", "/w/a.tar.gz",
    "--repo", "o/aims",
    "--signer-workflow", "o/aims/.github/workflows/release.yml",
    "--source-ref", "refs/tags/v1.0.0",
    "--deny-self-hosted-runners",
    "--format", "json",
  ]);
});

test("public repositories must verify; private ones may skip when unavailable", () => {
  expect(decide(0, "", false)).toBe("verified");
  expect(decide(1, "no attestations found", false)).toBe("failed");
  expect(decide(1, "no attestations found", true)).toBe("skipped");
  expect(decide(1, "HTTP 403: feature not available", true)).toBe("skipped");
  expect(decide(1, "certificate identity mismatch", true)).toBe("failed");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/attest.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/attest.ts`

```ts
import { basename } from "node:path";
import type { PackageConfig } from "./config";
import { TapsterError } from "./errors";
import { ghPath, runPath } from "./run";

export type AttestOutcome = "verified" | "skipped" | "off";

export function attestArgs(file: string, repo: string, workflow: string, tag: string): string[] {
  return [
    "attestation", "verify", file,
    "--repo", repo,
    "--signer-workflow", `${repo}/.github/workflows/${workflow}`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
    "--format", "json",
  ];
}

export function decide(code: number, stderr: string, isPrivate: boolean): "verified" | "skipped" | "failed" {
  if (code === 0) return "verified";
  const unavailable = /no attestations found|feature not available|upgrade|HTTP 403/i.test(stderr);
  return isPrivate && unavailable ? "skipped" : "failed";
}

export async function verifyAttestation(file: string, pkg: PackageConfig, tag: string, isPrivate: boolean, token: string): Promise<AttestOutcome> {
  if (pkg.attestation === "off") return "off";
  const res = await runPath(ghPath(), "gh", attestArgs(file, pkg.repo, pkg.workflow, tag), {
    env: { GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    allowFail: true,
  });
  const outcome = decide(res.code, res.stderr, isPrivate);
  if (outcome === "failed") {
    throw new TapsterError(
      `${basename(file)} has no valid build attestation from ${pkg.repo}/.github/workflows/${pkg.workflow} at ${tag}`,
      "Attest the archives in the project's release workflow (tapster add sets it up), or set attestation: off for this package.",
    );
  }
  return outcome;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/attest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Require build attestations from public projects"
```

---

### Task 15: Staging swap, publish and download wait

**Files:**
- Create: `src/publish.ts`
- Test: `tests/publish.test.ts`

**Interfaces:**
- Consumes: `GitHub`, `Release`, `Asset` (Task 7); `STAGING` (Task 10); `parseTag`, `compareSemver` (Task 5);
  `TapsterError`.
- Produces:
  - `type Outgoing = { name: string; data: Buffer }`.
  - `sameAssets(before: Asset[], now: Asset[]): boolean`.
  - `stageAndSwap(gh: GitHub, repo: string, releaseId: number, files: Outgoing[], before: Asset[]): Promise<void>` and
    `resumeSwap(gh: GitHub, repo: string, release: Release): Promise<void>`.
  - `makeLatest(tag: string, releases: Release[]): "true" | "false"`.
  - `waitDownloadable(urls: string[], fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>, deadlineMs?: number): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/publish.test.ts`:
```ts
import { expect, test } from "bun:test";
import { makeLatest, resumeSwap, sameAssets, stageAndSwap, waitDownloadable } from "../src/publish";
import type { Asset, GitHub, Release } from "../src/github";
import { TapsterError } from "../src/errors";

const a = (id: number, name: string, digest = `sha256:${id}`): Asset => ({ id, name, size: 1, state: "uploaded", digest, browser_download_url: `https://dl/${name}` });
const rel = (assets: Asset[], over: Partial<Release> = {}): Release => ({ id: 1, tag_name: "v1.0.0", draft: true, prerelease: false, created_at: "", published_at: null, upload_url: "u{?name}", assets, ...over });

function fakeGh(current: Release) {
  const log: string[] = [];
  let next = 100;
  const gh = {
    getRelease: async () => current,
    uploadAsset: async (_r: Release, name: string) => {
      log.push(`upload ${name}`);
      return a(next++, name);
    },
    deleteAsset: async (_repo: string, id: number) => {
      log.push(`delete ${id}`);
    },
    renameAsset: async (_repo: string, id: number, name: string) => {
      log.push(`rename ${id} ${name}`);
      return a(id, name);
    },
  } as unknown as GitHub;
  return { gh, log };
}

test("uploads every staging file first, then swaps with checksums last", async () => {
  const before = [a(1, "x.tar.gz"), a(2, "checksums.txt")];
  const f = fakeGh(rel(before));
  await stageAndSwap(f.gh, "o/r", 1, [{ name: "checksums.txt", data: Buffer.from("s") }, { name: "x.tar.gz", data: Buffer.from("x") }], before);
  expect(f.log).toEqual([
    "upload tapster-staging--x.tar.gz",
    "upload tapster-staging--checksums.txt",
    "delete 1",
    "rename 100 x.tar.gz",
    "delete 2",
    "rename 101 checksums.txt",
  ]);
});

test("stops when the draft changed or was published", async () => {
  const before = [a(1, "x.tar.gz")];
  await expect(stageAndSwap(fakeGh(rel([a(1, "x.tar.gz", "sha256:other")])).gh, "o/r", 1, [], before)).rejects.toBeInstanceOf(TapsterError);
  await expect(stageAndSwap(fakeGh(rel(before, { draft: false })).gh, "o/r", 1, [], before)).rejects.toBeInstanceOf(TapsterError);
});

test("resume finishes a half-done swap", async () => {
  const half = rel([a(2, "checksums.txt"), a(100, "tapster-staging--x.tar.gz"), a(101, "tapster-staging--checksums.txt")]);
  const f = fakeGh(half);
  await resumeSwap(f.gh, "o/r", half);
  expect(f.log).toEqual(["rename 100 x.tar.gz", "delete 2", "rename 101 checksums.txt"]);
});

test("sameAssets ignores order", () => {
  expect(sameAssets([a(1, "x"), a(2, "y")], [a(2, "y"), a(1, "x")])).toBe(true);
  expect(sameAssets([a(1, "x")], [a(1, "x"), a(3, "z")])).toBe(false);
});

test("make_latest only for the highest stable version", () => {
  const published = (tag: string) => rel([], { tag_name: tag, draft: false });
  expect(makeLatest("v1.2.0", [published("v1.1.0")])).toBe("true");
  expect(makeLatest("v1.0.1", [published("v1.1.0")])).toBe("false");
  expect(makeLatest("v2.0.0-rc.1", [])).toBe("false");
});

test("waits until every asset downloads", async () => {
  let calls = 0;
  const fetchImpl = async () => new Response(null, { status: ++calls > 2 ? 200 : 404 });
  await waitDownloadable(["https://dl/a"], fetchImpl, async () => {}, 60_000);
  expect(calls).toBe(3);
  await expect(waitDownloadable(["https://dl/a"], async () => new Response(null, { status: 404 }), async () => {}, -1)).rejects.toBeInstanceOf(TapsterError);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/publish.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/publish.ts`

```ts
import { compareSemver, parseTag } from "./config";
import { TapsterError } from "./errors";
import type { Asset, FetchLike, GitHub, Release } from "./github";
import { STAGING } from "./plan";

export type Outgoing = { name: string; data: Buffer };

const key = (x: Asset) => `${x.id}:${x.name}:${x.digest ?? ""}`;

export function sameAssets(before: Asset[], now: Asset[]): boolean {
  const a = before.map(key).sort();
  const b = now.map(key).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const checksumsLast = (names: string[]) => [...names.filter((n) => n !== "checksums.txt"), ...names.filter((n) => n === "checksums.txt")];

async function swap(gh: GitHub, repo: string, originals: Asset[], staged: Map<string, Asset>): Promise<void> {
  for (const name of checksumsLast([...staged.keys()])) {
    const old = originals.find((x) => x.name === name);
    if (old) await gh.deleteAsset(repo, old.id);
    await gh.renameAsset(repo, staged.get(name)!.id, name);
  }
}

export async function stageAndSwap(gh: GitHub, repo: string, releaseId: number, files: Outgoing[], before: Asset[]): Promise<void> {
  const current = await gh.getRelease(repo, releaseId);
  if (!current.draft) throw new TapsterError("the release was published while tapster worked on it", "Nothing was changed; check who published it.");
  if (!sameAssets(before, current.assets)) {
    throw new TapsterError("the draft changed while tapster worked on it", "The project is still uploading or edited the draft; the next run starts over.");
  }
  const staged = new Map<string, Asset>();
  for (const name of checksumsLast(files.map((f) => f.name))) {
    staged.set(name, await gh.uploadAsset(current, STAGING + name, files.find((f) => f.name === name)!.data));
  }
  await swap(gh, repo, current.assets, staged);
}

export async function resumeSwap(gh: GitHub, repo: string, release: Release): Promise<void> {
  const staged = new Map(release.assets.filter((x) => x.name.startsWith(STAGING)).map((x) => [x.name.slice(STAGING.length), x] as const));
  await swap(gh, repo, release.assets.filter((x) => !x.name.startsWith(STAGING)), staged);
}

export function makeLatest(tag: string, releases: Release[]): "true" | "false" {
  const t = parseTag(tag);
  if (!t || t.pre) return "false";
  const higher = releases.some((r) => {
    if (r.draft || r.tag_name === tag) return false;
    const o = parseTag(r.tag_name);
    return o !== null && o.pre === null && compareSemver(o, t) > 0;
  });
  return higher ? "false" : "true";
}

export async function waitDownloadable(
  urls: string[],
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  deadlineMs = 300_000,
): Promise<void> {
  const start = Date.now();
  let pending = [...urls];
  for (;;) {
    const next: string[] = [];
    for (const url of pending) {
      const res = await fetchImpl(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
      if (!res || res.status !== 200) next.push(url);
    }
    pending = next;
    if (pending.length === 0) return;
    if (Date.now() - start > deadlineMs) {
      throw new TapsterError(`${pending.length} published file(s) did not download yet`, "GitHub was slow; the next run renders the cask once they download.");
    }
    await sleep(10_000);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/publish.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Swap signed assets in through staging names and publish"
```

---

### Task 16: Casks and Scoop manifests

**Files:**
- Create: `src/render.ts`, `tests/golden/aims.rb`, `tests/golden/ebb.rb`, `tests/golden/aims.json`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `PackageConfig`, `Platform` (Task 5).
- Produces:
  - `rubyString(s: string): string`.
  - `type Download = { platform: Platform; url: string; sha256: string }`,
    `downloadUrl(repo: string, tag: string, asset: string): string`.
  - `type RenderInput = { pkg: PackageConfig; version: string; downloads: Download[]; description: string; homepage: string; license: string | null }`.
  - `renderCask(i: RenderInput): string` and `renderScoop(i: RenderInput): string | null`.

- [ ] **Step 1: Golden files**

`tests/golden/aims.rb`:
```ruby
cask "aims" do
  version "0.1.5"

  on_macos do
    on_arm do
      sha256 "1111111111111111111111111111111111111111111111111111111111111111"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_darwin_arm64.tar.gz"
    end
    on_intel do
      sha256 "2222222222222222222222222222222222222222222222222222222222222222"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_darwin_amd64.tar.gz"
    end
  end
  on_linux do
    on_intel do
      sha256 "3333333333333333333333333333333333333333333333333333333333333333"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_linux_amd64.tar.gz"
    end
  end

  name "aims"
  desc "Several Claude Code and Codex accounts on one machine"
  homepage "https://doguyilmaz.github.io/aims/"

  livecheck do
    skip "tapster"
  end

  binary "aims"
  bash_completion "completions/aims.bash"
  zsh_completion "completions/aims.zsh"
end
```

`tests/golden/ebb.rb`:
```ruby
cask "ebb" do
  version "0.1.1"

  on_macos do
    sha256 "4444444444444444444444444444444444444444444444444444444444444444"
    url "https://github.com/o/ebb/releases/download/v0.1.1/ebb_0.1.1_darwin_universal.tar.gz"
  end

  name "ebb"
  desc "See where your Mac's disk space went \#{and} \"wins\""
  homepage "https://github.com/o/ebb"

  livecheck do
    skip "tapster"
  end

  binary "ebb"

  uninstall launchctl: ["com.doguyilmaz.ebb"]

  zap trash: ["~/.config/ebb", "~/.local/state/ebb"]
end
```

`tests/golden/aims.json`:
```json
{
  "version": "0.1.5",
  "description": "Several Claude Code and Codex accounts on one machine",
  "homepage": "https://doguyilmaz.github.io/aims/",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_windows_amd64.zip",
      "hash": "5555555555555555555555555555555555555555555555555555555555555555"
    }
  },
  "bin": "aims.exe"
}
```

- [ ] **Step 2: Write the failing test**

`tests/render.test.ts`:
```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { downloadUrl, renderCask, renderScoop, rubyString } from "../src/render";
import { parseConfig } from "../src/config";

const golden = (n: string) => readFileSync(new URL(`./golden/${n}`, import.meta.url), "utf8");
const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
      darwin-amd64: "aims_{version}_darwin_amd64.tar.gz"
      linux-amd64: "aims_{version}_linux_amd64.tar.gz"
      windows-amd64: "aims_{version}_windows_amd64.zip"
    completions: { bash: completions/aims.bash, zsh: completions/aims.zsh }
    scoop: true
  - name: ebb
    repo: o/ebb
    binaries: [ebb]
    assets:
      darwin-universal: "ebb_{version}_darwin_universal.tar.gz"
    cask:
      uninstall: { launchctl: [com.doguyilmaz.ebb] }
      zap: { trash: ["~/.config/ebb", "~/.local/state/ebb"] }
`,
  "o",
);
const [aims, ebb] = cfg.packages as [typeof cfg.packages[0], typeof cfg.packages[0]];
const d = (platform: string, asset: string, n: string) => ({ platform: platform as never, url: downloadUrl("o/aims", "v0.1.5", asset), sha256: n.repeat(64) });
const aimsInput = {
  pkg: aims,
  version: "0.1.5",
  description: "Several Claude Code and Codex accounts on one machine",
  homepage: "https://doguyilmaz.github.io/aims/",
  license: "MIT",
  downloads: [
    d("darwin-arm64", "aims_0.1.5_darwin_arm64.tar.gz", "1"),
    d("darwin-amd64", "aims_0.1.5_darwin_amd64.tar.gz", "2"),
    d("linux-amd64", "aims_0.1.5_linux_amd64.tar.gz", "3"),
    d("windows-amd64", "aims_0.1.5_windows_amd64.zip", "5"),
  ],
};

test("cask with per-arch macOS and Linux blocks", () => {
  expect(renderCask(aimsInput)).toBe(golden("aims.rb"));
});

test("universal cask with uninstall and zap, hostile description escaped", () => {
  const out = renderCask({
    pkg: ebb,
    version: "0.1.1",
    description: 'See where your Mac\'s disk space went #{and} "wins".',
    homepage: "https://github.com/o/ebb",
    license: null,
    downloads: [{ platform: "darwin-universal", url: downloadUrl("o/ebb", "v0.1.1", "ebb_0.1.1_darwin_universal.tar.gz"), sha256: "4".repeat(64) }],
  });
  expect(out).toBe(golden("ebb.rb"));
});

test("scoop manifest", () => {
  expect(renderScoop(aimsInput)).toBe(golden("aims.json"));
  expect(renderScoop({ ...aimsInput, downloads: aimsInput.downloads.slice(0, 3) })).toBeNull();
});

test("ruby strings cannot interpolate or break out", () => {
  expect(rubyString('a"b\\c#{x}\n\u0001')).toBe('"a\\"b\\\\c\\#{x}\\n\\u{1}"');
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test tests/render.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement** `src/render.ts`

```ts
import { basename } from "node:path";
import type { PackageConfig, Platform } from "./config";

export function rubyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "#") out += "\\#";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

const list = (items: string[]) => `[${items.map(rubyString).join(", ")}]`;

export type Download = { platform: Platform; url: string; sha256: string };
export type RenderInput = { pkg: PackageConfig; version: string; downloads: Download[]; description: string; homepage: string; license: string | null };

export const downloadUrl = (repo: string, tag: string, asset: string) => `https://github.com/${repo}/releases/download/${tag}/${asset}`;

const tidyDesc = (s: string) => s.trim().replace(/\.+$/, "");

function block(lines: string[], indent: string, d: Download) {
  lines.push(`${indent}sha256 ${rubyString(d.sha256)}`, `${indent}url ${rubyString(d.url)}`);
}

function os(lines: string[], name: "macos" | "linux", downloads: Download[]) {
  const pick = (p: string) => downloads.find((d) => d.platform === `${name === "macos" ? "darwin" : "linux"}-${p}`);
  const universal = name === "macos" ? downloads.find((d) => d.platform === "darwin-universal") : undefined;
  const arm = pick("arm64");
  const intel = pick("amd64");
  if (!universal && !arm && !intel) return;
  lines.push(`  on_${name} do`);
  if (universal) block(lines, "    ", universal);
  else {
    if (arm) {
      lines.push("    on_arm do");
      block(lines, "      ", arm);
      lines.push("    end");
    }
    if (intel) {
      lines.push("    on_intel do");
      block(lines, "      ", intel);
      lines.push("    end");
    }
  }
  lines.push("  end");
}

export function renderCask(i: RenderInput): string {
  const { pkg } = i;
  const lines = [`cask ${rubyString(pkg.name)} do`, `  version ${rubyString(i.version)}`, ""];
  os(lines, "macos", i.downloads);
  os(lines, "linux", i.downloads);
  lines.push(
    "",
    `  name ${rubyString(pkg.name)}`,
    `  desc ${rubyString(tidyDesc(i.description))}`,
    `  homepage ${rubyString(i.homepage)}`,
    "",
    "  livecheck do",
    '    skip "tapster"',
    "  end",
    "",
  );
  for (const b of pkg.binaries) lines.push(`  binary ${rubyString(b)}`);
  const c = pkg.completions;
  if (c?.bash) lines.push(`  bash_completion ${rubyString(c.bash)}`);
  if (c?.zsh) lines.push(`  zsh_completion ${rubyString(c.zsh)}`);
  if (c?.fish) lines.push(`  fish_completion ${rubyString(c.fish)}`);
  const u = pkg.cask.uninstall;
  const parts = [u?.launchctl?.length ? `launchctl: ${list(u.launchctl)}` : "", u?.quit?.length ? `quit: ${list(u.quit)}` : ""].filter(Boolean);
  if (parts.length) lines.push("", `  uninstall ${parts.join(",\n            ")}`);
  if (pkg.cask.zap?.trash.length) lines.push("", `  zap trash: ${list(pkg.cask.zap.trash)}`);
  if (pkg.cask.caveats) lines.push("", `  caveats ${rubyString(pkg.cask.caveats)}`);
  lines.push("end", "");
  return lines.join("\n");
}

export function renderScoop(i: RenderInput): string | null {
  const arch: Record<string, { url: string; hash: string }> = {};
  for (const d of i.downloads) {
    if (d.platform === "windows-amd64") arch["64bit"] = { url: d.url, hash: d.sha256 };
    if (d.platform === "windows-arm64") arch.arm64 = { url: d.url, hash: d.sha256 };
  }
  if (!i.pkg.scoop || Object.keys(arch).length === 0) return null;
  const bins = i.pkg.binaries.map((b) => (b.endsWith(".exe") ? b : `${b}.exe`));
  const manifest = {
    version: i.version,
    description: tidyDesc(i.description),
    homepage: i.homepage,
    ...(i.license ? { license: i.license } : {}),
    architecture: arch,
    bin: bins.length === 1 ? bins[0] : bins,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const caskPath = (name: string) => `Casks/${basename(name)}.rb`;
export const scoopPath = (name: string) => `bucket/${basename(name)}.json`;
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/render.test.ts`
Expected: PASS. If a golden file differs only in whitespace, fix the renderer, not the golden file; the golden files
follow Homebrew's own stanza order.

- [ ] **Step 6: Commit**

```bash
git add src tests && git commit -m "Render escaped casks and Scoop manifests"
```

---
### Task 17: Action modes, bundle and hub workflow

**Files:**
- Create: `src/workdir.ts`, `src/action/context.ts`, `src/action/check.ts`, `src/action/fetch.ts`, `src/action/sign.ts`,
  `src/action/publish.ts`, `src/action/render.ts`, `src/action/cleanup.ts`, `src/action/main.ts`,
  `templates/hub/tapster.yml`, `dist/index.js`
- Modify: `action.yml` (add the `attest` and `attest-path` outputs)
- Test: `tests/context.test.ts`, `tests/modes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–16.
- Produces:
  - `workdir(): string`, `type DarwinArchive`, `type Fetched`, `type Manifest`, `loadManifest()`, `saveManifest(m)`.
  - `type Context = { hub: string; owner: string; config: HubConfig; workspace: string }`, `loadContext(configPath)`
    and `parseWork(text): WorkItem[]`.
  - `renderNeeded(ctx): Promise<boolean>`, `headIsStale(ws): Promise<boolean>` and
    `buildDownloads(pkg, tag, lines): Download[]`.
  - One function per mode: `check(ctx)`, `fetchMode(ctx)`, `signMode(ctx)`, `publishMode(ctx)`, `renderMode(ctx)`,
    `cleanupMode()`.

- [ ] **Step 1: Write the failing tests**

`tests/context.test.ts`:
```ts
import { expect, test } from "bun:test";
import { parseWork } from "../src/action/context";
import { TapsterError } from "../src/errors";

test("work lists are validated between jobs", () => {
  expect(parseWork('[{"package":"aims","tag":"v1.0.0","releaseId":5,"resume":false}]')).toEqual([{ package: "aims", tag: "v1.0.0", releaseId: 5, resume: false }]);
  expect(parseWork("")).toEqual([]);
  for (const bad of ['[{"package":"aims","tag":"v1.0.0#{x}","releaseId":5,"resume":false}]', '{"x":1}', "[1]", "nope"]) {
    expect(() => parseWork(bad)).toThrow(TapsterError);
  }
});
```

`tests/modes.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDownloads, renderNeeded } from "../src/action/render";
import { signMode } from "../src/action/sign";
import { parseConfig } from "../src/config";
import { serializeState, upsert, emptyState } from "../src/state";
import { loadManifest, saveManifest } from "../src/workdir";

const cfg = parseConfig(
  `version: 1
tap: o/tap
packages:
  - name: aims
    repo: o/aims
    binaries: [aims]
    assets:
      darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"
`,
  "o",
);

test("downloads come from the published checksums", () => {
  const d = buildDownloads(cfg.packages[0]!, "v1.0.0", [{ sha256: "a".repeat(64), name: "aims_1.0.0_darwin_arm64.tar.gz" }]);
  expect(d).toEqual([{ platform: "darwin-arm64", url: "https://github.com/o/aims/releases/download/v1.0.0/aims_1.0.0_darwin_arm64.tar.gz", sha256: "a".repeat(64) }]);
  expect(() => buildDownloads(cfg.packages[0]!, "v1.0.0", [])).toThrow();
});

test("render is needed when a cask is behind the state or an entry is publishing", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(ws, ".tapster"), { recursive: true });
  mkdirSync(join(ws, "Casks"), { recursive: true });
  const ctx = { hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: ws };
  const published = upsert(emptyState(), "aims", { tag: "v1.0.0", releaseId: 1, checksums: "b".repeat(64), status: "published" });
  writeFileSync(join(ws, ".tapster/state.json"), serializeState(published));
  writeFileSync(join(ws, "Casks/aims.rb"), 'cask "aims" do\n  version "0.9.0"\nend\n');
  expect(await renderNeeded(ctx)).toBe(true);
  writeFileSync(join(ws, "Casks/aims.rb"), 'cask "aims" do\n  version "1.0.0"\nend\n');
  expect(await renderNeeded(ctx)).toBe(false);
  const publishing = upsert(published, "aims", { tag: "v1.1.0", releaseId: 2, checksums: "c".repeat(64), status: "publishing" });
  writeFileSync(join(ws, ".tapster/state.json"), serializeState(publishing));
  expect(await renderNeeded(ctx)).toBe(true);
});

test("review focus 3: a release with nothing to sign passes without reading credentials", async () => {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "rt-"));
  for (const k of ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY"]) delete process.env[k];
  await saveManifest({ items: [{ package: "aims", tag: "v1.0.0", releaseId: 1, resume: false, before: [], checksums: [], archives: [], status: "fetched" }] });
  await signMode({ hub: "o/homebrew-tap", owner: "o", config: cfg, workspace: "/tmp" });
  expect((await loadManifest()).items[0]!.status).toBe("signed");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/context.test.ts tests/modes.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Shared work directory** (`src/workdir.ts`)

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecksumLine } from "./checksums";
import type { Platform } from "./config";
import type { Asset } from "./github";

export type DarwinArchive = { asset: string; platform: Platform; dir: string; binaries: string[] };
export type Fetched = {
  package: string;
  tag: string;
  releaseId: number;
  resume: boolean;
  before: Asset[];
  checksums: ChecksumLine[];
  archives: DarwinArchive[];
  status: "fetched" | "signed" | "failed";
};
export type Manifest = { items: Fetched[] };

export const workdir = () => join(process.env.RUNNER_TEMP ?? tmpdir(), "tapster");
const manifestPath = () => join(workdir(), "manifest.json");

export async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(manifestPath(), "utf8")) as Manifest;
  } catch {
    return { items: [] };
  }
}

export async function saveManifest(m: Manifest): Promise<void> {
  await mkdir(workdir(), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath(), JSON.stringify(m), { mode: 0o600 });
}
```

- [ ] **Step 4: Context** (`src/action/context.ts`)

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type HubConfig, NAME, TAG, parseConfig } from "../config";
import { TapsterError } from "../errors";
import type { WorkItem } from "../plan";

export type Context = { hub: string; owner: string; config: HubConfig; workspace: string };

export async function loadContext(configPath: string): Promise<Context> {
  const hub = process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!hub || !owner || !workspace) throw new TapsterError("tapster runs inside GitHub Actions only", "Call it from the hub workflow.");
  const text = await readFile(join(workspace, configPath), "utf8").catch(() => {
    throw new TapsterError(`${configPath} is missing in the hub`, "Run tapster init in a clone of the hub.");
  });
  return { hub, owner, config: parseConfig(text, owner), workspace };
}

const work = z
  .array(z.object({ package: z.string().regex(NAME), tag: z.string().regex(TAG), releaseId: z.number().int().positive(), resume: z.boolean() }).strict())
  .max(50);

export function parseWork(text: string): WorkItem[] {
  if (text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TapsterError("the work list is not valid JSON", "Pass the check job's work output unchanged.");
  }
  const r = work.safeParse(raw);
  if (!r.success) throw new TapsterError("the work list is invalid", "Pass the check job's work output unchanged.");
  return r.data;
}
```

- [ ] **Step 5: check mode** (`src/action/check.ts`)

```ts
import * as core from "@actions/core";
import { parseChecksums } from "../checksums";
import { GitHub } from "../github";
import { readSecret, requireVar } from "../mask";
import { type WorkItem, planPackage } from "../plan";
import { failure, record } from "../report";
import { type InstallationToken, installationToken } from "../token";
import type { Context } from "./context";
import { renderNeeded } from "./render";

export async function check(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const only = core.getInput("package");
  const items: WorkItem[] = [];
  for (const pkg of ctx.config.packages) {
    if (only && pkg.name !== only) continue;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const plan = await planPackage(pkg, await gh.listReleases(pkg.repo), async (r) => {
        const asset = r.assets.find((a) => a.name === "checksums.txt");
        return asset ? parseChecksums((await gh.downloadAsset(pkg.repo, asset.id)).toString("utf8")) : null;
      });
      items.push(...plan.items);
      for (const note of plan.notes) record({ item: pkg.name, result: "waiting", detail: note });
    } catch (e) {
      failure(pkg.name, e);
    } finally {
      await tok?.revoke();
    }
  }
  core.setOutput("work", JSON.stringify(items));
  core.setOutput("render", String(items.length > 0 || (await renderNeeded(ctx))));
}
```

- [ ] **Step 6: fetch mode** (`src/action/fetch.ts`)

```ts
import * as core from "@actions/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMachO, readTarGz } from "../archive";
import { verifyAttestation } from "../attest";
import { parseChecksums, sha256 } from "../checksums";
import { type Platform, assetName, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { readSecret, requireVar } from "../mask";
import { failure, warn } from "../report";
import { type InstallationToken, installationToken } from "../token";
import { type Fetched, type Manifest, saveManifest, workdir } from "../workdir";
import { type Context, parseWork } from "./context";

export async function fetchMode(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const manifest: Manifest = { items: [] };
  for (const item of parseWork(core.getInput("work"))) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package);
    if (!pkg) {
      failure(item.package, new TapsterError("the package is not in tapster.yml", "The config changed since the check; the next run checks again."));
      continue;
    }
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write", attestations: "read" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      if (!release.draft || release.tag_name !== item.tag) {
        throw new TapsterError("the release is no longer the draft that was checked", "The next run checks again.");
      }
      const fetched: Fetched = { ...item, before: release.assets, checksums: [], archives: [], status: "fetched" };
      if (!item.resume) {
        const repo = await gh.getRepo(pkg.repo);
        const dir = join(workdir(), pkg.name, item.tag);
        await mkdir(join(dir, "assets"), { recursive: true, mode: 0o700 });
        const sums = release.assets.find((a) => a.name === "checksums.txt");
        if (!sums) throw new TapsterError("checksums.txt disappeared from the draft", "The next run checks again.");
        fetched.checksums = parseChecksums((await gh.downloadAsset(pkg.repo, sums.id)).toString("utf8"));
        for (const a of release.assets) {
          if (a.name === "checksums.txt") continue;
          const data = await gh.downloadAsset(pkg.repo, a.id);
          const line = fetched.checksums.find((l) => l.name === a.name);
          if (!line || sha256(data) !== line.sha256 || (a.digest !== null && a.digest !== `sha256:${line.sha256}`)) {
            throw new TapsterError(`${a.name} does not match checksums.txt`, "Rebuild the release; the files changed after the checksums were written.");
          }
          const file = join(dir, "assets", a.name);
          await writeFile(file, data, { mode: 0o600 });
          if ((await verifyAttestation(file, pkg, item.tag, repo.private, tok.token)) === "skipped") {
            warn(`${pkg.name} ${item.tag}: ${a.name} has no attestation; ${pkg.repo} is private, so this is allowed`);
          }
        }
        const version = versionOf(item.tag);
        for (const platform of (Object.keys(pkg.assets) as Platform[]).filter((p) => p.startsWith("darwin"))) {
          const name = assetName(pkg, platform, version)!;
          const binDir = join(dir, "bin", name);
          const found: string[] = [];
          for (const e of readTarGz(await readFile(join(dir, "assets", name)))) {
            if (e.type !== "file") continue;
            const listed = pkg.binaries.includes(e.name);
            const macho = isMachO(e.data);
            if (macho && !listed) throw new TapsterError(`${name} holds ${e.name}, a Mach-O file not listed in binaries`, "List every macOS executable in binaries.");
            if (listed && !macho) throw new TapsterError(`${e.name} in ${name} is not a Mach-O binary`, "binaries must name the macOS executables in the archive.");
            if (!listed) continue;
            const out = join(binDir, e.name);
            await mkdir(dirname(out), { recursive: true, mode: 0o700 });
            await writeFile(out, e.data, { mode: 0o755 });
            found.push(e.name);
          }
          const missing = pkg.binaries.filter((b) => !found.includes(b));
          if (missing.length) throw new TapsterError(`${name} does not contain ${missing.join(", ")}`, "Check binaries in tapster.yml.");
          fetched.archives.push({ asset: name, platform, dir: binDir, binaries: found });
        }
      }
      manifest.items.push(fetched);
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
    }
  }
  await saveManifest(manifest);
}
```

- [ ] **Step 7: sign mode** (`src/action/sign.ts`). Review focus 3: items with no macOS archives pass straight through.

```ts
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openKeychain } from "../keychain";
import { readSecret, register, requireVar } from "../mask";
import { failure, info } from "../report";
import { PRESETS, entitlementsPlist, notarize, signFile, verifySigned, zipForNotary } from "../sign";
import { loadManifest, saveManifest, workdir } from "../workdir";
import type { Context } from "./context";

export async function signMode(ctx: Context): Promise<void> {
  const manifest = await loadManifest();
  for (const i of manifest.items) if (i.status === "fetched" && (i.resume || i.archives.length === 0)) i.status = "signed";
  const todo = manifest.items.filter((i) => i.status === "fetched");
  if (todo.length > 0) {
    const p12 = readSecret("MACOS_SIGN_P12");
    const password = readSecret("MACOS_SIGN_PASSWORD");
    const rawKey = readSecret("MACOS_NOTARY_KEY");
    const keyId = readSecret("MACOS_NOTARY_KEY_ID");
    const issuer = readSecret("MACOS_NOTARY_ISSUER_ID");
    const team = requireVar("TAPSTER_TEAM_ID");
    const p8 = rawKey.includes("BEGIN PRIVATE KEY") ? rawKey : Buffer.from(rawKey, "base64").toString("utf8");
    register(p8);
    const kc = await openKeychain(p12, password, team, workdir());
    const p8Path = join(workdir(), "notary.p8");
    await writeFile(p8Path, p8, { mode: 0o600 });
    try {
      for (const item of todo) {
        try {
          const pkg = ctx.config.packages.find((p) => p.name === item.package)!;
          const keys = [...new Set([...PRESETS[pkg.kind], ...pkg.entitlements])];
          const ent = keys.length ? join(workdir(), `${pkg.name}.entitlements.plist`) : null;
          if (ent) await writeFile(ent, entitlementsPlist(keys));
          for (const a of item.archives) {
            for (const b of a.binaries) {
              await signFile(kc, join(a.dir, b), ent);
              await verifySigned(join(a.dir, b), team);
            }
          }
          const root = join(workdir(), pkg.name, item.tag, "notary");
          await mkdir(root, { recursive: true, mode: 0o700 });
          for (const a of item.archives) await cp(a.dir, join(root, a.asset), { recursive: true });
          await zipForNotary(root, `${root}.zip`);
          await notarize(`${root}.zip`, { p8Path, keyId, issuer });
          item.status = "signed";
          info(`${item.package} ${item.tag}: signed and notarized`);
        } catch (e) {
          item.status = "failed";
          failure(`${item.package} ${item.tag}`, e);
        }
      }
    } finally {
      await rm(p8Path, { force: true });
      await kc.close();
    }
  }
  await saveManifest(manifest);
}
```

- [ ] **Step 8: publish mode** (`src/action/publish.ts`)

```ts
import * as core from "@actions/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTarGz, writeTarGz } from "../archive";
import { sha256, writeChecksums } from "../checksums";
import { GitHub } from "../github";
import { commitToHub } from "../hubcommit";
import { readSecret, requireVar } from "../mask";
import { type Outgoing, makeLatest, resumeSwap, stageAndSwap, waitDownloadable } from "../publish";
import { failure, record, warn } from "../report";
import { STATE_PATH, type StateEntry, parseState, serializeState, upsert } from "../state";
import { type InstallationToken, installationToken } from "../token";
import { loadManifest, workdir } from "../workdir";
import type { Context } from "./context";

async function recordState(gh: GitHub, hub: string, pkg: string, entry: StateEntry): Promise<void> {
  await commitToHub(gh, hub, `${pkg} ${entry.tag} ${entry.status}`, async (read) => {
    const before = await read(STATE_PATH);
    const next = serializeState(upsert(parseState(before), pkg, entry));
    return next === before ? [] : [{ path: STATE_PATH, content: next }];
  });
}

export async function publishMode(ctx: Context): Promise<void> {
  const appId = requireVar("TAPSTER_APP_ID");
  const pem = readSecret("TAPSTER_APP_PRIVATE_KEY");
  const hubGh = new GitHub(readSecret("GITHUB_TOKEN"));
  const out = join(workdir(), "out");
  await mkdir(out, { recursive: true, mode: 0o700 });
  let attest = false;
  for (const item of (await loadManifest()).items.filter((i) => i.status === "signed")) {
    const pkg = ctx.config.packages.find((p) => p.name === item.package)!;
    let tok: InstallationToken | undefined;
    try {
      tok = await installationToken(appId, pem, pkg.repo, { contents: "write" });
      const gh = new GitHub(tok.token);
      const release = await gh.getRelease(pkg.repo, item.releaseId);
      if (item.resume) {
        await resumeSwap(gh, pkg.repo, release);
      } else {
        const dir = join(workdir(), pkg.name, item.tag);
        const mtime = Math.floor(Date.parse(release.created_at) / 1000);
        const lines = item.checksums.map((l) => ({ ...l }));
        const files: Outgoing[] = [];
        for (const a of item.archives) {
          const entries = readTarGz(await readFile(join(dir, "assets", a.asset)));
          for (const e of entries) if (a.binaries.includes(e.name)) e.data = await readFile(join(a.dir, e.name));
          const data = writeTarGz(entries, mtime);
          files.push({ name: a.asset, data });
          lines.find((l) => l.name === a.asset)!.sha256 = sha256(data);
          await writeFile(join(out, a.asset), data);
          attest = true;
        }
        const sums = Buffer.from(writeChecksums(lines));
        files.push({ name: "checksums.txt", data: sums });
        await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: sha256(sums), status: "publishing" });
        await stageAndSwap(gh, pkg.repo, item.releaseId, files, item.before);
      }
      await gh.updateRelease(pkg.repo, item.releaseId, { draft: false, make_latest: makeLatest(item.tag, await gh.listReleases(pkg.repo)) });
      const published = await gh.getRelease(pkg.repo, item.releaseId);
      if ((await gh.getRepo(pkg.repo)).private) warn(`${pkg.name}: ${pkg.repo} is private, so its files cannot be downloaded by Homebrew users`);
      else await waitDownloadable(published.assets.map((a) => a.browser_download_url));
      const sumsAsset = published.assets.find((a) => a.name === "checksums.txt")!;
      const digest = sha256(await gh.downloadAsset(pkg.repo, sumsAsset.id));
      await recordState(hubGh, ctx.hub, pkg.name, { tag: item.tag, releaseId: item.releaseId, checksums: digest, status: "published" });
      record({ item: `${pkg.name} ${item.tag}`, result: "published", detail: "" });
    } catch (e) {
      failure(`${item.package} ${item.tag}`, e);
    } finally {
      await tok?.revoke();
    }
  }
  core.setOutput("attest", String(attest));
  core.setOutput("attest-path", `${out}/*`);
}
```

- [ ] **Step 9: render mode** (`src/action/render.ts`)

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ChecksumLine, parseChecksums, sha256 } from "../checksums";
import { type PackageConfig, type Platform, parseTag, versionOf } from "../config";
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { commitToHub } from "../hubcommit";
import { readSecret } from "../mask";
import { type Download, caskPath, downloadUrl, renderCask, renderScoop, scoopPath } from "../render";
import { failure, record } from "../report";
import { childEnv, run, runPath } from "../run";
import { STATE_PATH, latestPublished, parseState, serializeState, upsert } from "../state";
import type { Context } from "./context";

const readIfExists = (path: string) => readFile(path, "utf8").catch(() => null);

export function buildDownloads(pkg: PackageConfig, tag: string, lines: ChecksumLine[]): Download[] {
  const version = versionOf(tag);
  return (Object.entries(pkg.assets) as [Platform, string][]).map(([platform, template]) => {
    const name = template.replaceAll("{version}", version);
    const line = lines.find((l) => l.name === name);
    if (!line) throw new TapsterError(`${name} is not in the published checksums.txt`, "Check assets in tapster.yml.");
    return { platform, url: downloadUrl(pkg.repo, tag, name), sha256: line.sha256 };
  });
}

// GitHub turns the schedule off after 60 days without commits in a public repository.
export async function headIsStale(ws: string): Promise<boolean> {
  const out = await run("git", ["-C", ws, "log", "-1", "--format=%ct"]).catch(() => ({ stdout: "0" }));
  const last = Number(out.stdout.trim());
  return last > 0 && Date.now() / 1000 - last > 30 * 86400;
}

export async function renderNeeded(ctx: Context): Promise<boolean> {
  if (await headIsStale(ctx.workspace)) return true;
  const state = parseState(await readIfExists(join(ctx.workspace, STATE_PATH)));
  if (Object.values(state.packages).some((list) => list.some((e) => e.status === "publishing"))) return true;
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest) continue;
    const cask = await readIfExists(join(ctx.workspace, caskPath(pkg.name)));
    if (!cask?.includes(`  version "${versionOf(latest.tag)}"\n`)) return true;
  }
  return false;
}

async function audit(ws: string, tap: string, casks: { name: string; online: boolean }[]): Promise<void> {
  if (casks.length === 0) return;
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => existsSync(p));
  if (!brew) throw new TapsterError("Homebrew is not installed on this runner", "Run the render job on macos-15.");
  const env = childEnv({ PATH: `${dirname(brew)}:/usr/bin:/bin`, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" });
  const local = `${tap.split("/")[0]}/tapster-audit`;
  await run("git", ["-C", ws, "add", "-A"]);
  await run("git", ["-C", ws, "-c", "user.name=tapster", "-c", "user.email=tapster@localhost", "commit", "-q", "--allow-empty", "-m", "tapster audit"]);
  await runPath(brew, "brew", ["tap", local, ws], { env });
  try {
    for (const c of casks) {
      await runPath(brew, "brew", ["style", "--cask", `${local}/${c.name}`], { env });
      // A private project's release files are not downloadable, so only its public casks are checked online.
      await runPath(brew, "brew", ["audit", "--cask", ...(c.online ? ["--online"] : []), `${local}/${c.name}`], { env });
    }
  } finally {
    await runPath(brew, "brew", ["untap", local], { env, allowFail: true });
  }
}

export async function renderMode(ctx: Context): Promise<void> {
  const gh = new GitHub(readSecret("GITHUB_TOKEN"));
  const ws = ctx.workspace;
  const stateBefore = await readIfExists(join(ws, STATE_PATH));
  let state = parseState(stateBefore);
  for (const [name, entries] of Object.entries(state.packages)) {
    const pkg = ctx.config.packages.find((p) => p.name === name);
    if (!pkg) continue;
    for (const e of entries.filter((x) => x.status === "publishing")) {
      try {
        const r = await gh.getRelease(pkg.repo, e.releaseId);
        if (r.draft) continue;
        const sums = r.assets.find((a) => a.name === "checksums.txt");
        if (sums && sha256(await gh.downloadAsset(pkg.repo, sums.id)) === e.checksums) state = upsert(state, name, { ...e, status: "published" });
        else record({ item: `${name} ${e.tag}`, result: "skipped", detail: "published, but checksums.txt differs from what tapster recorded; not rendered" });
      } catch (err) {
        failure(`${name} ${e.tag}`, err);
      }
    }
  }
  const changes: { path: string; content: string }[] = [];
  const rendered: string[] = [];
  const online = new Map<string, boolean>();
  for (const pkg of ctx.config.packages) {
    const latest = latestPublished(state, pkg.name);
    if (!latest || parseTag(latest.tag) === null) continue;
    try {
      const r = await gh.getRelease(pkg.repo, latest.releaseId);
      const sums = r.assets.find((a) => a.name === "checksums.txt");
      if (!sums) throw new TapsterError(`${latest.tag} has no checksums.txt`, "Check the release.");
      const data = await gh.downloadAsset(pkg.repo, sums.id);
      if (sha256(data) !== latest.checksums) throw new TapsterError(`${latest.tag}: checksums.txt changed after tapster published it`, "tapster renders only what it published; check the release.");
      const repo = await gh.getRepo(pkg.repo);
      online.set(pkg.name, !repo.private);
      const input = {
        pkg,
        version: versionOf(latest.tag),
        downloads: buildDownloads(pkg, latest.tag, parseChecksums(data.toString("utf8"))),
        description: pkg.description ?? repo.description ?? pkg.name,
        homepage: pkg.homepage ?? repo.html_url,
        license: pkg.license ?? null,
      };
      const cask = renderCask(input);
      if ((await readIfExists(join(ws, caskPath(pkg.name)))) !== cask) changes.push({ path: caskPath(pkg.name), content: cask });
      const scoop = renderScoop(input);
      if (scoop && (await readIfExists(join(ws, scoopPath(pkg.name)))) !== scoop) changes.push({ path: scoopPath(pkg.name), content: scoop });
      rendered.push(`${pkg.name} ${latest.tag}`);
    } catch (e) {
      failure(pkg.name, e);
    }
  }
  const stateText = serializeState(state);
  const stateChanged = stateText !== (stateBefore ?? serializeState(parseState(null)));
  const heartbeat = changes.length === 0 && !stateChanged && (await headIsStale(ws));
  if (changes.length === 0 && !stateChanged && !heartbeat) return;
  for (const c of changes) {
    await mkdir(dirname(join(ws, c.path)), { recursive: true });
    await writeFile(join(ws, c.path), c.content);
  }
  const casks = changes.filter((c) => c.path.startsWith("Casks/")).map((c) => basename(c.path, ".rb"));
  await audit(ws, ctx.config.tap, casks.map((name) => ({ name, online: online.get(name) ?? true })));
  const all = [
    ...changes,
    ...(stateChanged ? [{ path: STATE_PATH, content: stateText }] : []),
    ...(heartbeat ? [{ path: ".tapster/heartbeat", content: `${new Date().toISOString().slice(0, 10)}\n` }] : []),
  ];
  const message = changes.length
    ? rendered.filter((r) => changes.some((c) => c.path.includes(`/${r.split(" ")[0]}.`))).join(", ")
    : heartbeat
      ? "Keep the tapster schedule active"
      : "Record published releases";
  await commitToHub(gh, ctx.hub, message, async () => all);
  for (const c of changes) record({ item: c.path, result: "rendered", detail: "" });
}
```

- [ ] **Step 10: cleanup mode and the entry point**

`src/action/cleanup.ts`:
```ts
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../run";
import { workdir } from "../workdir";

export async function cleanupMode(): Promise<void> {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(workdir()).filter((d) => d.startsWith("kc-"));
  } catch {
    return;
  }
  for (const d of dirs) await run("security", ["delete-keychain", join(workdir(), d, "tapster.keychain-db")], { allowFail: true });
  await rm(workdir(), { recursive: true, force: true });
}
```

`src/action/main.ts`:
```ts
import * as core from "@actions/core";
import { TapsterError } from "../errors";
import { failedCount, failure, writeSummary } from "../report";
import { check } from "./check";
import { cleanupMode } from "./cleanup";
import { loadContext } from "./context";
import { fetchMode } from "./fetch";
import { publishMode } from "./publish";
import { renderMode } from "./render";
import { signMode } from "./sign";

async function main(): Promise<void> {
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new TapsterError("tapster runs only on GitHub-hosted runners", "Use runs-on: ubuntu-24.04 or macos-15.");
  }
  const mode = core.getInput("mode", { required: true });
  if (mode === "cleanup") return cleanupMode();
  const ctx = await loadContext(core.getInput("config") || "tapster.yml");
  if (mode === "check") return check(ctx);
  if (mode === "fetch") return fetchMode(ctx);
  if (mode === "sign") return signMode(ctx);
  if (mode === "publish") return publishMode(ctx);
  if (mode === "render") return renderMode(ctx);
  throw new TapsterError(`unknown mode ${mode}`, "Use check, fetch, sign, publish, render or cleanup.");
}

try {
  await main();
} catch (e) {
  failure("tapster", e);
} finally {
  await writeSummary();
  if (failedCount() > 0) core.setFailed("tapster: some items failed; see the summary");
}
```

Add to `action.yml` outputs:
```yaml
  attest:
    description: "true when publish wrote archives to attest"
  attest-path:
    description: Glob of the archives to attest
```

- [ ] **Step 11: Hub workflow template** (`templates/hub/tapster.yml`). `init` fills the `__…__` values from
  `templates/pins.json` and the tapster release tag.

```yaml
name: tapster
on:
  schedule:
    - cron: "7-59/10 * * * *"
  workflow_dispatch:
    inputs:
      package:
        description: Only this package (optional)
        required: false
        default: ""
permissions: {}
concurrency:
  group: tapster
  cancel-in-progress: false
jobs:
  check:
    runs-on: ubuntu-24.04
    environment: { name: tapster, deployment: false }
    permissions: { contents: read }
    outputs:
      work: ${{ steps.check.outputs.work }}
      render: ${{ steps.check.outputs.render }}
    steps:
      - uses: actions/checkout@__CHECKOUT_SHA__ # __CHECKOUT_TAG__
        with: { persist-credentials: false }
      - id: check
        uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: check, package: "${{ inputs.package }}" }
        env:
          TAPSTER_APP_ID: ${{ vars.TAPSTER_APP_ID }}
          TAPSTER_APP_PRIVATE_KEY: ${{ secrets.TAPSTER_APP_PRIVATE_KEY }}
  sign:
    needs: check
    if: needs.check.outputs.work != '[]' && needs.check.outputs.work != ''
    runs-on: macos-15
    environment: { name: tapster, deployment: false }
    permissions: { contents: write, id-token: write, attestations: write }
    steps:
      - uses: actions/checkout@__CHECKOUT_SHA__ # __CHECKOUT_TAG__
        with: { persist-credentials: false }
      - uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: fetch, work: "${{ needs.check.outputs.work }}" }
        env:
          TAPSTER_APP_ID: ${{ vars.TAPSTER_APP_ID }}
          TAPSTER_APP_PRIVATE_KEY: ${{ secrets.TAPSTER_APP_PRIVATE_KEY }}
      - uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: sign }
        env:
          TAPSTER_TEAM_ID: ${{ vars.TAPSTER_TEAM_ID }}
          MACOS_SIGN_P12: ${{ secrets.MACOS_SIGN_P12 }}
          MACOS_SIGN_PASSWORD: ${{ secrets.MACOS_SIGN_PASSWORD }}
          MACOS_NOTARY_KEY: ${{ secrets.MACOS_NOTARY_KEY }}
          MACOS_NOTARY_KEY_ID: ${{ secrets.MACOS_NOTARY_KEY_ID }}
          MACOS_NOTARY_ISSUER_ID: ${{ secrets.MACOS_NOTARY_ISSUER_ID }}
      - id: publish
        uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: publish }
        env:
          TAPSTER_APP_ID: ${{ vars.TAPSTER_APP_ID }}
          TAPSTER_APP_PRIVATE_KEY: ${{ secrets.TAPSTER_APP_PRIVATE_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
      - if: steps.publish.outputs.attest == 'true'
        uses: actions/attest-build-provenance@__ATTEST_SHA__ # __ATTEST_TAG__
        with: { subject-path: "${{ steps.publish.outputs.attest-path }}" }
      - if: always()
        uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: cleanup }
  render:
    needs: [check, sign]
    if: always() && needs.check.result == 'success' && needs.check.outputs.render == 'true'
    runs-on: macos-15
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@__CHECKOUT_SHA__ # __CHECKOUT_TAG__
        with: { persist-credentials: false, ref: main }
      - uses: doguyilmaz/tapster@__TAPSTER_SHA__ # __TAPSTER_TAG__
        with: { mode: render }
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

- [ ] **Step 12: Run the tests, build the bundle**

Run: `bun test && bun run typecheck && bun run build:action`
Expected: all tests PASS, no type errors, and `dist/index.js` is written. Then:
`node -e "import('./dist/index.js')"` with `RUNNER_ENVIRONMENT` unset prints a "tapster runs only on GitHub-hosted
runners" error and exits non-zero. That proves the bundle loads in plain Node.

- [ ] **Step 13: Commit**

```bash
git add -A && git commit -m "Add the action modes, the bundle and the hub workflow"
```

---

### Task 18: `tapster doctor`

**Files:**
- Create: `src/cli/gh.ts`, `src/cli/doctor.ts`, `src/cli/main.ts`
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `GitHub`, `GitHubError`, `parseConfig`, `ghPath`, `runPath`, `run`.
- Produces:
  - `userGitHub(): Promise<GitHub>` and `currentRepo(dir?: string): Promise<string>`.
  - `setEnvSecret(repo, name, value)` and `setEnvVariable(repo, name, value)`.
  - `type Check = { name: string; ok: boolean; fix: string }`.
  - `workflowTriggerCheck(workflowYaml: string): Check` and `otherWorkflowsCheck(files: Record<string, string>): Check`.
  - `doctor(args: string[]): Promise<number>` (the exit code).

- [ ] **Step 1: Write the failing test** (the file-based checks are pure; the API checks are covered end to end in
  Task 22).

`tests/doctor.test.ts`:
```ts
import { expect, test } from "bun:test";
import { otherWorkflowsCheck, workflowTriggerCheck } from "../src/cli/doctor";

test("the hub workflow may only run on schedule and dispatch", () => {
  expect(workflowTriggerCheck("on:\n  schedule: [{cron: '7-59/10 * * * *'}]\n  workflow_dispatch: {}\n").ok).toBe(true);
  expect(workflowTriggerCheck("on:\n  schedule: []\n  pull_request_target: {}\n").ok).toBe(false);
  expect(workflowTriggerCheck("on: [push]\n").ok).toBe(false);
});

test("no other workflow may use the tapster environment", () => {
  expect(otherWorkflowsCheck({ "ci.yml": "jobs:\n  a:\n    runs-on: ubuntu-24.04\n" }).ok).toBe(true);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: tapster\n" }).ok).toBe(false);
  expect(otherWorkflowsCheck({ "x.yml": "jobs:\n  a:\n    environment: { name: tapster }\n" }).ok).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/doctor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/cli/gh.ts`:
```ts
import { TapsterError } from "../errors";
import { GitHub } from "../github";
import { ghPath, run, runPath } from "../run";

const userEnv = (): Record<string, string> => ({
  HOME: process.env.HOME ?? "/tmp",
  ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
  GH_PROMPT_DISABLED: "1",
});

export async function userGitHub(): Promise<GitHub> {
  const token = (await runPath(ghPath(), "gh", ["auth", "token"], { env: userEnv() })).stdout.trim();
  if (!token) throw new TapsterError("gh is not signed in", "Run gh auth login, then try again.");
  return new GitHub(token);
}

export async function currentRepo(dir = process.cwd()): Promise<string> {
  const url = (await run("git", ["-C", dir, "remote", "get-url", "origin"])).stdout.trim();
  const m = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new TapsterError("this folder is not a clone of a GitHub repository", "Run tapster inside a clone (git remote origin on github.com).");
  return m[1]!;
}

export async function setEnvSecret(repo: string, name: string, value: string): Promise<void> {
  await runPath(ghPath(), "gh", ["secret", "set", name, "--env", "tapster", "--repo", repo], { env: userEnv(), stdin: value });
}

export async function setEnvVariable(repo: string, name: string, value: string): Promise<void> {
  await runPath(ghPath(), "gh", ["variable", "set", name, "--env", "tapster", "--repo", repo, "--body", value], { env: userEnv() });
}
```

`src/cli/doctor.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseConfig } from "../config";
import { GitHubError, TapsterError } from "../errors";
import type { GitHub } from "../github";
import { currentRepo, userGitHub } from "./gh";

export type Check = { name: string; ok: boolean; fix: string };
const ok = (name: string): Check => ({ name, ok: true, fix: "" });
const bad = (name: string, fix: string): Check => ({ name, ok: false, fix });

export function workflowTriggerCheck(yaml: string): Check {
  const name = "the hub workflow runs only on schedule and manual dispatch";
  const on = (parse(yaml) as { on?: unknown })?.on;
  const keys = on && typeof on === "object" && !Array.isArray(on) ? Object.keys(on) : [];
  return keys.length > 0 && keys.every((k) => k === "schedule" || k === "workflow_dispatch")
    ? ok(name)
    : bad(name, "Other triggers (pull_request_target, issue_comment, workflow_run) would reach the credentials. Restore .github/workflows/tapster.yml with tapster init.");
}

export function otherWorkflowsCheck(files: Record<string, string>): Check {
  const name = "no other workflow uses the tapster environment";
  const offenders = Object.entries(files).filter(([, text]) => /environment:\s*(\{[^}]*name:\s*)?["']?tapster["']?/.test(text)).map(([f]) => f);
  return offenders.length === 0 ? ok(name) : bad(name, `Remove the tapster environment from ${offenders.join(", ")}.`);
}

const SECRETS = ["MACOS_SIGN_P12", "MACOS_SIGN_PASSWORD", "MACOS_NOTARY_KEY", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID", "TAPSTER_APP_PRIVATE_KEY"];
const VARIABLES = ["TAPSTER_APP_ID", "TAPSTER_APP_SLUG", "TAPSTER_TEAM_ID"];

async function apiChecks(gh: GitHub, hub: string, repos: string[]): Promise<Check[]> {
  const checks: Check[] = [];
  const env = await gh.json<{ deployment_branch_policy: { custom_branch_policies: boolean } | null }>("GET", `/repos/${hub}/environments/tapster`).catch(() => null);
  if (!env) return [bad("the tapster environment exists", "Run tapster init.")];
  const policies = await gh.json<{ branch_policies: { name: string; type?: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  checks.push(
    env.deployment_branch_policy?.custom_branch_policies && policies.branch_policies.length === 1 && policies.branch_policies[0]!.name === "main"
      ? ok("only main may open the tapster environment")
      : bad("only main may open the tapster environment", "Run tapster init to restore the branch rule."),
  );
  const secrets = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/secrets`)).secrets.map((s) => s.name);
  const missing = SECRETS.filter((s) => !secrets.includes(s));
  checks.push(missing.length ? bad("all credentials are stored", `Missing: ${missing.join(", ")}. Run tapster init --rotate for them.`) : ok("all credentials are stored"));
  const vars = (await gh.json<{ variables: { name: string; value: string }[] }>("GET", `/repos/${hub}/environments/tapster/variables`)).variables;
  const missingVars = VARIABLES.filter((v) => !vars.some((x) => x.name === v));
  checks.push(missingVars.length ? bad("the App and team variables are set", `Missing: ${missingVars.join(", ")}. Run tapster init.`) : ok("the App and team variables are set"));
  const perms = await gh.json<{ default_workflow_permissions: string }>("GET", `/repos/${hub}/actions/permissions/workflow`);
  checks.push(perms.default_workflow_permissions === "read" ? ok("the default workflow token is read-only") : bad("the default workflow token is read-only", "Run tapster init."));
  const rules = await gh.json<{ name: string }[]>("GET", `/repos/${hub}/rulesets`);
  checks.push(rules.some((r) => r.name === "tapster main") ? ok("main cannot be force-pushed or deleted") : bad("main cannot be force-pushed or deleted", "Run tapster init."));
  const flow = await gh.json<{ state: string }>("GET", `/repos/${hub}/actions/workflows/tapster.yml`).catch(() => null);
  checks.push(flow?.state === "active" ? ok("the schedule is enabled") : bad("the schedule is enabled", "Enable the tapster workflow in the hub's Actions tab (GitHub pauses it after 60 days without activity)."));
  const slug = vars.find((v) => v.name === "TAPSTER_APP_SLUG")?.value;
  for (const repo of repos) {
    const r = await gh.getRepo(repo).catch((e) => (e instanceof GitHubError ? null : Promise.reject(e)));
    if (!r) {
      checks.push(bad(`${repo} exists`, "Fix the repo field in tapster.yml."));
      continue;
    }
    checks.push(r.private ? bad(`${repo} is public`, "Homebrew downloads release files without a token; make the repository public first.") : ok(`${repo} is public`));
    const leftovers = (await gh.json<{ secrets: { name: string }[] }>("GET", `/repos/${repo}/actions/secrets`)).secrets
      .map((s) => s.name)
      .filter((n) => /^(HOMEBREW_TAP_|MACOS_)/.test(n));
    checks.push(leftovers.length ? bad(`${repo} holds no release secrets`, `Delete ${leftovers.join(", ")}: gh secret delete <name> --repo ${repo}`) : ok(`${repo} holds no release secrets`));
    if (slug) {
      const installed = await gh.json<{ id: number }>("GET", `/repos/${repo}/installation`).catch(() => null);
      checks.push(installed ? ok(`the App can reach ${repo}`) : bad(`the App can reach ${repo}`, `Add ${repo} at https://github.com/apps/${slug}/installations/new`));
    }
  }
  return checks;
}

export async function doctor(_args: string[]): Promise<number> {
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const checks: Check[] = [];
  let repos: string[] = [];
  try {
    repos = parseConfig(readFileSync(join(dir, "tapster.yml"), "utf8"), hub.split("/")[0]!).packages.map((p) => p.repo);
    checks.push(ok("tapster.yml is valid"));
  } catch (e) {
    checks.push(bad("tapster.yml is valid", e instanceof TapsterError ? `${e.reason}. ${e.fix}` : "Run tapster init."));
  }
  const flowsDir = join(dir, ".github/workflows");
  const flows = existsSync(flowsDir) ? Object.fromEntries(readdirSync(flowsDir).map((f) => [f, readFileSync(join(flowsDir, f), "utf8")])) : {};
  checks.push(flows["tapster.yml"] ? workflowTriggerCheck(flows["tapster.yml"]) : bad("the hub workflow exists", "Run tapster init."));
  const { "tapster.yml": _, ...others } = flows;
  checks.push(otherWorkflowsCheck(others));
  checks.push(...(await apiChecks(await userGitHub(), hub, repos)));
  for (const c of checks) console.log(c.ok ? `ok   ${c.name}` : `fix  ${c.name}\n     ${c.fix}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}
```

`src/cli/main.ts`:
```ts
#!/usr/bin/env bun
import { TapsterError } from "../errors";
import { add } from "./add";
import { doctor } from "./doctor";
import { init } from "./init";

const usage = `tapster: publish your projects' releases from one Homebrew tap

  tapster init                 set up this hub clone (run once)
  tapster init --rotate app|certificate|notary
  tapster add                  prepare this project clone for the hub
  tapster doctor               check the hub's setup`;

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "init") await init(args);
  else if (cmd === "add") await add(args);
  else if (cmd === "doctor") process.exitCode = await doctor(args);
  else {
    console.log(usage);
    process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof TapsterError ? `tapster: ${e.reason}\n  ${e.fix}` : "tapster: unexpected error");
  process.exitCode = 1;
}
```

Create placeholder exports in `src/cli/init.ts` and `src/cli/add.ts`, so `main.ts` type-checks until Tasks 19 and 20:
```ts
export async function init(_args: string[]): Promise<void> {
  throw new Error("init comes in Task 19");
}
```
```ts
export async function add(_args: string[]): Promise<void> {
  throw new Error("add comes in Task 20");
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/doctor.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -m "Check the hub's setup with tapster doctor"
```

---

### Task 19: `tapster init`

**Files:**
- Create: `src/cli/prompt.ts`, `templates/hub/README.md`
- Modify: `src/cli/init.ts` (replace the placeholder)
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `userGitHub`, `currentRepo`, `setEnvSecret`, `setEnvVariable` (Task 18); `run` (Task 4); `GitHub`;
  `templates/pins.json`; `templates/hub/tapster.yml`.
- Produces:
  - `ask(question: string, hidden?: boolean): Promise<string>`.
  - `appManifest(owner: string, hub: string, redirect: string): object` and `teamIdFromSubject(subject: string): string | null`.
  - `fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }): string`.
  - `init(args: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/init.test.ts`:
```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appManifest, fillWorkflow, teamIdFromSubject } from "../src/cli/init";
import pins from "../templates/pins.json";

test("the App asks only for what tapster needs", () => {
  const m = appManifest("o", "o/homebrew-tap", "http://127.0.0.1:5000/callback") as Record<string, unknown>;
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({ contents: "write", attestations: "read", metadata: "read" });
  expect(m.default_events).toEqual([]);
});

test("team id comes from the certificate subject", () => {
  expect(teamIdFromSubject("UID=ABC,CN=Developer ID Application: Dogu Kaan Yilmaz (5MYT4VYJFC),OU=5MYT4VYJFC,O=Dogu Kaan Yilmaz,C=TR")).toBe("5MYT4VYJFC");
  expect(teamIdFromSubject("CN=x")).toBeNull();
});

test("the workflow template is filled with pinned SHAs", () => {
  const out = fillWorkflow(readFileSync("templates/hub/tapster.yml", "utf8"), pins, { sha: "f".repeat(40), tag: "v1.0.0" });
  expect(out).not.toContain("__");
  expect(out).toContain(`doguyilmaz/tapster@${"f".repeat(40)} # v1.0.0`);
  expect(out).toContain(`actions/checkout@${pins["actions/checkout"].sha}`);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/init.test.ts`
Expected: FAIL, the exports are missing.

- [ ] **Step 3: Implement**

`src/cli/prompt.ts`:
```ts
import { createInterface } from "node:readline";

export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
```

`templates/hub/README.md`:
````markdown
# __TAP__

```sh
brew install __TAP__/<name>
```

On Windows this repository is also a Scoop bucket:

```sh
scoop bucket add __OWNER__ https://github.com/__HUB__
scoop install __OWNER__/<name>
```

| Path | What it holds |
| --- | --- |
| `Casks/` | Homebrew casks, written by tapster from signed, notarized releases |
| `bucket/` | Scoop manifests for packages with Windows builds |
| `tapster.yml` | which projects this hub publishes |
| `.tapster/state.json` | the releases tapster published |

Releases are signed and published by the `tapster` workflow; change the projects, not these files.
````

`src/cli/init.ts`:
```ts
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { TapsterError } from "../errors";
import type { GitHub } from "../github";
import { run, runPath } from "../run";
import pinsJson from "../../templates/pins.json";
import { currentRepo, setEnvSecret, setEnvVariable, userGitHub } from "./gh";
import { ask } from "./prompt";

type Pins = typeof pinsJson;
const templates = new URL("../../templates/", import.meta.url);

export function appManifest(owner: string, hub: string, redirect: string): object {
  return {
    name: `tapster-${owner}`.toLowerCase().slice(0, 34),
    url: `https://github.com/${hub}`,
    redirect_url: redirect,
    public: false,
    default_permissions: { contents: "write", attestations: "read", metadata: "read" },
    default_events: [],
    hook_attributes: { url: "https://example.com/tapster-has-no-webhook", active: false },
  };
}

export function teamIdFromSubject(subject: string): string | null {
  return /(?:^|[,/]\s*)OU=([A-Z0-9]{10})(?:[,/]|$)/.exec(subject)?.[1] ?? null;
}

export function fillWorkflow(template: string, pins: Pins, tapster: { sha: string; tag: string }): string {
  return template
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__TAPSTER_SHA__", tapster.sha)
    .replaceAll("__TAPSTER_TAG__", tapster.tag);
}

function openUrl(url: string): void {
  console.log(`  ${url}`);
  void runPath(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", "open", [url], { allowFail: true }).catch(() => undefined);
}

async function createApp(owner: string, hub: string, rotating: boolean): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/start") {
        const manifest = JSON.stringify(appManifest(owner, hub, `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`)).replaceAll('"', "&quot;");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${manifest}"></form><script>document.getElementById("f").submit()</script>`);
        return;
      }
      if (url.pathname === "/callback") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("tapster: the App was created. You can close this tab.");
        server.close();
        if (url.searchParams.get("state") !== state) reject(new TapsterError("the App creation answer did not match", "Run tapster init again."));
        else resolve(url.searchParams.get("code") ?? "");
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      console.log("Opening GitHub to create your tapster App. Click \"Create GitHub App\".");
      openUrl(`http://127.0.0.1:${p}/start`);
    });
  });
  const app = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
  if (!app.ok) throw new TapsterError(`GitHub did not convert the App (status ${app.status})`, "Run tapster init again within an hour of creating the App.");
  const created = (await app.json()) as { id: number; slug: string; pem: string };
  await setEnvSecret(hub, "TAPSTER_APP_PRIVATE_KEY", created.pem);
  await setEnvVariable(hub, "TAPSTER_APP_ID", String(created.id));
  await setEnvVariable(hub, "TAPSTER_APP_SLUG", created.slug);
  console.log(`Install the App on the projects tapster should publish (not on ${hub}):`);
  openUrl(`https://github.com/apps/${created.slug}/installations/new`);
  if (rotating) console.log("Then delete the old App in https://github.com/settings/apps so its key stops working.");
}

async function storeCertificate(hub: string): Promise<void> {
  const path = await ask("Developer ID Application .p12 file: ");
  const password = await ask(".p12 password: ", true);
  const data = await readFile(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const certs = await run("openssl", ["pkcs12", "-in", path.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "-passin", "env:TAPSTER_P12", "-nokeys", "-clcerts"], { env: { TAPSTER_P12: password } });
  const subject = (await run("openssl", ["x509", "-noout", "-subject", "-nameopt", "RFC2253"], { stdin: certs.stdout })).stdout.replace(/^subject=\s*/, "").trim();
  const team = teamIdFromSubject(subject);
  if (!team) throw new TapsterError("the certificate has no team ID", "Export the Developer ID Application certificate from Keychain Access.");
  await setEnvSecret(hub, "MACOS_SIGN_P12", data.toString("base64"));
  await setEnvSecret(hub, "MACOS_SIGN_PASSWORD", password);
  await setEnvVariable(hub, "TAPSTER_TEAM_ID", team);
  console.log(`Certificate stored for team ${team}.`);
}

async function storeNotary(hub: string): Promise<void> {
  const path = await ask("App Store Connect API key (.p8) file: ");
  const keyId = await ask("Key ID: ");
  const issuer = await ask("Issuer ID: ");
  const p8 = await readFile(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!p8.toString("utf8").includes("BEGIN PRIVATE KEY")) throw new TapsterError("that file is not an App Store Connect key", "Download the .p8 from App Store Connect, Users and Access, Integrations.");
  await setEnvSecret(hub, "MACOS_NOTARY_KEY", p8.toString("base64"));
  await setEnvSecret(hub, "MACOS_NOTARY_KEY_ID", keyId);
  await setEnvSecret(hub, "MACOS_NOTARY_ISSUER_ID", issuer);
  console.log("Notarization key stored.");
}

async function protectHub(gh: GitHub, hub: string): Promise<void> {
  await gh.json("PUT", `/repos/${hub}/environments/tapster`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  const policies = await gh.json<{ branch_policies: { name: string }[] }>("GET", `/repos/${hub}/environments/tapster/deployment-branch-policies`);
  if (!policies.branch_policies.some((p) => p.name === "main")) {
    await gh.json("POST", `/repos/${hub}/environments/tapster/deployment-branch-policies`, { name: "main", type: "branch" });
  }
  await gh.json("PUT", `/repos/${hub}/actions/permissions/workflow`, { default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  const rules = await gh.json<{ name: string }[]>("GET", `/repos/${hub}/rulesets`);
  if (!rules.some((r) => r.name === "tapster main")) {
    await gh.json("POST", `/repos/${hub}/rulesets`, {
      name: "tapster main",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    });
  }
}

async function tapsterRef(gh: GitHub): Promise<{ sha: string; tag: string }> {
  const latest = await gh.json<{ tag_name: string }>("GET", "/repos/doguyilmaz/tapster/releases/latest");
  const ref = await gh.json<{ object: { sha: string; type: string } }>("GET", `/repos/doguyilmaz/tapster/git/ref/tags/${latest.tag_name}`);
  const sha = ref.object.type === "tag" ? (await gh.json<{ object: { sha: string } }>("GET", `/repos/doguyilmaz/tapster/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha;
  return { sha, tag: latest.tag_name };
}

async function writeFiles(gh: GitHub, dir: string, hub: string): Promise<void> {
  const [owner, repo] = hub.split("/") as [string, string];
  const tap = `${owner}/${repo.replace(/^homebrew-/, "")}`;
  const write = async (path: string, content: string) => {
    if (existsSync(join(dir, path))) return;
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
    console.log(`wrote ${path}`);
  };
  await write("tapster.yml", `version: 1\ntap: ${tap}\npackages: []\n`);
  await write(".tapster/state.json", `${JSON.stringify({ version: 1, packages: {} }, null, 2)}\n`);
  await write("README.md", (await readFile(new URL("hub/README.md", templates), "utf8")).replaceAll("__TAP__", tap).replaceAll("__OWNER__", owner).replaceAll("__HUB__", hub));
  const flow = fillWorkflow(await readFile(new URL("hub/tapster.yml", templates), "utf8"), pinsJson, await tapsterRef(gh));
  await mkdir(join(dir, ".github/workflows"), { recursive: true });
  await writeFile(join(dir, ".github/workflows/tapster.yml"), flow);
  console.log("wrote .github/workflows/tapster.yml");
}

export async function init(args: string[]): Promise<void> {
  const dir = process.cwd();
  const hub = await currentRepo(dir);
  const gh = await userGitHub();
  const rotate = args[0] === "--rotate" ? args[1] : null;
  if (rotate === "app") return createApp(hub.split("/")[0]!, hub, true);
  if (rotate === "certificate") return storeCertificate(hub);
  if (rotate === "notary") return storeNotary(hub);
  if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "Use tapster init, or tapster init --rotate app|certificate|notary.");
  await protectHub(gh, hub);
  await createApp(hub.split("/")[0]!, hub, false);
  await storeCertificate(hub);
  await storeNotary(hub);
  await writeFiles(gh, dir, hub);
  console.log("\nDone. Review and commit the new files, push, then run tapster add in each project.");
}
```

`--rotate app` creates a new App; GitHub has no API to delete the old one, so `createApp` prints where to delete it.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/init.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src templates tests && git commit -m "Set up a hub with tapster init"
```

---

### Task 20: `tapster add` and the project templates

**Files:**
- Create: `templates/project/bun-release.yml`
- Modify: `src/cli/add.ts` (replace the placeholder)
- Test: `tests/add.test.ts`

**Interfaces:**
- Consumes: `currentRepo`, `userGitHub`; `templates/pins.json`; the `yaml` `parseDocument` API.
- Produces:
  - `adaptGoreleaser(text: string): { text: string; notes: string[] }` and
    `adaptReleaseWorkflow(text: string, attestSha: string, attestTag: string): { text: string; notes: string[] }`.
  - `bunWorkflow(name: string, entry: string, pins: Pins): string` and
    `inferEntry(name: string, repo: string, assets: string[], version: string, kind: "go" | "bun"): string`.
  - `add(args: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/add.test.ts`:
```ts
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { adaptGoreleaser, adaptReleaseWorkflow, bunWorkflow, inferEntry } from "../src/cli/add";
import pins from "../templates/pins.json";

test("goreleaser config hands signing and casks to the hub", () => {
  const before = `# keep me
version: 2
release:
  github: { owner: o, name: aims }
checksum:
  name_template: "{{ .ProjectName }}_checksums.txt"
notarize:
  macos: [{}]
homebrew_casks: [{ name: aims }]
scoops: [{ name: aims }]
`;
  const { text, notes } = adaptGoreleaser(before);
  const y = parse(text);
  expect(text.startsWith("# keep me")).toBe(true);
  expect(y.release.draft).toBe(true);
  expect(y.checksum.name_template).toBe("checksums.txt");
  expect(y.notarize).toBeUndefined();
  expect(y.homebrew_casks).toBeUndefined();
  expect(y.scoops).toBeUndefined();
  expect(notes.length).toBeGreaterThan(0);
});

test("release workflow drops release secrets and attests", () => {
  const before = `on: { push: { tags: ["v*"] } }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: goreleaser/goreleaser-action@abc
        with: { args: release --clean }
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_GITHUB_TOKEN: \${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}
          MACOS_SIGN_P12: \${{ secrets.MACOS_SIGN_P12 }}
`;
  const { text } = adaptReleaseWorkflow(before, pins["actions/attest-build-provenance"].sha, "v3");
  const y = parse(text);
  const steps = y.jobs.release.steps;
  expect(Object.keys(steps[0].env)).toEqual(["GITHUB_TOKEN"]);
  expect(steps[1].uses).toBe(`actions/attest-build-provenance@${pins["actions/attest-build-provenance"].sha}`);
  expect(y.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
});

test("bun workflow builds every target and drafts the release", () => {
  const flow = bunWorkflow("konvoy", "src/cli.ts", pins);
  expect(flow).toContain("--draft");
  expect(flow).toContain("bun build src/cli.ts --compile");
  expect(flow).not.toContain("__");
  expect(flow).not.toContain("secrets.");
});

test("the hub entry is inferred from the latest release", () => {
  const entry = inferEntry("aims", "o/aims", ["aims_1.2.3_darwin_arm64.tar.gz", "aims_1.2.3_linux_amd64.tar.gz", "aims_1.2.3_windows_amd64.zip", "checksums.txt"], "1.2.3", "go");
  expect(entry).toContain('darwin-arm64: "aims_{version}_darwin_arm64.tar.gz"');
  expect(entry).toContain('windows-amd64: "aims_{version}_windows_amd64.zip"');
  expect(entry).toContain("scoop: true");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/add.test.ts`
Expected: FAIL, the exports are missing.

- [ ] **Step 3: Bun project template** (`templates/project/bun-release.yml`)

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions: {}
jobs:
  build:
    runs-on: ubuntu-24.04
    permissions: { contents: write, id-token: write, attestations: write }
    steps:
      - uses: actions/checkout@__CHECKOUT_SHA__ # __CHECKOUT_TAG__
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@__SETUP_BUN_SHA__ # __SETUP_BUN_TAG__
        with: { bun-version: 1.4.3 }
      - run: bun install --frozen-lockfile
      - name: Build every target
        env: { TAG: "${{ github.ref_name }}" }
        run: |
          set -euo pipefail
          v="${TAG#v}"
          mkdir -p dist
          for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-x64; do
            exe=__NAME__; [ "${t%%-*}" = windows ] && exe=__NAME__.exe
            bun build __ENTRY__ --compile --target="bun-$t" --outfile "dist/$t/$exe"
          done
          cd dist
          for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
            p="${t/x64/amd64}"
            tar -C "$t" -czf "__NAME___${v}_${p/-/_}.tar.gz" .
          done
          (cd windows-x64 && zip -qX "../__NAME___${v}_windows_amd64.zip" __NAME__.exe)
          sha256sum *.tar.gz *.zip > checksums.txt
      - uses: actions/attest-build-provenance@__ATTEST_SHA__ # __ATTEST_TAG__
        with:
          subject-path: |
            dist/*.tar.gz
            dist/*.zip
            dist/checksums.txt
      - name: Hand the draft to the tapster hub
        env: { GH_TOKEN: "${{ github.token }}", TAG: "${{ github.ref_name }}" }
        run: gh release create "$TAG" dist/*.tar.gz dist/*.zip dist/checksums.txt --draft --verify-tag --generate-notes --title "$TAG"
```

- [ ] **Step 4: Implement** `src/cli/add.ts`

```ts
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";
import { TapsterError } from "../errors";
import pinsJson from "../../templates/pins.json";
import { currentRepo, userGitHub } from "./gh";

type Pins = typeof pinsJson;

export function adaptGoreleaser(text: string): { text: string; notes: string[] } {
  const doc = parseDocument(text);
  const notes: string[] = [];
  doc.setIn(["release", "draft"], true);
  notes.push("release.draft: true; the tapster hub publishes after signing");
  doc.setIn(["checksum", "name_template"], "checksums.txt");
  notes.push("checksum.name_template: checksums.txt; the hub reads this name");
  for (const key of ["notarize", "homebrew_casks", "brews", "scoops"]) {
    if (doc.has(key)) {
      doc.delete(key);
      notes.push(`removed ${key}; the hub does this now`);
    }
  }
  return { text: doc.toString(), notes };
}

export function adaptReleaseWorkflow(text: string, attestSha: string, attestTag: string): { text: string; notes: string[] } {
  const doc = parseDocument(text);
  const notes: string[] = [];
  const jobs = doc.get("jobs");
  if (!isMap(jobs)) throw new TapsterError("the release workflow has no jobs", "Add the GoReleaser job first.");
  for (const job of jobs.items) {
    const steps = (job.value as YAMLMap).get("steps");
    if (!isSeq(steps)) continue;
    const index = steps.items.findIndex((s) => isMap(s) && String(s.get("uses") ?? "").startsWith("goreleaser/goreleaser-action"));
    if (index === -1) continue;
    const step = steps.items[index] as YAMLMap;
    const env = step.get("env");
    if (isMap(env)) {
      for (const item of [...env.items]) {
        const key = String((item.key as { value?: unknown }).value ?? item.key);
        if (/^(MACOS_|HOMEBREW_TAP_)/.test(key)) {
          env.delete(key);
          notes.push(`removed ${key} from the GoReleaser step`);
        }
      }
    }
    steps.items.splice(index + 1, 0, doc.createNode({ name: "Attest the archives for tapster", uses: `actions/attest-build-provenance@${attestSha}`, with: { "subject-path": "dist/*.tar.gz\ndist/*.zip\ndist/checksums.txt" } }) as never);
    (job.value as YAMLMap).set("permissions", doc.createNode({ contents: "write", "id-token": "write", attestations: "write" }));
    notes.push(`added the attestation step (actions/attest-build-provenance ${attestTag}) and its permissions`);
    return { text: doc.toString(), notes };
  }
  throw new TapsterError("no GoReleaser step found in the release workflow", "tapster add edits the job that runs goreleaser/goreleaser-action.");
}

const bunTemplate = await readFile(new URL("../../templates/project/bun-release.yml", import.meta.url), "utf8");

export function bunWorkflow(name: string, entry: string, pins: Pins): string {
  return bunTemplate
    .replaceAll("__CHECKOUT_SHA__", pins["actions/checkout"].sha)
    .replaceAll("__CHECKOUT_TAG__", pins["actions/checkout"].tag)
    .replaceAll("__SETUP_BUN_SHA__", pins["oven-sh/setup-bun"].sha)
    .replaceAll("__SETUP_BUN_TAG__", pins["oven-sh/setup-bun"].tag)
    .replaceAll("__ATTEST_SHA__", pins["actions/attest-build-provenance"].sha)
    .replaceAll("__ATTEST_TAG__", pins["actions/attest-build-provenance"].tag)
    .replaceAll("__NAME__", name)
    .replaceAll("__ENTRY__", entry);
}

const PLATFORM: Record<string, string> = {
  darwin_universal: "darwin-universal",
  darwin_all: "darwin-universal",
  darwin_arm64: "darwin-arm64",
  darwin_amd64: "darwin-amd64",
  linux_arm64: "linux-arm64",
  linux_amd64: "linux-amd64",
  windows_amd64: "windows-amd64",
  windows_arm64: "windows-arm64",
};

export function inferEntry(name: string, repo: string, assets: string[], version: string, kind: "go" | "bun"): string {
  const lines = [`  - name: ${name}`, `    repo: ${repo}`, ...(kind === "bun" ? ["    kind: bun"] : []), `    binaries: [${name}]`, "    assets:"];
  let windows = false;
  for (const a of assets) {
    const key = Object.keys(PLATFORM).find((k) => a.includes(k));
    if (!key) continue;
    lines.push(`      ${PLATFORM[key]}: "${a.replaceAll(version, "{version}")}"`);
    if (key.startsWith("windows")) windows = true;
  }
  if (windows) lines.push("    scoop: true");
  return lines.join("\n");
}

export async function add(_args: string[]): Promise<void> {
  const dir = process.cwd();
  const repo = await currentRepo(dir);
  const name = repo.split("/")[1]!.toLowerCase();
  const goreleaser = [".goreleaser.yaml", ".goreleaser.yml"].find((f) => existsSync(join(dir, f)));
  const isBun = existsSync(join(dir, "package.json")) && (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")));
  let kind: "go" | "bun";
  if (goreleaser && existsSync(join(dir, "go.mod"))) {
    kind = "go";
    const g = adaptGoreleaser(await readFile(join(dir, goreleaser), "utf8"));
    await writeFile(join(dir, goreleaser), g.text);
    const flowPath = join(dir, ".github/workflows/release.yml");
    if (!existsSync(flowPath)) throw new TapsterError("no .github/workflows/release.yml found", "tapster expects the release workflow at that path, or set workflow: in the hub entry.");
    const w = adaptReleaseWorkflow(await readFile(flowPath, "utf8"), pinsJson["actions/attest-build-provenance"].sha, pinsJson["actions/attest-build-provenance"].tag);
    await writeFile(flowPath, w.text);
    for (const n of [...g.notes, ...w.notes]) console.log(`- ${n}`);
  } else if (isBun) {
    kind = "bun";
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!entry) throw new TapsterError("package.json has no bin entry", "Add the CLI entry file to bin in package.json.");
    await writeFile(join(dir, ".github/workflows/release.yml"), bunWorkflow(name, entry.replace(/^\.\//, ""), pinsJson));
    console.log("- wrote .github/workflows/release.yml (build, attest, draft)");
  } else {
    throw new TapsterError("this project is neither GoReleaser-based Go nor Bun", "tapster add supports those two in phase 1.");
  }
  const gh = await userGitHub();
  const latest = await gh.json<{ tag_name: string; assets: { name: string }[] }>("GET", `/repos/${repo}/releases/latest`).catch(() => null);
  console.log("\nAdd this to the hub's tapster.yml under packages:\n");
  console.log(latest ? inferEntry(name, repo, latest.assets.map((a) => a.name), latest.tag_name.slice(1), kind) : `  - name: ${name}\n    repo: ${repo}\n    binaries: [${name}]\n    assets: {}   # fill after the first release`);
  console.log("\nReview the changes with git diff, commit them, then tag a release.");
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/add.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src templates tests && git commit -m "Prepare Go and Bun projects for the hub with tapster add"
```

---
### Task 21: Leak test

This task proves spec §12.3. GitHub masks an exact secret, so a log search for a secret always comes back clean. The
test therefore runs the pipeline twice:
- **Plain run:** fake credentials as plain values, so any print of them shows in the log.
- **Masked run:** throwaway credentials as real secrets. Any `***` outside a step header means something printed a
  secret.

**Files:**
- Create: `tests/leak/scan.ts`, `tests/leak/run-scan.ts`, `tests/leak/hub/tapster.yml`, `tests/leak/setup.sh`,
  `tests/leak/fixture/make.ts`, `.github/workflows/leak.yml`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `rawTarGz` (Task 11 helper); the action modes (Task 17).
- Produces:
  - `type Finding = { line: number; kind: string }`.
  - `encodings(canary: string): { kind: string; value: string }[]`, `bodyLines(log: string): { line: number; text: string }[]`.
  - `scanPlain(log: string, canaries: string[]): Finding[]` and `scanMasked(log: string): Finding[]`.

- [ ] **Step 1: Write the failing test**

`tests/scan.test.ts`:
```ts
import { expect, test } from "bun:test";
import { bodyLines, encodings, scanMasked, scanPlain } from "./leak/scan";

const canary = "CANARY-p12-password-7f3a9c2e1b";
const log = (...lines: string[]) => lines.map((l, i) => `2026-10-18T10:00:0${i}.0000000Z ${l}`).join("\n");

test("finds a canary in plain text, base64 at any offset, hex and fragments", () => {
  const b64 = (shift: number) => Buffer.concat([Buffer.alloc(shift, 65), Buffer.from(canary)]).toString("base64");
  for (const leaked of [canary, b64(0), b64(1), b64(2), Buffer.from(canary).toString("hex"), encodeURIComponent(canary), "x password-7f3a9c y"]) {
    expect(scanPlain(log("ok", leaked), [canary]).length).toBeGreaterThan(0);
  }
  expect(scanPlain(log("nothing here"), [canary])).toEqual([]);
});

test("step headers are not scanned", () => {
  const text = log("##[group]Run doguyilmaz/tapster@abc", "env:", `  MACOS_SIGN_PASSWORD: ${canary}`, "##[endgroup]", "tapster: done");
  expect(bodyLines(text).map((l) => l.text)).toEqual(["tapster: done"]);
  expect(scanPlain(text, [canary])).toEqual([]);
});

test("masked runs flag any *** outside headers", () => {
  expect(scanMasked(log("##[group]Run x", "  MACOS_SIGN_P12: ***", "##[endgroup]", "fine"))).toEqual([]);
  expect(scanMasked(log("aims: failed (token ***)"))).toEqual([{ line: 1, kind: "masked value printed" }]);
});

test("encodings are long enough to be meaningful", () => {
  for (const e of encodings(canary)) expect(e.value.length).toBeGreaterThanOrEqual(8);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/scan.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the scanner** (`tests/leak/scan.ts`)

```ts
export type Finding = { line: number; kind: string };

const stamp = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;

export function bodyLines(log: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let header = false;
  for (const [i, raw] of log.split(/\r?\n/).entries()) {
    const text = raw.replace(stamp, "");
    if (text.startsWith("##[group]Run ")) header = true;
    else if (header && text.startsWith("##[endgroup]")) header = false;
    else if (!header) out.push({ line: i + 1, text });
  }
  return out;
}

export function encodings(canary: string): { kind: string; value: string }[] {
  const b = Buffer.from(canary, "utf8");
  const out = [
    { kind: "plain", value: canary },
    { kind: "hex", value: b.toString("hex") },
    { kind: "HEX", value: b.toString("hex").toUpperCase() },
    { kind: "url", value: encodeURIComponent(canary) },
  ];
  for (let shift = 0; shift < 3; shift++) {
    out.push({ kind: `base64+${shift}`, value: Buffer.concat([Buffer.alloc(shift, 65), b]).toString("base64").slice(4, -4) });
  }
  return out.filter((e) => e.value.length >= 8);
}

export function scanPlain(log: string, canaries: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const { line, text } of bodyLines(log)) {
    for (const canary of canaries) {
      const hit = encodings(canary).find((e) => text.includes(e.value));
      if (hit) {
        findings.push({ line, kind: hit.kind });
        continue;
      }
      for (let i = 0; i + 10 <= canary.length; i++) {
        if (text.includes(canary.slice(i, i + 10))) {
          findings.push({ line, kind: "fragment" });
          break;
        }
      }
    }
  }
  return findings;
}

export function scanMasked(log: string): Finding[] {
  return bodyLines(log)
    .filter(({ text }) => text.includes("***"))
    .map(({ line }) => ({ line, kind: "masked value printed" }));
}
```

- [ ] **Step 4: Log fetcher** (`tests/leak/run-scan.ts`). It prints line numbers and kinds only, never the lines
  themselves.

```ts
import { scanMasked, scanPlain } from "./scan";

const repo = process.env.SCAN_REPO ?? process.env.GITHUB_REPOSITORY!;
const run = process.env.SCAN_RUN_ID ?? process.env.GITHUB_RUN_ID!;
const token = process.env.GH_TOKEN!;
const canaries = (process.env.PLAIN_CANARIES ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const api = (path: string, accept = "application/vnd.github+json") =>
  fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" } });

const jobs = ((await (await api(`/repos/${repo}/actions/runs/${run}/jobs?per_page=100`)).json()) as { jobs: { id: number; name: string }[] }).jobs;
let failures = 0;
for (const job of jobs) {
  const plain = job.name.startsWith("plain");
  const masked = job.name.startsWith("masked") || process.env.SCAN_ALL_MASKED === "1";
  if (!plain && !masked) continue;
  const res = await api(`/repos/${repo}/actions/jobs/${job.id}/logs`, "application/vnd.github.v3.raw");
  const log = await res.text();
  const findings = plain ? scanPlain(log, canaries) : scanMasked(log);
  for (const f of findings) console.log(`LEAK ${job.name} line ${f.line}: ${f.kind}`);
  console.log(`${job.name}: ${findings.length === 0 ? "clean" : `${findings.length} finding(s)`}`);
  failures += findings.length;
}
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 5: Fixture project and test App (one-time, needs the person)**

1. Create a private fixture project:
   ```bash
   gh repo create doguyilmaz/tapster-fixture --private --add-readme
   ```
2. **The person** creates a GitHub App named `tapster-ci-doguyilmaz` at https://github.com/settings/apps/new:
   - permissions Contents: Read & write, Metadata: Read, Attestations: Read;
   - no webhook;
   - installed only on `tapster-fixture`;
   - a private key generated.
3. Store the App's credentials in the tapster repo without printing them:
   ```bash
   gh variable set CI_APP_ID --repo doguyilmaz/tapster --body <app id>
   gh secret set CI_APP_PRIVATE_KEY --repo doguyilmaz/tapster < ~/Downloads/tapster-ci-doguyilmaz.*.private-key.pem
   ```
   Delete the `.pem` afterwards.
4. Write `tests/leak/fixture/make.ts`. It builds three drafts on the fixture:
   - `v0.0.1`: a valid darwin `tar.gz` with a Mach-O built by `clang`, plus `checksums.txt`;
   - `v0.0.2`: a malformed `checksums.txt`;
   - `v0.0.3`: an archive with a `../evil` entry, made with `rawTarGz`.

```ts
import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTarGz } from "../../../src/archive";
import { rawTarGz } from "../../helpers/rawtar";

const repo = "doguyilmaz/tapster-fixture";
const dir = mkdtempSync(join(tmpdir(), "fixture-"));
writeFileSync(join(dir, "main.c"), 'int main(void){return 0;}\n');
await $`clang -arch arm64 -o ${join(dir, "fixture")} ${join(dir, "main.c")}`;
const bin = Bun.file(join(dir, "fixture"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function draft(tag: string, archive: Buffer, sums: string) {
  const v = tag.slice(1);
  const a = join(dir, `fixture_${v}_darwin_arm64.tar.gz`);
  writeFileSync(a, archive);
  writeFileSync(join(dir, "checksums.txt"), sums.replaceAll("{a}", sha(archive)).replaceAll("{v}", v));
  await $`git -C ${dir} init -q`.quiet();
  await $`gh release create ${tag} ${a} ${join(dir, "checksums.txt")} --repo ${repo} --draft --title ${tag} --notes fixture`;
}

const good = writeTarGz([{ name: "fixture", type: "file", mode: 0o755, data: Buffer.from(await bin.arrayBuffer()) }], 1_700_000_000);
await draft("v0.0.1", good, "{a}  fixture_{v}_darwin_arm64.tar.gz\n");
await draft("v0.0.2", good, "not a checksum line\n");
await draft("v0.0.3", rawTarGz([{ name: "../evil", data: "x" }]), "{a}  fixture_{v}_darwin_arm64.tar.gz\n");
```
Run: `bun tests/leak/fixture/make.ts`
Expected: three drafts in `doguyilmaz/tapster-fixture`.

5. Throwaway credentials for the masked run (`tests/leak/setup.sh`). These are real secrets of the tapster repository,
   but are worthless outside the test.

```bash
#!/usr/bin/env bash
set -euo pipefail
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
pw=$(openssl rand -hex 16)
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/k.pem" -out "$d/c.pem" -days 3650 -subj "/CN=Developer ID Application: Canary (CANARY0001)/OU=CANARY0001" 2>/dev/null
/usr/bin/openssl pkcs12 -export -in "$d/c.pem" -inkey "$d/k.pem" -out "$d/c.p12" -passout "pass:$pw"
/usr/bin/openssl ecparam -name prime256v1 -genkey -noout | /usr/bin/openssl pkcs8 -topk8 -nocrypt > "$d/n.p8"
base64 -i "$d/c.p12" | gh secret set CI_CANARY_P12 --repo doguyilmaz/tapster
printf %s "$pw" | gh secret set CI_CANARY_P12_PASSWORD --repo doguyilmaz/tapster
base64 -i "$d/n.p8" | gh secret set CI_CANARY_NOTARY_KEY --repo doguyilmaz/tapster
printf %s "CANARYKEY1" | gh secret set CI_CANARY_NOTARY_KEY_ID --repo doguyilmaz/tapster
printf %s "00000000-0000-4000-8000-0000000c4a72" | gh secret set CI_CANARY_NOTARY_ISSUER_ID --repo doguyilmaz/tapster
echo "canary secrets set"
```
Run: `bash tests/leak/setup.sh`
Expected: `canary secrets set`.

- [ ] **Step 6: Hub config for the test** (`tests/leak/hub/tapster.yml`)

```yaml
version: 1
tap: doguyilmaz/tapster-test
packages:
  - name: fixture
    repo: doguyilmaz/tapster-fixture
    binaries: [fixture]
    assets:
      darwin-arm64: "fixture_{version}_darwin_arm64.tar.gz"
```

- [ ] **Step 7: The leak workflow** (`.github/workflows/leak.yml`).
  - The plain canaries below are fake and exist only in this file.
  - The sign step gets a manifest with one item, so the keychain and signing paths actually run (and fail, as
    designed, on the self-signed identity).
  - Pin `actions/checkout` and `oven-sh/setup-bun` to the SHAs in `templates/pins.json`.

```yaml
name: leak
on:
  push: { branches: [main] }
  pull_request:
permissions: {}
concurrency: { group: "leak-${{ github.ref }}", cancel-in-progress: true }
env:
  PLAIN_CANARIES: |
    CANARY-app-key-3f9a7c1e5b2d
    CANARY-p12-body-2e8c
    CANARY-p12-password-7f3a9c2e1b
    CANARY-notary-key-b81e44d0c9
    CANARY-key-id-55aa
    CANARY-issuer-0c4a72
    CANARY-github-token-91df3e
jobs:
  plain:
    runs-on: macos-15
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<checkout sha> # v5
        with: { persist-credentials: false }
      - name: one fake work item for sign
        run: |
          mkdir -p "$RUNNER_TEMP/tapster/fixture/v0.0.1/bin/a"
          printf 'int main(void){return 0;}\n' > /tmp/m.c && clang -o "$RUNNER_TEMP/tapster/fixture/v0.0.1/bin/a/fixture" /tmp/m.c
          printf '%s' '{"items":[{"package":"fixture","tag":"v0.0.1","releaseId":1,"resume":false,"before":[],"checksums":[],"archives":[{"asset":"a","platform":"darwin-arm64","dir":"'"$RUNNER_TEMP"'/tapster/fixture/v0.0.1/bin/a","binaries":["fixture"]}],"status":"fetched"}]}' > "$RUNNER_TEMP/tapster/manifest.json"
      - name: check (fake App key)
        continue-on-error: true
        uses: ./
        with: { mode: check, config: tests/leak/hub/tapster.yml }
        env: { TAPSTER_APP_ID: "1", TAPSTER_APP_PRIVATE_KEY: "CANARY-app-key-3f9a7c1e5b2d" }
      - name: sign (fake certificate and key)
        continue-on-error: true
        uses: ./
        with: { mode: sign, config: tests/leak/hub/tapster.yml }
        env:
          TAPSTER_TEAM_ID: CANARY0001
          MACOS_SIGN_P12: Q0FOQVJZLXAxMi1ib2R5LTJlOGM=
          MACOS_SIGN_PASSWORD: CANARY-p12-password-7f3a9c2e1b
          MACOS_NOTARY_KEY: CANARY-notary-key-b81e44d0c9
          MACOS_NOTARY_KEY_ID: CANARY-key-id-55aa
          MACOS_NOTARY_ISSUER_ID: CANARY-issuer-0c4a72
      - name: render (fake token)
        continue-on-error: true
        uses: ./
        with: { mode: render, config: tests/leak/hub/tapster.yml }
        env: { GITHUB_TOKEN: CANARY-github-token-91df3e }
      - if: always()
        uses: ./
        with: { mode: cleanup }
  masked:
    runs-on: macos-15
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<checkout sha> # v5
        with: { persist-credentials: false }
      - id: check
        continue-on-error: true
        uses: ./
        with: { mode: check, config: tests/leak/hub/tapster.yml }
        env: { TAPSTER_APP_ID: "${{ vars.CI_APP_ID }}", TAPSTER_APP_PRIVATE_KEY: "${{ secrets.CI_APP_PRIVATE_KEY }}" }
      - name: fetch the fixture drafts (one good, one malformed, one malicious)
        continue-on-error: true
        uses: ./
        with: { mode: fetch, config: tests/leak/hub/tapster.yml, work: "${{ steps.check.outputs.work }}" }
        env: { TAPSTER_APP_ID: "${{ vars.CI_APP_ID }}", TAPSTER_APP_PRIVATE_KEY: "${{ secrets.CI_APP_PRIVATE_KEY }}" }
      - name: sign (self-signed certificate, fails on purpose)
        continue-on-error: true
        uses: ./
        with: { mode: sign, config: tests/leak/hub/tapster.yml }
        env:
          TAPSTER_TEAM_ID: CANARY0001
          MACOS_SIGN_P12: ${{ secrets.CI_CANARY_P12 }}
          MACOS_SIGN_PASSWORD: ${{ secrets.CI_CANARY_P12_PASSWORD }}
          MACOS_NOTARY_KEY: ${{ secrets.CI_CANARY_NOTARY_KEY }}
          MACOS_NOTARY_KEY_ID: ${{ secrets.CI_CANARY_NOTARY_KEY_ID }}
          MACOS_NOTARY_ISSUER_ID: ${{ secrets.CI_CANARY_NOTARY_ISSUER_ID }}
      - if: always()
        uses: ./
        with: { mode: cleanup }
  scan:
    needs: [plain, masked]
    if: always()
    runs-on: ubuntu-24.04
    permissions: { actions: read, contents: read }
    steps:
      - uses: actions/checkout@<checkout sha> # v5
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@<setup-bun sha> # v2
        with: { bun-version: 1.4.3 }
      - run: bun tests/leak/run-scan.ts
        env: { GH_TOKEN: "${{ github.token }}" }
```

The `fetch` step on the fixture finds `v0.0.1` ready and `v0.0.2` invalid. For `v0.0.3`, the check marks it ready (the
checksums match), and fetch rejects the archive. The masked run therefore covers the readiness, attestation (skipped,
private), checksum and archive failure paths with a real token in play.

`readSecret` registers each value with the runner, which then masks it exactly. The plain run therefore catches what
masking cannot:
- values printed before they are read;
- derived values tapster forgot to register;
- fragments and encodings of a value.

The masked run catches exact prints.

- [ ] **Step 8: Run locally, then in CI**

Run: `bun test tests/scan.test.ts`
Expected: PASS.

Then push the branch and open a pull request. Expected: in the `leak` workflow, `plain` and `masked` show failed
steps (by design, with `continue-on-error`), and `scan` passes, printing `clean` for both jobs.

- [ ] **Step 9: Prove the test can fail.** On a scratch branch, add `info(process.env.MACOS_SIGN_PASSWORD ?? "")` as
  the first line of `signMode` before `readSecret` is called. Push it. Expected: `scan` fails with
  `LEAK plain line N: plain`, and with `LEAK masked line N: masked value printed`. Delete the branch.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "Prove on every change that tapster prints no credential"
```

---

### Task 22: End to end, then make tapster public

**Files:**
- Create: `docs/e2e.md` (what was run and observed)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Let private repositories use the private action**

```bash
gh api -X PUT repos/doguyilmaz/tapster/actions/permissions/access -f access_level=user
git tag -a v0.1.0 -m "tapster 0.1.0" && git push origin v0.1.0
gh release create v0.1.0 --repo doguyilmaz/tapster --title v0.1.0 --notes "First test release"
```

- [ ] **Step 2: Test hub.** Create it and run `init` from the local checkout. The person clicks "Create GitHub App",
  installs it on the two fixture projects from Step 3, and enters the real credentials.

```bash
gh repo create doguyilmaz/homebrew-tapster-test --private --clone ~/Developer/FORK/homebrew-tapster-test
cd ~/Developer/FORK/homebrew-tapster-test && bun ~/Developer/FORK/tapster/src/cli/main.ts init
git add -A && git commit -m "Set up the tapster test hub" && git push
bun ~/Developer/FORK/tapster/src/cli/main.ts doctor
```
Expected: `doctor` reports `fix` only for "is public" on the fixture repositories, which is expected while they are
private.

- [ ] **Step 3: Fixture projects.**
  - **Go:** `doguyilmaz/tapster-e2e-go` has `main.go` printing its version, a `.goreleaser.yaml` building
    darwin/linux/windows, and the standard release workflow.
  - **Bun:** `doguyilmaz/tapster-e2e-bun` has `src/cli.ts` with a `bin` entry.

  In each clone run `bun ~/Developer/FORK/tapster/src/cli/main.ts add`, commit, push and tag `v0.0.1`. Paste the
  printed entries into the test hub's `tapster.yml` and push.

- [ ] **Step 4: Run the hub and verify.**

```bash
gh workflow run tapster.yml --repo doguyilmaz/homebrew-tapster-test
gh run watch --repo doguyilmaz/homebrew-tapster-test --exit-status
for r in tapster-e2e-go tapster-e2e-bun; do
  d=$(mktemp -d) && gh release download v0.0.1 --repo doguyilmaz/$r -p '*darwin_arm64.tar.gz' -D "$d"
  tar -xzf "$d"/*.tar.gz -C "$d"
  codesign -vvvv -R="notarized" --check-notarization "$d"/tapster-e2e-* && spctl -a -vvv -t install "$d"/tapster-e2e-*
done
gh api repos/doguyilmaz/homebrew-tapster-test/contents/Casks --jq '.[].name'
```
Expected:
- both releases are published;
- `explicit requirement satisfied` and `source=Notarized Developer ID` for both binaries;
- `Casks/` lists both casks, and `bucket/` holds the Go one.

- [ ] **Step 5: Scan the real run's logs.**

```bash
SCAN_REPO=doguyilmaz/homebrew-tapster-test SCAN_RUN_ID=<run id> SCAN_ALL_MASKED=1 GH_TOKEN=$(gh auth token) bun tests/leak/run-scan.ts
```
Expected: every job `clean`.

- [ ] **Step 6: Failure paths with real credentials.**
  - Set `MACOS_NOTARY_KEY_ID` in the test hub to a wrong value, tag `v0.0.2` on the Go fixture and run the hub.
    Expected: the item fails with "notarization …" or a 401 reason, the `v0.0.2` draft is untouched, and Step 5's scan
    is clean.
  - Restore the value with `init --rotate notary` and run again. Expected: `v0.0.2` publishes.

- [ ] **Step 7: Resume.** Interrupt a run while it publishes:
  1. tag `v0.0.3`;
  2. dispatch;
  3. cancel the run (`gh run cancel`) once `tapster-staging--` assets appear on the draft;
  4. dispatch again.

  Expected: the second run resumes, publishes, and leaves no staging assets.

- [ ] **Step 8: Record and publish.**
  1. Write `docs/e2e.md` with each step's command, observed output (no secrets) and run links.
  2. Rewrite `README.md` for users: what tapster does, a link to the spec's diagram, `init`, `add`, `doctor`, the
     security model in plain words, and the limits (signing needs macOS runners; casks cannot point at private
     projects).
  3. Make the repository public:
     ```bash
     gh repo edit doguyilmaz/tapster --visibility public --accept-visibility-change-consequences
     git add -A && git commit -m "Record the end-to-end run and write the README" && git push
     git tag -a v1.0.0 -m "tapster 1.0.0" && git push origin v1.0.0
     gh release create v1.0.0 --repo doguyilmaz/tapster --title v1.0.0 --generate-notes
     git tag -f v1 v1.0.0 && git push -f origin v1
     ```
  4. The person publishes the CLI to npm, with their own npm login and from their own terminal:
     `npm publish --access public`.
  5. Delete the test hub's App and the two e2e repositories once nothing refers to them.

---

### Task 23: Migrate the projects

**Files:**
- Modify (in other repositories): the hub `doguyilmaz/homebrew-tap`, `aims`, `konvoy`, `dothaven`, and later `ebb`
  and `lockstep`

**Interfaces:**
- Consumes: tapster v1 as published in Task 22.

- [ ] **Step 1: Set up the real hub.** In a clone of `doguyilmaz/homebrew-tap`:
  1. Run `bunx @doguyilmaz/tapster init`.
  2. The person creates the App and installs it on aims, konvoy and dothaven.
  3. Enter the credentials once.
  4. Commit and push the new files (`init` leaves the existing `README.md` alone; the old README stays).
  5. Run `bunx @doguyilmaz/tapster doctor`.

  Expected: only the "holds no release secrets" checks fail, because the projects still have their old secrets.

- [ ] **Step 2: aims** (Go, Scoop).
  1. In a clone, run `bunx @doguyilmaz/tapster add`.
  2. Review `git diff`: `notarize`, `homebrew_casks` and `scoops` are gone, `release.draft: true` is set, the
     attestation step is added, and the secrets are removed from the workflow.
  3. Keep the npm publish job as it is. It runs after GoReleaser and publishes the platform binaries. Point it at the
     release only after the hub publishes, by moving it to a workflow triggered `on: release: types: [published]`
     that downloads the signed archives with `gh release download`.
  4. Commit and push.
  5. Paste the printed entry into the hub's `tapster.yml`, and add the existing `completions` and `description`.
  6. Release `v0.1.6`.

  Expected:
  - the hub run publishes it;
  - `Casks/aims.rb` and `bucket/aims.json` are rendered by tapster;
  - `codesign -R=notarized --check-notarization` passes on the downloaded binary.

  Before installing the cask on this Mac with `brew install doguyilmaz/tap/aims`, ask the person.

- [ ] **Step 3: konvoy** (Bun).
  1. `tapster add` writes a fresh `release.yml`. konvoy's current workflow also builds the docs site and verifies
     itself.
  2. Merge by hand: keep konvoy's verify and pages jobs, and replace only its build, sign and tap jobs with the
     template's single build job.
  3. The asset names change (versioned names). Paste the printed hub entry.
  4. Release `v0.5.1` and verify as in Step 2.

- [ ] **Step 4: dothaven** (Go). As Step 2, without Scoop. Release a patch and verify.

- [ ] **Step 5: Remove the old secrets** from each migrated project:

```bash
for r in aims konvoy dothaven; do
  for s in MACOS_SIGN_P12 MACOS_SIGN_PASSWORD MACOS_NOTARY_KEY MACOS_NOTARY_KEY_ID MACOS_NOTARY_ISSUER_ID HOMEBREW_TAP_TOKEN HOMEBREW_TAP_GITHUB_TOKEN; do
    gh secret delete "$s" --repo doguyilmaz/$r 2>/dev/null || true
  done
done
bunx @doguyilmaz/tapster doctor
```
Expected: `doctor` all `ok` for these three.

- [ ] **Step 6: ebb and lockstep, once the person has made them public.**
  1. Run Step 2 for each.
  2. Their casks already exist from GoReleaser, and tapster takes them over from the first release it publishes.
  3. Then delete their old secrets as in Step 5.

- [ ] **Step 7: Record.** Commit the hub changes. In the tapster repo, note the migration result in `docs/e2e.md`.
