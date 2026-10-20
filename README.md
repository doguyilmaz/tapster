<p><img src="https://raw.githubusercontent.com/doguyilmaz/tapster/main/site/public/logo-512.png" width="112" alt="The tapster octopus, a courier carrying sealed parcels"></p>

# tapster

tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your
projects. Each project builds its files and opens a draft release. It holds no signing certificate, no notary key and
no tap token.

**Tutorial and docs: [tapster.doguyilmaz.com](https://tapster.doguyilmaz.com/)**

## Set it up in your browser

You need [Bun](https://bun.sh) and the GitHub CLI, signed in with `gh auth login`. Signing for macOS also needs an Apple
Developer account.

```sh
bunx @doguyilmaz/tapster setup
```

A page opens in your browser, served by your own computer. It walks you through every step and shows what each one
changes on GitHub:

1. **Choose or create your tap.** It becomes your hub.
2. **Protect it, create its GitHub App and store your Apple files.** Drop the `.p12` and `.p8`; your password manager
   can keep the `.p12` password.
3. **Write the hub files.** tapster commits them to your tap through GitHub; you need no clone of it.
4. **Add your projects.** tapster finds the projects cloned on your computer, prepares their release workflows, protects
   them and proposes them to the hub.

Then push a tag in a project. The [tutorial](https://tapster.doguyilmaz.com/tutorial/before/) shows every step.

Prefer a terminal? Run `bunx @doguyilmaz/tapster init` in a clone of your tap and `bunx @doguyilmaz/tapster add` in
each project. See [Set up from a terminal](https://tapster.doguyilmaz.com/guides/terminal/).

## How it works

```
project (push tag v1.2.3)              hub: you/homebrew-tap
  builds, attests, holds no keys       runs tapster on a schedule or when rung
  -> draft release + checksums.txt  -> checks every file against the project's build
                                       signs and notarizes the macOS code
                                       publishes the release
                                       writes the cask, the Scoop manifest and the apt and dnf repositories
```

It publishes Go tools built with GoReleaser, command line tools written for Bun and Mac apps that update with Sparkle.
Users install them with Homebrew, Scoop, apt or dnf. When something needs you, such as a certificate that expires
soon, the hub opens an issue and closes it once all is well.

## Your keys stay in your accounts

tapster has no server. Your Apple certificate, notary key and App key are secrets of your hub's `tapster` environment,
which only its `main` branch can open. Projects hold no signing keys. No one else, including tapster's author, ever
receives them. tapster's own code uses them only inside your hub's runs, at the commit your hub workflow pins. Read the
[security model](https://tapster.doguyilmaz.com/reference/security/).

## The Action

You do not write the hub workflow yourself: the setup writes it and pins this Action by commit. If you added the Action
from the Marketplace first, run it once. With no `mode` it runs a guide: its run summary checks your repository and
shows the next step.

```yaml
on: workflow_dispatch
jobs:
  guide:
    runs-on: ubuntu-24.04
    steps:
      - uses: doguyilmaz/tapster@v1.1.0
```

To move a hub to a newer release, see [Upgrade tapster](https://tapster.doguyilmaz.com/guides/upgrade/).

## Docs

- [Tutorial](https://tapster.doguyilmaz.com/tutorial/before/): from an empty tap to an installed release
- Guides: [Set up from a terminal](https://tapster.doguyilmaz.com/guides/terminal/),
  [GoReleaser](https://tapster.doguyilmaz.com/guides/goreleaser/),
  [Bun](https://tapster.doguyilmaz.com/guides/bun/),
  [Mac apps with Sparkle](https://tapster.doguyilmaz.com/guides/sparkle/),
  [apt and dnf](https://tapster.doguyilmaz.com/guides/linux/),
  [the doorbell](https://tapster.doguyilmaz.com/guides/doorbell/),
  [workflow tags](https://tapster.doguyilmaz.com/guides/auto-tag/),
  [Dependabot](https://tapster.doguyilmaz.com/guides/dependabot/),
  [key rotation](https://tapster.doguyilmaz.com/guides/rotate/),
  [upgrades](https://tapster.doguyilmaz.com/guides/upgrade/)
- Reference: [Commands](https://tapster.doguyilmaz.com/reference/commands/),
  [tapster.yml](https://tapster.doguyilmaz.com/reference/config/),
  [Security](https://tapster.doguyilmaz.com/reference/security/),
  [Troubleshooting](https://tapster.doguyilmaz.com/reference/troubleshooting/)

The design documents are in [docs/superpowers/specs](docs/superpowers/specs).

## License

MIT
