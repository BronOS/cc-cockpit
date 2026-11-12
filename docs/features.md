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
  The strip also has one chip per connected server (see "Remote servers" › "Other machines in the strip").
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

## Web access

Open the cockpit in a browser on another device (a laptop, a phone): the same project window, tabs, terminals, panels
and overlays, live on both screens at once, any of them able to act. Claude keeps running on this computer. Design and
reasons: [design-web.md](design-web.md).

**Turn it on:** Settings > General > Web access. It is off by default and listens on `127.0.0.1:7330` (port 1024 to
65535). The card shows the access link as text and a QR code (behind Show, so a screenshot does not leak it); open it
in the browser and the device is signed in. "Add a device" makes a one-time link. The top bar shows a chip while web
access is on (and a warning while a risky choice is on); it opens the devices list with Disconnect, Revoke and Revoke
all. Every new device raises a desktop notification. A browser attaches to one project window; closing that window with
a browser attached asks "Close for everyone" or "Keep running".

**Sign-in modes:**
- *Access link* (default): a long random link, `<address>/#t=<token>`; the page posts it once, gets a device cookie and
  clears the URL. Regenerate takes it back.
- *Password*: set on the desktop (needs a working keychain); works with no one at the desktop. At least 8 characters,
  12 once others can reach the address (a network bind, an external address, server mode); a shorter one set before
  keeps working, and the card and `ccc web status` say to change it. Wrong passwords are slowed, more so the longer
  they keep coming, never locked out; 20 wrong tries in 10 minutes raise a notice.
- *Desktop confirm*: the browser shows a code; type it into the request card on the desktop to allow it.
- *None*: no sign-in, anyone who reaches the address is in. Only for a proxy that signs people in. Revoke means nothing.

Whoever is signed in is the person at the keyboard: a shell and Claude on this computer, plugin accounts, files. The
Host and Origin checks, the device cookie and the log (sign-ins and revokes, never terminal text) apply in every mode.

A signed-in browser holds two things: the device cookie, and a device key the page keeps in its own storage for this
exact address (port included) and sends with each request. A cookie alone signs nothing in, so another web server on
the same computer that the browser visits (cookies ignore ports) cannot reuse it. **Devices signed in before this
change have no key and must sign in again** once (they are listed as revoked in `web-access.log`). Clearing the
browser's site data for the address signs it out the same way. A connection that sends nothing within 10 seconds is
closed, and only so many not-yet-signed-in connections are kept at once; signed-in browsers are never affected.

**Reaching it from another device:**
- *Same network (LAN):* set "Listen on" to `0.0.0.0` (or one address of the computer). A network bind over plain http,
  or with no sign-in, asks for a confirm first (Cancel keeps the old address). Open `http://<computer's LAN IP>:7330`;
  add the name you use to "Allowed host names" if it is not the IP. The link, the password and everything typed
  travel unencrypted: use it only on a network you trust, or add a certificate and key file (https).
- *Tailscale:* keep it on `127.0.0.1` and run `tailscale serve --bg --https=443 http://127.0.0.1:7330`; set "External
  address" to `https://<machine>.<tailnet>.ts.net` (the same name goes into the allowed hosts). Every peer then looks
  like 127.0.0.1, so sign-in does the work, not the address. Tailscale itself can be the sign-in (mode None) because
  only your tailnet reaches the proxy; the app stays on loopback so nobody goes around it.
- *SSH tunnel:* keep loopback and run `ssh -L 7330:127.0.0.1:7330 <host>`, then open `http://localhost:7330` on the
  other computer (the default Host and Origin already fit). Use a different local port with an "External address" for it.
- Any other reverse proxy: set "External address" to its public origin and keep the bind on loopback.

**What a browser does differently** (the table is design-web.md §6.1): a link opens as a notice you click, not in a new
tab by itself; notifications and sounds stay on the host; "Reveal in the file manager" and "Open with the system" are
refused; folder dialogs, plugin linking and OAuth sign-ins are done on the desktop, and Settings › Projects has no
Open button (it would open a window on the desktop's screen; a server's browsers keep it); URL overlays, and the
Browser panel of a project open on a desktop, show "available on the desktop" (in server mode the panel is streamed to the browser, see Server mode); window controls, full screen and the update notice are not shown. With no theme
picked ("Follow the system"), each browser shows the light or dark built-in of its own system setting, not the
computer's; a picked theme is the same everywhere. On a computer with no display (server mode) the approvals move to the browser: see Server mode below. A terminal has one
size for all places (the one that typed, clicked, selected its tab or was brought to the front last, or "Fit to this screen"). An HTML overlay or a plugin's settings page is
open in one place at a time, with Take over on the others.

