# cc-cockpit in detail

The full behaviour of the app, for anyone who wants more than the [README](../README.md). The design and the reasons
behind it are in [design.md](design.md).

## Features

- One window per project (a folder), a project picker, restore of the last open projects; each
  window reopens at its last size, place and maximised / full-screen state. One bar across the
  top holds the project's name and path, the Claude strip and the gear (on macOS it is the title
  bar, traffic lights included). The "+" at the end of the strip (or File > Open Project…) brings
  the picker back to open another project.
- A colour per project, to tell windows apart: Settings > This project > Colour picks None, one of
  eight palette colours (red, orange, yellow, green, teal, blue, purple, grey; each tuned per
  theme) or Custom… (the system colour panel). The project's window gets a 3px line along its top
  edge and a faint tint of its top bar, and a dot by its name there, on its entries in other
  windows' top bars and in the project picker; a change shows in every window at once.
- Terminal tabs (`claude` or a shell), `claude --resume` on restore. A tab whose process ends
  normally closes: a Claude or command tab on exit code 0 (`/exit`, a command that finishes), a
  terminal on any exit code (a shell reports its last command's status, so Ctrl+D can exit 1).
  Otherwise it stays with an "exited" banner with Restart / Close (a failed Claude or command, a
  shell killed by a signal or ended within 1 s of starting). Settings > Appearance and keys > Tabs > "When a tab's
  process exits" can keep every exited tab instead.
- A project that opens with no tabs (nothing restored, no plugin tab) starts one Claude tab in the
  project folder; closing the last tab later leaves the window empty. Settings > Appearance and
  keys > Tabs > "Open a Claude tab when a project opens with no tabs" (on by default) turns it off.
- Closing a tab that is still running (the ×, Cmd+W, the palette's Close Tab, the tab menu) asks
  first, naming the tab and, for Claude, its status; Cancel is the default. "Don't ask again" in
  the question, or Settings > Appearance and keys > Tabs > "Ask before closing a tab that is still
  running" (on by default), turns it off. A tab whose process already ended closes at once.
- Drag a tab left or right to move it; a bar shows where it lands, Escape puts it back, and the
  new order is kept after a restart. The tab menu (right-click) has Move left / Move right too.
  The strip doesn't scroll by itself while you drag, so with more tabs than fit, move a tab out of
  view in steps.
- Settings > Appearance and keys > Tabs > "Close button position" puts each tab's × before its
  label (Left) or after it (Right, the default), in every open window at once. An overlay's ×
  follows the same setting.
- Transparent project windows: Settings > Appearance and keys > Window > "Transparent background"
  lets the desktop show through the top bar, tabs, terminal and side zones while text, menus,
  dialogs, overlays and the settings screen stay solid. A window is made see-through or solid when
  it opens, so after a change the window you changed it in offers "Reopen window": it closes and
  opens again with its tabs as after a restart (Claude conversations resume, shells start fresh,
  anything running is stopped); "Later", and every other open window, keep how they were made
  until they are next opened.
  "See-through" (Whole window, or Main area only: the side and bottom panels stay solid, the top
  bar, tabs and terminal see-through), "Background opacity" (40–100 %, default 80 %) and "Blur behind" (off by default; macOS vibrancy, Windows 11
  acrylic) change every transparent window at once. Linux has no blur, and needs a compositing
  window manager for transparency.
- The terminal font, apart from the app's own: Settings > Appearance and keys > Terminal sets the
  family, size, line height, letter spacing and weights of every terminal (tabs and overlays), live
  in every window; "Reset to defaults" goes back to JetBrains Mono Nerd Font 13. The family is a
  searchable dropdown: Bundled (two Nerd Fonts that come with the app, so a zsh or starship theme's
  icons draw with nothing installed), Installed (the monospaced fonts on this computer) and
  Custom… (a CSS font list typed by hand); the preview line shows whether a font's icons draw.
- Bundled fonts (in `src/renderer/assets/fonts`, loaded by the app only, never installed on the
  system): JetBrains Mono Nerd Font Mono (Nerd Fonts v3.5.1, JetBrains Mono 2.304), SIL Open Font
  License 1.1, and MesloLGS NF (romkatv/powerlevel10k-media), Apache License 2.0; the licence
  texts sit next to the font files and ship in the packaged app (`Resources/fonts/`).
- Your own commands in the new-tab menu: a label and a command line (`lazygit`, `npm run dev`,
  `docker compose logs -f | grep api`), app-wide (Settings > Appearance and keys > Tabs) and per
  project (Settings > This project); the menu lists Claude, Shell, the app-wide entries, then the
  project's. An entry opens a tab named after its label that runs the command in your login shell
  (`$SHELL -l -i -c <command>`, so your aliases, functions and PATH work) in the project folder.
  The tab keeps its own copy of the command (editing the entry later does not change it). After a
  relaunch such tabs come back "not started" and run only when you click Restart. Set an entry to
  "Overlay" instead of "Tab" and it opens over the tabs in a full-window terminal overlay (marked
  "overlay" in the menu): handy for `lazygit` or `yazi`. Esc goes to the program; the overlay
  closes when the program exits, or with Cmd+Shift+W. Overlays are not restored.
- Claude status from hooks: tab dots, a top strip across windows, a Sessions panel with notes,
  steps and changed files (click a file for `git diff` in a terminal overlay). A permission prompt,
  a question from Claude and a plan approval all show as needing you and sort first.
- Sending text into a session through a gate (see limitations), with queueing while Claude is busy.
- Zones with movable, collapsible panels (move or hide one from the "…" in its header or a
  right-click on its icon); an overlay stack (terminal, html, url).
- Two-way html overlays: `ctx.overlay.start(spec)` returns `{ result, post, onMessage, close }`; the page's
  `ccPanel.post(message)` without a `result` key reaches `onMessage` and keeps the overlay open, `ccPanel.post({ result })`
  still closes it, and the host's posts wait until the page has loaded. Messages up to 1 MiB less 8 KiB, routed by main
  only between the overlay and the plugin and window that opened it. Esc dismisses without asking the page.
- Plugin system: install from git, from the Marketplace, or link a folder, per-project enable, a sandboxed panel
  per plugin, a host API (settings, storage, exec, schedule, badges, overlays, notify...).
- Plugin secrets and sign-ins: core has no accounts. A plugin brings its own sign-in: a token in a
  "secret" field of its settings form, `ctx.secrets` (a per-plugin store encrypted with the OS
  keychain), the optional `ctx.oauth` helper (system browser, loopback redirect, PKCE, refresh),
  or a CLI login in a terminal overlay (`ctx.overlay.open`, `ctx.exec`). Secret values never reach
  a renderer. An `accounts.json` left in the data dir by an earlier build is unused and can be
  deleted by hand.
- Plugin services: a plugin declares `services.provides` / `uses` (a name and a whole-number major version) in
  `plugin.json` and calls other plugins of the same project with `ctx.services` (`provide`, `use`, `emit`; handle
  methods are async, `handle.on(event, fn)` listens). Calls and events carry plain data only (copied with
  `structuredClone`). With two providers of one service, Settings > Plugins > "Plugin used for <service>" picks
  one for the project (it restarts the project's plugin host). A missing provider does not block enabling a
  plugin: the consumer runs, its calls throw, and the Plugins page warns (also for a version mismatch).
- Open-file hook: a plugin with `contributes.openFile` takes a click on a changed file in the Sessions panel
  through `ctx.files.onOpen({ path, tabId })` (path relative to the project; main checks the tab and the path).
  With several such plugins, or to keep the built-in viewer, Settings > Plugins > "Plugin used to open files"
  picks one per project. The built-in viewer opens when the plugin is not active, has no listener, its listener
  fails, or it does not answer within 2 s, and for a file outside the project.
- Themes, commands, a command palette and editable keybindings, a Settings screen.
- The `ccc` command line tool, the `hello` reference plugin and an example plugin to copy.
- Operable by Claude: inside a tab, `ccc guide [topic]` prints bundled docs (CLI, plugin API,
  panels, web view, dev loop; works with the app closed) and a SessionStart note points Claude
  at it. A core Claude skill and the skills of enabled plugins load into the Claude tabs the app
  starts (`--plugin-dir` on a generated tree in the data dir; nothing is written to `~/.claude`).
- Plugins extend `ccc` with their own commands (`contributes.cli`, `ctx.cli.register`) and bring
  Claude skills (`contributes.skills`).
- A built-in browser plugin (`cockpit.browser`, on by default, ships with the app): a web view
  panel; `ccc browser open <url|file>` shows a page, a local file or a dev server in it,
  `ccc browser url`, `ccc browser reload`. Local files are served read-only through a
  `cc-preview` scheme. Webview panels are a core primitive (`"kind": "webview"`, `ctx.webview`).
  A full browser (tabs, history, devtools) is not built.
- Plugin dev loop from a tab: `ccc plugin new|link|unlink|list|logs`. `link` asks you to confirm
  in a native dialog, since a linked plugin runs with full access.

## Updates and versions

- **Update notice.** Once at launch and then every 24 hours the app asks `api.github.com` for the latest release. If it
  is newer, each project window shows a dismissible bar with the new version. On a Mac it says to run
  `brew update && brew upgrade --cask cc-cockpit`; elsewhere it links to the release page. Both say to quit cc-cockpit before
  upgrading, or restart it afterwards. Dismissing hides that version; a newer one shows again. The app never downloads
  or installs anything, because replacing it under running Claude sessions would restart them. Failures (offline, a
  private repo answering 404) are silent. Only a plain `vX.Y.Z` tag is accepted.
- **The setting.** Settings > Appearance and keys > Updates > "Check for new versions" (on by default). Off makes no
  request at all and clears the notice.
- **Version warning.** After an upgrade over a running app, `ccc` is the new version and the app is the old one. A
  `ccc` command prints `ccc: the app is running version X, this ccc is version Y. Restart cc-cockpit.` on stderr (stdout
  stays clean for `--json`) and still runs. Hooks never print it. An old app sends no version, and then nothing is
  printed.
- **Packaged builds.** Linux x64: the AppImage was built and launched with a temporary data folder (via
  `--appimage-extract-and-run --no-sandbox`; a plain FUSE launch with the Chromium sandbox and Ubuntu are untested); the app started, bound its socket, and tokenless `ccc open`, `ccc sessions` and
  `ccc overlay --project` worked. The `.deb` was built and unpacked but not launched. A second build with a higher
  version started on the first one's data folder and kept the open project. macOS: v0.1.0 installed with `brew` on a Mac and
  ran, with the app allowed once at first launch; upgrading over a running app is untested. Test hooks are off in packaged apps by design (`isTestRun`,
  `main/test-run.ts`); a packaged build was not checked for that.

## Marketplace

Settings > Marketplace lists plugins from one or more static `index.json` files and installs one after a
confirmation that shows the repo and the commit. Things to know:

- **Network.** At every launch the app fetches the default index from `raw.githubusercontent.com`, plus every index
  you added and every index an installed plugin was installed from, so those hosts see the request too. While the app
  is open it fetches again any index over an hour old or whose last fetch failed (checked every 15 minutes). The Marketplace
  page refetches when an index is stale or failed, and adding or removing an index fetches. The default index is always
  fetched (removing it only hides its plugins) and there is no setting to turn the fetching off. It sends no account
  data, but the hosts see the request. The Plugins tab does no fetching. Offline, the last cached index is used.
- **"Listed" does not mean reviewed.** The app checks the shape of an index and refuses a tag that has moved.
  The official index's CI also checks that an entry matches its repo (tag, commit, id, version) and a person reviews and
  merges a new listing, but nobody audits the plugin code; an index you add may have no checks at all, so there "listed"
  only means the index names it. A plugin runs with full access to your computer. The index pins the commit; it can also
  revoke a known-bad commit, which disables the plugin until you move to a safe version or uninstall it. Limits: a
  revocation takes effect at the next successful fetch (up to about 75 minutes, plus host caching, in a running app that is online), not on a
  first offline run with no cache (an install then is not checked against it either), never for linked or bundled plugins or installs with no recorded
  commit, and it cannot undo what the plugin already ran. Only the default index and the index a plugin came from
  enforce revocations.
- **The official index** is the repo [BronOS/cc-cockpit-marketplace](https://github.com/BronOS/cc-cockpit-marketplace), made from
  the `marketplace/` template. Its setup steps (`PUBLISH_TOKEN`, branch protection with no required approvals) are in
  [marketplace/README.md](../marketplace/README.md). Add your own index under Settings > Marketplace.
- **Index URLs** are https (or `file:` for a local index). `marketplaces` in app settings holds the list; it replaces
  the default list, while the default index is still fetched and still enforces revocations.
- Repos are shown as plain text, and from an index only as ASCII. Installing a plugin id through the Marketplace from a
  different repo, or from an unknown one while a project still has the id on, disables it in all projects until you
  enable it again (an install by git URL does not).
- To list your plugin, see [marketplace/README.md](../marketplace/README.md) or `ccc guide plugins`.

## The `ccc` command

Settings > Appearance and keys > Command line > "Install ccc command" symlinks
`~/.local/bin/ccc` to the wrapper in the data dir (an existing different `ccc` is left alone;
make sure `~/.local/bin` is on your PATH). At start-up, when nothing is at that path, the first project window asks once per
launch whether to install it (Yes / No, "Don't ask again"); the same Settings group has "Offer to install at start-up" to turn it
back on. Not asked when it is installed, when something else is there, or in a test run. Commands:

```
ccc open <path>                          open (or focus) a folder as a project
ccc session note <text>                  add a note to this tab's Claude session (inside a Claude tab)
ccc session steps <done>/<total>         set progress, e.g. 3/5 (inside a Claude tab)
ccc overlay [--project <path>] --terminal -- <argv...> | --url <http(s) url> | --html <file>
ccc sessions [--json]                    the Claude tabs of every window
ccc notify <text>                        show a system notification
ccc guide [topic]                        bundled docs for Claude and plugin authors (works offline)
ccc plugin new|link|unlink|list|logs     the plugin dev loop (see `ccc guide dev-loop`)
ccc <plugin command> ...                 commands plugins declare (`ccc help` lists them in a tab)
```

`ccc overlay` prints the result as JSON. Exit codes: 2 for a usage error (message on stderr), 1 when
the request is refused, 124 when a plugin command exceeds its 30 s limit (its output is capped at 256 KiB), the app closes the connection or never answers, 0 otherwise. Inside any cockpit tab (Claude, shell or
command) or terminal overlay the window is known from the environment; outside the app, pass
`--project`. Only a Claude tab is a Claude session: `session note`/`steps` are refused elsewhere. When the app is not running `ccc`
exits 0 silently, so it can never fail a Claude hook. On Linux the wrapper of an AppImage build
works only while the app is running: the AppImage unpacks to a per-launch `/tmp/.mount_*` path,
so the wrapper's target is gone once the app quits (it then exits 0 silently, as above).

## Known limitations

- Distribution: the Mac build is ad-hoc signed and not notarised, Intel Macs are not supported, there is no auto-updater
  (the app only shows a notice), and the update check cannot see a private repo, which answers 404.
- The web view (browser plugin) cannot stop a hostile page from navigating its top level to an
  http(s) URL with data in the query (CSP does not cover that), so a folder shown with `ccc browser
  open` should hold only what the page may see.
- The send gate delivers text only while a session is *waiting for input* (idle is not sendable)
  and refuses text starting with `/`, `!`, `#` or `&`. A queued item can stay stuck while the tab sits in
  waiting (an idle_prompt promotion never auto-delivers); a Stop hook returning "block" or a
  permission dialog raised by a background task/subagent can still receive the paste. A tool's
  `PreToolUse` hook makes the tab non-sendable before its dialog opens, so this needs a hook that
  did not reach the app or a dialog without one (an MCP elicitation). The Enter that submits the
  paste is a real key: in a permission dialog it confirms the highlighted option, which can
  approve the permission.
- A tab leaves "needs permission" when Enter or an option digit is typed into it (no hook fires
  when a dialog is answered). After Esc, or Enter on "No", it keeps showing "needs permission"
  until Claude's next turn.
- A question from Claude (AskUserQuestion) or its plan-approval dialog (ExitPlanMode) shows as
  "needs you · question" / "needs you · plan approval" and holds sends like a permission prompt
  (plugins and `ccc sessions` see status `needs-permission` with that tool). It ends when Claude
  reports the tool done, not on a key; a cancelled question (Esc) keeps showing until Claude's
  next turn, and a background subagent's tool call while the dialog is up shows "working".
- Closing a whole project window, or quitting, does not ask, even with running tabs.
- The keybinding editor refuses ctrl+c, ctrl+d and ctrl+z; the app may take some chords before plugins.
- On Linux `Cmd` is Ctrl, so the default chords take Ctrl+T, Ctrl+W, Ctrl+B, Ctrl+J and Ctrl+O, which
  Claude Code and the shell use themselves (todos, delete-word, background, newline, transcript):
  the window takes them before the terminal sees them. Rebind them in Settings > Appearance and keys.
- Plugin settings schemas may not use regexes (`pattern`, `patternProperties`).
- When a plugin update or dev reload removes a secret settings field or makes it a plain one, its
  encrypted value stays in `secrets.json` (no form or `ctx.settings` gets it) until the plugin is
  uninstalled or, for a project field, the project is forgotten.
- Forgetting a project while `secrets.json` cannot be written (a full disk) forgets the project but
  leaves its secret settings values encrypted in `secrets.json` (the log says so) until the plugin
  is uninstalled; nothing retries the cleanup.
- Transparent windows: on macOS the blur material is a fairly solid tint, so with "Blur behind" on
  the desktop shows mostly as colour (lower the opacity to see more). On Windows Electron documents
  that `transparent` needs a frameless window, which project windows are not there; untested.
- On Linux and Windows the File / Edit / Window menu bar is hidden; its shortcuts still work (the "+"
  in the top bar opens the project picker).
- Windows is not supported. Also not built: a plugin registry server, binary downloads and panel drag-and-drop.
