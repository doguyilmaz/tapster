# __TAP__

```sh
brew install __TAP__/<name>
```

On Windows this repository is also a Scoop bucket:

```sh
scoop bucket add __OWNER__ https://github.com/__HUB__
scoop install __OWNER__/<name>
```

| Path | What it holds |
| --- | --- |
| `Casks/` | Homebrew casks, written by tapster from signed, notarized releases |
| `bucket/` | Scoop manifests for packages with Windows builds |
| `tapster.yml` | which projects this hub publishes |
| `.tapster/state.json` | the releases tapster published |

Releases are signed and published by the `tapster` workflow; change the projects, not these files.
