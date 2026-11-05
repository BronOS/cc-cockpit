# cc-cockpit — design

Status: agreed in brainstorm, 2026-10-29. Source of truth for the phase-1 implementation plan.

## 1. What cc-cockpit is

A desktop app (Electron) that wraps Claude Code terminal sessions and adds a cockpit around them:

1. **Terminal**: tabs running `claude` (or a shell) in the central zone, with the ability to send
   text into a running Claude session safely.
2. **Claude status**: core tracks every in-app Claude session (working, waiting, needs
   permission, changed files) across all windows, with a status dot on each tab; the views of
   them (the Sessions panel, the other windows' strip) are the bundled `cockpit.sessions` plugin's.
3. **Plugins**: everything source-specific (Jira, Gmail, calendar, Forgejo, file tree, editor…)
   is an externally installed plugin that brings its own data, panels, settings and triage.

**Project = folder; one window holds one project.** Settings, enabled plugins and layout belong
to the project.

### What belongs in core

**Core is the foundation for plugins plus the base functions every user needs without any
plugin.** A feature is core only if at least one holds:

1. everyone needs it with no plugin installed (projects and windows, terminal tabs, Claude in a
   tab with status, send gate, hooks and resume, themes, keys, settings, the `ccc` CLI);
2. only main can do it safely (PTYs, checking which window or host asks, the OS keychain, typing
   into a Claude session);
3. it connects parties that cannot reach each other directly (plugins ↔ Claude sessions,
   plugins ↔ their panels, the outside world ↔ the app through `ccc` and hooks, plugin ↔
   plugin through `ctx.services`).

Everything else is a plugin, even if every user installs it. Named accounts fail all three, so
they left core (removed in 2026-10); what stays is what only main can do: `ctx.secrets`, the
secret settings field and the optional `ctx.oauth` helper (§6). The Claude status *view* (the
Sessions panel, the other windows' strip in the top bar) fails them too and left the renderer in
0.10 for the bundled `cockpit.sessions` plugin; the session registry, hooks, status, the send gate,
the title reader, gist, restore and the tab strip's dots stay (§3).

### Phase 1 scope

In: projects and windows, zones and panel moving, terminal tabs, Claude status (tab dots, top
strip and Sessions panel, since 0.10 the bundled `cockpit.sessions` plugin's; notes/steps), overlay stack, plugin host and API, plugin secrets and
sign-in helpers (`ctx.secrets`, secret settings field, `ctx.oauth`), settings, themes, commands
and keybindings, CLI, the `hello` reference plugin.
Clicking a changed file opens the bundled reviewer (`cockpit.reviewer`, §5 "Bundled plugins"); with it off, `git diff` in a
terminal overlay.

Out (later, each real plugin in its own design session): every real data plugin, editor and
file tree, drag-and-drop of panels, a plugin registry server (the marketplace is a static index, see §5), binary
downloads, Windows builds, sessions that outlive the app.

### Decisions log

| Question | Decision |
|---|---|
| Sessions on quit/crash | They die; on start each Claude tab reopens with `claude --resume <id>` |
| Which Claude sessions are tracked | Only the app's own tabs, across all project windows |
| Plugin trust/runtime | VS Code model: backend in a Node plugin host, panels in sandboxed iframes |
| Plugins vs projects | Plugins are app-wide; each project enables plugins. No named accounts: a plugin brings its own sign-in (§6) |
| Project settings storage | App data dir, keyed by folder path (repos stay clean) |
| Panel placement | Manifest default zone; zone menu (header "…" or icon right-click) to move/hide; saved per project |
| Overlay | Stack over the whole window; Esc pops the top one (not a terminal one: Esc is its program's) |
| Plugin install | Git URL pinned to a tag, a linked local folder (dev), or the Marketplace: a static index file in a git repo, no registry server (§5, Marketplace) |
| Phase-1 plugin API | UI + background, settings + secrets, session access, commands/keys/themes |
| Data model | **Silos**: each plugin owns its data and triage. No core item store. Services (below) let plugins of one project call each other, so a plugin can read from several others without a shared store |
| Process layout | One plugin host per project window (option A) |
| Shell UI | React |
| Plugin CLI commands | Flat top-level names (`ccc browser open …`); a name taken by core or another plugin refuses the install, link or update (§5, §6) |
| Claude skills | Stay in the app data dir (`<data>/claude-plugins/`), loaded only into Claude sessions the app starts (`--plugin-dir`); nothing is written to `~/.claude` (§5 Skills) |
| Embedded web view | A core primitive (only main may create a `WebContentsView`): the `webview` panel kind plus `ctx.webview`; the browser plugin is built on it (§5 Web view) |
| Plugin services | A plugin declares `services.provides` / `uses` (name + whole-number major) and calls others through `ctx.services` (§5 "Plugin services"): addressing by service name, two providers allowed with a per-project pick, a missing provider does not block enabling (calls throw, the Plugins page warns), calls and events both in scope |
| Browser scope | Foundation plus a minimal built-in browser; a full one (tabs, history, devtools) gets its own design session |
| "Install Claude skill" button | Dropped: with `--plugin-dir` it would only matter for Claude sessions started outside the app, which the Claude-operable foundation does not target |

## 2. Processes and responsibilities

```
main (Electron)
 ├─ windows: one per project (folder), plus a project picker when none is open or on request
 ├─ PTYs: node-pty per terminal tab (owned here, never in a renderer)
 ├─ session registry: tab → {project, cwd, claude session id, status, files}
 ├─ app store: app settings, project settings (keyed by path), installed plugins
 ├─ secrets: per-plugin encrypted store in the OS keychain (safeStorage)
 ├─ CLI socket: <data>/app.sock (Unix socket / named pipe on Windows)
 │
 ├─ window "my-project" (renderer)
 │    ├─ shell UI: zones, icon strips, tabs, overlay stack, top strip
 │    ├─ xterm.js per tab ⇄ IPC ⇄ its PTY in main
 │    └─ panel iframes (sandboxed) ⇄ MessagePort ⇄ plugin host
 └─ plugin host "my-project" (utilityProcess)
      └─ plugins enabled in my-project: activate(ctx) with my-project's settings and its plugins' secrets
```

- **main is the only authority.** Renderers and plugin hosts ask; main knows which window or
  host is asking and acts only within that project. A plugin can see only its own window's tabs.
  This is enforced by main, never by trusting an id the plugin passes.
- **Trust boundary, honestly stated.** Plugins have full Node access (like VS Code extensions),
  so per-window hosts protect against mistakes (bugs, mixed-up state, crashes), not against a
  malicious plugin. Installing a plugin means trusting its author. The CLI socket requires a
  per-tab token so nothing poses as a session by accident. There are two kinds, decided by main's
  own lookup and never by anything the CLI sends: a Claude tab's **session token** is good for
  everything (hooks, `session note`/`steps`), and a shell tab's, a command tab's or a terminal
  overlay's **window token** only selects that window's project, as `--project <path>` would,
  for the window-level commands (§6); every command that needs a Claude session refuses it. A
  window token grants nothing `--project` does not already grant any local process; it only spares
  naming the folder and keeps naming the right window after the shell cd's elsewhere. Main mints
  each token at spawn and revokes it when the tab (or overlay) closes; Restart mints a fresh one.
- **Renderer** runs with `contextIsolation` and a minimal preload.
- **No daemon.** Quitting ends everything. On launch main reopens the last projects' windows;
  each window reopens its tabs and starts its plugin host.
- **The CLI** talks to main over the socket. If the app is not running it exits 0 silently:
  a Claude hook must never fail a session.

## 3. Terminal tabs and Claude sessions

**Tabs** (central zone): a Claude tab (main spawns `claude` in a PTY, `cwd` = project folder or a
subfolder), a shell tab (`$SHELL -l`), or a command tab (below). GUI apps on macOS do not get the
shell's PATH, so main reads the environment from `$SHELL -l -i` once at startup and uses it for
every PTY.

**Custom commands.** The [+] menu lists Claude and Shell, then the user's own entries: the
app-wide ones (Settings › General › Commands in the new-tab menu; `app.json` › `tabCommands`), then this
project's (Settings › This project; the project record's `tabCommands`), a separator before each
group. An entry is a label (1-60 characters, one line) and a command line (1-4096 characters, no
NUL), at most 50 per level: `lazygit`, `npm run dev`, `docker compose logs -f | grep api`.
Picking one opens a tab titled by the label that runs the command **in the user's login shell**,
as if typed into a terminal: `$SHELL -l -i -c <command>` (the flags of the login-env capture, so
.zshrc aliases and functions work), with the same env and PATH as every tab, in the project
folder. The shell parsing the command is deliberate and is not the argv-only rule's concern: the
text is the user's own setting, never renderer, plugin or hook input, and it still travels as one
argv element. Main is the authority: the renderer's `tabs.create` names the entry by level and id
and main looks the command up in its own settings (unknown id: refused); a command or label in
the payload is never read, and plugins cannot open command tabs (their tab APIs open Claude tabs
only). Ids are minted by main; a saved list may keep only ids its level already has. A damaged
settings file costs its bad entries (dropped on read), not the menu; saving refuses an invalid
list as a whole. The tab keeps its own copy of label and command: editing or deleting the entry
later does not change an open tab, its Restart, or its restore. A command tab is like a shell tab
otherwise: a window token, not a session token (§2: `ccc browser open …` after `npm run dev &`
reaches the window without `--project`; `hook` and `session note`/`steps` are refused), not in
the session registry, the status strip, `ccc sessions` or plugin `sessions` events; Exit (below) applies as to any tab: a clean
exit closes it, a failure keeps "exited (code N): Restart · Close", and Restart runs its command
again.

*Open as overlay.* Each entry also says where it opens: Tab (the default) or Overlay (a select per
entry in both editors; stored as `open: "overlay"` and only then: an absent or damaged value is a
tab, so files from before the field keep opening tabs). An overlay entry (`lazygit`, `yazi`)
opens a terminal overlay (§4 Overlay stack) in the window it was picked in, titled by the label:
the same `$SHELL -l -i -c <command>` argv, project folder and env as its tab would get (the
overlays' env is the login env with the overlay's own window token for the window it is shown
in, and no `APP_TAB_ID`; the token dies with the overlay). It
closes when the program exits, whatever the code (nothing is shown for a failure: the program's
own screen was the place for that), or on Cmd+Shift+W / ✕; Esc goes to the program like in every
terminal overlay. Nothing about it is saved or restored, and it has no Restart. Main decides tab
vs overlay from its own entry when `tabs.create` arrives (the menu's mark is only a hint; a
stale menu or a forged request cannot pick), and answers `null` instead of a tab for an overlay.
A program that cannot start fails the click like a tab's would (OverlayManager.start throws
before anything is on the stack). Every [+] menu row starts with an icon for where it opens: a
tab (Claude, Shell and tab entries) or two stacked panes (overlay entries); the chord stays at
the right edge. Two picks open two overlays, stacked; in practice
the second pick waits, since the menu and every non-overlay chord are inert while an overlay is
up. Plugins still cannot start entries.

*Keys for entries.* Every entry is also a command of the key table:
`tab.newCommand.app.<entryId>` / `tab.newCommand.project.<entryId>`, titled "New tab: <label>"
("Overlay: <label>" for an overlay entry; the id is the same either way, so switching keeps the
chord).
An app-wide entry's command exists in every project window, a project entry's only in that
project's (like a plugin's commands). None has a default chord: the user binds one in the
keybinding list (Settings › Keybindings) like any command, with the same overrides
(`app.json` › `keyOverrides`, keyed by the command id, so a rename keeps the chord), conflict
warnings, Unbind and Reset. The [+] menu shows an entry's chord next to its label, and the
palette lists the entries. The chord opens the tab the menu's way, by level and id (main looks
the command up); like every chord it does nothing while the settings screen, an overlay, the
palette or the close dialog is up. Saving a level's list sends the new key table to the windows
that see that level (all for app-wide, the project's for a project entry), so an added entry is
bindable at once and a removed one's chord stops firing. The removed entry's override stays in
`app.json`, ignored like any override for an unknown command (an id from a hand-edited file may
be shared by two projects' entries, so it is not pruned).

**Exit.** A tab whose process ends normally closes, exactly as if the user clicked Close; what
"normally" means depends on the kind. A Claude tab (`/exit`, Ctrl+D) and a command tab (`lazygit`
quit with q) close only on exit code 0 with no signal: a crashed `npm run dev` keeps its output
visible. A terminal (shell) tab closes on any exit code, because a shell's exit code is the status
of the user's last command, not whether the shell ended normally (zsh leaves `$?` = 1 at the first
prompt when the rc files end on a failing command, and `exit` after Ctrl+C returns 130). It keeps
its banner only when killed by a signal or when it exited within 1 s of its spawn
(`SHELL_MIN_LIFE_MS`, counted per process, so Restart resets it): a broken `$SHELL` or an rc file
that dies must not vanish silently. Main decides and tells
the window (`tabs.removed`); the session leaves the status strip, `ccc sessions` and plugin
`sessions` events; a Claude tab's record (and its session id) leaves the restore record. Any other
exit (by the rules above) keeps the tab with "exited (code N): Restart · Close",
so a failure stays visible. Exceptions that never close: a Claude tab started with `--resume`
that has not reported its SessionStart yet, or whose resume failed (its saved id must survive
until a fresh process replaces it), and tabs that end because the app is quitting (they restore
next launch). The last tab closing leaves the window open and empty. The app setting "When a
tab's process exits" (Settings › General › Tabs; `app.json` › `tabExit`) switches between
this (`close-clean`, the default) and `keep`: every exited tab stays with its banner. It is read
at each exit, so a change applies to open tabs. Terminal overlays are not tabs: they close when
their program ends, whatever the code.

**Close.** A tab the user closes while its process is still running asks first: "Close
“<tab>”?", with a Claude tab's status ("Claude is working in this tab"), Cancel focused (Enter alone
keeps the tab), Close, and a "Don't ask again" box that, with Close, turns the setting off. Every
close the user starts goes through the same check: the tab's ×, the tab menu's Close, Close Tab by
key (Cmd+W) or from the palette, and the exited banner's Close (which never asks: its process
ended). There is no middle-click close.
A tab that has exited, and a restored command tab that is not started, close at once. Closes that
are not a user's click never ask: a clean exit (§3 Exit), a plugin or main closing a tab, a
project window closing, the app quitting (the last two kill running tabs without a question; out of
scope for now). The question is a modal of the renderer (`CloseTabDialog`): the strip and the
zones under it are inert and the key handler runs no command while it is up, so no key typed there
can reach a terminal; Esc and a click outside cancel; an overlay opening dismisses it as a Cancel,
and so does its tab going meanwhile. The app setting "Ask before closing a tab that is still
running" (Settings › General › Tabs; `app.json` › `confirmTabClose`, default on; only `false`
turns it off) is read from main at each close (`settings.confirmTabClose`), so a change made in one
window applies to the next close in every window.
The × sits after the tab's label (status dot, name, queued chip, then ×) or, with "Close button
position: Left" (Settings › Appearance › Tabs; `app.json` › `tabCloseSide`, `'right'`
by default; anything but `'left'` reads as right), before it. It moves in the DOM, not by CSS
order, so keyboard focus follows what is drawn. An overlay's header ✕ follows the same setting
(before or after its title), so it sits where the hand already goes for a tab's ×.

