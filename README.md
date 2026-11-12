# cc-cockpit

A desktop cockpit for [Claude Code](https://claude.com/claude-code). It runs `claude` in terminal tabs, shows the live
status of every session across your projects, and lets plugins bring your other tools into panels around the terminal.

**Status: early.** The plugin API may still change, and the packaged builds have had little testing so far (see What was
tested).

## What it does

- **One window per project.** A project is a folder. Each one keeps its own tabs, layout, settings, plugins and colour,
  and comes back as you left it.
- **Terminal tabs.** Run Claude, a shell or your own commands. Claude conversations resume after a restart.
- **Claude status at a glance.** See which sessions are working, waiting or need permission across all your windows,
  with notes, progress and changed files. Tabs are named after the topic Claude gives the session, and an optional
  one-line gist written by Claude Haiku says what each session is about.
- **Safe text sending.** Plugins and tools can send text to a session. It is delivered only while Claude is waiting for
  input and queued otherwise, so a keystroke doesn't answer a permission prompt by accident.
- **Plugins.** A plugin can add panels, slots in other plugins' panels, buttons on overlays, settings (with global values
  and per-project overrides), commands, `ccc` commands and Claude skills. Install from the
  Marketplace or a git URL, or link a folder while developing, then turn it on per project.
- **Built for Claude to operate.** Inside a tab, `ccc guide` gives Claude the docs for the app and the plugin API, so
  it can write and debug plugins with you.
- **Discuss with Claude.** Any overlay a plugin opens (a diff, a mail, a ticket) has a toolbar with Discuss: pick a
  Claude tab or a new session, add a note, and the item goes to Claude as a prompt.
- **Make it yours.** Themes, editable keybindings, a command palette, terminal fonts and transparent windows.
- **Web access.** Open a project in a browser on your phone or another computer, live on both screens: the same tabs,
  terminals and panels. Off by default; sign in by link, password or a desktop confirm (Settings > General).
