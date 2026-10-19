---
title: Dependabot
section: Guides
order: 7
description: Keep Dependabot's pull requests in a project the hub protects.
---

Dependabot opens each pull request from a branch named `dependabot/...`. The rules `tapster add` sets let only you
create branches. GitHub does not let personal repositories exempt Dependabot from them. So after `tapster add`,
Dependabot cannot open pull requests in that project. `tapster add` warns you when the project has a
`.github/dependabot.yml`.

## Keep Dependabot

```sh
bunx @doguyilmaz/tapster add --allow-dependabot
```

The rules then leave branches named `dependabot/...` open. The hub entry gets `protection: dependabot`, so the hub
accepts that opening only where you wrote it down.

> [!WARN]
> Those branches are open to anything with write access to the project, the hub's App included. Someone with a stolen
> App key could push code to such a branch and run the project's workflows on it. Tags and every other branch stay
> protected, so they still cannot have the hub sign anything. Use this only where you want Dependabot.