**For plugin authors:** nothing has to change for a panel to work in a browser, with three rules. Load everything by a
URL relative to the page (`../dist/x.js`), never root-absolute (`/dist/x.js`): the page is served under a path prefix
(`/p/<token>/`), and `ccc plugin link` and the marketplace check warn about the others. Expect several pages of your
panel at once, one per view: `ctx.panels.post(id, msg)` goes to all of them, `ctx.panels.post(id, msg, { view })` with
the `view` the listener was given answers only the page that asked, and your calls made from a listener act in that view.
Do not depend on URL overlays, on file-manager calls or on native dialogs working for a person in a browser, nor on
`ctx.webview` when the project is open on a desktop (the browser shows a placeholder); in server mode a webview panel works. `ccc guide panels` and `ccc guide api` carry the same text.

## Server mode

Run cc-cockpit on a machine with no display (a home server, a VM) and use it only from browsers, over web access. The
model is web access's: one person, several devices, every signed-in device is that person. What changes is that no
desktop exists, so what web access keeps on the desktop moves: who gets in is set from a shell on the server (`ccc web`),
who is in is shown by the log, `ccc web status` and the browsers' card, and approving what runs as code is done in the
browser. Linux only; on macOS and Windows `--server` prints "server mode runs on Linux only" and exits 1. Design and
reasons: [design-web.md](design-web.md) §9.

**Start:** `cc-cockpit --server`, or just `cc-cockpit` on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set
(it then prints one line saying it detected that). `ssh -X` sets `DISPLAY`, so such a session gets the desktop; use
`--server` to force server mode. The app re-executes itself in place with the headless switches (same pid, stdout and
exit status kept), so a manual run stays in the terminal, Ctrl-C quits, and a unit's main process is the app. Where the
runtime cannot re-execute in place it starts a child and watches its parent instead, chosen at start with no change for
you. It starts the web gateway and the CLI socket before any project opens; if either fails (the port is taken) it
prints the reason and exits 1. Web access is turned on and said once ("turned web access on"); turning it off, and
Desktop confirm, are refused (nobody could answer it). The change is written to `app.json`, so a later desktop start on
the same data dir (a desktop session started with no display variables, by a unit or over ssh, counts as a server run)
finds web access on, listening on its stored address; turn it off in Settings › Web access there. A stored risky setting with no confirm (a network bind with no
sign-in or plain http) is refused, never made safer: nothing listens, start prints the exact `ccc web set ... --confirm`
line, and the app keeps running so you can run it.

**systemd** (a user unit, not shipped):

```ini
# ~/.config/systemd/user/cc-cockpit.service
[Unit]
Description=cc-cockpit (server mode)

[Service]
ExecStart=/usr/bin/cc-cockpit --server
# Optional, mode 0600: CLAUDE_CODE_OAUTH_TOKEN=... (see Claude login)
EnvironmentFile=-%h/.config/cc-cockpit-server.env
Restart=on-failure
RestartSec=5
# New files (data dir, key file, sockets, and what tabs write) readable by this user only
UMask=0077
# No core dumps: one would put secrets, tokens and session keys from memory on disk
LimitCORE=0

[Install]
WantedBy=default.target
```

`loginctl enable-linger <user>` starts the user manager at boot and `systemctl --user enable --now cc-cockpit` starts
the app. `systemctl --user stop` ends it in under a second; tabs are saved and Claude tabs resume on the next start, and
open browser tabs reconnect by themselves. Output goes to `journalctl --user -u cc-cockpit`, which never holds a link.
Never run it as root: Chromium's sandbox refuses, and the app never passes `--no-sandbox`.

**The first link:** with stdout a terminal and the mode access link, start prints the address and a one-time link
(works once, expires in 10 minutes). Under systemd or in a pipe it prints the address and a hint instead, so no live
link reaches the journal: run `ccc web add-device` in a shell on the server for one. The link is never written to
`web-access.log`, which records that a start link was issued and the sign-in that used it. If someone else opens it
first, that shows as an unknown device (Revoke it) and your own copy says "already used".