**First tab.** A project window that opens with nothing to bring back (from the picker, `ccc
open`, File › Open Folder, the command line) gets one Claude tab in the project folder, started by
main exactly as "New tab › Claude" would. Eligibility is fixed when the window opens: a window
with a queued restore plan, or whose saved record still holds tabs (a project whose folder was
missing at launch), is never given one, even when every restored tab fails to start; a fresh tab
there would be one nobody asked for, and for the saved record it would overwrite the session ids
waiting in it. The tab starts when the window's renderer first attaches, after its restore has
resolved and the login env is known (as restored tabs do, so no early output is lost), and only if
the project has no live tab at that moment: a tab a plugin opened during startup wins. It fires at
most once per window open; a page reload or the last tab closing later (by hand or by a clean
exit) never brings one back. A missing `claude` gives the usual exited banner. The app setting
"Open a Claude tab when a project opens with no tabs" (Settings › General › Tabs; `app.json`
› `claudeTabOnOpen`, default on; only `false` turns it off) is read at that attach.

**Wiring.** Main launches `claude --settings <app>/hooks.json` with `APP_TAB_ID` and
`APP_TAB_TOKEN` in the environment. The hooks run `<app> hook <event>`, which forwards the hook's
stdin JSON plus the token to main over the socket. The user's global Claude settings are never
touched; Claude outside the app is never seen.

**Status per tab**, from hook events:

| Event | Status |
|---|---|
| `SessionStart` | idle (a working tab stays working when `source` is `compact`: auto-compaction mid-turn); `session_id` stored for `--resume` |
| `UserPromptSubmit`, `PreToolUse` | working (current tool shown) |
| `PreToolUse` of a dialog tool (AskUserQuestion, ExitPlanMode) | needs permission, shown as "needs you · question" / "needs you · plan approval" |
| `Notification` (permission) | needs permission |
| Enter or a digit typed into a needs-permission tab | working (the dialog was answered); not for a dialog tool |
| `PostToolUse` | working (a dialog tool's: the dialog was answered, its tool name cleared) |
| `Stop`, `Notification` (idle) | waiting for input |
| `SessionEnd` / PTY exit | ended |

`PostToolUse` for Edit / Write / MultiEdit / NotebookEdit adds `file_path` to the tab's
changed-files list; it is also registered for the dialog tools, whose PostToolUse is the one sign
that their dialog was answered.

*Dialog tools* (`DIALOG_TOOLS`, `shared/hooks.ts`) are the tools whose call is a dialog the user
answers: AskUserQuestion (a question with options) and ExitPlanMode (plan approval). Claude is
blocked on the user from their `PreToolUse` on, and no Notification comes for them, so that hook
puts the tab in *needs permission* at once: the strip sorts it first and tints it, the send gate
holds text (its Enter would pick an option). The status stays `needs-permission` for plugins and
`ccc sessions` (with the tool naming the dialog); only the renderer's wording differs. An answer
key does not take a tab out of a dialog tool (several questions take one Enter each); the tool's
`PostToolUse` or any later hook does. The list is the terminal CLI's tools that declare
`requiresUserInteraction` (claude 2.1.316); EnterPlanMode asks through the ordinary permission
flow. A background subagent's tool hook while the dialog is up moves the tab to working: wrong
on screen, still not sendable.

**Sending text into a session** — the core safety rule:

- Allowed only while the status is *waiting for input*.
- Sent as a bracketed paste (`ESC[200~ … ESC[201~`) followed by Enter, so multi-line text
  arrives as one message.
- If busy, the text is queued and shown as a "queued" chip on the tab; delivered on the next
  `Stop`, cancellable from the chip.
- Never sent while *needs permission*: a keystroke must never answer a permission prompt, a
  question or a plan approval.

**Claude status UI.** Core keeps what only main can do or every tab needs: the session registry,
hooks, status, the send gate and queue, the title reader, gist, restore, and the tab strip with its
status dots. The views of the sessions are the bundled **`cockpit.sessions`** plugin's (§5 "Bundled
plugins", design-next §4), built on the public API only:

- each Claude tab shows a status dot where shell and command tabs show a glyph of their kind;
  a *working* dot pulses (a slow ring), off under `prefers-reduced-motion` (core);
- the **top bar** (§4 Window chrome) is the project's name and folder, the app slot
  `sessions-strip`, a "+" ("Open project…", the project picker, so the bar is shown even with no
  Claude tab anywhere) and a gear (the `app.openSettings` toggle). `cockpit.sessions` draws the
  slot: the Claude tabs of the *other* windows (project · status · tool), the ones needing you
  first and tinted, a dot in each project's colour, a click through `ctx.sessions.focus` (that
  window raised at the tab). It reads them with `ctx.sessions.list({ scope: 'all' })`, which needs
  its `"access": { "sessions": "all-windows" }` declaration and carries status, tool, title, name
  and the project only. A window's own session snapshot (`sessions.snapshot`) holds its own tabs
  and nothing else. With no other window's session the page draws nothing; with no provider (the
  plugin off, or the pick "None") the bar is the name, the "+" and the gear. The frame takes room
  only once main handed its page a port, so a provider that stopped in between leaves no gap;
- the **Sessions panel** (`cockpit.sessions/sessions`, default zone left): a card per Claude tab of
  the window with name or title, gist or last prompt (main takes Claude's paste wrappers,
  `<pasted_content id="…">` and its closer, out of the hook's prompt before storing it, keeping the
  pasted text, so every consumer gets the text the user saw: `main/sessions/paste-wrappers.ts`),
  status, notes, steps done (a count over a small bar) and changed files under an "N changed files"
  caption; a card click selects the tab (`ctx.sessions.focus`), a file click goes through
  `ctx.sessions.openFile` (main checks the file is one it recorded for the tab and routes it: the
  `@open-file` pick, else the built-in viewer). Its header meta counts the window's sessions ("2 in
  this window"). A layout stored before 0.10 holds the old core key `core/sessions`: it is read as
  `cockpit.sessions/sessions` in the same zone, order, open state and size
  (`RENAMED_PANEL_KEYS`, `shared/layout.ts`).
- **Replacing it**: another plugin provides `sessions-strip` and appears in its pick; the panel is
  replaced by turning `cockpit.sessions` off (project or app-wide) and enabling one's own. With
  neither there is no strip and no Sessions panel; the tab dots, `ccc sessions` and notifications
  work as ever.
- **Prompt cleaning.** Claude Code delivers its own input as user turns (`<system-reminder>`,
  `<task-notification>`, `<agent-message>`, `<bash-input>`/`<bash-stdout>`, `<command-name>`/
  `<command-args>`, `<local-command-stdout>`, …), and UserPromptSubmit reports them as the prompt.
  Main cuts those blocks out before the paste unwrap (`main/sessions/harness-markup.ts`, known tag
  names only, closed blocks only, linear time): a turn of nothing else keeps the previous
  `lastPrompt`, a slash command reads `/name args`, a `!` command `! command`.
- **Session name.** Main reads OSC 0/2 (the terminal title) from each Claude tab's PTY output as it
  flushes (`main/sessions/terminal-title.ts`, across chunk boundaries, bounded, other OSC numbers
  skipped). Claude Code sets `✳ <topic>` with an animated status glyph (`◐`/`◑` while working) and
  plain `Claude Code` before a topic exists; main strips the glyph and control characters, ignores
  the generic and the empty title (the reset at exit), and stores `title` on the entry only when it
  changes, so the spinner never causes a broadcast. The tab strip and the Sessions panel show it in
  place of "Claude · folder" / "Claude N"; plugins get it in `SessionInfo.title`, and a plugin with
  the `access` declaration in `SessionSummary.title` for other windows' tabs.
- **Active tab.** The renderer reports its tab pane's selection (`tabs.selected`, on every change of
  `activeId`); main keeps it per project only when the id is one of the sender's project's tabs
  (`SessionRegistry.setActive`, cleared when the window closes) and plugins get `SessionInfo.active:
  true` on that tab, absent elsewhere and on every tab while a shell tab is selected. A change is
  reported for the tabs that gained and lost it, so it reaches `ctx.sessions.onChange` through the
  usual throttle. It is the selection only, not window focus.
- **Changed files per session** (`cockpit.sessions`' app setting `filesShown`, Settings › Plugins ›
  Sessions, a whole number 1–500, default 10): the Sessions panel lists that many of a card's
  changed files and puts the rest behind Show all (N more) / Hide (N); the open/closed choice is the
  card's own state, not stored. It was the core `app.json` › `sessionFilesShown` until 0.10: main
  copies a valid value into the plugin's setting once at start and drops the old key
  (`main/settings/sessions-migration.ts`).
- **Session gist** (Settings › General › Claude sessions; `app.json` › `sessionGist`, off
  unless exactly `true`): after a turn ends (entry
  moves into *waiting*) and the tab's last five cleaned prompts changed since its last run, main
  runs `claude -p --model haiku --safe-mode --strict-mcp-config --no-session-persistence
  --disable-slash-commands --tools ""` with the prompts (at most 4000 characters, newest kept) on
  stdin, in the OS temp folder, with the tabs' env minus every tab variable (`claude` resolves on
  the same PATH). `--safe-mode` turns off the person's hooks, MCP servers, CLAUDE.md and plugins
  but keeps their login (`--bare` would not). Bounded: 60 s timeout (SIGKILL to the group), one run
  per tab, at least 60 s between a tab's runs (later turns coalesce), two at once app-wide;
  failures logged, never shown. The first output line is the entry's `gist`, shown under the name
  in place of the last prompt. Off cancels runs and clears every gist
  (`main/sessions/session-gist.ts`, `gist-run.ts`).

**Restore.** Main saves each project's tabs (kind, cwd, `session_id`, order; a command tab's own
label and command); on next start Claude tabs reopen with `claude --resume <id>`, shell tabs start
fresh. Command tabs come back **not started**: a re-run of something like a deploy on app launch
would be a nasty surprise, so the tab is restored without a process (gen 0), shows "not started"
with Restart · Close, and runs only when the user clicks Restart. A saved command tab whose label
or command no longer validates is skipped. A running tool call does not survive. A window
*reopen* (§4 Window background) goes through the same path without a quit: the tabs are saved and
queued from the live ones as the window closes (`TabRestorer.requeue`), overlays are not restored.

## 4. Window layout, zones, overlay

```
┌─● ● ●─ project ~/path │ slot sessions-strip (other windows)   [+] ───────────────── ⚙ ─┐
├──┬────────────┬─────────────────────────────────────────────┬────────────┬──┤
│ic│ panel A  … │ tabs: ( claude ● | claude ○ | >_ zsh ) [+]  │ panel X  … │ic│
│on│────────────│                                             │            │on│
│s │ panel B    │            terminal (xterm.js)              │            │s │
│  │            │                                             │            │  │
├──┴────────────┴─────────────────────────────────────────────┴────────────┴──┤
│ icons │ panel C  │ panel D  │                bottom zone                    │
└────────────────────────────────────────────────────────────────────────────┘
```

**Zones.** Left and right: an icon strip plus a panel area where open panels stack vertically
with draggable splitters. Bottom: the same, panels side by side. A click on an icon toggles its
panel; each zone collapses with a keybinding. Sizes, open panels and order are saved per project.
Plugins set a badge on their icon (a count or a "needs you" dot). The zone menu (move to
left / right / bottom, or hide) opens from the "…" button in a panel's header or a right-click on
its icon. Hidden panels are listed under a "···" at the end of each strip. A collapsed bottom zone
keeps its strip, captioned "Bottom zone collapsed" with its key.

**Panel column and slots.** A plugin panel's frame sits in a column with the slot frames its plugin placed (`ctx.panels.slots`, §5 Slots): the `top` ones above, the `bottom` ones below, each at its placement height (24 to 600 px, within the provider's `minHeight` / `maxHeight`; a page may ask for less with `ccPanel.slot.setHeight`), and together at most 40 % of the panel's height each side so a slot never pushes the panel off. A slot frame is the provider's page in a sandboxed iframe the shell draws (`SlotFrame`, the panel loader and CSP); the host panel gets no handle on it. A hidden panel or a collapsed zone unmounts the panel and so its frames (the provider hears `onClose`); a webview panel sits in the same column. The top bar draws the app slot `sessions-strip` between the project name and the "+", taking the bar's height and the width left once its page has a port (before that, or with no provider, or "None", the bar is the name, the "+" and the gear); core draws no strip of its own (`cockpit.sessions` provides it, §3).

**Auto-hide.** The terminal is the priority. When the window narrows so the centre would be under
the minimum terminal width (Settings › General › Side panels; `app.json` › `zoneAutoHide`,
default on, and `minTerminalWidth`, default 720 px, 400 to 2000), the right zone's panel area hides
first, then the left one's; widening brings them back in reverse (left, then right), each only when
the centre keeps the minimum plus a 48 px margin with it shown, so a window resting at the threshold
does not flap. Widths are the zones' saved sizes (capped at 70vw like the CSS). The decision is the
renderer's, a pure function (`renderer/zones/auto-hide.ts`) fed by a ResizeObserver on the zones' row
(`use-auto-hide.ts`). Auto-hidden is the window's own state, never written to the layout: the zone stays
expanded with its panels open in the record, it is drawn like a collapsed zone (strip only), and a
zone the person closed (collapsed, or no panel open) is never auto-hidden, so it never comes back on
its own. Hiding is checked only when something the person did not ask for narrowed the terminal: the
window shrank, the minimum went up or the setting on, or panels appeared (the first layout, a plugin's
declaration). Opening a zone or dragging one wider is the person's pick and hides nothing. A request
to see an auto-hidden zone shows it: an icon click (opening the panel if it was closed), the zone's
toggle key, a panel opened or moved into it, or a panel show (`ctx.panels.show`, `ccc panel show`;
main publishes the view with `reveal` even when the layout did not change). It then stays until the
window next shrinks.

