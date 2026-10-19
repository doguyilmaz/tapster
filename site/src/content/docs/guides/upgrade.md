---
title: "Upgrade tapster"
description: "Move your hub to a newer tapster release."
sidebar:
  order: 9
---

Your hub's workflow pins the exact tapster commit that wrote it. A new tapster release changes nothing in your hub until
you move it there yourself. To hear about new releases, open
[tapster on GitHub](https://github.com/doguyilmaz/tapster) and choose **Watch**, **Custom**, **Releases**.

## Move the hub

In a clone of your hub:

```sh
git pull
bunx @doguyilmaz/tapster@<version> init --workflow
git diff
```

`init --workflow` rewrites `.github/workflows/tapster.yml` for that version and pins it by commit. Read the diff, then
commit and push it:

```sh
git commit -am "Move the hub to tapster <version>"
git push
```

:::note
Add `--every <minutes>` to change how often the hub looks for drafts in the same step.
:::

## If the hub has a doorbell

The doorbell runs its own copy of tapster's Worker. Move it to the same version and schedule:

```sh
bunx @doguyilmaz/tapster@<version> init --rotate doorbell
```

## Check it

```sh
bunx @doguyilmaz/tapster@<version> doctor
```

:::tip[You should see]{icon="approve-check-circle"}
Every check reports `ok`.
:::

## Coming from a version before 1.0

Since 1.0 the hub refuses a project until its branches and tags are protected. Run `tapster add` once in a clone of each
project. It only adds what is missing and keeps what an earlier `--auto-tag` or `--allow-dependabot` opened.
