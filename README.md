# tapster

tapster turns one repository, your Homebrew tap, into the single place that signs, notarizes and publishes the
releases of all your projects. Project repositories only build and open a draft release. They hold no secrets.

Status: in development. Phase 1 covers command line tools written in Go and in Bun/TypeScript.

## How it works

1. A project pushes a tag. Its CI builds the archives, attests them and opens a draft release with `checksums.txt`.
2. The hub (your `homebrew-tap` repository) runs tapster on a schedule. It finds ready drafts, signs and notarizes
   the macOS binaries with your Developer ID, replaces the archives and publishes the release.
3. tapster writes the cask and the Scoop manifest into the hub.

The Apple credentials and the GitHub App key live only in one GitHub environment of the hub.

## License

MIT
