# Code editor (design)

Status: implemented (2026-11-13; plan `docs/plans/completed/20261112-code-editor.md`, what v1 leaves out in §6).
Revision 2 (2026-11-12): the brainstorm's design, revised after a Fable review (all findings applied). A main
coding editor in cc-cockpit: files as tabs in the tab bar, CodeMirror 6, language servers from v1, and Claude features
built in. It works the same on the desktop, in a browser and in a remote window, because it is a plugin page.

Decisions taken in the brainstorm:
- **Job:** a main coding editor, not a quick-edit tool.
- **Placement:** open files are tabs in the main tab bar, next to Claude tabs.
- **Claude writing an open file:** reload when clean, three-way merge when dirty, conflicts inline.
- **Intelligence:** LSP from v1, for TS/JS, Go, PHP and Python, any other server by setting.
- **Claude features in v1:** Ask Claude on a selection, a quick chat popup that proposes edits, Claude's changes in
  the gutter, `ccc edit path:line`, review notes in place.
- **Component:** CodeMirror 6 with our own LSP client (option A), over Monaco (B) and a VS Code server in a webview
  (C): the Reviewer already ships CodeMirror 6, it is small, themes from the component stylesheet, and works on touch.
  If it feels wrong in use, the component can be swapped behind the same tabs.
- **One release**, with a try-it checkpoint after page tabs and basic editing.

Revision 2 (review findings, all applied): Ask Claude goes through core's Discuss (a plugin's `sessions.send` is
refused on a typed tab); the editor host is the only LSP client (pages never speak LSP to a server); page-tab frames
survive a host restart, a web reconnect and a relay backlog; each page keeps its own base and merges, the host only
compares and swaps; the save is checked on the inode; frames mount lazily; dirty and close are per view and the close
question is core's; keyboard routing is its own piece; page-tab types are declared in the manifest; `processes` is
not a capability (host code can already spawn); argv hardening for `rg` and `git`; one server per language per
project; quick chat runs with `--restricted --strict-mcp-config --tools Read,Grep,Glob` (the build added `--safe-mode` and
`--permission-prompts none`, §4 "Quick chat"). Cut from v1: Vim mode, the
"since opened" mark, the Plugins-page process list, root detection.

## 1. Architecture

Three pieces: two in core, one plugin.

**Core: page tabs.** A new `TabKind` `page` beside `claude`, `shell`, `command`: a tab whose content is a plugin
page. A plugin declares its page-tab types in the manifest (`contributes.tabs: [{ type, page }]`, validated like
`contributes.slots`); main never takes a page path from the host. A plugin opens one with
`ctx.tabs.openPage(type, params, { title, icon })`; the editor uses type `file` with params `{ path, line?, col? }`.
The shell draws the page in the tab area in its own frame with its own `MessagePort` to the plugin's backend, as it
draws slots. Ctrl+Tab, drag, flags, close, the All tabs menu and restore work as for any tab. A saved page tab keeps
type and params; on restore its plugin is asked again; a gone or revoked plugin drops it. A page tab is never typed
into as a terminal: the send gate, `typed` and Claude status do not apply. Title and icon are set by main from the
plugin's request, clamped.

Frame lifetime (a page holds unsaved text, so its frame must outlive what reloads plugin pages today):
- **Mount** on first select, not at restore; a small LRU keeps recently used frames alive; a cap on page tabs per
  plugin; never mounted in server mode's hidden page.
- **Host restart:** the frame stays; main delivers a new port to it (the panel SDK's port handover, no reload), and
  the page re-sends what it holds (open files, dirty buffers).
- **Web reconnect:** a browser or remote view's remount keeps page-tab frames (they sit outside the remounted tree) and
  hands them a new port the same way.
- **Relay backlog:** a page-tab port is not closed at the relay's byte limit; its limit is higher (64 MiB, room for a
  whole file's answer in one burst) and past it the port is paused and resynced (the page owns its buffer, so dropping
  messages is safe once it resends; the editor's reconnect asks for the file's head only, the text only when it changed).

Dirty and close: dirty is per (tab, view), kept by main from each page's report. Closing a tab that is dirty in any
view asks with core's dialog (the `CloseTabDialog` pattern, an `ApprovalDialog` in server mode), also on window close,
on a window reopen (Settings › Window's "Reopen window": the new window restores the tabs, never their buffers; Cancel or
a box that fails to show keeps the window) and on quit; the page cannot block or delay a close itself. A browser view's
own unload (the browser tab closed, reloaded or navigated away) is the web shell's: it holds the unload with the
browser's "Leave site?" question (`beforeunload`) while a page frame in that view is dirty. A desktop remote window's
page has the webview hardening, which lets every unload go ahead, so main asks instead: the person's own close of the
window is held, the page is asked whether it would hold an unload (a cancelable `beforeunload` dispatched from main's
isolated world), and when it would, core's native box asks (Discard and Close / Cancel, naming the window; a page that
does not answer within a second, or a box that fails to show, closes). Main's own loads and closes of that window (a
re-pair or sign-in, the tunnel back on another port, Forget, a project the server closed, and quit) do not ask: their
state cannot wait on a box, and most of them happen to a page signed out or cut off from its server. A known limit.