**Projects:** the browser's first page is the project picker, in the desktop picker's look: the projects open now (a
link each), the recent ones (newest first, with when each was last opened; a filter field with ↑/↓ and Enter) and
"Open folder…". On a new server with nothing open or recent it is a welcome naming the server and the user it runs as,
with one Open folder button. "Open folder…" opens a folder browser on the server's folders: it starts in the start folder
(`ccc web set --start-folder <path>`; by default the server user's home, and a start folder that is gone falls back to
home with a note), shows subfolders only (dot folders behind "Hidden folders"), with a filter, breadcrumbs and Up, and
marks folders that are git repositories or already projects. A click goes into a folder; Open takes the folder shown;
a double click (or Enter on a row) takes a folder at once. "Go to path" takes a pasted path (`~` is the home folder) and
completes it with Tab from the listings. A folder the server user cannot read says so in place. It reaches any folder
the server user can read, no more than a terminal tab does; at most 1000 folders are listed at once (it says so; type
the path to go further). A recent project whose folder is gone shows as missing with Relink… (the folder browser again:
the project opens in the folder you pick, without its old tabs) and Forget (asks in the row; removes the project and its
saved tabs). `ccc open <path>` from a server shell opens one too. A click on a session of another project in the top
bar's strip takes the browser tab to that project with that session's tab selected.

**`ccc web`** is run from a shell on the server, outside cc-cockpit (a Claude, shell or command tab is refused): `status
[--json]`, `revoke <id>|--all`, `link [--regenerate]`, `add-device`, `password` (from stdin, or asked twice with no
echo on a terminal, never an argument), `mode link|password|none`, `set` (bind, port, origin, hosts, TLS, `--confirm`,
and `--start-folder` for the folder browser, `''` for home) and `stop`. A network bind with plain http, or with no sign-in, applies only with its `--confirm`, as the Settings
confirm does on the desktop. On a desktop `ccc web` answers only `status` and `revoke`. `ccc guide cli` has the
details. The wrapper is `<data>/bin/ccc` (`~/.config/cc-cockpit/bin/ccc` on Linux); the app offers no install in server
mode, so start prints that path.

**Secrets without a keyring:** server mode keeps secrets (the access link, the password, plugin secrets, OAuth tokens)
in `<data>/secret.key`, made on first start with mode 0600: AES-256-GCM, so each stored value is useless without the
key. It is no more protected than `~/.claude/.credentials.json`: whoever reads the data folder as you, or root, reads
the secrets, and a backup of the data folder carries its key. Disk encryption is the server's job. A key file that is a
symlink, not yours, readable by others or not 32 bytes is refused with the reason and is never replaced; delete it by
hand and enter the secrets again. The desktop always uses the keychain and never the key file.

**Claude login:** `claude` in a browser terminal tab prints its sign-in URL and waits for a pasted code; the credentials
go to `~/.claude/.credentials.json` and stay. For a box that must never need that, run `claude setup-token` and put
`CLAUDE_CODE_OAUTH_TOKEN` in the unit's environment file; Claude tabs get that one variable (every other
`CLAUDE_CODE_*` is still dropped).

**Reaching it:** keep it on loopback and use an SSH tunnel (`ssh -L 7330:127.0.0.1:7330 <host>`) or `tailscale serve`,
both as under Web access above. A LAN bind works with the same confirms.

**What differs from a desktop**
- Approvals are in the browser, by any signed-in device. A plugin link (`ccc plugin link`, code that runs as you) and
  the Trash confirm ask in an in-page dialog: Allow is never the default, Enter does nothing, the dialog takes no
  keyboard focus from a terminal, and Allow works only after the dialog has been visible for about a second. A browser
  can also browse the server's folders and open one (or a recent project), relink or forget a missing project, close a
  project for everyone, revoke and disconnect
  devices, read the web access card and finish a plugin's OAuth sign-in. It cannot add or widen access (mode, bind,
  secrets, new devices): those are `ccc web`.
- Nothing is shown on the server's screen. A link opens as a notice you click; a folder dialog, "Reveal in the file
  manager", "Open with the system" and URL overlays are refused ("not available in server mode"); the Browser panel works,
  streamed (below).
  A plugin OAuth sign-in redirects to a loopback address on the server, so its page fails in your browser: paste that
  failed address into the box the notice shows.
- Notices (`ctx.notify`, `ccc notify`) are in-page notices in the browsers of the project, with the tab title marked
  while one is unseen in a background tab. They do not reach a phone in a pocket: with no browser open a notice waits (up
  to its time-out) and a plugin that needs to reach you elsewhere has to do that itself. The app's own notices (a new
  device, a revoked plugin, a newer release, many failed sign-ins, a `ccc web` change of who may get in) are one stdout
  line each and are listed by `ccc web status`. The ones about access (a new device, failed sign-ins, `ccc web`
  writes such as a new password, a new link, another mode or bind) are also an in-page notice in every browser with a
  project open (one opened within 10 minutes still shows it; the project list shows none).
