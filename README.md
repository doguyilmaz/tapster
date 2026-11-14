<p align="center">
  <img src="https://raw.githubusercontent.com/doguyilmaz/tapster/main/site/public/logo-512.png" width="128" height="128" alt="The tapster octopus, a courier carrying sealed parcels">
</p>

<h1 align="center">tapster</h1>

<p align="center">
  Sign, notarize and publish your projects' releases from one Homebrew tap.<br>
  Set it up in your browser. Keep your keys in your own accounts.
</p>

<p align="center">
  <a href="https://tapster.doguyilmaz.com">Documentation</a> ·
  <a href="https://tapster.doguyilmaz.com/tutorial/before/">Quick start</a> ·
  <a href="https://github.com/doguyilmaz/tapster/releases/latest">Releases</a>
</p>

---

tapster turns your Homebrew tap into a release hub for all your projects. Each project builds its files and opens
a draft release. The hub verifies the files, signs and notarizes macOS code, then publishes the release and updates
your package repositories. Projects need no signing certificate, notary key or tap token.

## Install

With Homebrew on macOS or Linux:

```sh
brew install --cask doguyilmaz/tap/tapster
```

Homebrew and standalone installs do not need Bun. Standalone binaries for macOS and Linux (ARM64 and x86-64) are
available in [Releases](https://github.com/doguyilmaz/tapster/releases/latest).
Extract the archive and put `tapster` on your `PATH`.

<details>
<summary>Use Bun or npm instead</summary>

These options need [Bun](https://bun.sh) 1.4.0 or later, including when installing with npm.

| Method | Command |
| --- | --- |
| Install with Bun | `bun add -g @doguyilmaz/tapster` |
| Install with npm | `npm install -g @doguyilmaz/tapster` |
| Run without installing | `bunx @doguyilmaz/tapster` |

The npm package is [@doguyilmaz/tapster](https://www.npmjs.com/package/@doguyilmaz/tapster).

</details>

## Start

Install the [GitHub CLI](https://cli.github.com), sign in and open tapster:

```sh
gh auth login
tapster
```

The page runs on your own computer. It walks you through setup and shows what each step changes on GitHub:

1. **Choose or create your tap.** It becomes your release hub.
2. **Protect the hub and connect GitHub.** Create its GitHub App and, for macOS signing, add your Apple certificate
   and notary key. Signing needs an Apple Developer account and Xcode command line tools.
3. **Write the hub files.** tapster commits them through GitHub; you need no clone of the tap.
4. **Add your projects and release.** tapster finds local clones and prepares their release workflows. Click
   **Release** to tag a project and follow it through publication.

The [tutorial](https://tapster.doguyilmaz.com/tutorial/before/) covers every step. To keep the page available at login,
run `tapster service install`; see [Keep setup running](https://tapster.doguyilmaz.com/guides/service/).

Prefer a terminal? Run `tapster init` in a clone of your tap and `tapster add` in each project.
Use `tapster --help` for commands and options. `tapster setup` is also available as an alias for `tapster`.

## Supported projects

| Project | Release integration |
| --- | --- |
| Go tools | [GoReleaser](https://tapster.doguyilmaz.com/guides/goreleaser/) |
| Bun command line tools | [Bun builds](https://tapster.doguyilmaz.com/guides/bun/) |
| Mac apps | [Sparkle updates](https://tapster.doguyilmaz.com/guides/sparkle/) |

Users install your releases through Homebrew, Scoop, apt or dnf. The hub opens an issue when something needs your
attention, such as a certificate expiring, and closes it once resolved.

Setup writes the hub's GitHub Actions workflow and pins tapster by commit. If you added the [Action](action.yml)
from the Marketplace first, run it without a `mode` to get a setup guide in the run summary.

## Security

Your Apple certificate, notary key and App key stay in your hub's `tapster` environment, which only its `main` branch
can open. Projects hold no signing keys. tapster uses the keys inside your hub's runs, at the commit your workflow
pins; no credentials go to tapster's author or a hosted tapster service.
Read the [security model](https://tapster.doguyilmaz.com/reference/security/).

## Documentation

| Task | Guide |
| --- | --- |
| Set up your first hub | [Tutorial](https://tapster.doguyilmaz.com/tutorial/before/) |
| Set up without the browser | [Terminal setup](https://tapster.doguyilmaz.com/guides/terminal/) |
| Keep tapster running and up to date | [Background service](https://tapster.doguyilmaz.com/guides/service/) · [Upgrades](https://tapster.doguyilmaz.com/guides/upgrade/) |
| Look up commands and configuration | [Commands](https://tapster.doguyilmaz.com/reference/commands/) · [tapster.yml](https://tapster.doguyilmaz.com/reference/config/) |
| Fix a problem | [Troubleshooting](https://tapster.doguyilmaz.com/reference/troubleshooting/) |

More guides are on the [documentation site](https://tapster.doguyilmaz.com).
Design documents are in [docs/superpowers/specs](docs/superpowers/specs).

<!-- Documentation pages retain trailing slashes because the site redirects slashless paths to those canonical URLs. -->

## License

[MIT](LICENSE)
