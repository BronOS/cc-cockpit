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
type and params; on restore its plugin is asked again; a gone or revoked plugin drops it, one that failed to load or is off in
the project keeps it in the record for the next launch. A page tab is never typed
into as a terminal: the send gate, `typed` and Claude status do not apply. Nor is it ever a split pane (design.md §3
"Split groups", which hold terminal tabs only): main refuses it in a group, and its frame covers the whole tab area.
Title and icon are set by main from the plugin's request, clamped.

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

Dirty and close: dirty is per (tab, view), kept by main from each page's report. A view's copy of a tab's dirty comes
back from main (`tabs.added`) and can lag the report (typed, then closed at once; another view's page), so the closing
view also reads its own frame's dirty, and main leaves a page tab some view reported dirty open unless the close says the
person was asked (`tabs.close { discard }`; else `{ unsaved: true }` and the view asks then). Closing a tab that is dirty in any
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
maps app chords to `commands.trigger`, as webview panels do. Web shell: the panel SDK forwards chords to the parent,
which runs one only from the shown frame with the keyboard and while `navigator.userActivation.isActive` (a real key
press or click in the last few seconds: a page nobody is using cannot run app commands). This narrows, it does not prove:
the activation is not tied to one key, so a page the person is typing in can post any listed chord they did not press.
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
would corrupt them). A file that already has a tab focuses it and moves to the line. A file that turns read-only
while its tab holds unsaved edits (its permissions, a second hard link) keeps them: the tab stays dirty (closing it
asks), the bar says they cannot be saved there (Reload drops them), and autosave resumes once it is writable again;
one whose bytes changed into something not savable (binary, too large, not UTF-8) is the Reload-only conflict.

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
setting `servers` (`{ language, extensions, argv }[]`) adds or overrides. An extension listed by a `servers` row is
that row's language, whatever the built-in order; two rows listing one extension: the later row.

**Lifecycle.** One server per language per project, rooted at the project folder. Started on the first file of that
language, stopped a minute after its last tab closes. A crash restarts with backoff (3 in 5 minutes), then a bar with
Restart. A live server is restarted from the page only when a command the host stopped never got its answer: after a few
seconds the status says so (`held`) and the bar offers Restart, since the server runs no other command until it answers. The host sends `workspace/didChangeWatchedFiles` for project changes it sees (Claude edits files that are not
open; gopls and tsserver go stale otherwise).

