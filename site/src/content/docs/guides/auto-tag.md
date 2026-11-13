---
title: "Automatic releases and workflow tags"
description: "Pick versions and release automatically, with the tag key restricted to the project's default branch."
sidebar:
  order: 6
---

[Adding a project protects it](/tutorial/project/#1-choose-the-options) so that only you can create or
move its tags. That also stops a workflow that tags releases by itself, for example one that picks the next version
after each merge to `main`.

`--auto` writes the version analysis and tagging workflow too. `--auto-tag` gives an existing tagging workflow a key
without choosing versions for it. Both keep the key in an environment restricted to the default branch.

## Automatic releases

In a project clone, run:

```sh
bunx @doguyilmaz/tapster add --auto
```

Review, commit and push the generated files. Merge the project's hub entry and install the hub's App as usual.
The new `.github/workflows/tapster-auto.yml` checks the default branch daily at **03:23 UTC**, even when tapster is
closed. GitHub may delay scheduled runs. You can also run **tapster auto** from GitHub Actions to check sooner.

For a release after each push instead, use `tapster add --auto push`. The setup page offers the same choices under
Projects → **Release settings** beside the project’s badges → **Release mode**. A local clone is required; add its folder in Projects if the button is disabled. Choosing automatic mode authorizes releases from the default branch
without a separate approval for each version. Existing environment approval requirements are kept and still apply.

The build workflow stays separate and starts from a version tag. Auto mode requires it to explicitly accept `v*`
or `v[0-9]+.[0-9]+.[0-9]+` tags and refuses additional branch or path filters on that push trigger.

### How the version is chosen

The analysis reads all commits since the highest version tag. It uses the same rules as the manual Release button's
version suggestion, with additional checks before it may tag automatically:

| Change | Automatic result |
| --- | --- |
| `fix:`, `perf:` or ordinary code commits | Patch, such as `v1.2.3` to `v1.2.4` |
| `feat:` or `feat(cli):` | Minor, such as `v1.2.3` to `v1.3.0` |
| `feat!:` or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer before `v1.0.0` | Minor |
| Breaking change at `v1.0.0` or later | Stops until an explicit major decision |
| `Release: minor` or `Release: major` trailer | At least that bump; it cannot hide a larger breaking change |
| Only known documentation or automation paths or fully reverted changes | No release |

A trailer is a line in the last paragraph of a commit message, separated from the subject by a blank line:

```text
Remove the legacy configuration format

Release: major
```

`Release: patch` can deliberately release a build-workflow fix that would otherwise be skipped. Invalid trailer
values stop the run. Normal merge commits also contribute the PR title when it uses Conventional Commits.
The largest required bump wins across all accumulated commits. Explicit major means the next major even for a
`v0.x.y` project. A project with no version tags starts at `v0.1.0` or `v1.0.0` with `Release: major`.

The skipped paths are `docs/`, `doc/`, `.github/`, `.agents/` and `.claude/`, plus root README, CHANGELOG,
CONTRIBUTING, CODE_OF_CONDUCT and LICENSE files. Unknown paths, dependencies, build files and assets count as code.
Documentation commits do not raise the bump for an unrelated code fix. A docs commit at the tip still includes code
changes waiting below it in the next release.

This is deterministic commit analysis. It does not infer whether arbitrary code changes break an API. Use `feat!:`
or a breaking-change footer when they do. Unclassified code changes use patch; no AI service or extra API key is used.

### When automation waits

Auto mode creates no new tag while a version draft waits for the hub. It stops if the highest version tag is a
prerelease, is outside the default branch's history or requires analyzing more than 1000 commits. Make a stable
manual release first in those cases. A tip with a GitHub skip-ci marker is also left untagged.

The analysis job has a read token and no tag key. A separate job in the `release` environment checks the current
branch tip and every tag again before pushing one tag, without force. If anything changed after analysis, the run
leaves it for the next check. Neither job installs dependencies or runs project code. The analysis code is embedded
in the generated workflow so project scripts never receive the tag key. Re-run `add --auto` to update that code.

To return to manual releases:

```sh
bunx @doguyilmaz/tapster add --auto off
```

Commit and push the disabled workflow. The manual Release button becomes available once GitHub has that change.
The existing deploy key and rulesets are kept; remove the deploy key in GitHub settings if nothing else needs it.
Running `tapster add` without an auto option keeps an existing automatic workflow as it is.

### Reading the project list

The list and the project details show **Auto · daily**, **Auto · push**, **Workflow tags** for custom tagging workflows
or **Manual**. A dot beside the repository name marks changes to review. **New commits** means the default branch
has commits after its highest version tag; documentation-only commits may still be skipped by automation.
**Config update**, **Config PR** and **Review config** describe changes needed in the hub entry.

These indicators stay separate from the release stage. A draft can be waiting for the hub while newer commits are
already visible in the list. A previous published release no longer hides those commits. A new tag with no release
yet shows **Tagged v1.2.3; awaiting draft** rather than saying there is nothing new.

## Set it up

If your own workflow already chooses versions, use `--auto-tag` instead:

In a clone of the project:

```sh
bunx @doguyilmaz/tapster add --auto-tag
```

tapster then:

1. creates a `release` environment in the project that only the default branch may use;
2. makes an SSH key, stores its private half as the `TAPSTER_TAG_KEY` secret of that environment and adds the public
   half as a deploy key named `tapster tags`;
3. lets deploy keys pass the project's tag rules. Branches remain restricted to the owner.

:::note[Where your keys go]{icon="padlock"}
The tag key lives only in the project's `release` environment. tapster makes it in a temporary folder and deletes the
folder right after. A workflow on another branch cannot read it.
:::

:::note
Environments need a public project or GitHub Pro. If the project already has other deploy keys with write access,
tapster names them: they can now push tags too. Remove the ones you do not need.
:::

## Push tags with the key

tapster prints the steps for your workflow, with the checkout action pinned by commit. Put them in the job that decides
the version:

```yaml
    environment: release
    steps:
      - uses: actions/checkout@<commit> # <version>
        with: { ssh-key: "${{ secrets.TAPSTER_TAG_KEY }}" }
      # ... compute VERSION ...
      - name: Push the release tag
        run: git tag "v$VERSION" && git push origin "v$VERSION"
```

A tag pushed with this key starts the project's release workflow, which a tag pushed with the workflow's own
`GITHUB_TOKEN` would not. From there the release goes through the hub as usual.

To replace the key, delete the deploy key `tapster tags` in the project's settings and run `tapster add --auto-tag`
again. Every setup checks that only the default branch can use the environment, even when the key already exists.
Extra branch or tag deployment policies are refused. Existing reviewer requirements are preserved.

Running `tapster add` again later keeps this. You do not have to pass `--auto-tag` each time.