Keyboard: a sandboxed frame's keys never reach the shell's window listener. Desktop: `before-input-event` on the frame
maps app chords to `commands.trigger`, as webview panels do. Web shell: the panel SDK forwards chords to the parent.
Precedence: the app table and `keyOverrides` win for chords they hold (Ctrl+Tab, Ctrl+W...); the editor's own chords
(Ctrl+P, Ctrl+K, Ctrl+L, Ctrl+D, Ctrl+S) are declared in its manifest as page-tab keys and go to the page while it has
focus; a conflict with the app table is shown in the keybinding editor (Settings > Keybindings lists the key two
commands share). The default table holds one: Ctrl+Shift+F (Cmd+Shift+F) is core's Toggle Tab Flag, so find in files
got Ctrl+Shift+H and a context-menu item, and its declared Ctrl+Shift+F reaches the page only once the flag is rebound.

`ccc edit` "the tab is marked": a core *unseen* dot on a tab opened while you were elsewhere (cleared on first view);
never a tab flag, which is the person's alone.

**Core: long-running processes.** `ctx.processes.spawn(argv, { cwd })` returns a handle: `write(bytes)`,
`onData(bytes)`, `onStderr`, `onExit`, `kill`. Bytes, not text (LSP framing counts bytes). argv only, never a shell;
the same env fixes as `ctx.exec`. It runs in the plugin host, which can already start processes, so it is not a
capability: a cap per plugin (host side) and the kill of every child with its process group when the host stops or
the plugin reloads; a child whose stdin closes at a host crash exits (LSP servers do on EOF).

**The plugin `cockpit.editor`**, rewritten. Page: CodeMirror 6, the editor UI, the merge, the quick-chat popup. Host:
file read and compare-and-swap writes, the watcher, the LSP client (one per server), quick chat. The `editor` v1
service (`open(path, { line })`, used by Files) keeps working and opens a file tab; micro stays as "Open in micro",
and its settings (`microPath`, `colorscheme`) stay for it; `autosaveSeconds` is replaced by the new autosave
settings, read once as a default. For a remote project the editor runs in the server's plugin host: files and language
servers stay with the code.

## 2. Files, saving, Claude writing the same file