**Window chrome.** One bar across the top (variant A of the window redesign): the project's
folder glyph, name and path, then the `sessions-strip` slot (above), the "+", then the gear. On macOS the bar is the
window's title bar: project windows use `titleBarStyle: 'hiddenInset'` with the traffic lights
centred on the 40px bar (`main/windows/window-chrome.ts`), the bar reserves their room (collapsed
in full screen, where macOS hides the lights: main sends `window.state` on `enter-full-screen` /
`leave-full-screen`, and `window.info` carries the state for a window restored in full screen)
and is a drag region, every control in it `no-drag`; full-window layers (overlays, settings) start under
it. Other platforms keep the native title bar above the same bar. The BrowserWindow title stays
the project's name (Window menu, Mission Control); the picker keeps its native frame (as a modal
child of a project window it is a sheet on macOS) and is never transparent (Window background
below). The tabs sit
above the terminal as a segmented control followed by the [+] menu (Claude, Shell, then the
"App commands" / "Project commands" groups under captions). Panel headers carry the title and the
"…" zone-menu button; splitters are a hairline with a grip mark that turns accent on hover or
focus. The project path is shown in full: project windows are not told the home folder, so it is
not abbreviated to `~`.

**Panels** are sandboxed iframes (`sandbox="allow-scripts"`, no same-origin, strict CSP) loaded
from the plugin's files, talking to their plugin backend through a `MessagePort` that main hands
over. The core injects the theme's CSS variables into every panel. The SDK also adopts a constructable
stylesheet with thin themed scrollbars (`:where()`, zero specificity, so a plugin's CSS wins; a constructable
sheet needs no CSP change), and, installed first, the component stylesheet `src/sdk/components.css` (`?raw` import,
every rule in `@layer cc` so a plugin's own rule wins; the shell's `styles.css` imports the same file; `ccc guide style`);
the theme message carries `mac` and the rule is skipped on macOS, where overlay
scrollbars already fit. The shell has the same rule in `styles.css`, scoped by `html[data-platform]`.

**Overlay stack.** Opened by plugins (API), the CLI and the user's overlay entries of the new-tab
menu (§3 Custom commands); covers the whole window (on macOS, everything under the in-page title bar); overlays stack.

- `terminal`: an argv command with a cwd in its own PTY; the overlay closes on exit and the
  opener gets the exit code. Its xterm fills the window under the overlay's title bar, with the
  terminal font of the tabs, and the PTY is resized with it (a TUI gets the real size).
- `html`: a plugin page in a sandboxed iframe with the panel message API. Opened with
  `ctx.overlay.start(spec)` it is two-way (below).
- `url`: an Electron `WebContentsView`, no Node, its own session partition; links to other
  sites open in the system browser.

Esc pops the top overlay, except in a terminal overlay of any opener (Esc belongs to the program,
nvim / lazygit / yazi need it; close with ✕ or Cmd+Shift+W, or by quitting the program). Neither
the shell page nor main's key watch takes Esc while a terminal overlay is on top. The opener receives a result when its overlay closes: exit code, a value
the page sent, or "dismissed". Esc on an html or url overlay (like ✕ and Cmd+Shift+W) resolves
`{ kind: 'dismissed' }` without asking the page, so a page that holds a draft posts it as it goes.

**Overlay size.** Every kind takes `size?: 'default' | 'large' | 'full'` (`OVERLAY_SIZES`,
`src/shared/ipc.ts`; anything else is refused by `parseOverlaySpec`). The overlay is a centered dialog:
`default` is 75 % of the window in both directions, `large` about 90 %, `full` the whole window below the
top bar with a small margin (`data-size` on `.overlay`, `styles.css`). The title bar and ✕ stay; a
terminal overlay's PTY is resized to the frame (the existing fit path). The CLI's `ccc overlay` and the
user's overlay entries use `default`.

**Two-way html overlays.** `ctx.overlay.start(spec)` returns `{ result, post, onMessage, close }`
(`open(spec)` is `start(spec).result`). The opener passes an `OverlayChannel` to `OverlayManager.start`,
kept on the overlay's record, so what the page posts without a `result` key reaches only that callback:
nothing a renderer sends can name another receiver, and a message for an overlay id of another window is
dropped (`pageMessage` looks the id up in the sender's own window stack). A page's `ccPanel.post(m)` with
a `result` key still closes the overlay; without one it is relayed (renderer → main → host RPC) to
`onMessage` and the overlay stays open. The host's `post` goes out as `overlays.message` once the renderer
reports the page's port up (`pageReady`); until then, and again after a renderer reload, it waits in a
per-overlay outbox (at most 100 messages and 8 MiB of JSON; a full outbox throws to the poster, with the
limit named). A message is at most `MAX_OVERLAY_MESSAGE_LENGTH` = 1 MiB less 8 KiB of JSON text, a page's
over-limit message is dropped with a log line, and a post to a gone overlay is a no-op. The constant lives
in `src/shared/overlay-message.ts`, not next to the panel SDK's cap: the transport is the host RPC, capped
at 1 MiB with its envelope, and a module shared with `panel.js` would pull a common chunk that `panel.js`
loads with `require`, which throws in a page. `post`/`onMessage` throw for a terminal or url overlay.
Ownership: only the plugin whose host opened the overlay can post to it or hear it (HostApi looks the
overlay up by its own plugin and handle).

**Overlay toolbar** (`OverlayToolbar.tsx`, design-next §3). One header row on every overlay kind: the
title (ellipsis, full text in the tooltip), the opener's buttons (`buttons` in the spec, at most 4, clicks
reach `handle.onButton`, `setButtons` replaces them), a divider, the type buttons other plugins add for
the overlay's `type` (`ctx.overlay.buttons`), Discuss with Claude, and ✕ on the side the tab close side
setting names. More than 6 buttons: the first 5 show and "…" takes the 6th place; Esc with the menu open
closes the menu only, and a url overlay's native view gets zero bounds meanwhile (it would paint over
the menu). Button rules (ids, labels, icons) are one module for host and main, `src/shared/overlay-buttons.ts`.
Type buttons: main asks the window's host once per typed overlay (the host calls every provider of the
name, 500 ms each; main bounds the whole ask to 2 s) and again after a click settles, on `setButtons` and
when a plugin that added buttons stops; a click is accepted only for a button main currently shows (not
busy, not disabled), from that window's host, and goes main → host as a request (30 s bound, busy
meanwhile); `{ close: true }` dismisses the overlay. A click never reaches the page. The `type` is
untrusted data from the opener: a button provider checks it. The info's `opener` is main's: the plugin id
HostApi accepted the open for (`core`, `cli` otherwise), never a field of the spec, so a source gates its
`inbox-item` buttons on it (itself or the reviewer it handed the item to). Well-known types: `file` `{ path, mime? }`
and `inbox-item` `{ source, id }`.

**Overlay loader.** `OverlayInfo.loading` is main's: an overlay is on the stack from the request, with a
`.cc-spinner` until its content is up (an html page's `pageReady`, or `ccPanel.ready()` for
`ready: 'manual'`, relayed to the parent window as `{ type: 'cc-plugin.ready' }`; a url view's first
`did-finish-load` / `did-fail-load` / `did-stop-loading`; a terminal's first PTY output). "Still
loading…" after 10 s; ✕ and Esc work throughout. A renderer reload brings an html overlay's loader back.

**Discuss with Claude** (`DiscussPopover.tsx`, `main/overlays/discuss.ts`). Shown for an overlay with a
`type` or an `onDiscuss` handler unless the spec says `discuss: false`. The popover lists this window's
Claude tabs (status) and New session; the preselection is the opener's `discuss.tabId`, else the active
Claude tab, else New session (`src/shared/discuss.ts`, used by renderer and main). Send is the renderer
call `overlays.discuss`; main asks the opener's host for context (`onDiscuss`, 5 s), builds `About:
<title>`, the type line, the context and the note (at most 20,000 characters, the context cut first, the
note never), re-checks that the target is a Claude tab of this window, then sends through the send gate
(queued when the tab is busy) or opens a Claude tab in the project folder with the text as its first
prompt (5 a minute per window), closes the overlay with `{ kind: 'discussed', tabId, queued }` and selects
the tab. The text always starts with `About:`, so the gate's refusal of a leading `/`, `!`, `#` or `&`
never fires; an `onDiscuss` that throws or times out shows its error in the popover and sends nothing.
The reviewer's own Discuss and New session buttons are gone: its file reviews are `type: file` overlays
and answer `onDiscuss` with the review text.

**Themes**: a set of CSS variables plus an xterm palette. Light and dark are built in; theme
plugins add more. The active theme is app-wide. A plugin theme inherits every variable it does
not set from the built-in of its kind (accent, surfaces and focus tokens came later than some
themes). Colour tokens only; radii, fonts and the type scale are fixed in the shell's stylesheet.

**Window background** (Settings › Appearance › Window; `app.json` › `windowBackground`,
`{ transparent, opacity, blur, area }`, defaults off / 80 / off / `'window'`; checks in
`main/settings/window-background.ts`: booleans, opacity a whole percent 40–100, area `'window'` or
`'main'`, a damaged stored
field reads as its own default, one bad field refuses a change). Background-only transparency:
the shell's own surfaces (top bar, icon strips, tab bar, panel areas and so panel headers, the
terminal, the empty terminal area) let the desktop through; text, icons, borders and the accent
stay opaque, and so do menus, the palette, dialogs, overlays (terminal overlays included) and the
settings screen. Plugin iframes and the web view keep their own pages' backgrounds. Project
windows only; the picker and other windows stay opaque.

- *Transparent* is creation-only in Electron (`transparent: true` with a `#00000000`
  `backgroundColor`): main reads the setting when it creates a project window
  (`WindowManager` › `projectWindowLook`, options from `window-chrome.ts`
  `projectWindowBackground`) and records which windows it made transparent. `window.info` tells
  the page `transparent: true` from main's record, never from the current setting: a window is
  what it was made as for its whole life. So a flip of the switch that leaves the window it was
  made in looking otherwise shows an in-page confirm there ("Reopen this window to apply? Claude
  conversations resume; shells start fresh, and anything running now is stopped." · Reopen window
  · Later); flipping back hides it. *Reopen window* sends `window.reopen` (project windows only;
  main takes the project from the sender, never from the payload) and main remakes that window
  (`WindowManager.reopen`): a modal picker over it is closed, the window is closed, and in its
  `closed` a new one is opened for the project at once, from the current setting. In between the
  project is never treated as closed: it stays in the open list, no picker shows, the app does not
  quit, `onProjectClosed` gets `reopening` and, instead of clearing the saved tabs, saves and
  queues them from the live tabs before killing them (§3 Restore: Claude tabs come back with
  `--resume <id>`, shell tabs fresh, command tabs not started; a running turn or command is
  stopped, overlays are not restored). The bounds and maximised / full-screen state saved as the
  old window closes are where the new one opens; the plugin host restarts with the window (a new
  host waits for the old one to go), the zone layout is in the record and stays. *Later*, and every
  other open project window, keep how they were made until they are next opened (or the app
  restarts). If the folder is gone by then, the project simply closes (the picker shows).
- *Opacity* is live: it travels in the shell prefs (`backgroundOpacity`, `prefs.changed`) and a
  transparent window sets `--cc-window-alpha` from it. The page draws (`html.see-through`,
  `renderer/theme/see-through.ts`) glass tokens: the theme's `--cc-bg`, `--cc-bg-bar` and the
  terminal colour mixed with transparent at that alpha (`color-mix`), so a theme switch re-colours
  them with no extra code. Exactly one translucent layer per pixel: the body goes transparent and
  each surface carries the glass (two 85 % layers would read as 98 %). The tab terminals' xterm gets
  the theme palette with a fully transparent background in the background's own rgb (xterm draws
  inverse and dim text with the opaque background) and `allowTransparency` (only there: it costs
  drawing time); the terminal host paints the glass, in xterm's background colour, and xterm's
  stylesheet `#000` viewport and native scrollbar track are made transparent.
- *Area* ("See-through": Whole window / Main area only) is live like the opacity (`seeThroughArea`
  in the shell prefs). `'main'` sets `html.see-through-main`, which gives the icon strips and the
  panel areas (so the side and bottom zones, panel headers included) their solid theme colours
  again; the top bar, the tab bar and the terminal keep the glass. The splitters are solid border
  lines either way.
- *Blur* is live on the windows created transparent (`WindowManager.setBlur`): macOS
  `vibrancy: 'under-window'` with `visualEffectState: 'active'` (`setVibrancy`), Windows
  `backgroundMaterial: 'acrylic'` (`setBackgroundMaterial`; Windows 11 22H2 and later, ignored
  before). Linux has no blur-behind in Electron: the switch is shown disabled with that reason, and
  a transparent window there needs a compositing window manager. On macOS the vibrancy material is
  itself a fairly solid tint, so with blur the desktop shows mostly as colour; a lower opacity shows
  more. Windows is untested: Electron documents that `transparent` does not work on a framed
  window, and project windows keep the native frame there.

**Shell prefs**: app settings the shell page applies itself as it draws (the tab close button's
side, the terminal font, a transparent window's background opacity) travel like the theme: the page reads them once at load (`prefs.get`,
before the first render) and main pushes every change to every window (`prefs.changed`), so a pick
made in one window's settings shows in all of them at once. Main applies the defaults; a damaged
`app.json` value never reaches a window.

