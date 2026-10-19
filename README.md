# tapster

tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your
projects. Each project builds its files and opens a draft release. It holds no signing certificate, no notary key and
no tap token.

**Tutorial and docs: [doguyilmaz.github.io/tapster](https://doguyilmaz.github.io/tapster/)**

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
Users install them with Homebrew, Scoop, apt or dnf.

## Quick start

You need [Bun](https://bun.sh) and the GitHub CLI (`gh auth login`). Signing for macOS also needs an Apple Developer
account.

```sh
cd homebrew-tap                 # a clone of your tap
bunx @doguyilmaz/tapster init   # protects it, creates its App, stores your keys

cd ../my-tool                   # a clone of a project
bunx @doguyilmaz/tapster add    # prepares its release workflow and proposes it to the hub
```

Then push a tag in the project. The [tutorial](https://doguyilmaz.github.io/tapster/tutorial/before/) walks through
every step and shows what you should see.

## Your keys stay in your accounts

tapster has no server. Your Apple certificate, notary key and App key are secrets of your hub's `tapster` environment,
which only its `main` branch can open. Projects hold no keys. No one else, including tapster's author, ever receives
them. Read the [security model](https://doguyilmaz.github.io/tapster/reference/security/).

## The Action

You do not write the hub workflow yourself. `tapster init` writes it and pins this Action by commit. To move a hub to a
newer release, see [Upgrade tapster](https://doguyilmaz.github.io/tapster/guides/upgrade/).

## Docs

- [Tutorial](https://doguyilmaz.github.io/tapster/tutorial/before/): from an empty tap to an installed release
- [Commands](https://doguyilmaz.github.io/tapster/reference/commands/)
- [Security](https://doguyilmaz.github.io/tapster/reference/security/)

The design documents are in [docs/superpowers/specs](docs/superpowers/specs).

## License

MIT