- **Server mode (Linux).** Run it on a machine with no display (`cc-cockpit --server`, or just start it with no
  `DISPLAY`) and use it only from browsers: sign-in is managed from a shell with `ccc web`, secrets live in a key file,
  and approvals happen in the browser. Not tested beyond the unpacked build; see
  [docs/features.md](docs/features.md#server-mode).
- **Remote servers.** Connect the desktop app to a cc-cockpit in server mode on another machine, over SSH or a pasted
  link, one window per project; see [docs/features.md](docs/features.md#remote-servers).
- **A built-in browser panel.** `ccc browser open <url|file>` shows a page, a local file or a dev server next to the
  terminal.
- **A file tree.** The Files panel shows the whole project; open any file to read it, note it and discuss it with
  Claude, changed or not.
- **Usage at a glance.** A top-bar meter and a Usage panel: what your Claude Code work would cost at API prices, by
  project, model and session, and your plan's rate-limit windows.
- **A built-in reviewer and editor.** Click a file Claude changed to review its diff, attach notes and send them back to
  Claude; Edit opens the file in micro (optional, see below). Both are bundled plugins you can turn off or replace.

Every feature in detail: [docs/features.md](docs/features.md).

## Install

You need `claude` (Claude Code) on your PATH, and git for installing plugins. [micro](https://micro-editor.github.io) is
optional: the bundled editor plugin uses it (`brew install micro`, `sudo pacman -S micro` or `sudo apt install micro`).

If you linked your own `cockpit.reviewer` or `cockpit.editor` before, unlink them (`ccc plugin unlink <id>`): those ids now
belong to the bundled plugins and the app drops an old linked copy at start with a log line.
The template plugins were renamed the same way: `cockpit.hello` is now `example.hello` and `cockpit.example` is
`example.plugin`; a link under an old id no longer loads, so unlink it and link the folder again.

### macOS (Apple silicon)

Install with Homebrew:

```sh
brew install --cask BronOS/tap/cc-cockpit
```

The app is not notarised, so the first time you open it macOS asks you to allow it. If it offers no way to, use System
Settings > Privacy & Security > "Open Anyway".

Intel Macs are not supported yet.

### Linux (x64)

Download the `.AppImage` or the `.deb` from the
[releases page](https://github.com/BronOS/cc-cockpit/releases).

```sh
sudo apt install ./cc-cockpit-X.Y.Z-linux-x64.deb
# or
chmod +x cc-cockpit-X.Y.Z-linux-x64.AppImage && ./cc-cockpit-X.Y.Z-linux-x64.AppImage
```

Neither has been tried on Ubuntu yet. Ubuntu 24.04 and later restrict the unprivileged user namespaces Chromium's sandbox
uses, so the AppImage may fail to start there. Prefer the `.deb`, which installs its own sandbox helper.

On Arch, a PKGBUILD in the repo turns the released `.deb` into a pacman package (it is not on the AUR yet):

```sh
git clone https://github.com/BronOS/cc-cockpit.git
cd cc-cockpit/packaging/aur
makepkg -si
```

### Upgrading

On a Mac run `brew update && brew upgrade --cask cc-cockpit` (Homebrew may not have seen the new version yet without the
`brew update`). On Linux download the new file. Quit cc-cockpit before upgrading, or
restart it afterwards. A running app keeps its old code, and `ccc` prints a warning when its version differs from the
running app's.

### What was tested

| Platform | State |
| --- | --- |
| macOS, arm64 | v0.1.0 installed with `brew` on a Mac and ran: first launch needed allowing the app once. Upgrading over a running app is untested |
| Linux x64 | Runs from source, tried on Hyprland/Wayland; restoring window size and position may not work there. The packaged AppImage launched only via `--appimage-extract-and-run --no-sandbox` (no libfuse2 here); a plain double-click run (FUSE, Chromium sandbox) and Ubuntu are untested; the `.deb` was built and unpacked but not launched |
| Linux x64, server mode | The unpacked build (`npm run package:dir`) ran headless with no display and no network, checked by `scripts/server-mode-smoke.mjs`. The AppImage on a stock Ubuntu Server, the systemd unit on a real server and Tailscale were not run |
| macOS x64 | Not supported yet |
| Windows | Not supported |

To build the installers yourself, see Build from source below.

## Build from source

You need [Node.js](https://nodejs.org) with npm (releases are built with Node 26.8.1) and git. On Linux, `npm install`
also compiles a native terminal module, so you need Python, `make` and a C++ compiler too.

```sh
git clone https://github.com/BronOS/cc-cockpit.git
cd cc-cockpit
git checkout v0.1.1      # a released version; master may be ahead of it
npm ci
npm run package
```

The installers land in `release/`. You get the ones for the system you build on:

- macOS (Apple silicon): `cc-cockpit-X.Y.Z-mac-arm64.dmg`. It is unsigned, but a build you made yourself is not
  quarantined, so macOS opens it without asking.
- Linux (x64): `cc-cockpit-X.Y.Z-linux-x64.AppImage` and `cc-cockpit-X.Y.Z-linux-x64.deb`. Install them as in Linux
  above.

`npm run package:dir` skips the installers and leaves the unpacked app in `release/`, which is quicker for trying a
build. To run the app straight from the source tree, see Development below.

## Plugins

Open **Settings > Plugins** to browse, search and install: installed plugins and the marketplace's listings are one list.

**A plugin runs with full access to your computer: your files, your accounts and the network.** "Listed" means the index
names that exact version and checks that it matches its repo. It does not mean anyone reviewed the code, so install only
what you trust. The index pins each version to a commit, and it can revoke a bad one, which stops the plugin in your app.

Each listing can show a preview image and a category, and **Update all** moves every marketplace-installed plugin to its
newest listed version after one confirmation.

**Network use:** at every launch, and about hourly while open, the app fetches the plugin index from
`raw.githubusercontent.com`, plus any index you added or installed a plugin from. These requests send no account data,
but those hosts see them, and there is no setting to turn them off.

The app also asks `api.github.com` once a day, and at launch, whether a newer release exists. It never downloads or
installs anything; it only shows a notice. To turn this off, go to Settings > General > Updates and switch off
"Check for new versions". Off means no request at all.

### Write your own

Start from the [example plugin](https://github.com/BronOS/cc-cockpit-plugin-example), a small template with its own
build. To go further:

- `ccc guide` has the full API and works offline. `ccc plugin new` starts a plugin from a Claude tab.
- [plugins/hello](plugins/hello/README.md) is the full reference, using nearly the whole API.
- [marketplace/README.md](marketplace/README.md) explains how to list a plugin.

## The `ccc` command

Settings > General > Command line > **Install ccc command** links `~/.local/bin/ccc`, which must be on your
PATH. It lets Claude, your scripts and plugins talk to the app:

```
ccc open <path>                          open (or focus) a folder as a project
ccc sessions [--json]                    the Claude tabs of every window
ccc notify <text>                        show a system notification
ccc guide [topic]                        bundled docs (works offline)
ccc plugin new|link|unlink|list|logs     the plugin dev loop
ccc plugin config <id> [key=value...]    show or set a plugin's settings
  [--scope app|global|project]           which value a set changes
ccc plugin config <id> --use-global <key>...   drop this project's override
ccc panel show <plugin>/<panel>          reveal a plugin's panel
ccc help                                 everything else, in a tab
```

Full reference and exit codes: [docs/features.md](docs/features.md#the-ccc-command).

## Known limitations

- **Linux shortcuts:** `Cmd` becomes Ctrl, so the default chords take Ctrl+T, Ctrl+W, Ctrl+B, Ctrl+J and Ctrl+O before
  the terminal sees them, and Claude Code and shells use those too. Rebind them in Settings > Keybindings.
- **Web access exposes your computer to whoever signs in:** a signed-in browser is you at the keyboard. It listens on
  127.0.0.1 unless you change it, and asks before a network address without https or without a sign-in. See
  [docs/features.md](docs/features.md#web-access).
- **Server mode is new:** run it only as a normal user, never root and never with `--no-sandbox`, and read the Server mode
  section of [docs/features.md](docs/features.md#server-mode) first.
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