**v1 features:** diagnostics, hover, completion with snippets, signature help, go-to-definition, find references,
rename, format, code actions, document symbols. A definition in another project file opens or focuses its tab; a
location outside the project (`node_modules`, module cache, vendor) opens read-only, and only for a location the server
returned. A page's text decides what a server returns (tsserver's `/// <reference path>`), so some outside paths never
open, whoever names them (`files.js` outsideRefused, by the named path and by its realpath): `/proc`, `/sys`, `/dev`,
`/run`; macOS's `~/Library/Keychains`, `Application Support` and `Cookies`; and, as a rule rather than a list of known
secrets, every hidden (dot) folder or file under the home (credentials, tokens, histories, app data all live there:
`~/.ssh`, `~/.claude/.credentials.json`, `~/.codex/auth.json`, a sibling project's `.env`), except what follows a
`node_modules` folder that is not itself behind another dot folder, and the toolchain and library folders the supported
servers return definitions in: Node (`.nvm/versions`, `.volta/tools`, `.fnm/node-versions`,
`.local/share/fnm/node-versions`, `.bun/install`, `.npm-global`, `.local/share/pnpm`, `.config/yarn/global`, tsserver's
type cache `.cache/typescript`, `.local/share/nvim/mason/packages`), any language (`.local/share/mise/installs`,
`.asdf/installs`), Go (`.go/pkg/mod`, `.goenv/versions`, `.gvm/gos`, `.gvm/pkgsets`; the default `~/go/pkg/mod` has no
dot), PHP (`.composer/vendor`, `.config/composer/vendor`: not `auth.json` beside it), Python (`.local/lib/python*`,
`.pyenv/versions`, `.local/share/uv`, `.virtualenvs`, `.local/share/virtualenvs`, `.conda/envs`,
`.cache/pypoetry/virtualenvs`, `.local/pipx/venvs`, `.local/share/pipx/venvs`) and Rust for a `servers` row
(`.cargo/registry`, `.cargo/git`, `.rustup/toolchains`). A definition anywhere else in a dot folder is not shown. Rename and code actions: the host declares no resource operations (no file create, rename, delete) and
applies a `WorkspaceEdit` to open files through their pages and to unopened files through the compare-and-swap write.
Everything is checked before the first file is touched; a cancel (the page gave up) is checked again before each file,
so one that lands while a page applies its part stops before the next file, and the page is told which files changed.
A code action's command runs on its server one at a time: a server's `workspace/applyEdit` names no command, so it is
taken only while exactly one command the host ran is working there, checked against that command's own snapshot (the
documents when its code action was offered, the text the server built it on; after the action's own edit, only the files
that edit changed advance, to the versions it produced, so typing in another file meanwhile still refuses the command's
edits there) and stopped with it (the page's cancel, the command's failure or deadline, until every edit it sent has
settled, an edit that came with its answer too); a command one of whose edits was refused (stale, cancelled part way)
is not applied, whatever the server answered, with what did change counted. A second command
on a busy server is refused; a command the host stopped waiting for holds the server until the server answers it or
exits, so its late edits are never taken as another command's. An action whose edit (or command edit) changed files
before its command failed or was cancelled answers with the files counted, and a page that gave up is told.
A view that is not the document's syncing owner (a second view of the tab, with its own unsaved buffer) is answered on
the owner's text: it reads (hover, completion labels, diagnostics), but takes no server range into its buffer (a
completion replaces the word only, with no auto-import) and refuses rename and code actions (their position would name
a place in its buffer that the server reads in the owner's). An outside tab stays read-only when its file is missing.
A page's typing before the host confirms it syncs the document (`lsp-doc`) is not lost: the page sends its whole text
again once it does, so the host never holds a text that differs from the buffer while it takes changes.
`didChange` follows the server's `textDocumentSync` (Incremental: the page's ranges; Full: the whole text; None or
omitted: none). Positions count `\r\n`, a lone `\r` and `\n` as line breaks, as LSP does, in the page as in the host
(one rule: edits.js `offsetAt`, used by the host's copy of each document, its edits and its references' line text),
though the page's editor splits lines on `\n` only (a `\r` stays in the text); a change that starts or ends between the
`\r` and `\n` of a CRLF has no LSP position, so the page sends its whole text instead, as it does for a change too large for
one port message (a paste over 128K characters, over 1000 changes) and after a post that failed; the buffer is marked
edited before any of it, so a failed sync never leaves a pasted buffer looking clean. A completion's auto-import is
taken only when nothing since the ask touched its range and no reload or merge came in between. A definition, reference or
symbol in the same file goes to its LSP position; one in another file opens at its LSP line and column, which is off
in a file that has a lone `\r` (that text is not in the page to convert against).

Language servers run project tooling, as in any IDE; the docs say so. The page never names a binary or a setting a
server would use to start one.

Not in v1: debugging (DAP), semantic tokens, call hierarchy, workspace symbol search.

## 4. Working with Claude