**Opening.** Through the Reviewer's Edit button (the file overlay), the `editor` service, `ccc edit` and the editor's
own navigation (go-to-definition, quick open). A plain click on a file keeps opening the Reviewer's view by default
(Oleg's decision at the checkpoint, 2026-11-13), and is configurable ("make it configurable", the same day): the editor
declares `contributes.openFile` with `whenPicked: true`, a general manifest flag meaning "a candidate only when the
project picked it", so it is listed in Settings > This Project, "Plugin used to open files", and with no pick it is
left out (the Reviewer stays the default, nothing becomes ambiguous). Picked, a click opens the file's tab; a binary
file is refused by its listener and the built-in viewer shows it. Only files inside the project, checked by realpath; outside files go
to the built-in viewer. Binary files, text over about 5 MB, and text that is not valid UTF-8 open read-only (saving
would corrupt them). A file that already has a tab focuses it and moves to the line.

**Base, in the page.** Each page keeps its own *base*: the text and hash it last loaded or saved. The host keeps no
merge state, so two views and a host restart are just more writers.

**Saving: compare and swap in the host.** The page sends `save {text, baseHash}`; the host answers `saved {hash}` or
`changed {theirs, hash}`. The host writes to the file's realpath (a symlink is never replaced): it opens the current
file and holds that descriptor, checks the hash against `baseHash`, writes a temp file in the same directory, checks
the inode and hash once more just before the rename, renames, then re-hashes the held old descriptor; a difference
means a write landed in between, and the host answers `changed` with that text so the page merges it. Line endings,
final newline, BOM and mode are kept.

**Autosave:** on focus loss and after about 3 s idle (setting; off allowed); Ctrl+S saves at once.

**Claude changes the file.** The host watches each open file's directory (a rename-replace ends a file watch), and the
page re-checks on focus and before every save.
- Clean buffer: reload; cursor, scroll and selection mapped through the change; changed lines flash.
- Dirty buffer: the page merges three ways (its base, its text, theirs). Clean: applied and saved, notice "Merged
  Claude's changes". Conflicts: inline mine/theirs blocks with Keep mine, Take Claude's, Keep both; no save until all
  are resolved; the tab shows a conflict marker.
- Deleted or renamed: the tab stays, "deleted on disk", with Save (recreate) or Close.

Not in v1: a "Claude is editing this file" lock; local history beyond undo.

## 3. Language servers

**The host is the only LSP client.** Pages never send LSP to a server. A page asks the host in editor terms (`opened`,
`changed`, `hover at`, `complete at`, `definition at`...), and the host speaks LSP: it owns `initialize`
(capabilities, `processId`, root, `initializationOptions`) and all configuration (`didChangeConfiguration` comes from
app settings only), keeps one id space per server, refcounts documents per URI (one syncing owner per document; other
views read), validates every URI against the project, allow-lists the methods a page may trigger (no
`workspace/executeCommand` from a page; code actions are applied by the host), answers server-to-client requests
itself (`workspace/configuration`, `applyEdit`, progress), and trims results to stay under the port's message cap.

**Servers.** Built-in table: TS/JS `typescript-language-server --stdio`; Go `gopls`; PHP `intelephense --stdio`, else
`phpactor language-server`; Python `basedpyright-langserver --stdio`, else `pyright-langserver --stdio`. Looked up on
the login-shell PATH. A missing server is not an error: highlighting only and a bar with the install command. App
setting `servers` (`{ language, extensions, argv }[]`) adds or overrides.

**Lifecycle.** One server per language per project, rooted at the project folder. Started on the first file of that
language, stopped a minute after its last tab closes. A crash restarts with backoff (3 in 5 minutes), then a bar with
Restart. The host sends `workspace/didChangeWatchedFiles` for project changes it sees (Claude edits files that are not
open; gopls and tsserver go stale otherwise).

**v1 features:** diagnostics, hover, completion with snippets, signature help, go-to-definition, find references,
rename, format, code actions, document symbols. A definition in another project file opens or focuses its tab; a
location outside the project (`node_modules`, module cache, vendor) opens read-only, and only for a location the server
returned. Rename and code actions: the host declares no resource operations (no file create, rename, delete) and
applies a `WorkspaceEdit` to open files through their pages and to unopened files through the compare-and-swap write.

Language servers run project tooling, as in any IDE; the docs say so. The page never names a binary or a setting a
server would use to start one.

Not in v1: debugging (DAP), semantic tokens, call hierarchy, workspace symbol search.

## 4. Working with Claude

**Ask Claude** (to a tab) is core's Discuss for page tabs: select, Ctrl+L or the context menu; core draws the question
box; main asks the editor's `onDiscuss` for the context (`About: src/x.ts:40-52` and the fenced selection), adds the
question, and sends through the send gate as person-origin text, to the Claude tab last used in the project or one
picked from a short menu; delivered only in *waiting for input*, queued otherwise. A plugin's own `sessions.send`
would be refused on any typed tab, which is nearly every tab.

**Quick chat** (Ctrl+K on a selection): a short-lived headless Claude through `ctx.processes` in the project folder,
with a fixed argv: `claude -p --restricted --safe-mode --strict-mcp-config --tools Read,Grep,Glob --permission-prompts
none --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <setting>`.
`--restricted` ignores the user, project and local settings files (their hooks and permissions with them) and removes
the tools that run commands; `--safe-mode` turns off installed plugins (and their hooks), skills, CLAUDE.md, custom
agents and commands, which `--restricted` alone still loaded; `--strict-mcp-config` with no config means no MCP server;
`--tools` leaves only reading; `--permission-prompts none` denies whatever would ask instead of waiting on a prompt
nobody answers; `--verbose` is required by `-p` with stream-json output, and `--include-partial-messages` gives the
streamed text. So no user or project settings, plugins, hooks, CLAUDE.md or MCP servers are loaded; the host refuses
to start when the installed `claude --help` lacks any of these flags. The prompt carries the path, the selection
and about 30 lines around it, as data (file text can carry injected instructions; with read-only tools and no MCP the
worst is a wrong proposal). Answers stream as Markdown; follow-ups continue the same headless session; closing the
popup ends it. A proposed change is a replacement for the selection, shown as an inline diff; the range is mapped
through later edits, and a proposal whose original text no longer matches is dropped. Accept puts it in the buffer;
Claude never writes. Model: app setting, default `sonnet`. These runs leave transcripts in `~/.claude` and count in
Usage (documented).

**Claude's changes in the gutter.** Lines changed against git `HEAD` get a bar (host: `git cat-file blob HEAD:<path>`);
hover shows the old lines; click opens the Reviewer's diff. Not a repo or untracked: no marks.

**`ccc edit path[:line[:col]]`** opens or focuses the file tab there. The guide tells Claude to use it to point at
code. It never takes focus from a terminal being typed in: the tab opens with the unseen dot.

**Review notes in place.** The Reviewer's notes for the file show in the gutter; "Add review note" on a selection writes
to the same store. The `reviewer` service gains `notes(path)`, `addNote`, `onNotesChange` (versioned).

## 5. Editing, remote, security, errors, testing

**Editing.** Search and replace (regex, case, word), multi-cursor, bracket matching, auto-close, folding, indent
guides, comment toggle; VS Code-like keys; colours from the cockpit theme, font from the terminal font settings.
Multi-cursor: Alt+click or Mod+click (Cmd on macOS, Ctrl elsewhere) adds a cursor; Alt+drag selects a column and adds
it to the cursors already there (CodeMirror's rectangular selection, which owns every Alt+press, honours the same "add"
flag; VS Code's Shift+Alt+drag is not separate). The indent unit (what Tab inserts, the indent guides' step) comes from
the file: tabs when most indented lines start with one, else the most common space step, else CodeMirror's 2 spaces.
Quick open (Ctrl+P): `rg --files` (ignore rules from rg itself), fuzzy filtered in the page. Find in files
(Ctrl+Shift+H, or the context menu; Ctrl+Shift+F is core's Toggle Tab Flag by default, which the app's table keeps, so it
reaches the page only once the flag is rebound): `rg --json -e <query> -- .`. At most four rg run for the plugin at once, every tab together (they share
ctx.processes' per-plugin cap with the language servers); past that a search is refused with a "try again".

**Web and remote.** A normal plugin page under the path token. File contents travel in chunks under the message cap.
Two views with the same file each have a buffer and a base, and meet through compare-and-swap and merge.

**Security.** The page is untrusted: the host checks every path by realpath against the project root, never lets the
page name a binary, a server setting or an LSP method outside the allow-list. argv only, options ended by `--` before
any user text; `rg` queries go through `-e`. Quick chat's flags are fixed by the host.

**Errors.** Read and write failures show as a bar on the tab and keep the buffer. A language server timing out never
blocks typing. A host restart, a web reconnect or a relay backlog keeps the page and its buffers (§1).

**Testing.** Host (`node:test`): compare-and-swap including the write-between race, symlink and non-UTF-8 cases;
watcher on rename-replace; LSP client against a fake server (initialize once, id rewrite, refcounted documents, URI
checks, method allow-list, server-to-client requests, workspace edits to unopened files, backoff); quick chat argv and
refusal against a fake `claude`; argv hardening. Page: three-way merge (clean, conflict, two views). Core (vitest):
page tabs (manifest types, open, restore, unseen dot, never typed into), frame lifetime across a host restart and a web
reconnect, dirty per view and the close ask, keyboard routing, `processes` (bytes, cap, kill). e2e: open from Files,
type, autosave; an external write (reload, merge, conflict); `ccc edit`; diagnostics from a fake server; a page tab in a
browser view surviving a reconnect with a dirty buffer.

## 6. Not in v1

What the design names and v1 does not do (verified against the code at Task 19; the rest of this document is built):
- **Cut at revision 2:** Vim mode, the "since opened" mark, the Plugins-page process list, root detection (one root:
  the project folder).
- **Files:** a "Claude is editing this file" lock; local history beyond undo.
- **Language servers:** debugging (DAP), semantic tokens, call hierarchy, workspace symbol search; per-server settings
  (`initializationOptions`, `workspace/configuration` values): the `servers` setting only names a command, so a server
  runs with its own defaults and every configuration section is answered `null`; the host has the hook for them
  (`slot.entry.initializationOptions` / `settings`) but no settings field feeds it yet. The case people will hit: a
  Python project's virtualenv (`python.pythonPath` / `python.venvPath`) cannot be named, so pyright and basedpyright
  look for imports with the interpreter they find and may report a venv's packages unresolved unless the project has a
  `pyrightconfig.json` (or `[tool.pyright]` in `pyproject.toml`) that names it; intelephense runs in its free tier
  (no licence key) with its storage in its own default folder. File create, rename and delete
  from a rename or code action are refused (the host declares no resource operations).
- **Not run for real:** the language servers (`typescript-language-server`, `gopls`, `intelephense`, `basedpyright`) are
  exercised against a fake server in tests and e2e; quick chat's argv was checked once against the installed `claude`
  (Task 16) and runs against a fake in tests. A manual run with the real servers is the person's.
