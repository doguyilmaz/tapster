---
title: Create the hub
section: Tutorial
order: 3
step: 3
description: Run tapster init in your tap to protect it, create its GitHub App and store your keys.
---

Go to a clone of your tap and run `init`:

```sh
cd homebrew-tap
bunx @doguyilmaz/tapster init
```

`init` walks through five parts. Each part can run again and skips what is done, so if anything stops it, run the same
command again.

## 1. macOS or not

> [!SEE]
> `Will this hub sign software for macOS (Mac apps or CLI tools with macOS builds)? [Y/n]`

Press Enter for yes. Answer `n` if you skipped the Apple step. tapster then leaves out the Apple parts below.

## 2. The hub is protected

tapster creates a `tapster` environment in the hub that only the `main` branch can open. It adds a ruleset that keeps
`main` from being deleted or force-pushed. Your keys go into that environment. Nothing to answer here.

## 3. The App is created

The hub needs a GitHub App to write releases to your projects. tapster opens a page in your browser that shows the App
and the permissions it asks for.

1. Read the page and click **Continue to GitHub**.
2. GitHub shows the same App. Click **Create GitHub App**.
3. GitHub sends you back to a page that says **Your tapster App is created**. Close it.

> [!KEYS]
> GitHub hands the App's private key to tapster in your terminal. tapster stores it as a secret of the hub's `tapster`
> environment. It goes nowhere else.

tapster then opens the App's install page:

1. Choose **Only select repositories**.
2. Pick the project you will add in the next step. You can add more projects later.
3. Never pick the hub itself. The App can write to every repository it is installed on. The hub holds your keys.
4. Click **Install**.

> [!WAIT]
> `Waiting until the App is installed; tapster continues by itself once you choose Install.`
>
> tapster checks every few seconds for up to 10 minutes. If you close the page without installing, it says so and moves
> on. `tapster add` links to the install page for each project too.

## 4. Your Apple credentials

Drag each file from Finder into the terminal when tapster asks for it, then press Enter.

> [!SEE]
> `.p12 file (drag it here):` then `.p12 password:`
>
> `Certificate stored for team ABCDE12345. It expires on 2031-02-01; the hub warns 30 days before.`

tapster opens the `.p12` with your password to check that it is a Developer ID Application certificate that has not
expired. The password is not shown while you type.

> [!SEE]
> `.p8 file (drag it here):`, `Key ID:` and `Issuer ID:`
>
> `Apple accepted the key.` and `Notarization key stored.`

On a Mac, tapster asks Apple whether the key works before it stores it. Elsewhere Apple checks it at the first release.

> [!KEYS]
> The certificate, its password and the notarization key become secrets of the hub's `tapster` environment. Only
> workflows on `main` can read them. Keep your backups: GitHub never shows a secret again.

## 5. The files are written

> [!SEE]
> ```
> wrote tapster.yml
> wrote .tapster/state.json
> wrote README.md
> wrote .github/workflows/tapster.yml from the template, tapster v1.0.0 (61cd09d); hand edits in it are replaced
> The hub looks for new drafts every 10 minutes; change it with tapster init --workflow --every <minutes>.
>
> Done. Review and commit the new files, push, then run tapster add in each project.
> ```

tapster keeps files that already exist, such as your own README. The workflow pins the exact tapster you ran by its
commit.

Commit and push them:

```sh
git add -A
git commit -m "Set up tapster"
git push
```

The hub is ready. It has no projects yet, so its runs find nothing to do.
