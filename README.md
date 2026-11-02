# cc-cockpit

A desktop cockpit for [Claude Code](https://claude.com/claude-code). It runs `claude` in terminal tabs, shows the live
status of every session across your projects, and lets plugins bring your other tools into panels around the terminal.

**Status: early.** The plugin API may still change. Prebuilt downloads are set up but have not been published yet (see
Install).

## What it does

- **One window per project.** A project is a folder. Each one keeps its own tabs, layout, settings, plugins and colour,
  and comes back as you left it.
- **Terminal tabs.** Run Claude, a shell or your own commands. Claude conversations resume after a restart.
- **Claude status at a glance.** See which sessions are working, waiting or need permission across all your windows,
  with notes, progress and changed files.
- **Safe text sending.** Plugins and tools can send text to a session. It is delivered only while Claude is waiting for
  input and queued otherwise, so a keystroke doesn't answer a permission prompt by accident.
- **Plugins.** A plugin can add panels, settings, commands, `ccc` commands and Claude skills. Install from the
  Marketplace or a git URL, or link a folder while developing, then turn it on per project.
- **Built for Claude to operate.** Inside a tab, `ccc guide` gives Claude the docs for the app and the plugin API, so
  it can write and debug plugins with you.
- **Make it yours.** Themes, editable keybindings, a command palette, terminal fonts and transparent windows.
- **A built-in browser panel.** `ccc browser open <url|file>` shows a page, a local file or a dev server next to the
  terminal.

Every feature in detail: [docs/features.md](docs/features.md).

## Install

You need `claude` (Claude Code) on your PATH, and git for installing plugins.

### macOS (Apple silicon)

The app is not notarised, so macOS may refuse to open it the first time. The first-launch step is:

> TODO: fill this in after the first real run on a Mac (Post-Completion in
> `docs/plans/20261102-distribution.md`). Not tested yet, so no step is stated here.

Then install with Homebrew:

```sh
brew install --cask BronOS/tap/cc-cockpit
```

`brew install` does not work yet. It needs the `BronOS/cc-cockpit` repo and the `BronOS/homebrew-tap` repo to be public.
Intel Macs are not supported yet.

### Linux (x64)

Download the `.AppImage` or the `.deb` from the
[releases page](https://github.com/BronOS/cc-cockpit/releases) once a release is published there. Until the repo is
public, there is nothing to download.

### Upgrading

On a Mac run `brew upgrade --cask cc-cockpit`. On Linux download the new file. Quit cc-cockpit before upgrading, or
restart it afterwards. A running app keeps its old code, and `ccc` prints a warning when its version differs from the
running app's.

### What was tested

| Platform | State |
| --- | --- |
| macOS, arm64 | Runs from source. The packaged app and the brew path are untested until the manual runs in the plan's Post-Completion |
| Linux x64 | Runs from source, tried on Hyprland/Wayland; restoring window size and position may not work there. The packaged AppImage launched only via `--appimage-extract-and-run --no-sandbox` (no libfuse2 here); a plain double-click run (FUSE, Chromium sandbox) and Ubuntu are untested; the `.deb` was built and unpacked but not launched |
| macOS x64 | Not supported yet |
| Windows | Not supported |

To run from source instead, see Development below.

## Plugins

Open **Settings > Marketplace** to browse and install.

**A plugin runs with full access to your computer: your files, your accounts and the network.** "Listed" means the index
names that exact version and checks that it matches its repo. It does not mean anyone reviewed the code, so install only
what you trust. The index pins each version to a commit, and it can revoke a bad one, which stops the plugin in your app.

**Network use:** at every launch, and about hourly while open, the app fetches the plugin index from
`raw.githubusercontent.com`, plus any index you added or installed a plugin from. These requests send no account data,
but those hosts see them, and there is no setting to turn them off.

The app also asks `api.github.com` once a day, and at launch, whether a newer release exists. It never downloads or
installs anything; it only shows a notice. To turn this off, go to Settings > Appearance and keys > Updates and switch off
"Check for new versions". Off means no request at all.

### Write your own

Start from the [example plugin](https://github.com/BronOS/cc-cockpit-plugin-example), a small template with its own
build. To go further:

- `ccc guide` has the full API and works offline. `ccc plugin new` starts a plugin from a Claude tab.
- [plugins/hello](plugins/hello/README.md) is the full reference, using nearly the whole API.
- [marketplace/README.md](marketplace/README.md) explains how to list a plugin.

## The `ccc` command

Settings > Appearance and keys > Command line > **Install ccc command** links `~/.local/bin/ccc`, which must be on your
PATH. It lets Claude, your scripts and plugins talk to the app:

```
ccc open <path>                          open (or focus) a folder as a project
ccc sessions [--json]                    the Claude tabs of every window
ccc notify <text>                        show a system notification
ccc guide [topic]                        bundled docs (works offline)
ccc plugin new|link|unlink|list|logs     the plugin dev loop
ccc help                                 everything else, in a tab
```

Full reference and exit codes: [docs/features.md](docs/features.md#the-ccc-command).

## Known limitations

- **Linux shortcuts:** `Cmd` becomes Ctrl, so the default chords take Ctrl+T, Ctrl+W, Ctrl+B, Ctrl+J and Ctrl+O before
  the terminal sees them, and Claude Code and shells use those too. Rebind them in Settings > Appearance and keys.
- **Closing a window doesn't ask:** closing a project window or quitting stops running tabs without a question.
- **Sending text isn't perfectly safe:** the Enter that submits text is a real key, and in rare cases a permission dialog
  raised without a hook can receive it.

The full list is in [docs/features.md](docs/features.md#known-limitations).

## Development

To run from source you need [Node.js](https://nodejs.org) with npm, git and `claude` on your PATH. On Linux,
`npm install` also compiles a native terminal module, so you need Python, `make` and a C++ compiler.

```sh
git clone https://github.com/BronOS/cc-cockpit.git
cd cc-cockpit
npm install
npm run dev            # run the app from source
npm test               # unit tests (vitest)
npm run test:e2e       # builds, then Playwright against the built app (needs openssl)
npm run typecheck && npm run lint
npm run build          # builds the bundled plugins, then the app into out/
npm run package        # build + installers for the current OS, unsigned
npm run package:dir    # build + unpacked app in release/, for a smoke launch
```

Start with [docs/design.md](docs/design.md), the source of truth for how the app works. `npm run package` ends with
`electron-builder install-app-deps`, which puts the host-arch `node-pty` back in `node_modules/`.

## License

MIT, see [LICENSE](LICENSE).

The two bundled terminal fonts keep their own licences, shipped next to them (in the source under
`src/renderer/assets/fonts/<font>/`, in the packaged app under `Resources/fonts/<font>/`):

- JetBrains Mono Nerd Font Mono: SIL Open Font License 1.1.
- MesloLGS NF: Apache License 2.0.

Both carry the Nerd Fonts icon sets, each under its own licence (MIT, Apache 2.0, SIL OFL 1.1, CC BY
4.0, Unlicense); each font folder's `NOTICE.txt` lists them and what was changed (TTF converted to
WOFF2, nothing else).
