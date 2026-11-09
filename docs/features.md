# cc-cockpit in detail

The full behaviour of the app, for anyone who wants more than the [README](../README.md). The design and the reasons
behind it are in [design.md](design.md).

## Features

- One window per project (a folder), a project picker, restore of the last open projects; each
  window reopens at its last size, place and maximised / full-screen state. One bar across the
  top holds the project's name and path, the other windows' Claude strip (the bundled Sessions plugin's), a "+" and
  the gear (on macOS it is the title bar, traffic lights included: the strip takes only its entries' width, so the
  rest of the bar drags the window and a double-click zooms or minimises it as System Settings says). The "+" (or File > Open Project…) brings the
  picker back to open another project.
- A colour per project, to tell windows apart: Settings > This Project > Colour picks None, one of
  eight palette colours (red, orange, yellow, green, teal, blue, purple, grey; each tuned per
  theme) or Custom… (the system colour panel). The project's window gets a 3px line along its top
  edge and a faint tint of its top bar, and a dot by its name there, on its entries in other
  windows' top bars and in the project picker; a change shows in every window at once.
- Many tabs: the tab strip never grows past the centre column. Tabs shrink to a minimum width, then
  the strip scrolls (the mouse wheel scrolls it sideways, the active tab is brought into view, the
  edges fade where tabs are hidden), and an "All tabs" list button appears while tabs are hidden.
- Terminal tabs (`claude` or a shell), `claude --resume` on restore. A tab whose process ends
  normally closes: a Claude or command tab on exit code 0 (`/exit`, a command that finishes), a
  terminal on any exit code (a shell reports its last command's status, so Ctrl+D can exit 1).
  Otherwise it stays with an "exited" banner with Restart / Close (a failed Claude or command, a
  shell killed by a signal or ended within 1 s of starting). Settings > General > Tabs > "When a tab's
  process exits" can keep every exited tab instead.
- A project that opens with no tabs (nothing restored, no plugin tab) starts one Claude tab in the
  project folder; closing the last tab later leaves the window empty. Settings > General >
  Tabs > "Open a Claude tab when a project opens with no tabs" (on by default) turns it off.
- Closing a tab that is still running (the ×, Cmd+W, the palette's Close Tab, the tab menu) asks
  first, naming the tab and, for Claude, its status; Cancel is the default. "Don't ask again" in
  the question, or Settings > General > Tabs > "Ask before closing a tab that is still
  running" (on by default), turns it off. A tab whose process already ended closes at once.
- Ctrl+Tab (Ctrl on every platform; Cmd+Tab is macOS's app switcher) goes back to the tab you were
  in before. Hold Ctrl and press Tab again to walk further back through the tabs in recent order,
  Shift+Tab or the arrow keys to step back; after a moment an overlay lists the tabs, and letting go
  of Ctrl picks the highlighted one. Esc cancels, Enter picks. Move the mouse over the list and it
  stays open after the release, for a click. Both chords can be rebound in Settings (Switch to
  Recent Tab). Known limit: the chord is not seen while the keyboard is in a plugin's panel page
  (a sandboxed frame keeps its keys); a web panel forwards it, and the overlay then waits for a click or Enter.
- Tab flags, to come back to the tab that matters while Claude works in many: right-click a tab
  (or Shift+F10 on it) > Flag and pick one of six colours (red, orange, yellow, green, blue,
  purple), Edit note… for a short reminder (up to 80 characters; Enter saves, Esc cancels), Clear
  flag to remove it. Toggle Tab Flag (Cmd+Shift+F, Ctrl+Shift+F on Linux; in the palette and
  Settings > Keybindings) flags the current tab with the last colour you picked, or clears its flag.
  Any tab kind can be flagged. A flagged tab gets a coloured bar along its bottom edge, its note as
  the first line of the tooltip, and stays wider than other tabs when the strip is crowded; when it
  scrolls out of view, that edge of the strip shows its colour, the All tabs button gets a dot, and
  All tabs lists flagged tabs first with colour and note, as the Ctrl+Tab switcher does. When a
  flagged Claude tab finishes and waits for input while you are in another tab, its bar pulses
  until you select it (a steady tint instead when the OS asks for reduced motion). Flags are kept
  until cleared, also across a restart of the app; the Sessions panel lists flagged sessions in a
  group at the top, and other windows' top bars underline a flagged entry in its colour. Only you
  set a flag: plugins can read it, never write it.
- Drag a tab left or right to move it; a bar shows where it lands, Escape puts it back, and the
  new order is kept after a restart. The tab menu (right-click) has Move left / Move right too.
  The strip doesn't scroll by itself while you drag, so with more tabs than fit, move a tab out of
  view in steps.
- Settings > Appearance > Tabs > "Close button position" puts each tab's × before its
  label (Left) or after it (Right, the default), in every open window at once. An overlay's ×
  follows the same setting.
- Transparent project windows: Settings > Appearance > Window > "Transparent background"
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
- The terminal font, apart from the app's own: Settings > Appearance > Terminal sets the
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
  `docker compose logs -f | grep api`), app-wide (Settings > General) and per
  project (Settings > This Project); the menu lists Claude, Shell, the app-wide entries, then the
  project's. An entry opens a tab named after its label that runs the command in your login shell
  (`$SHELL -l -i -c <command>`, so your aliases, functions and PATH work) in the project folder.
  The tab keeps its own copy of the command (editing the entry later does not change it). After a
  relaunch such tabs come back "not started" and run only when you click Restart. Set an entry to
  "Overlay" instead of "Tab" and it opens over the tabs in a full-size terminal overlay (marked
  "overlay" in the menu): handy for `lazygit` or `yazi`. Esc goes to the program; the overlay
  closes when the program exits, or with Cmd+Shift+W. Overlays are not restored. Overlays are centered dialogs, 75 % of
  the window by default; a plugin's spec can ask for `size: 'large'` (about 90 %) or `'full'` (the whole window below
  the top bar).
- Claude status from hooks: tab dots (core), and through the bundled Sessions plugin (`cockpit.sessions`, on by default,
  ships with the app) a top-bar strip of the other windows' sessions and a Sessions panel (left zone) with notes,
  steps and changed files (a click opens the file through "Plugin used to open files", the built-in `git diff` overlay
  without one). A permission prompt, a question from Claude and a plan approval all show as needing you and sort first.
  With the plugin off there is no strip and no panel; tabs, dots, `ccc sessions` and notifications work as before.
  A Sessions panel placed before 0.10 keeps its zone, order and size.
- Session names: a Claude tab is named after the topic Claude Code puts in its terminal title (`File tree plugin`),
  in the tab strip and the Sessions panel, its spinner glyph left out; "Claude N" until Claude has one. Plugins see it
  as `title` in `ctx.sessions`.
- The last prompt under each session is what the person typed: Claude Code's own markup in a user turn is taken out
  (a `<system-reminder>`, a `<task-notification>`, an agent message, a `!` command's output). A turn made only of that
  markup keeps the prompt before it; a slash command reads `/name args`, a shell command `! command`.
- Changed files per session (the Sessions plugin's setting, Settings > Plugins > Sessions, 10 by default; a value set
  before 0.10 in Appearance and keys is moved there once): the Sessions panel lists that many of a session's changed
  files; the rest are behind Show all (N more) / Hide (N) under the list.
- Session gist (off by default; Settings > General > Claude sessions): after a turn ends, Claude Haiku
  writes a one-line summary of the session from its last five prompts, shown in the Sessions panel in place of the last
  prompt (which stays as the tooltip). It uses your Claude Code login (`claude -p --model haiku --safe-mode`, so none of
  your hooks or MCP servers run and no transcript is kept), one small request per gist: only when the prompts changed,
  at most one a minute per tab and two at once. Failures are logged only. Turning it off cancels runs and hides gists.
- Rate limits from the status line (on by default; Settings > General > Claude sessions): Claude tabs run the app's
  status line command, which passes the plan's 5-hour and weekly usage, the session's cost and its context fill to
  plugins (`ctx.sessions.rateLimits`, `SessionInfo.costUsd` / `contextPercent`) and then runs your own status line from
  your Claude settings, so it looks as before. Turning it off applies to tabs started afterwards.
- Sending text into a session through a gate (see limitations), with queueing while Claude is busy.
- Typing in a Claude tab takes it over from plugins: once you type or paste there, plugins can no longer send text into it and their queued texts are dropped (clicks, focus and terminal replies do not count; Discuss with Claude still works).
- Zones with movable, collapsible panels (move or hide one from the "…" in its header or a
  right-click on its icon); an overlay stack (terminal, html, url).
- Panel order: each zone keeps one ordered list of panels, saved per project and applied the same after a restart.
  Move up, Move down and Move to top (disabled at the first or last panel) are in both the icon's right-click menu
  and the header "…" menu. An icon can also be dragged in its strip: a line shows where it lands, a drop on the
  other zone's strip moves it there at that place, Escape cancels, and a press that barely moves is still a click.
  A strip stays a drop target while its zone is collapsed or auto-hidden. "Move to …" still puts a panel at the end
  of the other zone. Dragging is mouse only; the keyboard has the menu items.
- Side zones give way to a narrow terminal (Settings > General > Side panels, on by default, minimum
  terminal width 720 px, 400 to 2000): when the window narrows so the terminal would be under the minimum, the right
  zone's panels hide first, then the left one's; as it widens they come back, left first, each once the terminal keeps
  the minimum plus 48 px with it shown (no flapping at the threshold). The icon strips stay; a click on an icon, the
  zone's toggle key or `ctx.panels.show` shows a hidden zone, and it stays until the window next shrinks. Only zones the
  app hid come back: one the person closed stays closed, and the saved layout never records an auto-hide. A zone dragged
  wider never pushes the other one out; the window's next shrink decides.
- Two-way html overlays: `ctx.overlay.start(spec)` returns `{ result, post, onMessage, close, focus, onButton, setButtons,
  onDiscuss }`; the page's `ccPanel.post(message)` without a `result` key reaches `onMessage` and keeps the overlay open,
  `ccPanel.post({ result })` still closes it, and the host's posts wait until the page has loaded. Messages up to 1 MiB
  less 8 KiB, routed by main only between the overlay and the plugin and window that opened it. Esc dismisses without
  asking the page.
- Overlay toolbar, loader and Discuss with Claude: every overlay (terminal, html, url) has one header row with its title,
  the opener's buttons (up to 4), the buttons other plugins add to overlays of the same `type` (`ctx.overlay.buttons`:
  the Inbox's Done on a Gmail message, the reviewer's Edit on a file), Discuss with Claude and the close button (✕ on the
  side Settings > Appearance names). More than 6 buttons fold the rest into "…". An overlay opens at once with a spinner
  and "Still loading…" after 10 s; ✕ and Esc work throughout. Discuss with Claude is core's: it shows for a typed overlay
  (or one whose opener answers `onDiscuss`), lists this window's Claude tabs and New session, sends `About: <title>` and the context through the send gate (queued while the tab is busy) and selects the
  tab. A "Discuss prompt" (Settings › General, overridable per project under This Project; empty by default) is appended to every such message, after the context and never cut. A plugin whose overlay has no type and no `onDiscuss` shows only ✕ (an older plugin looks as before).
- Component stylesheet: the panel SDK adopts `components.css` (buttons, inputs, rows, chips, a spinner and the like, all
  in a low-priority `@layer cc`) before the plugin's own CSS, so plugin pages look like the app's and any rule of the
  plugin still wins; `ccc guide style` lists the classes, and the bundled plugins use them.
- Slots: a plugin can place a slot in one of its panels (`ctx.panels.slots`, at the top or the bottom) and another plugin
  draws it (`contributes.slots`, `ctx.slots.onOpen`): the Inbox places an `agenda` slot, the Calendar fills it. The
  shell draws the frame and a port joins it to the provider only. With several providers of a type, Settings > This Project
  picks one (or "None"); with none picked nothing is drawn. The top bar's strip of other windows' sessions is the
  app slot `sessions-strip`; the plan usage meter before the gear is the app slot `usage-meter`.
- Plugin system: install from git, from the Marketplace, or link a folder, per-project enable, a sandboxed panel
  per plugin, a host API (settings, storage, exec, schedule, badges, overlays, notify, opening a web page in the
  system browser with `ctx.openExternal`...). A panel's icon is drawn in
  the strip's text colour (only its shape counts), so it follows the theme, hover and open states.
- Plugin notifications: `ctx.notify(text, { title, sound, action })`. `sound` rings a short sound from the window (the
  same on every OS; Settings > General > Notifications > "Notification sounds" turns it off; at most one per
  5 s per window). "Sound" there picks it, one for all notifications: a built-in tone made in the app (Chime, the
  default, Bell, Ping, Soft pop, Two-tone, Marimba) or a sound file from the system's sound folders (Linux
  `/usr/share/sounds` and `~/.local/share/sounds`, macOS `/System/Library/Sounds` and `~/Library/Sounds`, Windows
  `%WINDIR%\Media`), with "▶ Play" to hear it. A plugin can offer the same picker in its settings (`"format": "sound"`,
  first entry "App default") and ring the person's pick for its own notifications; it never names a file, and an id
  the app no longer offers rings the app's sound. `action: { label }` makes the notification clickable (a button on macOS and Windows) and the call
  resolves `{ clicked: true }`, so a calendar plugin can join the meeting on a click; it waits at most 10 minutes.
- Panel headers: a plugin can put a short muted text ("3 open", "synced 2 min ago") after its panel's title and up to
  three icon buttons (refresh, add, search, filter, settings, open external, check, sort, or its own SVG) before the
  "…" menu (`ctx.panels.header`, clicks through `ctx.panels.onAction`). A busy button spins and ignores clicks. The
  header is cleared when the plugin stops or reloads.
- Plugin storage: `ctx.storage` is per project; `ctx.appStorage` (with an atomic `increment`) and `ctx.appDataDir` are
  shared by every project window, for state that must add up across windows. Both are kept when the plugin is
  uninstalled (only secrets are deleted). App storage is written to disk about 300 ms after a change and at quit, so
  a crash of the app can lose the last fraction of a second of it.
- Plugin secrets and sign-ins: core has no accounts. A plugin brings its own sign-in: a token in a
  "secret" field of its settings form, `ctx.secrets` (a per-plugin store encrypted with the OS
  keychain), the optional `ctx.oauth` helper (system browser, loopback redirect, PKCE, refresh),
  or a CLI login in a terminal overlay (`ctx.overlay.open`, `ctx.exec`). Secret values never reach
  a renderer. On Linux they need an unlocked Secret Service keyring or KWallet; the app picks the Secret Service
  by itself on desktops Electron doesn't know (Hyprland, sway) when one is on the session bus, and otherwise the
  error says what to start. An `accounts.json` left in the data dir by an earlier build is unused and can be
  deleted by hand.
- Plugin services: a plugin declares `services.provides` / `uses` (a name and a whole-number major version) in
  `plugin.json` and calls other plugins of the same project with `ctx.services` (`provide`, `use`, `emit`; handle
  methods are async, `handle.on(event, fn)` listens). Calls and events carry plain data only (copied with
  `structuredClone`). With two providers of one service, Settings > This Project > "Plugin used for <service>" picks
  one for the project (it restarts the project's plugin host). A missing provider does not block enabling a
  plugin: the consumer runs, its calls throw, and the Plugins page warns (also for a version mismatch).
  Inside a provider's method, `ctx.services.caller()` is the id of the calling plugin, for per-caller counts or caps.
  A plugin that reads every provider of a name (Inbox reading every `inbox-feed`) declares it in `services.collects`
  and calls `ctx.services.useAll` (0.9.7+): all providers answer, events come from each with its id, and the
  Plugins page shows no pick or warning for a name only such plugins use.
- Open-file hook: a plugin with `contributes.openFile` takes a click on a changed file in the Sessions panel
  through `ctx.files.onOpen({ path, tabId })` (path relative to the project; main checks the tab and the path).
  With several such plugins, or to keep the built-in viewer, Settings > This Project > "Plugin used to open files"
  picks one per project. The built-in viewer opens when the plugin is not active, has no listener, its listener
  fails, or it does not answer within 2 s, and for a file outside the project.
- Plugins open tabs: a Claude tab with `ctx.sessions.open` (a prompt as an argument, a model and effort) and a plain
  shell tab with `ctx.sessions.openShell` (the person's "+" > shell: their login shell, with no command or environment
  from the plugin). Both take a cwd inside the project folder (checked by real path), open unselected unless the
  plugin passes `focus: true` for a click, and share one budget of 5 a minute per plugin.
- Thin themed scrollbars in the shell and in every plugin page (overridable by the plugin; macOS keeps its overlay scrollbars).
- Themes, commands, a command palette and editable keybindings, a Settings screen (`Cmd+,`) with one page per
  kind of setting, each setting on exactly one: General (tabs, side panels, notifications and sound, session gist,
  app-wide new-tab commands, the `ccc` command line, updates), Appearance (theme, window background, tab close
  button, terminal font), Keybindings, Plugins (installed plugins and the marketplace in one list; a card's gear opens
  the plugin's global settings), This Project (colour, enabled plugins and their project settings, the project's
  new-tab commands, panel zones, slot and service picks) and Projects.
- Global values and project overrides: a plugin's project settings have a global value (Settings > Plugins, the card's
  gear), and Settings > This Project shows each field under "Use global" (the default) or an override of its own; a
  secret field works the same way. A plugin's app settings stay app-wide. A panel header shows a gear for a plugin with
  settings, which opens This Project at that plugin (its global page when it has no project settings). A plugin whose
  form cannot hold its settings can add an html page under the form (`contributes.settings.page`); the Inbox's rules
  editor is one. `ccc plugin config <id> --scope global|project key=value` and `--use-global key` do the same from a tab.
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
- A built-in reviewer plugin (`cockpit.reviewer`, on by default, ships with the app): click a file a session changed
  to see its diff (side by side or unified; the choice is remembered), select text to attach notes, write one comment
  for the file, then send the review to Claude with Discuss (the session you came from) or New session, or open the file
  in the editor with Edit. "Add note" floats just under the selection (or press `a`). A draft is kept when you close it, and a second click on a file under review brings it to the
  front. Edit appears only when a plugin provides the `editor` service. Other plugins can open the same overlay on a
  text of their own (the `reviewer` service's `annotate`: a ticket, a mail): one read-only pane, the same notes and
  buttons, no diff and no Edit. Or on HTML (a Jira issue with its panels, mentions, tables, comments and
  screenshots), sanitized against an allow-list and rendered as a document; notes go on selected text and are
  highlighted again when the draft reopens. No header row repeats the title (the overlay's title bar has it);
  the caller's `url` is an open-in-browser icon at the end of the document's first heading (the link opens in the
  system browser); key fields can show as a compact grid with coloured lozenges and name chips, or in a details column at the right
  (`aside`); the notes are a compact list under the comment, with no sidebar; links in the HTML and the details column open in the system browser on a click (http and https only, and only links present in what the caller sent; a drag-select ending on a link does not open it). A caller can hand a second document to show beside
  the first (`companion`: the Jira issue a mail is about): two columns side by side, each scrolling on its own under
  a header row that stays put (each column's label, an "Open in Gmail ↗" / "Open in Jira ↗" style button and its key
  fields, both cells the same height), a divider you drag (remembered), each header above its own document when the
  overlay is narrow; notes go on either, and Claude is told which document each is in. Esc closes the review even while an
  image is shown larger. The tab picker starts on the tab you are looking at unless the caller names one. A mail
  (`kind: 'mail'`, app 0.13.0) is shown in a reading layout: a narrow column of larger text, calm links, the subject
  first, the sender with an avatar and the time, no tint on unread mail; its remote pictures are quiet placeholders that
  the caller can fill later without the document moving (`update`), and buttons in the document (`data-action`, e.g.
  Show images) come back to the caller as a service event. A mail can also open in its **Original** view (`originals`,
  app 0.13.0): the message as its sender made it (its layout, colours and styles, e.g. a Jira notification's issue card
  with the old value struck through in red and the new one on green) on a light "paper" page under the app-themed
  header, in a frame that runs no script and loads nothing from the web; an **Original | Reader** switch sits above
  the document, and the caller hears each switch (Gmail remembers it per sender).
  The reviewer renders markdown (Rendered / Source switch; the diff first when there is one) and previews images
  (10 MiB) and PDFs (pdf.js, 25 MiB, notes on selected text by page).
- A built-in editor plugin (`cockpit.editor`, on by default, ships with the app): opens a file in
  [micro](https://micro-editor.github.io) in a large terminal overlay, with autosave (default 5 s, 0 off), a colour
  scheme and a path-to-micro setting; `ccc edit <file>` too. micro is an optional dependency, not shipped: install it
  with `brew install micro` (Mac), `sudo pacman -S micro` or `sudo apt install micro` (Linux). Without it, Edit shows
  that command and the `microPath` setting instead of failing silently.
- A built-in file tree (`cockpit.files`, on by default, ships with the app): a Files panel (left zone) with the
  whole project folder, so any file can be opened and discussed with Claude, changed or not. A click opens it through
  "Plugin used to open files" (the reviewer by default: the diff for a changed file, the file itself otherwise, with
  notes, Discuss and New session); Edit opens it in the editor. "Open with" rules (app setting) send chosen extensions to the system app, a
  terminal command in an overlay or a new tab (`{file}` as one argument), or the viewer; the menu lists them all. Hidden files and git-ignored files are shown (ignored
  ones dimmed) unless the app settings "Hide hidden files" / "Hide ignored files" are on; `.git` is never shown.
  Folders load when expanded and are watched (`fs.watch`) while open; git marks (M, A, ?, R, U, D) follow the work
  tree and the index. The filter box searches git's tracked and untracked files (not ignored ones), or a bounded walk
  outside git. A right-click menu (also the context-menu key and Shift+F10; files 0.2.0): Open, Open with default app,
  Reveal in Finder / Show in Explorer / Open in file manager, Ask Claude about this file (a new Claude tab whose prompt names
  the path), Open terminal here (a folder's: a selected shell tab in that folder), Copy path, Copy relative path,
  Rename…, New file…, New folder… and Move to Trash. Move to Trash asks in the
  app's own dialog and is recoverable; Open with default app refuses folders, executables, app bundles and script or
  program types (`.sh`, `.command`, `.exe`, `.js`, `.jar`...).
- Usage (`cockpit.usage`, on by default, ships with the app): a meter at the end of the top bar (today's API-equivalent
  spend and the plan's rate-limit use) and a Usage panel with Today / 7 days / 30 days totals, tokens by kind, the plan's
  5-hour and weekly windows (as Claude Code reports them through the status line; a window past its reset is hidden),
  and spend by project, model and session. It reads Claude Code's transcripts in `~/.claude/projects` (subagents
  included) incrementally; one window scans for all. Amounts are what Anthropic's API would bill at list prices, not
  what a subscription costs.
- Bundled plugins (browser, reviewer, editor, files, sessions, usage) can be switched off for the whole app (Settings > Plugins, "Off in all
  projects") or per project, and replaced through the existing picks: another plugin providing `editor` / `reviewer` in
  the provider pick, another file handler in "Plugin used to open files". Ids starting with `cockpit.` are reserved for
  plugins that ship with the app; the template plugins are `example.hello` and `example.plugin` (renamed from
  `cockpit.hello` and `cockpit.example`: a link under an old id no longer loads, so unlink it and link the folder again;
  its settings, switches and storage stay under the old id). If you linked your own
  copy of `cockpit.reviewer` or `cockpit.editor` earlier, unlink it (`ccc plugin unlink`): the app drops such a linked
  record at start with a log line and uses the bundled plugin (settings and per-project switches carry over).
- Plugin dev loop from a tab: `ccc plugin new|link|unlink|list|logs`. `link` asks you to confirm
  in a native dialog, since a linked plugin runs with full access. A linked folder is watched and reloads on edits,
  except a nested folder with its own `plugin.json`, which is another plugin; `plugin new` also writes into a folder
  that holds other files, refusing only to overwrite one. `ccc plugin config <id> [key=value...]` reads and sets
  a plugin's settings (never a secret field), `ccc panel show <plugin>/<panel>` reveals a panel, and `ccc guide types`
  prints the SDK types.

## Updates and versions

- **Update notice.** Once at launch and then every 24 hours the app asks `api.github.com` for the latest release. If it
  is newer, each project window shows a dismissible bar with the new version. On a Mac it says to run
  `brew update && brew upgrade --cask cc-cockpit`; elsewhere it links to the release page. Both say to quit cc-cockpit before
  upgrading, or restart it afterwards. Dismissing hides that version; a newer one shows again. The app never downloads
  or installs anything, because replacing it under running Claude sessions would restart them. Failures (offline, a
  private repo answering 404) are silent. Only a plain `vX.Y.Z` tag is accepted.
- **The setting.** Settings > General > Updates > "Check for new versions" (on by default). Off makes no
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

Settings > Plugins lists the installed plugins together with the plugins of one or more static `index.json` files
(20 per page, with a search and the Installed / Available / Updates and category filters) and installs one after a
confirmation that shows the repo and the commit. A card shows the plugin's preview image when it has one. "Update all"
lists each marketplace-installed plugin with a newer listed version and updates them one at a time after one
confirmation (the same checks as a single update; a failure names its plugin and stops nothing else). Things to know:

- **Network.** At every launch the app fetches the default index from `raw.githubusercontent.com`, plus every index
  you added and every index an installed plugin was installed from, so those hosts see the request too. While the app
  is open it fetches again any index over an hour old or whose last fetch failed (checked every 15 minutes). The Plugins
  page refetches when an index is stale or failed, and adding or removing an index fetches. The default index is always
  fetched (removing it only hides its plugins) and there is no setting to turn the fetching off. It sends no account
  data, but the hosts see the request. Paging and search fetch nothing. Offline, the last cached index is used.
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
  [marketplace/README.md](../marketplace/README.md). Add your own index under Settings > Plugins › Marketplace indexes.
- **Previews and categories.** A listing may carry a `preview.png`, a logo card rather than a screenshot (the card shows it at 96x60) (PNG, at most 512 KiB, 640x400 to 1600x1000,
  1280x800 recommended) and one category (`integrations productivity ai developer appearance other`). The official index's CI checks and
  republishes the image beside `index.json`; the app fetches it lazily from the index's own folder, checks its sha256
  and caches it. A listing without a preview shows the name's initial; the index requires one only after the date in
  its `preview-policy.json`.
- **Index URLs** are https (or `file:` for a local index). `marketplaces` in app settings holds the list; it replaces
  the default list, while the default index is still fetched and still enforces revocations.
- Repos are shown as plain text, and from an index only as ASCII. Installing a plugin id through the Marketplace from a
  different repo, or from an unknown one while a project still has the id on, disables it in all projects until you
  enable it again (an install by git URL does not).
- To list your plugin, see [marketplace/README.md](../marketplace/README.md) or `ccc guide plugins`.

## The `ccc` command

Settings > General > Command line > "Install ccc command" symlinks
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
ccc guide types                          the plugin SDK types
ccc plugin new|link|unlink|list|logs     the plugin dev loop (see `ccc guide dev-loop`)
ccc plugin config <id> [key=value...]    show or set a plugin's settings (never a secret field)
  [--scope app|global|project]           which value a set changes (an app, global or project field)
ccc plugin config <id> --use-global <key>...   drop this project's override: the field uses the global value
ccc panel show <plugin>/<panel>          reveal a plugin's panel in this project's window
ccc <plugin command> ...                 commands plugins declare (`ccc help` lists them in a tab)
```

`ccc overlay` prints the result as JSON. Exit codes: 2 for a usage error (message on stderr), 1 when
the request is refused, 124 when a plugin command exceeds its 30 s limit (its output is capped at 256 KiB), the app closes the connection or never answers, or the command's stdin is not closed within 40 s (pipe the input or redirect `</dev/null`), 0 otherwise. A plugin that is reloading or still starting is waited for inside the 30 s, so a command right after an edit runs in the new copy (a call already running in the old copy ends with 1). Inside any cockpit tab (Claude, shell or
command) or terminal overlay the window is known from the environment; outside the app, pass
`--project`. Only a Claude tab is a Claude session: `session note`/`steps` are refused elsewhere. When the app is not running `ccc`
exits 0 silently, so it can never fail a Claude hook. On Linux the wrapper of an AppImage build
works only while the app is running: the AppImage unpacks to a per-launch `/tmp/.mount_*` path,
so the wrapper's target is gone once the app quits (it then exits 0 silently, as above).

## Known limitations

- The status line passthrough chains only your status line's `command`; `padding`, `refreshInterval` and
  `hideVimModeIndicator` still apply because Claude Code merges them from your settings. A managed (enterprise)
  status line replaces the app's, so no usage is reported then. The plan usage only updates when some Claude tab's
  status line runs (after a message, or on your `refreshInterval`), and it is kept in memory only (empty after a
  restart until the first one). With no status line of your own, Claude Code gets an empty one from the app.

- Distribution: the Mac build is ad-hoc signed and not notarised, Intel Macs are not supported, there is no auto-updater
  (the app only shows a notice), and the update check cannot see a private repo, which answers 404.
- The reviewer's Original view (a mail as its sender made it) cannot run script, so: a link inside the message opens
  in the system browser on a click (http and https only; a mailto link opens from neither the message nor the Links
  list above it); a note cannot be made on the message's text
  (switch to Reader); each message's frame is as tall as the visible area and scrolls on its own (nothing can measure
  its content without script); and showing the pictures reloads the frame at its top.
- The reviewer and editor handle files inside the project only. A file a session edits outside its project keeps
  opening in the built-in viewer, because plugins only receive project-relative paths.
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
- A session's name comes from Claude Code's terminal title: with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` set it stays
  "Claude N", and after `/clear` it keeps the old topic until Claude generates a new one. A restart starts with no name
  (and no gist) until Claude sets the title again.
- A harness block the person pasted into a prompt (a copied `<system-reminder>…</system-reminder>`) is taken out of
  the shown prompt too.
- The keybinding editor refuses ctrl+c, ctrl+d and ctrl+z; the app may take some chords before plugins.
- On Linux `Cmd` is Ctrl, so the default chords take Ctrl+T, Ctrl+W, Ctrl+B, Ctrl+J and Ctrl+O, which
  Claude Code and the shell use themselves (todos, delete-word, background, newline, transcript):
  the window takes them before the terminal sees them. Rebind them in Settings > Keybindings.
- A slot type with several providers and no pick draws nothing (the Plugins page asks for a pick). A url overlay's
  "…" menu (more than 6 buttons) hides the page under it while open, because a native view paints over the window.
  Discuss with Claude sends only into a Claude tab of the same window, or starts a new one.
- A plugin that uses an app member added in 0.10 (slots, overlay buttons, `ctx.settingsPage`, a session `name`) checks
  `typeof` for it and says the app version in its README; the plugin API stays `api: 1`, so an older app runs it
  without the feature.
- Plugin settings schemas may not use regexes (`pattern`, `patternProperties`).
- On Linux the plugin secrets need a running, unlocked Secret Service keyring (gnome-keyring, KeePassXC) or KWallet; there
  is no plaintext fallback by design. The automatic Secret Service choice is made at start-up from the session bus.
- Plugin notifications: the chime plays even when the OS is in do-not-disturb mode (only the setting silences it), and
  only from an open project window. On Linux there is no action button, only the click on the notification, and
  whether a click or a dismissal reaches the app depends on the notification daemon; an unanswered one counts as not
  clicked after 10 minutes. Windows (unsupported) is untested.
- Notification sound picker: only the fixed system sound folders are listed (at most 300 files of up to 2 MiB, four
  folder levels deep), no file chooser. A picked file that goes away or does not decode rings the Chime (logged once in
  the window's console). Compressed AIFF-C files (macOS `ima4`, `ulaw`...) are not decoded; uncompressed AIFF is.
- `ctx.services.caller()` and the service calls are not a security boundary: all plugins of a project share one process.
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
- Windows is not supported. Also not built: a plugin registry server and binary downloads.
