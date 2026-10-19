---
title: Add a project
section: Tutorial
order: 4
step: 4
description: Run tapster add in a project to prepare its release workflow, protect it and propose it to the hub.
---

Go to a clone of the project you want to publish and run `add`:

```sh
cd my-tool
bunx @doguyilmaz/tapster add
```

The first time, tapster asks which hub publishes the project and remembers the answer in the clone:

> [!SEE]
> `Which hub publishes this project (owner/repo)?` Type `you/homebrew-tap` and press Enter.

tapster recognizes three kinds of projects. Each line it prints starts with `-` and says what it did.

## 1. The release workflow

- **Go with GoReleaser** (a `.goreleaser.yaml` next to `go.mod`): tapster turns on draft releases, names the checksum
  file `checksums.txt` and removes `notarize`, `homebrew_casks`, `brews` and `scoops`, because the hub does those now.
  In the workflow that runs GoReleaser (`release.yml` or the file you name with `--workflow`), it adds a step that
  attests the archives. See [Move a GoReleaser project](/guides/goreleaser).
- **Bun** (a `package.json` with `bin` and a `bun.lock`): tapster writes `.github/workflows/release.yml`. It builds every
  platform in a job that can only read the repository. A second job attests the archives and opens the draft. See
  [Bun projects](/guides/bun).
- **A Mac app with Sparkle**: see [Mac apps with Sparkle](/guides/sparkle), which has its own order of steps.

Every release workflow also gets a step named **Ring the tapster hub**. It does nothing until you add the
[doorbell](/guides/doorbell).

## 2. The project is protected

> [!SEE]
> `- protected you/my-tool: only you can create, move or delete branches and tags; workflows and Apps, the hub's
> included, cannot. Push release tags yourself; GitHub then notes "Bypassed rule violations", which is your admin
> right at work.`

This is what makes a stolen App key useless: it cannot tag code for your hub to sign. Two kinds of projects need an
option here:

- A workflow that pushes its own release tags needs `--auto-tag`. See [Releases tagged by a workflow](/guides/auto-tag).
- Dependabot opens its pull requests from branches, which the rules now close. See [Dependabot](/guides/dependabot).

## 3. The hub entry

tapster writes the project's entry for the hub's `tapster.yml` and opens a pull request on the hub with it:

> [!SEE]
> `- proposed the hub entry in https://github.com/you/homebrew-tap/pull/1; merge it to start publishing`

If the repository's GitHub description is one that Homebrew would reject, tapster says so and suggests a better one in
the entry. Homebrew wants a short description that starts with a capital letter and has no full stop at the end.

> [!NOTE]
> A project whose archives tapster cannot predict yet, for example GoReleaser with its own name template, gets no
> entry until its first draft exists. Run `tapster add` again after that.

## 4. The App's install link

> [!SEE]
> `- open this page and choose Install, unless the hub's App already reaches you/my-tool; the project is preselected
> (keep "Only select repositories"):` followed by a link.

If you picked this project when you created the hub, skip it. Otherwise open the link and click **Install**.

## Your turn

tapster commits nothing. When it ends with
`Review the changes with git diff, commit and push them, then push a tag to release.`, do this:

- [ ] Merge the pull request on your hub.
- [ ] Open the install link if tapster printed one for a project the App does not reach yet.
- [ ] Review the changes in the project, then commit and push them:

  ```sh
  git diff
  git add -A
  git commit -m "Release through tapster"
  git push
  ```

> [!KEYS]
> The project holds no keys. If it still has old release secrets such as `MACOS_*` or `HOMEBREW_TAP_*`, tapster lists
> them. Delete them once the hub has published a release.