**Terminal font**: every xterm (tabs and terminal overlays; there is one place one is made,
`TerminalSession`) draws with Settings › Appearance › Terminal, apart from the app UI's
own font: family (a CSS font list), size (6–72 px), line height (1–2; xterm throws below 1),
letter spacing (−5–10 px), weight and bold weight (`normal`, `bold`, `100`–`900`). `app.json` ›
`terminalFont`; the defaults are `"Cockpit JetBrains Mono NF", monospace` (the bundled font below),
13, 1, 0, normal, bold. Only the fields the user set are stored (a change is merged into them), so
a field left alone follows the default; the pre-bundling default family (`Menlo, Monaco, "Courier
New", monospace`, which the first version stored on any change) reads as unset. Main checks each
value (`main/settings/terminal-font.ts`) and refuses a whole change for one bad field; a damaged
stored field reads as its own default. The family may not hold control characters, `;`, `{`, `}`
or `/*` (xterm writes it raw into a style rule) and is at most 512 characters. A change reaches
every open terminal at once: once the font has loaded (`document.fonts.load` at the regular and
bold weight, so the cell is not measured with a fallback; after 1.5 s the terminal goes on
without it), its options are set, the terminal is fitted again and the new cols x rows go to the
PTY through the resize path (a hidden tab does that when shown). The first window renders, and its
terminals open, only after the font in effect has loaded (`startPrefs`).

*Bundled fonts*: JetBrains Mono Nerd Font (the Nerd Fonts "Mono" variant, so icons are one cell
wide; SIL OFL 1.1) and MesloLGS NF (romkatv/powerlevel10k-media; Apache 2.0), regular, bold,
italic and bold italic, as WOFF2 in `renderer/assets/fonts` with their licences. The shell page
declares them with `@font-face` (`fonts.css`); Vite emits the files with the renderer build (inside
`app.asar` when packaged; the licence texts go to `Resources/fonts/` through electron-builder's
`extraResources`) and they load under the page's `font-src 'self'`. Nothing is installed
on the system. Their families are `Cockpit JetBrains Mono NF` and `Cockpit MesloLGS NF`, a name no
installed copy can have, so the cell measures the same on every machine; the page shows the
friendly names. A drift test (`bundled-fonts.test.ts`) ties `fonts.css` to
`BUNDLED_TERMINAL_FONTS` (shared/terminal-font.ts).

