---
title: "Releases tagged by a workflow"
description: "Let a project's own workflow push release tags while its tags stay protected."
sidebar:
  order: 6
---

[Adding a project protects it](/tutorial/project/#1-choose-the-options) so that only you can create or
move its tags. That also stops a workflow that tags releases by itself, for example one that picks the next version
after each merge to `main`.

`--auto-tag` gives such a project one key that may push tags. Only its default branch can use it.

## Set it up

In a clone of the project:

```sh
bunx @doguyilmaz/tapster add --auto-tag
```

tapster then:

1. creates a `release` environment in the project that only the default branch may use;
2. makes an SSH key, stores its private half as the `TAPSTER_TAG_KEY` secret of that environment and adds the public
   half as a deploy key named `tapster tags`;
3. lets deploy keys pass the project's rules for tags and branches.

:::note[Where your keys go]{icon="padlock"}
The tag key lives only in the project's `release` environment. tapster makes it in a temporary folder and deletes the
folder right after. A workflow on another branch cannot read it.
:::

:::note
Environments need a public project or GitHub Pro. If the project already has other deploy keys with write access,
tapster names them: they can now tag and push to any branch too. Remove the ones you do not need.
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
again.

Running `tapster add` again later keeps this. You do not have to pass `--auto-tag` each time.