- A new device is seen in the card of every open browser, in `web-access.log` and in `ccc web status`, not in a desktop
  notification.
- Loopback is every local user. On a shared server anyone with a shell reaches 127.0.0.1, so mode None there (or the
  local end of an SSH tunnel on a shared client) hands the account to all of them.
- A revoke does not undo what an unlocked lost device already did from its shell (a started program, a changed file,
  a plugin linked). Revoke ends the device's access; treat what it could reach as exposed. The boundary is sign-in and the
  server's OS account.
- A desktop launch that meets a server: with a display, `cc-cockpit <folder>` on the server's own desktop does not
  open the folder in the server (it logs a line); the second launch asks the running one and shows a box "cc-cockpit
  runs in server mode on this machine (web access at ...)" with Stop and Cancel. Stop ends the server.
- A later desktop start on the same data folder finds web access on, and its stored secrets belong to the other store: the
  desktop asks for them again (a secret field shows "stored in the other mode", the access link cannot be shown until it
  is regenerated, the password must be set again; signed-in devices stay signed in), and the same in the other
  direction. Nothing moves between the keychain and the key file.
- With no theme picked, each browser follows its own light or dark setting (the server has none, and used to paint
  every browser light); a picked theme applies to all of them.
- The window is never seen. Its page is kept hidden and never sizes a terminal: a terminal keeps the size the last
  browser gave it, and a new tab no browser has sized starts at 120x40. A crash of the hidden page reloads it with a
  log line. With no project open the app stays up with the gateway; it never shows a picker or quits on its own.