*The family dropdown* (`TerminalFontPicker`, logic in `font-picker-model.ts`): an editable
combobox (ARIA combobox + listbox; ↑/↓, Enter, Esc closes the list only, typing filters) with
sections Bundled, Installed and a last Custom…. Each name is drawn in its own face with a short
sample. Installed lists the monospaced families (Chromium's `queryLocalFonts`, started by the click
or key that opens the list, which is the user activation it needs; monospace is measured on a
canvas); when the API is missing or refused the section says so. A pick stores a CSS font list as
before: a bundled font as `"Cockpit … NF", monospace`, an installed one as `<name>, monospace`.
Custom… reveals the free-text CSS font list field (main's checks above); it is also shown for a
stored family no pick produces. The preview line includes a few Nerd Font icons so the user sees
whether a font draws them.

**Browser permissions: denied by default** (`main/windows/permissions.ts`). Electron grants every
permission to a session without a handler, so every session gets one: the default session (the
shell page and the plugin panels and html overlays it embeds) and each URL overlay partition
(`electron-url-view.ts`, and any other session a WebContents is created in, from
`web-contents-created`). The request and the check handler answer alike (the check handler is
what `navigator.permissions.query` and the first step of some APIs read). Only the shell page's
own top frame is granted anything (its URL is the dev server's origin or the built `index.html`,
`appPageMatcher`, AND it is the main frame, so an iframe of the page is not), and only what it
uses: `local-fonts`. Terminal copy and paste are the Edit menu's native commands, links go
through the `app.openExternal` IPC and notifications are main's, none of which ask the handler.
Plugin panels, html overlays and URL overlays get nothing (no clipboard, notifications,
geolocation, media, MIDI, fullscreen, pointer lock, `openExternal`, ...): a plugin that needs a
privileged thing asks main through `ctx`. The paths that bypass the permission handler are
closed too: the device permission handler refuses (WebHID, Web Serial, WebUSB), the HID, USB,
serial and (per WebContents) Bluetooth choosers are cancelled, and `getDisplayMedia` is refused.
A new need of the shell page is added to `APP_PAGE_PERMISSIONS`, never a wider rule.

## 5. Plugin package and API

**Package**: a folder or git repo with `plugin.json`; ships built JS (no build at install).

```jsonc
{
  "id": "bronos.jira", "name": "Jira", "version": "0.3.0",
  "api": 1,                          // plugin API major; the app refuses unknown majors
  "main": "dist/host.js",            // runs in the plugin host
  "contributes": {
    "panels":   [{ "id": "board", "title": "Board", "icon": "icons/board.svg",
                   "entry": "panels/board.html", "defaultZone": "left" }],
    "settings": { "project": { /* JSON Schema */ }, "app": { /* JSON Schema */ } },
    "commands": [{ "id": "refresh", "title": "Jira: Refresh", "key": "cmd+shift+j" }],
    "themes":   [{ "id": "solar", "file": "themes/solar.json" }],
    "cli":      [{ "name": "jira", "summary": "…", "usage": "jira [issue]", "stdin": false }],
    "skills":   [{ "id": "jira", "dir": "skills/jira" }],
    "openFile": { "title": "Jira viewer" },  // takes a click on a changed file in the Sessions panel
    "slots":    [{ "type": "agenda", "entry": "slots/agenda.html", "title": "Agenda", "minHeight": 48, "maxHeight": 320 }]
    // a panel may list the slot types it places: {"id", "title", "entry", "slots": ["agenda"]}
    // a panel may instead be {"id", "title", "kind": "webview", "defaultZone"}: no "entry"
  },
  "services": { "provides": { "triage": 1 }, "uses": { "mail-index": 2 } }
}
```

- `panels[].kind`: `"html"` (default, needs `entry`) or `"webview"` (no `entry`; see Web view below).
- `cli[].name`: `^[a-z][a-z0-9-]{1,31}$`, not a core command (or `app`, `config`, `version`), at
  most 10, and the manifest needs `main`. `stdin: true` lets the command receive stdin.
  A name already owned by another plugin refuses install, link and update, naming the owner; it
  is also re-checked at every load and dev reload (bundled plugins first, then the earlier index
  entry): the loser gets a not-ok state naming the clash and is not activated. A plugin installed
  another way whose id a bundled plugin already holds is skipped (the bundled one wins). Clash
  losers keep their manifest in the loaded map, so they win the name back once the owner is removed.
- `skills[]`: see Skills below.
- `slots[]` (provider) and `panels[].slots` (host): see Slots below. A provider needs `main`, `type`
  (`^[a-z][a-z0-9-]{0,63}$`) and an `entry` ending in `.html`; `title` 1 to 100 characters; `minHeight` and `maxHeight`
  integers 24 to 600 (defaults 24 and 600, min not above max); at most 10 per plugin, a type once per plugin. A panel
  lists at most 4 distinct types and may not list an app slot type (`sessions-strip`).
- `openFile`: one object, not a list, and it needs `main` (`{ "title": 1..100 chars }`). The plugin may
  take a click on a changed file in the Sessions panel through `ctx.files.onOpen`; see Open file below.
- A panel's `icon` (an SVG or PNG in the plugin folder) is drawn as a mask in the strip's text colour,
  not as an image: only its shape and alpha count, so it follows the theme, hover and open states (a
  `stroke="currentColor"` SVG drawn by `<img>` came out black). `IconStrip.tsx` paints a CSS
  `mask-image` over `currentColor`; a mask reports no load error, so a detached `Image` probe falls back to the
  title's first letter when the file fails.
- `services`: top level (a dependency between plugins, not something the app shows). Names `^[a-z][a-z0-9-]{0,63}$`,
  versions integers 1..9999, at most 32 entries in each of `provides` and `uses`; a plugin may not provide and use
  the same name; no other key inside `services` (strict, unlike the top level). Absent means none. The host ignores
  an unknown key that still arrives and errors only that plugin for a malformed field, never the project's batch.
  See Plugin services below.

**Host API**: `activate(ctx)` is called once per project window; `ctx` is already scoped to
that project.

| Area | API |
|---|---|
| config | `ctx.settings` (project + app, validated by schema), `ctx.onSettingsChange` |
| secrets | `ctx.secrets.get/set/delete/keys` → this plugin's encrypted store (app-wide, OS keychain) |
| oauth | `ctx.oauth.authorize(spec)` / `refresh(spec, token)` → loopback + PKCE sign-in, optional helper |
| data | `ctx.storage` (KV, per plugin per project), `ctx.dataDir`; `ctx.appStorage` (the same KV, app-wide, with an atomic `increment`), `ctx.appDataDir` |
| work | `ctx.schedule(seconds, fn)` (no overlap, timeout), `ctx.exec(argv, {stdin, cwd})` (argv only, never a shell) |
| project | `ctx.projectDir` (the project folder's real path, read-only) |
| UI | `ctx.panels.post(id, msg)`, `onMessage`, `ctx.panels.show(id)` (reveals the panel's zone), `ctx.panels.header(id, {meta, actions} \| null)` and `onAction(id, fn)` (panel header, below), `ctx.panels.slots(id, placements \| null)` (Slots, below), `ctx.badge(id, n \| "dot")`, `ctx.overlay.open(…)` → result, `ctx.overlay.start(…)` → `{result, post, onMessage, close, focus, onButton, setButtons, onDiscuss}` (`focus` brings it to the front, no-op after close; two-way html overlay, toolbar buttons and Discuss, §4), `ctx.overlay.buttons(type, provider)` (buttons on every overlay of a type, §4 Overlay toolbar) |
| slots | `ctx.slots.onOpen(type, fn)` → disposer (provider side; the type must be in `contributes.slots`), a `SlotInstance` `{id, type, host, params, post, onMessage, onClose}`, `ctx.slots.available(type)` → `Promise<boolean>` (Slots, below) |
| files | `ctx.files.onOpen(({path, tabId?}) => …)` → disposer (needs `contributes.openFile`), `ctx.files.open(path, {tabId?})` → `{via: 'plugin' \| 'builtin'}` (no declaration) |
| web view | `ctx.webview.navigate(panelId, urlOrAbsolutePath)`, `back`, `forward`, `reload`, `current` → `{url, title}`, `onNavigate` (webview panels only) |
| cli | `ctx.cli.register(name, (argv, {stdin, cwd}) => {stdout?, stderr?, code?})` for a command declared in `contributes.cli` |
| services | `ctx.services.available(name)` (host-local, same `serviceStatus` rule as a call, never cached, false for an unknown name) |
| sessions | `ctx.sessions.list({scope?})`, `onChange(fn, {scope?})` (`scope: 'all'`: every window's tabs as `SessionSummary`, status/tool/title/name/project only, needs `"access": { "sessions": "all-windows" }`), `send(tabId, text)` (this window, waiting-only, else queued), `open({cwd, prompt, focus})`, `focus(tabId)` (any window's tab), `close`, `rename`, `openFile` (this window's tabs; limits per plugin and window) |
| commands | `ctx.commands.register(id, fn)` |
| services | `ctx.services.provide(name, impl)`, `use(name)` → handle (async methods, `on(event, fn)` → disposer), `emit(name, event, data)`, `caller()` → the calling plugin's id or `undefined` |
| misc | `ctx.log`, `ctx.notify(text, {title?, sound?, action?})` → `{clicked}` (below), `ctx.openExternal(url)` (system browser; below) |

`sessions.open` adds the tab to the window unselected (it starts in `starting`, where a key meant for the tab the
person is typing in could answer Claude's trust dialog). `focus: true` selects it as well: main sends the window a
`tabs.select` right after `tabs.added`, only to the host's own window. It is for a click the person made that means
"go there" (the reviewer's New session). An older app ignores the option.

`activate`'s return value is ignored; a plugin offers an API to others with `ctx.services`.

**Panel header** (`ctx.panels.header`, `ctx.panels.onAction`; `src/shared/panel-header.ts`). A plugin fills the
title bar of one of its own panels (html or webview): `meta`, muted plain text after the title (≤ 120 chars, an
ellipsis when it does not fit, the whole text as tooltip), and up to 3 `actions` `{id, icon, title, busy?, disabled?}`,
icon buttons before the panel's "…" menu, which stays last. `icon` is a core name (`refresh`, `add`, `search`,
`filter`, `settings`, `open-external`, `check`, `sort`, drawn in the window's stroke style) or a relative `.svg` path in
the plugin folder (the manifest `icon` rule; drawn as a mask over the header colour, served by `cc-plugin://`, which
checks containment). Ids are 1 to 40 of `[A-Za-z0-9._-]` and unique, titles ≤ 80; text is drawn as React text, never
HTML. One parse rule serves both sides: the host throws a TypeError at the call site, and main checks the request again
(`HostApi`, which never trusts a host) and refuses a panel the calling plugin does not declare. The header follows the
badge's path: main keeps it per project and panel key in the layout service's panel status and pushes it with the
`PanelInfo`; it is cleared when the plugin's ctx ends (the host sends `plugin.disposed` for a ctx that set one), when
the plugin reloads in place, and when the host stops. A click goes renderer → main (`panels.action`, the project is the
sender's) → the project's host (`panel.action` event) → that panel's `onAction` listeners, only for an action the
current header has that is neither busy nor disabled (the renderer drops those clicks too). A busy action's icon spins
(under `prefers-reduced-motion` it is dimmed instead).

**App-wide plugin storage** (`ctx.appStorage`, `ctx.appDataDir`; `src/main/plugins/app-storage.ts`).
`ctx.storage` has one writer, the project's host, and lives in `<data>/plugin-data/<projectId>/<pluginId>/`.
`ctx.appStorage` is the same API (`get`, `set`, `delete`, `keys`) plus `increment(key, by = 1)`, shared by
every project window, and **main owns it**: each window runs its own host, so a file the hosts wrote
themselves would have one writer per window and a read-modify-write (a usage cap counted from every
window) would lose updates. Main is one thread and every store method is synchronous, so calls from any
number of hosts apply one at a time in arrival order, each call is atomic and `increment` is the safe
counter. A `get` then a `set` is not atomic; there are no locks. The host only forwards through RPC
(`src/host/ctx/app-storage.ts`; the plugin id is checked against the host's own plugins). Data lives in
`<data>/plugin-data/_app/<pluginId>/storage.json` (`ctx.appDataDir` is that folder, created on first
read; `_app` can never be a project id). Writes go through `JsonFile` (tmp, fsync, rename: never a half
file), debounced by 300 ms from the first unsaved change and flushed at quit (`will-quit`); the in-memory
object is what every host reads meanwhile. So a crash or kill of main (not of a host, and not a normal
quit) can lose the last ~300 ms of changes, and the file is then the previous complete one. Keys and value
caps are `ctx.storage`'s (`src/shared/plugin-storage.ts`), except a value is capped at 1 MiB less 8 KiB so it
fits one RPC message. Like the per-project data, both folders stay after uninstall and after forgetting a
project (only a plugin's secrets are deleted), and a reinstall finds them again.

**Slots** (`ctx.panels.slots`, `ctx.slots`, `contributes.slots`; `src/shared/slots.ts`, design-next §2). A slot is a place in
one plugin's panel (or the app's top bar) where another plugin draws its own page: the Inbox places an `agenda` slot,
the Calendar fills it. The host plugin only places it, `ctx.panels.slots(panelId, [{ type, position: 'top' | 'bottom',
height, params? }] | null)` (at most 4; the type must be in that panel's manifest `slots`; `params` plain JSON of at
most 4 KiB that only the provider sees). The page is the provider's, isolated like a panel and talking only to the
provider's backend over a `MessagePort` main hands out per frame (`panel-ports.ts`); plugin code never runs in
another plugin's page, and the shell draws the frame (§4). The provider's backend hears a frame with
`ctx.slots.onOpen(type, (slot) => …)`; the page uses the panel SDK plus `ccPanel.slot` (`{ type, setHeight(px) }`).
Known types: `agenda` (today's events, a compact strip) and `sessions-strip` (an app slot type: the Claude sessions
of other windows, one line, drawn in the top bar). Main enforces: the call names a panel of the calling plugin,
never a host-supplied id; the type is in that panel's `slots` and is not an app slot type; heights are rounded and
clamped to 24-600, then to the provider's range; the provider is enabled in the project, declares the type and is the
project's pick; at most 8 frames per project (app frames first; an extra placement is not drawn and is logged once in
the host plugin's log). Placements follow the panel header's path: kept per project and panel in the layout service,
pushed with `PanelInfo` (frames carry no `params`), cleared when the host plugin's ctx ends, it reloads, or the host
stops. A provider reload gives its frames new ids (`onClose`, then `onOpen` in the new copy), a disabled provider
removes them, a hidden or collapsed host panel unmounts them.

**Which provider draws a slot type.** The project's enabled plugins that declare the type, through `selectProvider` as
providers of one reserved name, as `@open-file` does (`slotStatus` in `src/shared/services.ts`). The pick is stored in
`serviceProviders` under `@slot:<type>` (a plugin id or `@none`, which turns the type off for the project). One
candidate draws; several with no valid pick (a stale pick counts as none) draw nothing and the Plugins page shows a
"pick a provider" row; no candidate, no slot. A pick change needs no host restart: main re-sends the layout. Code that
walks `serviceProviders` as services skips every `@` key.

**Open file**: a Sessions panel file click (`ctx.sessions.openFile`, the `cockpit.sessions` panel's) goes to a plugin before core's own viewer
(`src/main/sessions/open-file.ts`). Which plugin: the plugins of the project's host that declare
`contributes.openFile`, run through `selectProvider` as providers of one reserved name (`selectOpenFile`,
`openFileStatus` in `src/shared/services.ts`, the rule the Plugins page shares). The pick is stored in
`serviceProviders` under the reserved key `@open-file` (a service name never starts with `@`, and `@slot:<type>` keys are reserved the same way, Slots above); its value is
a plugin id or `@builtin` for core's viewer, and changing it needs no host restart (main routes each click).
With one candidate it gets the clicks; with several and no valid pick (a stale pick counts as none) or with
`@builtin`, the built-in viewer opens. Main is the authority for what the plugin receives: the tab must
belong to the asking window's project and the file must be one main recorded for that tab (the checks
`openDiff` makes), the path is made relative to the project folder by main and a file outside the project
is never sent (the built-in viewer shows it): the real path decides, so a symlink out of the project is
outside and one in (macOS `/var` -> `/private/var`) is inside, and a deleted file resolves through its
nearest existing folder. The `tabId` is the one just checked, and checked again (tab, file, the project's
window) right before the delivery, since choosing the plugin awaits the host; a repeated click on the same file while the first is pending is dropped. The plugin's
`onOpen({ path, tabId })` listener is awaited for 1 s (a listener still running then counts as handled, so
one that awaits an overlay is fine); a throw or rejection of every listener, no listener, an inactive
plugin, or no ack from the host within 2 s falls back to the built-in viewer, so a click always shows
something. A plugin opens a project file the same way with `ctx.files.open(path, { tabId? })` (host API
`files.open`, `routeProjectFile`): main checks the path against the host's own project folder (relative, no
`..` segment, a regular file inside by its real path, else the call rejects), keeps `tabId` only when it is a
tab of that project (else drops it, so the listener's `tabId` is absent), then uses the same pick, delivery
and fallback as a click; the built-in viewer runs over the project folder (`openProjectFileDiff`), and the
call resolves `{ via: 'plugin' | 'builtin' }`. No manifest declaration; 20 calls per 10 s per plugin and window.

**Opening a web page outside the app** (`ctx.openExternal(url)`, host API `openExternal`). Main is where a link
leaves the app: the plugin host's env is an allow-list (`hostEnv`, no `DISPLAY`, `WAYLAND_DISPLAY`, D-Bus or desktop
variables), so `xdg-open` from `ctx.exec` fails on Linux, and the env stays narrow rather than growing for this. The
host checks the shape (a non-empty string of at most 2048 characters, else a `TypeError`); main checks it all again
with the renderer's link rule (`src/shared/web-url.ts` `checkWebUrl`, also behind `app.openExternal`): http and
https only (no `file:`, `javascript:`, `data:` or app schemes), at most 2048 characters before and after
normalizing, and no userinfo (`https://bank.example@evil.example/` puts a trusted name in front of another host).
Then at most 3 opens per 10 s per plugin and window, the webview's `window.open` rate: a loop opening browser tabs
is the hardest flood for the person to clean up. A refused URL spends no budget. The normalized `href` goes to
`shell.openExternal` through a lambda (the e2e recorder replaces it). No manifest declaration. Pages (panels,
overlays) still cannot open links themselves; they post to their host, which calls this with a URL it chose.

**Notifications** (`ctx.notify(text, options?)`, host API `notify`; `src/shared/notify.ts`,
`src/main/notifications/`). Text is cut at 500 characters; at most 10 per minute per plugin and window
(`HostManager`), and only while the window is open (the host runs only then). One parse rule for the options
serves both sides, like the panel header: the host throws a TypeError at the call site and main checks the
request again: `title` plain text of 1 to 80 characters (control characters become spaces; default
`cc-cockpit: <pluginId>`), `sound` a boolean or a sound id of at most 1024 characters (`""` is `true`),
`action` `{ label }` of 1 to 40 characters; unknown keys are
ignored. A refused call spends no budget. The window is main's record of the host's, never one the request
names. Electron's `Notification` is only in `notifications/electron-notification.ts`; `notifier.ts` holds the
logic (a test run swaps in a recording backend the e2e clicks through test hooks).
- Sound: OS notification sounds are unreliable (most Linux daemons play none; macOS and Windows follow the
  person's per-app settings), so `sound: true` rings the app's own sound: main sends `notify.chime` with
  the picked sound's id to the project window and its renderer plays it (`renderer/notify/chime.ts`,
  `sound-player.ts`). The OS notification is then `silent`, so there are never two sounds. Main
  gates it (`ChimeGate`): the app setting "Notification sounds" (Settings › General ›
  Notifications; `app.json` › `notificationSounds`, default on, only `false` turns it off; read at each
  chime) and at most one chime per 5 s per window. Without `sound` the OS notification is made as before
  (the platform's default sound, if any). The chime ignores the OS's do-not-disturb mode; the setting is the
  way to silence it.
- Which sound: the app setting "Sound" (`app.json` › `notificationSound`) for `sound: true`. A plugin may
  instead pass a sound id the person picked in its own settings (a `"format": "sound"` field, §6), never a
  file: main (`NotifySounds`, notifier.ts) rings that id only when the app offers it now (a built-in, or a
  system id found in a fresh listing of the folders below, the same check as a pick in Settings), and
  otherwise rings the app's sound and logs it once per plugin and id (a stale id never silences a
  reminder, and a guessed path reaches nothing). The id is resolved before the gate, which then applies
  as for any chime: "Notification sounds" off silences a plugin's own sound too, and two plugins' sounds
  in one window within 5 s are one chime. The stored value is an id
  (`src/shared/notify-sound.ts`), never a path: `builtin:<name>` is a tone the renderer makes with WebAudio
  from a few sine or triangle partials with an exponential fade (`renderer/notify/tones.ts`: Chime, the
  default, Bell, Ping, Soft pop, Two-tone, Marimba; each under 1 s, no file, nothing fetched);
  `system:<root index>:<relative path>` is a file under one of main's fixed OS sound folders
  (`main/notifications/system-sounds.ts`): Linux `/usr/share/sounds` (freedesktop's `stereo` files listed
  first) and `~/.local/share/sounds`, macOS `/System/Library/Sounds` and `~/Library/Sounds`, Windows
  `%WINDIR%\Media`. The listing takes regular files with an audio extension (`.oga .ogg .wav .aiff .aif .mp3
  .flac`), non-empty and at most 2 MiB, at most four folder levels deep (a symlinked folder is not
  entered), no dot files, at most 300 in all; a symlinked file counts only when its realpath stays inside
  the root's, so a link to a private file is never readable. Names are the file stem, with the folder (and
  then the extension) when two clash. A damaged or unknown stored id reads as the Chime. Main never trusts
  the stored id or one a page sends: a pick (`settings.notificationSoundSet`) and every bytes request
  (`notify.soundData`, project windows only) list the folders again and act only on an id in that fresh
  listing; the read opens the listed realpath and checks it is still the same regular file (device,
  inode, size cap). The page decodes the bytes (`decodeAudioData`; AIFF, which Chromium does not read, by
  `renderer/notify/aiff.ts` for uncompressed AIFF and AIFF-C), and a file that is gone, refused or
  undecodable rings the Chime instead, logged once per id. Settings lists Built-in, then a group per
  folder, a "▶ Play" button that plays the picked sound at once (not throttled; a double click plays
  once), both disabled while "Notification sounds" is off.
- Action: with `action` the call waits. Main resolves `{ clicked: true }` on a click on the notification
  or on its button (`click` or `action`: macOS and Windows show the button, Linux's libnotify path offers
  only the click), `{ clicked: false }` on `close` or `failed`, after 10 minutes (main then closes it, so
  a stale one cannot be clicked into nothing; bounded because Electron's `close` "is not guaranteed"), or
  when the plugin's ctx or its host process ends. A notification with an action is `timeoutType: 'never'`
  (Linux, Windows) so it stays up until answered: with the default the pop-up expires in seconds and the
  OS reports that as closed. Main keeps the native object referenced while waiting (Electron drops a
  collected Notification's click handler). The host waits for main's answer at most 30 s longer than
  main's bound; its ctx's dispose resolves the call `{ clicked: false }` at once (not a rejection, so a
  `void ctx.notify(...)` cannot become an unhandled rejection at a reload) and sends `plugin.disposed`, on
  which main closes that plugin's waiting notifications (`NoticeWaits`, one per host process; a stop, a
  crash or the window closing closes all of them). Main does not focus the window on a click; the plugin
  decides what a click does (`ctx.openExternal`, with its own limit). Without an action the call resolves
  `{ clicked: false }` once shown, as `ctx.notify(text)` always did.

**Plugin services**: one plugin offers a named API, others in the same project call it and listen to
its events (`src/host/services.ts`, `src/shared/services.ts`). All plugins of a project run in one
host and one JS realm with no isolation, so this is a contract, not a security boundary; calls are
dispatched inside the host with no round trip to main.
- The provider calls `ctx.services.provide('triage', { classify })` (only names in its own `provides`;
  an object of functions, no `on`, `then`, `constructor`, `__proto__`, `prototype` or `_` names) and
  `ctx.services.emit('triage', 'rulesChanged', data)` (only the selected provider). The consumer
  calls `ctx.services.use('triage')` (only names in its own `uses`), then `await triage.classify(...)`
  and `triage.on('rulesChanged', fn)`.
- Resolved on every call, never cached in the handle: a host restart, dev reload or provider error
  replaces or removes providers, and a handle keeps working across them. A call made while the
  provider activates (or reloads) waits for that activation; two plugins awaiting each other during
  `activate`, or an `activate` reaching itself again through active providers' methods, fail at once
  with a cycle error instead of timing out. The host follows the call chain with AsyncLocalStorage
  (an activate frame, then a frame per provider method); a frame counts only while its activate or
  method runs, and event listeners run outside the emitter's chain. A handle of a released copy of
  the consumer can no longer call or subscribe.
- Arguments, results and event data are copied with `structuredClone` in the host: plain data only (a
  function or symbol throws, and so does shared memory, which a clone would share; a class instance arrives as a
  plain object). A provider's throw reaches the
  consumer as a new `Error` with the same message and name. No core timeout on calls.
- Which provider: the only one, or the project's pick (`serviceProviders` in the project record, set on
  the Plugins page; a change restarts the project's host). Zero providers, several with no valid pick
  (a stale pick counts as none) or a major-version mismatch make calls fail with a clear error and the
  Plugins page warn on the consumer. `selectProvider` and `serviceStatus` (`src/shared/services.ts`)
  are the one rule, used by the host and by main over the same set of specs, so warnings and errors
  agree. Main decides the specs and the picks; the host only applies them.
- Collectors (0.9.7, for Inbox): a plugin that wants every provider's answer, not the picked one,
  lists the name in `services.collects` (a subset of `uses`) and calls `ctx.services.useAll(name)`.
  `providers()` lists every enabled plugin that provides the name at the collector's major and has
  called `provide` (read fresh each call), each with a handle bound to that plugin; `on` hears every
  provider's events with the sender's id; `onChange` fires (once per turn) when the set changes. The
  app is the registry: a new source joins by providing the name, with no change to the collector.
  A name only collectors use has no pick and no pick problem on the Plugins page (`collectedOnly` in
  `serviceStatus`); a provider of the name at another major than the collector's is a `collected-major`
  problem on the collector ("Gmail provides inbox-feed 1, Inbox reads 2: update Gmail"), since `useAll`
  skips it and its items would be silently absent. An emit no `use` consumer misses is not logged as dropped. `services` is
  strict in the manifest schema, so an app before 0.9.7 refuses a manifest with `collects`.
- `ctx.services.caller()`, inside a provider's method, is the id of the plugin whose call it serves, for per-caller
  counts or caps. The registry takes it from the calling plugin's own `ctx` (the AsyncLocalStorage frame it
  pushes for each provider method), never from an argument, so a caller cannot name another plugin; it holds in
  what the method awaits or starts while the call runs, the innermost caller wins (A calls B, B calls C: C sees
  B), and it is `undefined` in `activate`, in event listeners, outside a call and after the call returned. Not a
  security boundary (one JS realm); it guards against honest mistakes. A service call reaches no limits: no rate,
  size or time cap, since it never leaves the host; a provider that must protect itself counts its callers.
- `ctx.services.provider(name)` is the plugin id a call on `name` would reach now, or `null` (the same `selectProvider` over the host's specs and picks, never cached, no round trip); it throws for a name not in `uses` and for one in `collects` (the pick does not apply to a collector, and null would read as "no provider" while several answer). Sources check an `inbox-item` overlay's `opener` against the picked `reviewer` with it.

**Panel side**: a small `panel.js` SDK (`post`, `onMessage`, `theme`) that also installs the component stylesheet (§4 Panels). Panels have no direct
API; everything goes through their own plugin backend, so the plugin decides what its panel may do.

**Skills**: a plugin brings Claude skills with `contributes.skills`. Main keeps a generated tree
`<data>/claude-plugins/`, rebuilt at start and whenever the plugin set changes (temp dir, then
renamed per child, so a starting tab never sees half a tree): `core/` (Claude plugin
`cc-cockpit`, whose skill maps the `ccc guide` topics) and one `<pluginId>/` per enabled plugin
with skills (Claude plugin `ccc-<id with dots as dashes>`, a hash added to a later id when two
map to one name). A Claude tab starts with `--plugin-dir` for `core` and each skill plugin
enabled in its project (`claudeArgv`, read at every spawn; restore waits for the first build).
Running sessions keep what they started with; new tabs and restarts see changes. The
`SKILL.md` front matter is read by a strict parser of our own (`src/main/plugins/skill-files.ts`):
exactly `name: <id>` and a one-line plain-string `description` (at most 1024 chars); any other
key (`allowed-tools`, `model`, `hooks`) refuses the plugin, since those change what Claude may
do. Copy limits per plugin: 50 files, 50 folders, 1000 directory entries (dot ones too), 1 MiB, 8 folders deep, regular files only (dot entries skipped, never copied), no `SKILL.md` (any case) below the top one, re-checked
while copied.

**Telling Claude about the app**: `ccc guide [topic]` (topics: overview, cli, plugins, api, panels, style, settings-secrets, dev-loop, webview, types) prints docs bundled into the CLI (Vite
`?raw` imports; works with the app closed), and `ccc hook SessionStart` prints one line before
delivering the event ("You are inside cc-cockpit; run `ccc guide` …"), produced locally so it
cannot fail the hook. Two ways in, so one failing does not leave Claude blind. Drift tests tie
the guide to `USAGE`, the host `ctx` members and the core skill.

**Web view**: a panel with `"kind": "webview"` is a `WebContentsView` main lays over the panel's
bounds (`src/main/webview/`; `electron-webview.ts` is the only file that creates it). Hardened
like url overlays (no preload, sandbox, in-memory partition `webview-<project>-<plugin>`,
permissions denied, downloads cancelled, WebRTC limited), but http(s) navigation stays in the
view. The shell draws a toolbar (back, forward, reload, URL, open in system browser) and a
placeholder; the renderer reports the placeholder's bounds and visibility, main moves the view
and hides it while the panel is hidden or covered (palette, menus, dialogs, settings, overlay
stack, splitter drag). Local files are served read-only through the privileged `cc-preview`
scheme, registered on the view's own session: a token maps to the file's folder; no traversal,
symlink escape or dot-files, 50 MiB per response and 100 MiB of unread responses per session
(then a 503), a CSP with no network and `Referrer-Policy: no-referrer`, and a folder of `/`, home, an ancestor of home, one with a dot-folder anywhere on
its real path, `~/Library` (except cloud-storage folders), a mount point or a temp root is
refused. `ctx.webview.navigate` file targets follow the same rules: dot-files and files inside any
dot-folder (`~/.ssh`, a project's `.git`) or `~/Library` (except `CloudStorage` and `Mobile
Documents`) are refused. Navigate is capped at 60 per minute
per plugin and 32 folder tokens per view; sub-frames may navigate anywhere except `file:` and
other views' tokens. Chords with
Cmd/Ctrl/Alt typed into a view are forwarded to the app.

**Bundled plugins**: `PluginSource` has a third kind, `bundled`, for plugins shipped in the app
resources (`plugins/browser`, `plugins/reviewer`, `plugins/editor`, `plugins/files`, `plugins/sessions`, `extraResources`). They are indexed from an allowlist
(`BUNDLED_PLUGINS`) at every start, never copied, cannot be uninstalled (only disabled) and update with the app.
They use only the public plugin API, with no privilege beyond being shipped; a third party can build the same under its own id.
`build:browser` and `build:reviewer` (deterministic, a unit test rebuilds and compares bytes) produce the committed
output; the plugins' own `node:test` tests run with `npm run test:plugins`.

*Reserved ids*: an id starting with `cockpit.` (case-insensitive, `isReservedPluginId`) is accepted only for a plugin
loaded from the bundled root: the load path checks that the id is a `BUNDLED_PLUGINS` entry and the folder's realpath is
`<bundledRoot>/<dir>`, so a symlink into it, a linked folder or a hand-edited `plugins.json` entry is refused at load
(shown as refused in Settings > Plugins). Link, folder/git install, marketplace install and the marketplace index tools
refuse it up front. Bundling happens through app releases. The template ids are `example.hello` (`plugins/hello`) and
`example.plugin` (`examples/plugin`). A user's old linked `cockpit.reviewer` / `cockpit.editor` record is dropped at start
with a log line; the bundled copy wins and project enablement and settings keyed by the id carry over.

*App-wide off*: each bundled plugin has "Off in all projects" (app setting `disabledBundled`). Off app-wide wins over the
project record, and main refuses enabling it per project meanwhile. Third-party plugins are per project only.

*Replacing*: no new mechanism. Another plugin providing `editor` / `reviewer` appears in the services provider pick, and
another `openFile` plugin in "Plugin used to open files". A bundled plugin has no priority in `selectProvider`; turning it
off (project or app-wide) leaves the other as the only provider.
The index entry (not the manifest) may set `enabledByDefault`; the project record keeps
`disabledPlugins` so a default-on plugin can be switched off. The built-in browser
(`cockpit.browser`) has a webview panel, an app setting `home`, `ccc browser open|url|reload`
and a skill. The reviewer (`cockpit.reviewer`) opens a changed file as a diff in a two-way html overlay (CodeMirror 6 with
`@codemirror/merge`), takes notes on selections and one comment per file. A file review is an overlay of the type `file`: the app's toolbar gives it
Discuss with Claude (the reviewer answers `onDiscuss` with the review text; a note is optional, New session selects
its tab) and the editor's Edit button (micro on top, the review stays under it); its
`reviewer` service also takes a plain text from another plugin
(`annotate`: a ticket, a mail), as text or as allow-list-sanitized HTML with image assets, for notes in the same overlay (`prepare` shows that
overlay at once with a loader while the caller still fetches, and the annotate of the same key fills it); its design is in `plugins/reviewer/docs/design.md`. The editor
(`cockpit.editor`) provides `editor` v1: micro in a terminal overlay, with app settings `autosaveSeconds`, `colorscheme`
and `microPath` and `ccc edit`; it needs micro installed and says how to install it when it is missing. Files a session
edits outside its project stay in the built-in viewer: plugins only receive project-relative paths. The sessions plugin
(`cockpit.sessions`, §3 "Claude status UI") is the Claude status view that left the renderer in 0.10: the Sessions panel and the
top bar's `sessions-strip` slot, with the `access` declaration for the other windows' tabs and the app setting `filesShown`;
turned off, the window keeps its tab dots, `ccc sessions` and notifications and draws neither.

*Overlays and reloads*: when a plugin reloads, is disabled, updated, uninstalled or its host stops, main closes that
plugin's open overlays and `result` resolves as dismissed in the old copy; the new copy starts clean.

**Lifecycle**: install = clone the git URL at a tag into `<data>/plugins/<id>@<version>/`,
validate manifest and `api` → enable per project → activate on window open, deactivate on close
(with timeout) → on host crash, restart with backoff; affected panels show "plugin stopped:
Restart". A linked dev folder is watched; a change reloads that plugin in every open host (`dev-watch.ts`). The watcher
ignores `node_modules`, `.git` and any nested folder that has its own `plugin.json`: that is another plugin
with its own link and watcher, so editing it reloads only it (if linked) and editing the parent reloads only the
parent. Plugin files without a manifest of their own, such as a `test/` folder, still reload the parent.
Enabling, disabling, linking or unlinking a plugin restarts the project's whole host, not a dev edit.
`ccc plugin new` writes into a new folder or one that holds other files (a nested plugin inside another, or a
parent around a nested one) and refuses only when a file it would write already exists, naming those files.

### Marketplace

A browsable list of plugins in Settings > Plugins, one page for the installed plugins and the listings (design-next
§6.3): cards with a preview, name, author, version, repo as plain text, description and state, 20 per page, a
case-insensitive substring search over name, id, author and description (no regex), and filters Installed / Available /
Updates and category (`plugin-list-model.ts`); "Add plugin…" holds the git URL install and Link folder, and index
management is the folded section at the bottom. There is no server: the index is one static
`index.json` that anyone can host, and the default one lives in the repo `BronOS/cc-cockpit-marketplace`
(fetched from `raw.githubusercontent.com`). That repo does not exist until it is created; until then the
default fetch fails and the page shows the error. The template for it is `marketplace/` in this repo.

- **Untrusted input.** Every byte of an index is untrusted: `parseMarketplaceIndex` (`src/shared/marketplace.ts`)
  caps the size and each field, refuses `git@`, non-https and non-ASCII repos (a `file:` repo only from a `file:` index),
  drops duplicate ids, and refuses the whole index on a bad body or unknown `schema` (the last good cache is kept).
- **Fetch.** The app refreshes at every launch (no staleness check), fetching every configured index, every index recorded
  on an installed plugin, and always the default index (removing it only hides its plugins; it cannot be turned off).
  While it runs, a 15-minute timer refetches any of those over an hour old or whose last fetch failed. Redirects are
  refused, so the default index's repo must never be renamed or transferred: installed copies would keep their cache and a fetch error.
  The Plugins page refetches when an index is stale or failed (Refresh forces it), and adding or removing an index fetches. The cache is read first, so an offline start still lists plugins and still enforces
  revocations. The page touches the network only through that fetch and the lazy preview fetch below. The repo of an entry is shown as plain text, not a link.
- **Category.** An entry may name one of `sources views tools themes claude other`; the app reads an unknown or absent
  one as `other`, the index CI refuses an unknown one. The page's category filter uses it.
- **Preview.** A plugin repo may hold a `preview.png` at its root (PNG, ≤ 512 KiB, 640×400 to 1600×1000, 1280×800
  recommended, not animated, a regular file). The index CI checks it and publishes it as `previews/<id>/<commit>.png`
  beside `index.json`, writing `preview: { sha256 }` on the entry; a missing preview is a warning until the date in
  `marketplace/preview-policy.json` (`requiredFrom`, `null` = warning only), then a refusal. The app fetches the image
  lazily (`settings.marketplacePreview`) from the index's own folder only, no redirect, ≤ 512 KiB, checks the sha256 and
  the PNG signature and caches it under `<data>/marketplace/previews/`; the page shows the bytes from a `blob:` URL
  (`img-src blob:`). A malformed `preview` drops the field, not the entry. With none, the card shows the name's initial.
  An installed git or folder plugin's own `preview.png` is shown through `cc-plugin://`.
- **Update all.** A button on the Plugins page while at least one marketplace-installed plugin has a newer listed version
  from its recorded index. One confirmation lists each plugin's current and new version, repo and commit; on Confirm main
  (`settings.marketplaceUpdateAll`, `SettingsService.updateAllMarketplace`) runs the same checked update per plugin, one at
  a time (pin from main's state, `expect` from the prompt, revocation and repo-change rules, asked again in the installer's
  queue), and answers with the failures and their reasons; a later failure rolls nothing back. Linked, git-URL and revoked
  plugins are never in it (a revoked plugin's move to a safe version stays on its own card); main refuses such an item
  even when asked, and a malformed or duplicated list (or more than 100 items) updates nothing.
- **Pinning.** An entry pins a tag and the full commit. Install and update clone the tag, read `rev-parse HEAD` in
  staging and refuse when it differs from the commit (a moved tag), or when id or version differ from the entry.
  The UI sends the repo and commit it showed (`expect`); main refuses when the entry changed meanwhile.
  The commit and the index it came from are recorded in the install record (`commit`, `marketplace`).
- **"Listed" is not "reviewed".** The app checks shape and refuses a pin mismatch at install; the official index's CI also checks that an entry
  matches its repo and a person reviews and merges a new listing, but nobody audits the code. An added index may have no CI,
  so there "listed" only means the index names it. A plugin runs with full access, so install, update and move-to-safe-version always ask for confirmation.
- **Revocation.** `revoked.json` lists bad commits. The authority is the default index plus the index a plugin
  was installed from (even if it was later removed from the list). A plugin whose recorded commit is revoked is
  disabled and shown as revoked, enforced where the installer hands a plugin out (list and get), so no host gets one
  however its state became ok; the way out is moving to a safe version from the plugin's recorded index, or uninstalling
  (the only option when none is listed). There is no override for the default index's revocations; one from another index can be
  sidestepped by reinstalling the commit by git URL or from another index, which changes the authorities. A revocation from any other
  index is shown as a warning and never enforced. Linked plugins and installs with no recorded commit never match.
  A withdrawn revocation restores the plugin; a failed fetch keeps what was enforced. It takes effect only at a
  successful fetch, not on a first offline run with no cache, and it cannot undo what the plugin already ran.
  An authority with no usable copy answers "unknown", and an install or update then goes ahead: a known exception, since
  refusing would block every install until the default repo exists and answers, and a first run with no network has
  nothing to clone either. A recorded revocation is withdrawn by a good copy of the index that issued it with no matching row, whatever the other authority's state; an issuer with no usable copy cannot have it lifted.
- **Repo changes.** `app.json` `pluginRepos` remembers the last repo per plugin id. Installing an id from a different
  repo through the Marketplace, or with no recorded repo while a project still has the id on, disables it in all projects, on disk, once the clone passed its checks and before the plugin is recorded; when that write fails nothing is installed (a git URL install records the repo but does not disable) and the view reports `repoChangedFrom`. The repo itself is written to disk at the same point, and an install whose write fails is refused; an uninstall first corrects a record that disagrees with the installed plugin, best effort: a write that fails is logged and the uninstall goes on, since it is the way out of a bad plugin. The index repo never auto-merges a `repo` change.
- **Settings.** `marketplaces` in app settings is the list of index URLs (https, or `file:`); it replaces the default list, so the
  default index is listed only if the array contains it (it is still fetched and still enforces revocations).
  `CC_COCKPIT_MARKETPLACE_URLS` overrides it in a test run only (`CC_COCKPIT_TEST=1`, unpackaged app). Index repo CI (`marketplace/.github/workflows`) validates entries, lets an owner (numeric
  GitHub id) publish a new version by PR without a human, and publishes `index.json` with a token. A bad entry on main keeps its last published listing and fails the run without holding up `index.json`, since revocations travel in the same file; only a bad `revoked.json` stops the publish.

## 6. Plugin sign-ins and secrets, settings, projects, CLI

There are no named accounts and no Accounts page: a plugin that needs a sign-in brings its own UI
and flow (its panels or overlays, or a secret field in its settings form; not a settings page of
its own). (Named accounts were removed in 2026-10; an old `accounts.json` in the data dir is
ignored and can be deleted by hand.) Core keeps only what main alone can do:

- **`ctx.secrets`**: `get(key)`, `set(key, value)`, `delete(key)`, `keys()` over a small
  keychain-backed store per plugin (Electron `safeStorage` exists only in main; the plugin host
  is a `utilityProcess` and cannot reach it). On Linux, Electron picks its keyring backend from
  `XDG_CURRENT_DESKTOP` and falls back to `basic_text` on a desktop it does not know (Hyprland, sway, i3),
  which the store refuses even when gnome-keyring or KeePassXC owns `org.freedesktop.secrets`. So before
  `ready`, `main/index.ts` asks `choosePasswordStore` (`src/main/secrets/password-store.ts`) and appends
  `--password-store=gnome-libsecret` when the desktop is not one Electron maps to a keyring, the user passed
  no `--password-store` of their own and the Secret Service name has an owner on the session bus (a
  `dbus-send ... NameHasOwner` call, argv only, bounded; any failure means no switch). With no keyring the
  error names the fix: start and unlock a Secret Service keyring, or launch with
  `--password-store=gnome-libsecret` (`kwallet6` on KDE 6). There is still no plaintext fallback.
  The backend name and `isAsyncEncryptionAvailable` are not trusted alone: with a forced
  `--password-store` and no keyring behind it, Electron 45 reports both as fine and encrypts with
  Chromium's hard-coded key, tagging the ciphertext `v10`. On Linux the store encrypts a probe and
  accepts only `v11` (a key from the keyring), on the probe and on every value it returns.
  App-wide per plugin id; a plugin that wants
  per-project sign-ins names its keys itself (`google:work`) and lets the project pick one
  through a normal project setting. Keys match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, values are
  at most 64 KiB, at most 100 keys per plugin. The prefix `setting:` is reserved for secret
  settings fields (below): plugins are refused `set` / `delete` on it, `keys()` hides those keys,
  and they do not count toward the 100. `set` rejects when the OS cannot encrypt: plaintext is
  never stored. Uninstalling a plugin deletes its secrets (credentials should not outlive the
  plugin, unlike per-project plugin data), and forgetting a project drops every plugin's
  `setting:project:<projectId>:*` keys.
- **Secret settings field**: a top-level string property with `"format": "secret"` in a plugin's
  settings schema. A token-style sign-in is one password field in the plugin's own settings
  form. The value is stored encrypted under `setting:app:<field>` or
  `setting:project:<projectId>:<field>` (a project field's global value is `setting:projectDefault:<field>`),
  never in the settings files, and never reaches a
  renderer: the form shows "Set" / "Not set" with Replace and Clear. The plugin host receives the
  plaintext in `ctx.settings`. An unset secret, even a required one, does not mark the plugin's
  settings invalid or disable the plugin: `ctx.settings` just lacks the field and the form shows
  "Not set". The format is refused anywhere but a top-level string property (nested, `items`,
  `allOf`/`anyOf`/`oneOf`, `$ref`), with a `default`, or with any keyword but `type`, `format`,
  `title`, `description` and `$comment` (the value is not validated). A root
  `allOf`/`anyOf`/`oneOf`/`not`/`if`/`then`/`else`/`dependencies` may not name a secret field: it
  would act on values checked without it. A schema with a secret field holds no reference or
  identity keyword at all (`$ref`, `$dynamicRef`, `$recursiveRef`, `$anchor`, `$dynamicAnchor`,
  `$recursiveAnchor`, `$id`), anywhere: ajv and the form resolve references differently, and main
  must see the same secret fields as both. Known limitation: a plugin update or dev
  reload that drops a secret field or makes it plain leaves its encrypted `setting:` value in
  `secrets.json` (unused) until the plugin is uninstalled or, for a project field, the project is
  forgotten; a field that becomes secret leaves its old plain value in the settings file (unused)
  until that form is saved again.
- **`ctx.oauth`**: optional helper wrapping the loopback + PKCE code. `authorize(spec)` opens
  the system browser, catches the loopback redirect and exchanges the code; `refresh(spec,
  refreshToken)` gets a fresh access token. Both answer `{ accessToken, refreshToken, expiresAt,
  scope? }`, `scope` being the granted scopes when the provider sends them (the person may untick
  one on the consent page). `spec` is `{ authUrl, tokenUrl, clientId,
  clientSecret?, scopes }`; both URLs must be https. One `authorize` per plugin at a time (a new one cancels the pending one: a provider error page
  never redirects, so the user can retry at once) and 5 a
  minute, counted per plugin per project (the limit lives in the project's host API, not
  app-wide). Each call belongs to the plugin's ctx that made it: when that ctx is disposed, for
  any reason (deactivate, unload or reload, a failed or timed-out `activate`, the host
  stopping), the call rejects at once, main aborts it (loopback closed, token request dropped)
  and tokens never reach the disposed copy; the window closing or the host stopping aborts every
  pending one too. At most 4 `refresh` calls per plugin in flight.
  Storing the tokens is the plugin's job (`ctx.secrets`).
- **CLI-style login** (`gh auth login`) needs nothing new: the plugin opens a terminal overlay
  with `ctx.overlay.open` and checks the result with `ctx.exec`.
- **Sharing one sign-in between features** is done by one plugin with several panels (a "Google"
  plugin with mail, calendar and drive panels), not by core.

**Trust boundary**: one plugin host serves every plugin of a project window. Main knows which
host (so which project) asks; the plugin id in a request comes from the payload and is only
checked to be one of this host's plugins. Plugins enabled together in any one project therefore
share a host and can read each other's whole store, which is app-wide: every sign-in, the
`setting:app:*` values and this project's `setting:project:*` values (main refuses a read of
another project's, which only that project's host has a reason to see). That is no worse than
what they can already do with `ctx.exec` as the user. Main enforces only which plugins a host may
name, not which plugin is asking; installed plugins are trusted code.

**Settings** open as an overlay:

- Projects: list, open, relink a moved folder, remove.
- Plugins: one page of cards for the installed plugins and the configured indexes' listings (paging, search,
  filters, categories, previews), install or update from a listing, Update all, "Add plugin…" (git URL install, link
  a local folder), update to a newer tag, uninstall, app-wide settings form, and the folded index management (add or
  remove an index, refresh); see §5 Marketplace. A plugin's gear opens its global page: the app form, the global values of
  its project fields and its html page (Global values and project overrides, below). A row still names a problem with a
  service the plugin uses.
- This project: the project's colour (below, Project colour), enable plugins, each enabled plugin's project settings
  (every top-level field under "Use global" or an override), panel zones, the project's commands in the new-tab menu (§3
  Custom commands), and the Services group, this project's picks (a service with several providers, the open-file plugin,
  and one row per slot type with a candidate: "Plugin drawing the agenda slot", with "None").
- General: what a tab does when its process exits (close when it ends normally, or keep; §3 Exit);
  whether a project that opens empty gets a Claude tab (§3 First tab); whether closing a running tab
  asks first (§3 Close); side panels, Claude sessions, notifications, the app-wide commands in the
  new-tab menu (an editable list: add, edit, remove, move up / down; §3 Custom commands), the
  command line install and updates.
- Appearance: theme; the window background (transparent project windows, opacity, blur;
  §4 Window background); which end of a tab its × sits at (§3 Close); the terminal font (a family
  dropdown: bundled, installed, Custom…), with a preview and Reset to defaults (§4 Terminal font).
- Keybindings: the list with overrides (the new-tab menu entries included, §3 Custom commands ›
  Keys for entries).

**Global values and project overrides** (design-next §5.2). A plugin's `settings.app` fields are app-wide by meaning and
edited only on its global page (Plugins, the card's gear). Its `settings.project` fields also have a **global value** on
that page, and This Project shows each with "Use global" (the default) or an override. `ctx.settings.project[field]` is the
project's override, else the global value, else the schema default; only top-level fields are overridden (an object field
whole), and the schema validates the merged object, so a save that would make any open project's effective values invalid is
refused with that project named. Storage: the global values are `app.json` › `pluginProjectDefaults[pluginId]`
(main-owned, like `ctx.appStorage`), an override stays in the project record, and "use global" is the key being absent. A
secret project field's global value is the secret `setting:projectDefault:<field>` (a third reserved form under `setting:`,
next to `setting:app:` and `setting:project:<projectId>:`), an override `setting:project:<projectId>:<field>`; the host gets
the effective plaintext, and a secret override cleared goes back to the global value. `ctx.onSettingsChange` fires in every
project whose effective values changed, so a global edit reaches each project that uses global. At first start a stored
project value equal to the schema default is dropped (it becomes "use global"; the global value starts as the default, so
nothing changes) and every other value stays an override. `ccc plugin config` reads the three scopes and sets `--scope global`
(a project field's global value) or `--scope project` (an override); `--use-global <key>` drops an override.

Plugin forms are rendered from the manifest's JSON Schema, plus an optional html page (below). A panel
never holds a settings form: the app draws a gear in the header of every panel whose plugin has settings
(`PanelInfo.settings`, `settingsGearOf` in `src/shared/settings-gear.ts`), after the plugin's actions and before
the "…". It opens Settings > This Project at the plugin when it has project settings (a `project` schema or a
page with the `project` scope), else the plugin's global page under Plugins (an `app` schema or a page with the
`app` scope); the plugin's header action with the `settings` icon is then redundant. For what a form cannot hold, a plugin may
add an html page with `contributes.settings.page` (`{ entry, scopes }`, scopes `app` and/or `project`),
shown under the form; its backend is `ctx.settingsPage.onOpen` in the window's host. The page has no
settings API of its own (the plugin stores what it edits via `ctx.appStorage` / `ctx.storage`) and never
receives a secret value. One page of a plugin is open at a time; a plugin not enabled in the project has
no backend there, so the page shows an enable hint.
Besides `"format": "secret"` (§6) the form knows two more formats. `"multiline"`: a string drawn as
a growing text area, allowed anywhere in the schema. It is a hint to the form only (main's ajv does
not validate formats), so it needs no check in main. `"sound"`: a notification sound picker, the
app's "Sound" dropdown (`renderer/settings/sound-options.tsx`, shared with General) with
"App default" (stored as `""`) first and ▶ Play (which plays at once, even with "Notification sounds"
off: it is a preview), so a plugin can let the person pick its own sound and pass the value to
`ctx.notify(text, { sound })` (§5 Notifications). Allowed anywhere, but main checks the field
(`soundFieldProblems`, `main/plugins/validate.ts`): exactly `"type": "string"`, no keyword but `type`,
`format`, `title`, `description`, `default`, `$comment` (an `enum` or a `maxLength` would fight the
picker), and a `default` of `""` or a built-in id (`builtin:chime`, `builtin:bell`, `builtin:ping`,
`builtin:pop`, `builtin:two-tone`, `builtin:marimba`), never a system file, which differs per machine.
A stored value is not checked against the app's sounds: main does that at every ring, so any string is
harmless. The picker shows an id it does not list as "Missing sound file" (a system id) or "Unknown
sound". An app without the format (0.9.4) draws a text input and ignores `ctx.notify`'s options.

**Projects**: File › Open Folder or `<app> open <path>`; an already-open folder focuses its
window. The project picker (recent projects + Open Folder…) appears by itself when no project
window is left, and on request from an open one: the top strip's "+" or File › Open Project…
(no default key: none existed, and a new chord could take one Claude or a plugin uses). The
renderer asks main (`projects.showPicker`, project windows only); there is only ever one picker,
so asking again focuses it, and it re-reads the recent list when it gains the focus. Picking a
project there opens its window, or focuses it when it is already open; either way the picker
closes. Opened from a project window (the "+", the menu item while one is focused) the picker is a
**modal child of that window** (`parent` + `modal`; a sheet on macOS): the window takes no focus or
input until the picker closes. Main picks the parent from its own window table (the IPC sender's
window, or the focused window for the menu), never from an id a renderer names. With no calling
window (start with nothing to restore, the last window closed, the Dock) it is a standalone
window. A modal picker offers Cancel and Esc (`projects.closePicker`, refused for a standalone one,
whose close button is the app's quit decision); every way of closing it returns focus to the
parent. If the parent window closes first, a standalone picker replaces its sheet. An already open
picker is only focused, whichever window asks. The record (path, settings, layout, tabs, window bounds) lives in
`<data>/projects/<id>.json`. A missing folder at open → relink or forget. Forgetting a project
also drops its plugins' secret project settings (§6 `ctx.secrets`).

**Project colour**: a mark to tell project windows apart (`src/shared/project-color.ts`). None
by default; one of eight palette colours like Finder tags (`red`, `orange`, `yellow`, `green`,
`teal`, `blue`, `purple`, `grey`), or a custom `#rrggbb`. Stored as the record's `color`
(lowercase hex); the file is user-writable, so the registry reads anything else as none.
Settings › This project › Colour sets it (`settings.projectColorSet`, a project route: always the
sender's own project; the picker cannot set one). Main checks it strictly (a palette name or exactly
`#` plus six hex digits, a character loop, no regex) and refuses anything else with the reason.
A palette colour is a theme token, `--cc-project-<name>`, defined per built-in theme to read on
its bars (a plugin theme inherits the missing ones from the built-in of its kind); a custom hex
is drawn as-is in every theme. It shows as a 3px line along the window's top edge (absolutely
placed over the top bar: no layout shift, the traffic lights and the full-screen collapse
untouched), a 10 % tint of the top bar (in a see-through window the tint goes into the bar
colour before the glass alpha, so the bar stays one translucent layer), and a dot by the
project's name: its own title-bar chip and the picker's rows (other windows' strips are the
`cockpit.sessions` plugin's: `SessionSummary.project.color`, read again with the next session change).
A change is live in core: main sends the project's window `project.updated` (its summary, as
`window.info` gives it) and tells an open picker `projects.changed` (it reads the list again). Settings
› Projects does not show the colour.

**Window bounds**: each project window reopens at its last size and place. The record's `bounds`
holds the normal x/y/width/height plus `maximized` / `fullScreen` (set only when true); it is
saved on move, resize, maximise and full-screen changes (debounced by the store) and again on
close, never while minimised. On open it is validated (damaged → the default 1280×800, centred;
a half position → OS-centred) and fitted to the connected displays: a window overlapping no
display by 64 px (a monitor unplugged) is clamped onto the nearest one, shrunk to its work area.
A maximised or full-screen window is created at its normal bounds and switched once shown, so
un-maximising lands there. New projects and the picker keep the default sizes
(`src/main/windows/window-bounds.ts`).

**CLI** (`<app> …` over the socket; exits 0 silently when the app is not running):

| Command | Used by |
|---|---|
| `open <path>` | user, scripts |
| `hook <event>` | the app's Claude hooks (internal) |
| `session note "…"`, `session steps 3/5` | Claude or a skill inside a Claude tab: extra lines on its status entry |
| `overlay --terminal -- argv…` / `--url U` / `--html F` | anyone; waits and prints the result |
| `notify "…"` | anyone |
| `sessions --json` | scripts: current Claude status |
| `guide [topic]`, `<command> --help` | Claude or a person: bundled docs; works with the app closed |
| `guide types` | the SDK types (`src/sdk/types.ts`, bundled with the CLI by a `?raw` import); works with the app closed |
| `plugin config <id> [--json]` / `plugin config <id> [--scope app\|global\|project] key=value…` / `plugin config <id> --use-global key…` | the plugin's settings (one `scope key = JSON` line per top-level field, a secret only `set` / `not set`) or a save through the Settings form's own path (`settings.pluginSettingsSave`: the same schema check, then `ctx.onSettingsChange`); a value is JSON if it parses, else text; the scope is the one whose schema declares the key (both: `--scope` needed); `global` is the global value of a project field, `project` an override, `--use-global` drops an override; a secret field is refused, a person sets it in Settings |
| `panel show <plugin>/<panel>` | reveals the panel in the caller's project window (unhidden, opened, its zone expanded: what `ctx.panels.show` does); refused for an unknown or not enabled plugin, an undeclared panel, or a project with no open window |
| `plugin new <dir>` / `link <dir>` / `unlink <id>` / `list` / `logs <id> [--follow]` | the plugin dev loop; `new` and `logs` are local, `link` asks the person to confirm in a native dialog (Deny is the default); the dialog rate limit is per window and counts only requests that reach a dialog; linking an already-linked folder (same id and path) only enables it in the calling project after the confirm; the manifest is re-checked against the inspected id, so a swap between dialog and link is refused |
| `<name> …` | a command a plugin declared in `contributes.cli`; main routes it to the owning plugin of the caller's project (30 s limit, 256 KiB each for stdin, stdout and stderr); `ccc help` lists them inside a tab |

A plugin command never waits without a bound. A plugin that is reloading or still starting is waited for
inside the same 30 s (`HostManager.waitCliReady`), and the command then runs in the new copy; if it is not
active by then, or the limit passes, the answer is exit 124 (`CLI_TIMEOUT_CODE`, also `timeout(1)`'s). A call
already running in the old copy when the reload starts ends with exit 1. The client adds its own bounds: a reply
timer of 35 s (`CLI_REPLY_TIMEOUT_MS`) and a hard deadline of 40 s over the whole call
(`CLI_CLIENT_DEADLINE_MS`, a backstop for whatever the round trip fails to settle), each exit 124. Stdin is read
only for a command declared `stdin: true` and only when it is not a terminal; if it is not closed within 40 s
(`STDIN_READ_TIMEOUT_MS`, an open pipe a tool runner leaves attached) the command prints the reason and exits 124.
`plugin config` with values, like `overlay` and `plugin link`, has no 10 s reply timer: it waits behind the plugin's settings-save
queue (a form save may sit at a keychain prompt) and for a host the change restarts. Its edits are merged into
the stored values inside that queue, so overlapping calls setting different keys both land.

Inside a tab of any kind or a terminal overlay, the token (`APP_TAB_TOKEN` and `CC_COCKPIT_SOCK`,
the same variables for both kinds; tabs also get `APP_TAB_ID`) selects that window; outside,
`--project <path>` does. A window token (shell tab, command tab, terminal overlay; §2) is taken by exactly
the commands a `--project` caller may use (`open`, `notify`, `overlay`, `sessions`, plugin
commands, `plugin link|unlink|list`) plus the plugin list behind `ccc help`
(`WINDOW_TOKEN_COMMANDS`, `src/shared/protocol.ts`); `hook` and `session note`/`steps` need a
Claude tab's session token. A `ccc hook` with a window token still exits 0 and records nothing.

## 7. Stack, errors, testing

**Stack**: TypeScript, Electron, `electron-vite`; `xterm.js` (fit, web-links, unicode11
addons) + `node-pty`; React for the shell UI; `@rjsf` for JSON-Schema forms; `electron-builder`
for packaging. Phase 1 builds mac and Linux; socket and PTY sit behind one interface so named
pipes and ConPTY can follow for Windows.

**Repo layout**:

```
src/main/        windows, pty, session registry, socket + CLI server, store, secrets, oauth, plugin install
src/host/        plugin host: loader, ctx implementation, scheduler, exec
src/renderer/    shell UI: zones, tabs, overlay stack, top strip, settings
src/sdk/         plugin types + panel.js (published for plugin authors)
src/cli/         the `<app>` CLI (small Node script talking to the socket)
plugins/hello/   reference plugin exercising every contribution point
test/            unit + e2e, fake `claude`
```

**Errors**: a plugin throwing in `activate` or a scheduled job is logged and shows ⚠ on its
icon (error in the tooltip), never takes down the window. Host crash → restart with backoff. A
broken manifest or settings failing the schema → that plugin is disabled with the reason on the
settings page. Hook delivery failures are dropped silently.

**Testing**: vitest for logic without a window (hook → status reducer, send-text gate and
queue, manifest/settings validation, layout state, restore). Playwright on Electron with a fake
`claude` script that emits hook events and reads stdin: open a project, open a tab, status
reaches the tab dot and the cockpit.sessions strip, the hello plugin's panel sends text, text is queued while busy, an overlay
returns a result.

### Distribution

A `v*` tag runs `.github/workflows/release.yml`: it checks the tag equals `v` + the `package.json` version
(`scripts/check-release-tag.mjs`), runs `ci.yml`, builds the arm64 dmg on macOS and the AppImage and deb on Linux, then
creates a draft GitHub Release with a `SHA256SUMS` file. Only the last job has a write token and it checks out no code.
Publishing the draft by hand runs `publish-cask.yml`, which takes the newest published stable release (not the one that
triggered it: GitHub drops a pending run when a newer one queues, so a late older release could otherwise cost the newest
its update), verifies its dmg against `SHA256SUMS`, renders the cask (`scripts/render-cask.mjs`) and pushes it to
`BronOS/homebrew-tap` with the `TAP_TOKEN` secret. A prerelease never reaches the tap.
electron-builder never publishes (`publish: null`, guarded by `packaging-config.test.ts`). There is no auto-updater: the app
checks `releases/latest` (`main/updates/update-check.ts`) and shows a notice, since replacing the app under running
sessions would restart them. Builds are unsigned (Mac: ad-hoc). The `ccc` reply carries `appVersion` so the CLI can warn on a
mismatch.

To cut a release: run `npm test` and `npm run test:e2e` (CI does not run e2e; on Linux only `window-bounds.spec.ts:40`
and `:62` may fail), check that the `TAP_TOKEN` secret is still valid and that the tap has a `main` branch, bump the version
in `package.json`, commit, tag `vX.Y.Z` and push the tag, try the draft's files on a Mac and a Linux machine, then publish
the draft. On a failed run, delete the draft and the tag and tag again.

After publishing, confirm that `publish-cask` went green and that `brew update && brew info BronOS/tap/cc-cockpit` shows the
version. It runs once the release is public, so if it fails the update notice is already out while the cask stays on the
old version; re-running it picks up the newest release. An older release published late changes nothing there, and the run
never moves the cask to an older version than the tap has.

The packed app must have no world-writable file: `scripts/after-pack.cjs` clears those bits, because Electron's own files can
carry them, and the release workflow stops if any remain.

The first-launch text in the README and the cask caveats (`scripts/render-cask.mjs`) comes from the v0.1.0 run on a Mac: macOS
asks once to allow the app. Check it still holds when the signing setup or the macOS floor changes.

## 8. Open points for the plan

All decided in phase 1:

- CLI binary name: `ccc`. Data dir: Electron's `userData`, overridable with `CC_COCKPIT_DATA_DIR`.
- Keybindings: Cmd-based, mac-first (on Linux Cmd = Ctrl), e.g. Cmd+T new Claude tab,
  Cmd+Shift+T shell tab, Cmd+W close tab, Cmd+B / Cmd+J / Cmd+Shift+B toggle zones, Cmd+, settings,
  Cmd+Shift+P palette, Cmd+Shift+W close the top overlay, Ctrl+Tab / Ctrl+Shift+Tab switch tabs in
  recent order (held: an overlay lists them; Ctrl on every platform). All editable in Settings.
- Hooks: `PreToolUse` on every tool (`*`); `PostToolUse` only for `Edit|Write|MultiEdit|NotebookEdit` and the
  dialog tools `AskUserQuestion|ExitPlanMode` (§3 Status per tab).
  All hooks are synchronous, so arrival order equals event order. No hook fires when a permission
  dialog is answered (and `PostToolUse` only when the tool ends), so an answer key typed into a
  needs-permission tab is what moves it back to working; widening the `PostToolUse` matcher would
  not cover a long-running approved tool and would cost ~90 ms per tool call.
- Idle is not sendable: text is delivered only while a session is waiting for input.

### Implementation notes (differences from the sections above)

- The send gate also refuses text starting with `/`, `!`, `#` or `&` (slash commands, bash mode,
  memory and background prompts could bypass a permission prompt).
- Plugin settings schemas may not use regexes (`pattern`, `patternProperties`): ReDoS in main.
- `ccc overlay --html` reads the file once in main and serves it from the privileged
  `cc-overlay://<overlayId>/` scheme; there is no one-shot protocol.
- A plugin's html overlay is served the same way (no port to the page yet).
- The settings screen is a renderer-drawn overlay below the overlay stack, not part of it.
- The hello plugin (`example.hello`) is not bundled in the packaged app: plugins are linked or installed from a
  folder, and hello is a template to link in dev (`electron-builder.yml`). Only the built-in
  browser, reviewer, editor, files and sessions (`plugins/browser`, `plugins/reviewer`, `plugins/editor`, `plugins/files`,
  `plugins/sessions`) ship, as bundled plugins.
- `ctx.cli.register` is host-local (no call to main); main routes by manifest. Plugin commands are
  listed by `ccc help` only inside a tab.
- The web view is also reachable at `cc-preview://<token>/…` only on its own partition session; a
  hostile page can still navigate the top level to http(s) with data in the URL (the CSP cannot
  stop that), so a preview folder should hold only what the page may see.
- Linux targets (AppImage, deb) are x64 only; mac builds arm64 only.
- The "Install ccc command" button only creates the `~/.local/bin/ccc` symlink; nothing in the
  app removes it again (`src/main/hooks/ccc-install.ts`).
  A start-up question offers the same install (`src/main/hooks/ccc-offer.ts`, `CccOfferDialog` in the
  renderer; main decides, the renderer only asks `ccc.offer` and draws it): only when nothing is at the
  path (an installed link needs nothing; a foreign file or other link is something the installer refuses to
  replace, so a Yes could only fail and the Settings row explains it), once per launch to the first project
  window that asks (a second window or a page reload never asks again), never when the link cannot be
  inspected, and never in a test run unless `CC_COCKPIT_CCC_OFFER=1` (itself honoured only in a test run).
  "Don't ask again" sets `cccOffer: false` in `app.json`; Settings > General > Command line >
  "Offer to install at start-up" turns it back on.
- The keybinding editor refuses ctrl+c, ctrl+d and ctrl+z (they would be eaten from the terminal).
- "Cmd = Ctrl" on Linux is kept as decided: the defaults Cmd+T/W/B/J/O become Ctrl chords that
  Claude Code and readline also use, so on Linux they never reach the terminal until rebound.
  A Linux-specific default table (Ctrl+Shift, as terminal emulators do) is left for when the
  Linux build is actually tried; it cannot simply be Ctrl+Shift for everything, since Cmd+T and
  Cmd+Shift+T (and W, B) would collide.
- Closing a tab or window sends SIGHUP and, after 3 s, SIGKILL to a child still running
  (`PtyService.terminate`), as a dismissed terminal overlay does. A child that exits while its PTY
  is paused for flow control still delivers its tail: the node-pty backend polls the paused
  child and resumes once it is gone (`src/main/pty/exit-drain.ts`).