**Ask Claude** (to a tab) is core's Discuss for page tabs: select, Ctrl+L or the context menu; core draws the question
box; main asks the editor's `onDiscuss` for the context (`About: src/x.ts:40-52` and the fenced selection), adds the
question, and sends through the send gate as person-origin text, to a new session (the default) or a Claude tab
picked from a short menu (the one last used in the project listed first); delivered only in *waiting for input*, queued otherwise. A plugin's own `sessions.send`
would be refused on any typed tab, which is nearly every tab. Every review note of the file follows the selection,
`Review notes on this file:` then the notes in line order as the Reviewer's own Discuss writes a file review's
(`1. Lines 40-44:`, the quote as `> ` lines, the note), a note whose lines overlap the asked ones (the cursor's line
with none) marked `(on the asked lines)` where the Reviewer writes a note's side. The page names the notes by id with
the lines its gutter shows (the marks mapped through edits, so a dirty buffer matches the selection), and the host
adds the Reviewer's words from its own copy of the list. The whole context stays under 13,000 characters (what core's
20,000 leave after the head, a 4,000-character question and the closing prompt), the notes at most 8,000 of it (the
selection's cap): quotes shorten first, then the block is cut with the Reviewer's `(review cut: too long)`. No notes:
the text is unchanged. There is one action, Ask Claude; no separate "discuss the notes" command.

Sent notes go, or every ask would send the same notes again; the Reviewer deletes a review's notes once all of it
reached Claude, and these go the same way. Core does not tell a page tab where its Discuss went or whether it was
queued, so the host reads every Claude tab's prompt before answering and then watches for a tab whose new prompt holds
the sent text's start (the Reviewer's `watchQueued` match, over all tabs) for up to an hour, then calls the service's
`removeNotes(path, [{ id, text }])` (feature `'removeNotes'`): only notes whose id and text still match go, never the
file's comment, and not while its review is open. A cut notes block, a send that never arrives or an older Reviewer
keeps them.

**Quick chat** (Ctrl+K on a selection, or the context menu): a short-lived headless Claude through `ctx.processes` in the project folder,
with a fixed argv: `claude -p --restricted --safe-mode --strict-mcp-config --tools Read,Grep,Glob --permission-prompts
none --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <model>
[--effort <effort>] [--resume <session>]`.
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
through later edits, and a proposal whose original text no longer matches, or whose target was edited since the
question was sent (an empty target typed into included), is dropped. Accept puts it in the buffer;
Claude never writes. Model and effort: two pickers in the chat's header, preselected from the app settings
`quickChatModel` (default `sonnet`) and `quickChatEffort` (default `default`, which passes no `--effort` and lets Claude
Code decide; else `low`, `medium`, `high`, `xhigh`, `max`, the list of `src/shared/session-options.ts`, copied into
the plugin with a test comparing them). The page only sends the picked values with each question; the host checks
them against its own lists (anything else refuses the question, nothing spawned) and puts each as its own argv
element. A process's model is fixed at spawn, so a follow-up with another pick ends the chat's Claude and starts one
with the new flags and `--resume <session>` (the id from the stream's init line, used only when it is a UUID), after
the old one exited; the answer running when the pick changed keeps its own. `--effort` and `--resume` are not
required flags: only a pick that needs one checks the help for it and is refused, with what to do, when it is missing.
The last pick a question went with (saved once its Claude runs, not on a select change) is remembered host-side in
`ctx.appStorage` (`quickChatPick`: main-owned, so every window and a restart see it; never a host-written file or the
page's per-view localStorage), together with the two settings' values at the time. A new chat starts with it only
while the settings still equal those, so a setting changed afterwards wins; a stored value off the host's lists falls
back to the settings. The host sends the pickers' defaults when a tab connects, after a settings change or a
remembered pick (its own window's tabs), and when a chat opens (`chat-defaults-get`, which picks up another window's).
These runs leave transcripts in `~/.claude` and count in Usage (documented).

**Claude's changes in the gutter.** Lines changed against git `HEAD` get a bar (host: `git cat-file blob HEAD:<path>`);
hover shows the old lines; click opens the Reviewer's diff. Not a repo or untracked: no marks.

**`ccc edit path[:line[:col]]`** opens or focuses the file tab there. The guide tells Claude to use it to point at
code. It never takes focus from a terminal being typed in: the tab opens with the unseen dot.

**Review notes in place.** The Reviewer's notes for the file show in the gutter; "Add review note" on a selection (Ctrl+Shift+N or
the context menu) writes to the same store. The `reviewer` service gains `notes(path)`, `addNote`, `onNotesChange` (versioned).

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