**The Browser panel** (`ccc browser open <url|file>`, and every third-party `"kind": "webview"` panel) works in server mode.
The page runs in an off-screen Chromium on the server, as the desktop's would, and its picture is streamed to the
browsers that show the panel; your clicks, keys and text go back. So a local file, a dev server on the server's
`localhost` (a Vite server with live reload) and an external site all load, and `ccc browser open|url|reload`, the
toolbar (back, forward, reload, URL and title, the load error) behave as on the desktop. Design and reasons:
[design-web-browser.md](design-web-browser.md).
- *How it feels:* streamed pictures, so there is some latency and a page can look a little soft on a high-DPI screen
  (it is drawn at CSS pixels, scale 1). A page that does not change costs nothing; an animated one costs server CPU
  and bandwidth. The page has one size, like a terminal: the last screen you clicked, typed or scrolled in sets it, and
  another screen shows the same picture letterboxed; "Fit to this screen" (in the panel's toolbar) takes the size of the
  screen you are on. A panel nobody shows (closed, or its browser tab in the background) stops painting.
- *What works:* click, double click, drag, scroll, keys (letters with shortcuts, Enter, Tab, arrows, F-keys; the
  shell's own chords stay with the shell), typing including IME, dead keys and non-ASCII text, paste (Ctrl/Cmd+V),
  copy and cut (Ctrl/Cmd+C/X: the page's selection goes to your clipboard), and `<select>` dropdowns (the browser
  draws its own list; the page sees focus, `input` and `change`, not the mouse events of that click).
- *What does not:* file uploads (a file input does nothing), downloads, drag and drop into the page, sound, camera and
  other permissions, and URL overlays (`ccc overlay --url`, still refused). The page's own `alert`, `confirm` and
  `prompt` are silenced (`alert` returns at once, `confirm` answers no, `prompt` throws in the page). A `<select>`
  inside an iframe, a `multiple` or `size` > 1 list is keyboard-only (focus it, arrows, Enter). A touch drag on a phone
  is a mouse drag. A link that opens a new window (`window.open`,
  `target="_blank"`) becomes a link notice to click; it never opens a tab by itself.
- *Limits:* at most 4 pages per project and 12 per app (a `ccc browser open` past that is refused with the reason).
  The page never runs in your browser and gets nothing from it but input, pasted text and its size.
- *Not tested:* a real IME and phone keyboards, a real phone, a real server with a desktop portal on the session bus
  (the page's `print()` and file choosers are cancelled on the server regardless).

**Installs** (what was run, not what is expected to work):
- Unpacked build (`npm run package:dir`): run. The smoke script (`node scripts/server-mode-smoke.mjs <executable>`)
  starts it with no display and no session bus, checks the pid, `ccc web status`, a sign-in, SIGTERM and that nothing is
  left, and passed with the network off too.
- `.deb`: built and unpacked, never launched. It ships `chrome-sandbox`, so it is the install expected to work.
- AUR package (`packaging/aur`): unpublished and not run.
- AppImage: not run in server mode. It needs FUSE, and with no setuid sandbox helper it is inferred to abort where
  unprivileged user namespaces are restricted (Ubuntu 23.10 and later, most containers), because the app never passes
  `--no-sandbox`. Whether the in-place re-exec keeps its single mount is also unchecked.
- A stock Ubuntu Server, the systemd unit above with linger across a reboot, and `tailscale serve`: not run.
No install is called supported beyond what was run.

**Known limitations (server mode)**
- Linux only; the packaged installs above are unverified except the unpacked build.
- A notice that needs a person reaches only open browsers.
- A first start killed between creating `secret.key` and writing it leaves a file the app refuses (wrong length): delete
  it and enter the secrets again.
- Relink and forget of a project, and a Files "Download", are not available from the browser; open the folder by its new
  path instead.
- A start link read by someone else, a lost device that was unlocked, and a shared server's other users are exposures
  Revoke does not undo (above).

## Remote servers

Use a cc-cockpit that runs in server mode on another machine from this desktop app, in its own windows instead of a
browser tab. The project picker has a **Servers** section: each saved server shows its name, how it connects, its state
and its recent projects; **Connect to server…** opens a form with three tabs. Design and reasons:
[design-remote-desktop.md](design-remote-desktop.md).

**SSH (built in).** Type a **Host** (`devbox`, `me@box.example.com`, or an alias from `~/.ssh/config`), optionally a
user, port and **Name**, and choose how to sign in: *Agent and my keys* (the SSH agent, then the config's
`IdentityFile`s, else `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`), *Password*, or *Key file* (a path with a Browse button).
The agent is the config's `IdentityAgent` (1Password, Secretive) or `SSH_AUTH_SOCK` from your login environment. The app
needs no `ssh` on this machine. cc-cockpit must run in server mode on the server; the app runs the `ccc` at
`~/.config/cc-cockpit/bin/ccc`, else the one on the server's PATH. When the server's is elsewhere (a machine running both
the desktop app and a server with its own data dir: `<data dir>/bin/ccc`), set **ccc path on the server** under
**Advanced**; a connect that reached the desktop's `ccc` says so. Over the same SSH connection the
app runs `ccc web status --json` to find the server's port, version and scheme and `ccc web add-device` to pair this
device, and it listens on a loopback port of its own for the windows, so nothing but SSH is exposed.

- **Secrets.** The password or a key's passphrase is asked in a dialog when it is needed, never typed into the form. A
  wrong one is asked once more, then the connect fails. **Remember** (on by default) keeps it encrypted in the server's
  record; off, or with no keyring, it is held in memory until the app quits and asked again at the next launch. A key
  file is kept by path only. A key that needs a passphrase is skipped under *Agent and my keys* with a message to
  choose *Key file*.
- **Trust this host.** On a first connect the app shows the host's address, key type and SHA256 fingerprint and asks.
  Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server, then Trust. The key is kept with the
  server. If `~/.ssh/known_hosts` already lists the host (plain or hashed entries; the file is only read, never written),
  the app trusts that key without asking. A key that **changed** is refused, never a question: if the server was
  reinstalled, open **Edit**, tick **Forget the trusted host key**, and connect again.
- **`~/.ssh/config`.** The app reads `HostName`, `User`, `Port`, `IdentityFile`, `IdentityAgent` and `Include`, with
  `Host` patterns as `ssh` matches them; what you type in the form wins, and the file is read again on every connect.
- **Not supported by the built-in client:** `ProxyJump` and `ProxyCommand` (a host that needs them is refused with a
  hint), `Match` blocks, FIDO (`sk-`) keys, certificates, and second-factor or other keyboard-interactive prompts. A
  host that needs any of these uses **My own tunnel**.

**My own tunnel.** You run `ssh` yourself, with your whole config. Fill in **SSH host** (only for the commands), **Server
port** (the server's web port, 7330 by default) and **Local port** (7331), then run the two commands the form shows:
`ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 devbox` keeps the tunnel up, and `ssh devbox ccc web add-device` prints a
pairing link to paste into the form (on the server `ccc` may be at `~/.config/cc-cockpit/bin/ccc`). The app connects to
`127.0.0.1:<local port>`. If nothing answers there yet, the window shows the tunnel command and keeps trying every few
seconds; if something else answers, the app refuses to load it. The app cannot check that the process on that port is
your tunnel: a local process that imitates a cc-cockpit would receive the device cookie. The built-in client does not
have this exposure, because the app owns its port. When the device is revoked, Edit takes a fresh link.

**Pairing.** With SSH it is automatic, also again after a device was revoked. In password mode the server's own page
asks once, in the window. With None there is nothing to do. The device appears in the server's `ccc web status`.

**Connect Direct.** Choose **Link** and paste the access link the server printed, or one from `ccc web add-device`
(`https://server.example.com/#t=…`). A plain `http` link to a network address is marked as not encrypted.

**Edit.** A server's menu has **Edit**: change the host, user, port, sign-in, `ccc` path, ports or name. A changed host
or port drops the trusted host key, and a changed host, user, port or sign-in drops the remembered password and
passphrase. Saving an SSH server dials nothing; the next open asks for what it needs.

**Windows.** Opening a remote project gives one window per project, with the desktop's shortcuts. Links clicked in a
remote session open in your own browser here, not on the server. In a remote project window the tab strip's **+** shows this app's own
picker (local projects and your servers), and **Close project** closes the project on the server and its window here.
A click on a session of another project in the top bar's strip opens that project in its own window (or brings its
window forward) with that tab selected.

**Other machines in the strip.** Local and remote windows run different cockpits, so each top-bar strip shows its own
machine's sessions and a chip for the other one. In a local window the strip has one chip per connected server that has a
window open: the server's name with a dot and a number for the sessions waiting for you and the ones working (the
tooltip adds the idle ones), dimmed when the server cannot be reached; a click brings that server's window forward. The
counts come from the server (`GET /api/sessions`, every 5 seconds while one of its windows is open) and are all that
crosses: no session names, projects or text. A server too old to answer shows its name alone. In a remote window the strip
starts with **This computer**: a click brings forward the local project window you used last, or shows the picker when none
is open. The chips need the bundled Sessions plugin; plugins can read the same list with `ctx.sessions.machines()`.

**Forget vs revoke.** **Forget** removes the server from this app and drops its cookie, secrets and trusted host key
here; the device stays listed on the server until `ccc web revoke <device id>` (or Revoke in the browsers' card) there.

**Known limitations (remote servers)**
- Files are the server's: no Reveal in folder, Open with the system, upload or download.
- A server with TLS on is refused over SSH and My own tunnel (the tunnel encrypts already); connect Direct with its address.
- No system notifications from remote sessions.
- The server's sshd must allow TCP forwarding (`AllowTcpForwarding`); the app says so when it does not.
- With no keyring the device cookie is not remembered: every launch pairs again, which adds a device on the server.
- Windows is not supported.

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
ccc notify <text>                        show a system notification (server mode: an in-page notice in the browsers)
ccc guide [topic]                        bundled docs for Claude and plugin authors (works offline)
ccc guide types                          the plugin SDK types
ccc plugin new|link|unlink|list|logs     the plugin dev loop (see `ccc guide dev-loop`)
ccc plugin config <id> [key=value...]    show or set a plugin's settings (never a secret field)
  [--scope app|global|project]           which value a set changes (an app, global or project field)
ccc plugin config <id> --use-global <key>...   drop this project's override: the field uses the global value
ccc panel show <plugin>/<panel>          reveal a plugin's panel in this project's window
ccc <plugin command> ...                 commands plugins declare (`ccc help` lists them in a tab)
ccc web status [--json] | revoke <id>|--all | stop     web access from a shell on the server, never from a cockpit tab
ccc web link|add-device|password|mode|set              server mode only: sign-in and where it listens (see "Server mode")
```

`ccc overlay --url` is refused in server mode (exit 1, "not available in server mode"): there is no desktop to draw the
page on. `ccc notify` in server mode reaches the browsers with the caller's project open, or every browser when it names
no project; one naming a project with no open window is dropped.

`ccc overlay` prints the result as JSON. Exit codes: 2 for a usage error (message on stderr), 1 when
the request is refused (and for `ccc web` when the app is not running), 124 when a plugin command exceeds its 30 s limit (its output is capped at 256 KiB), the app closes the connection or never answers, or the command's stdin is not closed within 40 s (pipe the input or redirect `</dev/null`), 0 otherwise. A plugin that is reloading or still starting is waited for inside the 30 s, so a command right after an edit runs in the new copy (a call already running in the old copy ends with 1). Inside any cockpit tab (Claude, shell or
command) or terminal overlay the window is known from the environment; outside the app, pass
`--project`. Only a Claude tab is a Claude session: `session note`/`steps` are refused elsewhere. When the app is not running `ccc`
exits 0 silently, so it can never fail a Claude hook; the exceptions are `guide` and `help`, which work offline, and
`ccc web`, which prints "cc-cockpit is not running" and exits 1. On Linux the wrapper of an AppImage build
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
- Closing a whole project window, or quitting, does not ask, even with running tabs. With a browser attached to the
  window, closing it asks "Close for everyone" (the browser is told the window closed) or "Keep running for <device>":
  the window is hidden and its tabs keep running for the browser. Opening the project again (the project picker,
  `ccc open`, the dock, or starting the app again) shows it; a plugin or a click in a browser never does. On Linux there
  is no dock: a window kept running there comes back through the picker of another window, `ccc open` or starting the
  app again. Quitting closes the browsers with a notice ("quit on the host"); they do not reconnect on their own.
- Web access signs a browser in with the access link, a password or a desktop confirm (or not at all, None). A wrong
  password is slowed down (one shared limit for every sign-in, about one try a second once a burst is used up), never
  locked out; under a sustained flood of tries a new sign-in, the person's own too, is answered "busy" until it stops.
  Changing the password signs out every browser that signed in with the old one. With no working keychain no password
  can be set. Desktop confirm: one browser can wait at a time (another is told to try again; anyone who can reach the
  address can keep that one place taken, each time showing as a request to deny), and a request is gone after 2
  minutes or three wrong codes. The request card shows in every project window, not in the project picker window.
- Web access listens on 127.0.0.1 by default. Another address (0.0.0.0 for every network, or one of the computer's
  own) can be set in Settings; over plain http, or with no sign-in, it asks to confirm first (Cancel keeps the
  address as it was), and the top bar shows a warning while it is on. A confirm holds only while web access stays on
  with the same address, external address and certificate: changing one of them, or turning web access off, asks
  again. A bind or a sign-in mode edited by hand in `app.json` with no confirm does not listen (the confirm guards the
  settings page, not the file: whoever edits `app.json` can also write the confirm in it). With a certificate and key file it serves https; the files are
  read when web access starts, so a renewed certificate takes effect after turning web access off and on (or a
  restart). The bind is an IP address, never a name. Listening on 0.0.0.0, the link names the computer's first LAN
  IPv4 address; for a certificate made for a name, enter that name as the external address. With no sign-in, Revoke
  has no effect (anyone who can reach the address comes back in).
- Web access keeps a headless copy of each terminal in a worker. If that worker crashes or hangs, it is restarted and
  each copy starts again from the desktop window's screen of that tab (its scrollback up to 5,000 lines, the alternate
  screen, mouse and cursor modes). A tab whose desktop terminal was itself behind at that moment starts blank: a
  terminal that resyncs before its program redraws (a desktop page reload, a view that fell behind) then shows a blank
  screen until Claude redraws, and a shell tab until it prints again. After three restarts within a minute web access
  stops mirroring until it is turned on again, and the tabs run as with web access off.
- Turning web access on while tabs run starts each tab's copy from the desktop window's screen of it, at its current
  size, so a browser that opens such a tab sees what the desktop shows, a full-screen program (Claude Code, htop) on
  its alternate screen with mouse tracking included. The desktop has a few seconds to answer; meanwhile that tab's
  output waits (a program printing a lot pauses briefly) and its terminal queries are answered once the copy has
  started. If the desktop does not answer in time (its window still loading, for example), the copy starts blank and a
  browser sees only what the tab printed since, until its program redraws; a full-screen program that turned on the
  alternate screen and mouse tracking before then is shown on the normal screen, its redraws piling up as scrollback,
  until it starts again. Still lost, as for any copy: charsets, tab stops and the cursor position saved by the program.
  A desktop tab still catching up on output at that moment
  stays paced by the desktop until it has caught up, so it is not resynced from that copy. Turning it off closes the browsers with a notice and waits
  up to 5 seconds for a desktop tab that fell behind to be resynced before it ends the copies.
- While web access is on, the app itself answers a program's terminal queries (cursor position, device attributes,
  modes, the foreground, background and cursor colours from the theme of the place that typed in the tab last, else
  the one sizing it, else the computer's) and the terminals' own answers are dropped.
  Palette colour queries (OSC 4) go unanswered then, a see-through window reports the theme's background rather than
  the transparent one, and Shift+F3 / Ctrl+F3 (the same bytes as a cursor position reply) do not reach the program.
  A query the program sends in the moment web access is switched on or off can go unanswered.
  It can also be answered twice: switching web access off right after a query that the app already answered can let the
  desktop's own reply, still unparsed in its terminal, reach the program as well. A tab that was already running when
  web access was switched on (or whose copy was reset) is answered from the copy started from the desktop's screen, or
  from a blank one when the desktop did not answer, so a cursor position or mode query then reports the top-left corner
  and default modes rather than the program's real state.
- A terminal shown in several places (the desktop window and browsers) has one size: the place that typed last (after
  half a second without the other typing), that pressed "Fit to this screen", or where you clicked or focused the
  terminal, selected its tab (a click in the tab bar, the tab switcher, a tab shortcut, or a new tab made with +; not a
  tab selected by a plugin or the Sessions panel, nor the neighbour of a closed tab), brought its window or browser tab
  to the front, or opened or reloaded the browser page (at once). The others draw it at that size, scaled
  down (a smaller font, never below 70%; past that the terminal scrolls, kept at the bottom and the cursor) when it is
  larger than their pane, with empty space when it is smaller. A
  minimized window or a browser tab in the background never sizes a terminal while another place shows it.
- Keys typed in a browser are the person's, as on the desktop: they mark the tab as typed in (plugins can no longer
  send to it) and answer Claude's dialogs. Keys from the desktop and browsers typing at once interleave, as two
  keyboards on one machine would; there is no turn-taking. When the last keys in a tab came from another place, its
  terminal shows "Typed last on <device>" (the browser's device name, or "Desktop"); never for your own typing, so
  never with web access off.
- An html overlay's page (a plugin's page, `ccc overlay --html`) and a plugin's settings page are open in one place at
  a time: where the overlay was opened (the place whose click opened it, else the desktop), or where the settings page
  was opened last. The other places show "Open on <device> — Take over"; Take over loads the page there anew (as a
  reload: whatever the page had typed but not sent is lost) and the other place shows the note instead. When a browser
  holding an overlay's page leaves (or reconnects), the page goes back to the desktop. When the place holding a settings
  page closes it, a place showing the note loads it.
- Some things only the desktop can do. In a browser, a link a page or plugin asks to open (`openExternal`, the update
  notice's release link) opens in a new tab at once when it follows the person's click by a few seconds at most, and
  otherwise shows as a notice to click (a browser blocks a tab nobody clicked for); the host's own browser is not opened. Showing a file in the file
  manager or opening it with its default app is refused with a message (the Files menu leaves those two items out in a
  browser; a plugin page reads `ccPanel.view.remote`, a UI hint only), and a plugin's OAuth sign-in says to sign in
  on the desktop. Notifications stay on the host, as on the desktop. While a browser is attached, Move to Trash
  confirms in an in-page dialog on every place (first answer wins) and a browser may answer Move too: the Trash is
  recoverable, and the person in the browser is often the one who asked; with none attached it is the native dialog. A URL overlay, or the Browser panel of a project open on a desktop, shows "available on the desktop". While a browser is attached,
  the confirm of `ccc plugin link` is an in-page dialog on every place (first answer wins); a browser can only Deny it
  (it says "Approve on the desktop"), Allow is the desktop's; with none attached it is the native dialog.
- A browser keeps some chords for itself and never passes them to the page: Ctrl+W, Ctrl+T, Ctrl+N (Cmd on a Mac),
  with or without Shift, and Ctrl+Tab / Ctrl+Shift+Tab. In a browser the cockpit's commands bound to one of them use
  the same chord with Alt (Option) added: New Claude Tab Ctrl+Alt+T (⌥⌘T on a Mac), New Shell Tab Ctrl+Alt+Shift+T,
  Close Tab Ctrl+Alt+W, Close Top Overlay Ctrl+Alt+Shift+W, the tab switcher Ctrl+Alt+Tab. The menus and the palette
  show the chord that works there; Settings > Keys shows and edits the desktop's. A command whose Alt chord belongs to
  another command has no chord in the browser (the palette still runs it), and a chord rebound to one the browser
  leaves alone works as it is. Which chords count follows the browser's system while the table is the host's: a Mac
  host's Cmd chords are Meta (Windows or Super key) chords in a Linux or Windows browser, which the system often takes,
  some Linux desktops take Ctrl+Alt+T for themselves, and on Windows (and Linux layouts with AltGr) Ctrl+Alt is AltGr, so on a layout where AltGr+T, W or N types a character the Alt chord takes it from the terminal. Ctrl+W typed in a browser terminal (a shell's "delete word")
  closes the browser tab.
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
