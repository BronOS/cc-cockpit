# Code editor

External review: sol / high

## Overview
- A main coding editor in cc-cockpit (design `docs/design-editor.md` revision 2, the source of truth): open files are
  tabs in the main tab bar, edited with CodeMirror 6, with language servers (TS/JS, Go, PHP, Python, others by setting)
  and Claude features built in (Ask Claude, quick chat proposing edits, Claude's changes in the gutter, `ccc edit`,
  review notes in place).
- Core additions any plugin can use: **page tabs** (declared in the manifest, frames that survive host restarts and
  web reconnects, dirty per view with core's close ask, keyboard routing, an unseen dot), **Discuss for page tabs**,
  and **`ctx.processes`** (long-running processes with byte stdio). `cockpit.editor` is rewritten on them; micro stays
  as "Open in micro".
- Works the same on the desktop, in a browser view and in a remote window; files and language servers stay on the
  machine with the code.
- One release, with a try-it checkpoint (Task 9) after page tabs and basic editing.

## Context (from discovery)
- Tabs: `src/shared/types.ts` (`TabKind`), `src/main/tabs/tab-manager.ts`, `src/main/restore.ts`, `src/shared/ipc.ts`
  (`REMOTE_CLASS`), renderer `src/renderer/tabs/` (`TabBar.tsx`, `TabsPane.tsx`, `tab-label.ts`, `CloseTabDialog.tsx`).
- Plugin pages: `src/renderer/plugins/PluginFrame.tsx`, slots (`src/shared/slots.ts`, `contributes.slots`),
  `src/main/plugins/panel-ports.ts` (host restart reloads pages today), `src/sdk/panel.ts` (`FrameLoads`, port
  handover), web shell remount (`<App key={drawn}>` in `src/renderer/web/main.tsx`), relay byte limit
  (`src/main/web/port-relay.ts`).
- Keys: the shell's window listener never sees a sandboxed frame's keys (`src/main/index.ts` comment); webview panels
  map chords with `before-input-event` → `commands.trigger`.
- Discuss: `src/main/overlays/discuss.ts`, send gate `src/main/sessions/send-gate.ts` (plugin text refused on a typed tab).
- Plugin API: `src/sdk/types.ts`, host `src/host/ctx/`, `src/host/loader.ts`, main `src/main/plugins/host-api.ts`,
  `src/main/plugins/validate.ts`, guide `src/cli/guide/*.md`, example types `examples/plugin/sdk/types.ts`.
- Editor today: `plugins/editor` (micro overlay, `editor` v1 `open(path, { line })` used by `plugins/files`, `ccc edit`,
  settings `autosaveSeconds`, `colorscheme`, `microPath`); Reviewer `plugins/reviewer` (CodeMirror 6, `@codemirror/merge`,
  `npm run build:reviewer`), `reviewer` service.

## Development Approach
- **testing approach**: Regular (code first, then tests); every task ends with its tests, all passing before the next.
- Bundled plugins use only the public plugin API: every gap goes into the API and the guide.
- A new `ctx` member, manifest field or `ccc` command needs its guide text and the example types copy in the same change.
- main is the authority: page-tab types, titles, params, dirty state and the close ask are main's; the editor host
  checks every path from its page by realpath; the page never names a binary, a server setting or an LSP method
  outside the allow-list; argv only, `--` before user text.
- New IPC channels get their `REMOTE_CLASS` in the same change. Dense "why" comments.

## Testing Strategy
- **unit (vitest)**: page tabs (manifest types, open, restore, drop, unseen dot, never typed into), frame lifetime
  (host restart, web reconnect, relay pause), dirty per view and the close ask, keyboard routing, Discuss for page tabs,
  `processes` (bytes, argv, cap, kill on host stop).
- **plugin tests (`node:test`)**: editor host compare-and-swap (race, symlink, non-UTF-8, EOL/BOM/mode), watcher on
  rename-replace, LSP client against a fake server, workspace edits, quick chat argv against a fake `claude`, argv
  hardening; page merge (clean, conflict, two views).
- **e2e (Playwright)**: open from Files via Edit, type, autosave; external write (reload, merge, conflict); `ccc edit`;
  diagnostics from a fake server; a page tab in a browser view surviving a reconnect with a dirty buffer.

## Progress Tracking
- mark completed items with `[x]` immediately; ➕ new tasks; ⚠️ blockers; keep the plan in sync with the work.

## Solution Overview
- Page tabs are drawn like slots (shell frame, own port), declared in the manifest, mounted lazily, and kept alive
  across host restarts and web remounts by re-delivering the port instead of reloading the page.
- The page owns its buffer and base and does the merge; the host only compares and swaps on the inode.
- The host is the single LSP client per server; pages ask it in editor terms.
- Ask Claude is core's Discuss (person-origin); quick chat is a locked-down headless `claude -p`.

## Technical Details
- Manifest `contributes.tabs: [{ type, page, keys? }]`; record `{ kind: 'page', plugin, type, params, title, icon? }`;
  params plain JSON, size-capped; title clamped.
- `ctx.tabs.openPage(type, params, { title, icon? })` → tab id; `ctx.tabs.onOpen(type, (tab) => { port, params, view,
  setTitle })`; `ctx.tabs.list(type)`; dirty reported by the page through the panel SDK per view.
- `ctx.processes.spawn(argv, { cwd })` → `{ pid, write(Uint8Array), onData(cb), onStderr(cb), onExit(cb), kill() }`.
- Editor page ↔ host: `open`/`content` (chunked), `save {text, baseHash}` → `saved {hash}` | `changed {theirs, hash}`,
  `disk {changed|deleted}`, editor-level LSP asks (`hover`, `complete`, `definition`...), `diagnostics`, `chat`, `notes`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: manual checks on the Mac and in a real remote window; language servers on real projects.

## Implementation Steps

### Task 1: Core page tabs: manifest, model, main, restore [model: opus]

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/shared/manifest.ts`, `src/main/plugins/validate.ts`
- Modify: `src/main/tabs/tab-manager.ts`, `src/main/restore.ts`, `src/main/sessions/session-registry.ts`
- Create: `test/unit/page-tabs.test.ts`

- [x] manifest `contributes.tabs: [{ type, page, keys? }]` validated like `contributes.slots` (relative page path)
- [x] `TabKind` `page` with plugin, type, params (plain JSON, size cap), title and icon clamped in main
- [x] TabManager: open, close, focus, reorder, flags; no pty, never in the send gate, never `typed`, no Claude status
- [x] persist; restore asks the owning plugin; drop when the plugin is gone, off or revoked; cap per plugin
- [x] core unseen dot on a tab opened while another tab had focus, cleared on first view (not a flag)
- [x] new channels with their `REMOTE_CLASS` (none needed: an unseen-dot change rides `tabs.added`, its clearing `tabs.selected`)
- [x] write tests: manifest validation, open, persist, restore, drop, cap, unseen dot, never typed into
- [x] run tests - must pass before next task

### Task 2: Renderer: drawing page tabs, lazy mount, frame lifetime [model: opus]

**Files:**
- Modify: `src/renderer/tabs/TabsPane.tsx`, `src/renderer/tabs/TabBar.tsx`, `src/renderer/tabs/tab-label.ts`
- Modify: `src/renderer/plugins/PluginFrame.tsx`, `src/sdk/panel.ts`, `src/main/plugins/panel-ports.ts`
- Modify: `src/renderer/web/main.tsx`, `src/main/web/port-relay.ts`
- Create: `test/unit/page-tab-frames.test.ts`

- [x] draw the page in the tab area in its own frame with its own port (slot pattern); mount on first select, LRU of
  live frames, never in server mode's hidden page
- [x] host restart: keep page-tab frames and re-deliver a new port (no reload); the page re-sends its state
- [x] web reconnect: page-tab frames live outside the remounted tree and get a new port the same way
- [x] relay: a page-tab port is paused and resynced at the byte limit, not closed
- [x] tab label with title, icon, dirty dot (any view dirty) and the unseen dot
- [x] write tests: lazy mount, LRU, host restart keeps the frame, remount keeps it, relay pause
- [x] run tests - must pass before next task

### Task 3: Dirty per view, core close ask, keyboard routing [model: opus]

**Files:**
- Modify: `src/main/tabs/tab-manager.ts`, `src/renderer/tabs/CloseTabDialog.tsx`, `src/main/windows/window-manager.ts`
- Modify: `src/main/index.ts` (frame `before-input-event`), `src/sdk/panel.ts` (chord forwarding), `src/renderer/commands/`
- Create: `test/unit/page-tab-close.test.ts`, `test/unit/page-tab-keys.test.ts`

- [x] dirty per (tab, view) kept by main from page reports; cleared when a view goes away
- [x] closing a tab dirty in any view asks with core's dialog (`ApprovalDialog` in server mode), also on window close
  and quit; the page cannot block a close
- [x] desktop: app chords from a page frame through `before-input-event` → `commands.trigger`; web: SDK forwards chords
- [x] precedence: the app table and `keyOverrides` win; a page's declared `keys` go to the page while it has focus;
  conflicts shown in the keybinding editor
- [x] write tests for dirty per view, close and quit asks, routing and precedence
- [x] run tests - must pass before next task

### Task 4: Plugin API `ctx.tabs` and Discuss for page tabs [model: opus]

**Files:**
- Modify: `src/sdk/types.ts`, `src/host/ctx/` (new `tabs.ts`), `src/main/plugins/host-api.ts`
- Modify: `src/main/overlays/discuss.ts`
- Modify: `src/cli/guide/*.md`, `examples/plugin/sdk/types.ts`
- Create: `test/unit/host-tabs.test.ts`, `test/unit/discuss-page-tabs.test.ts`

- [x] `ctx.tabs.openPage`, `onOpen`, `list`, the tab handle (`port`, `params`, `view`, `setTitle`); only the caller's
  declared types, its own window, rate limit
- [x] Discuss from a page tab: core draws the question box, main asks the plugin's `onDiscuss` for context, sends
  person-origin through the send gate to the last used or picked Claude tab; text starts with `About:`
- [x] guide text and example types copy
- [x] write tests: foreign type refused, rate limit, Discuss target re-check, typed tab accepts person-origin text
- [x] run tests - must pass before next task

### Task 5: Plugin API `ctx.processes` [model: opus]

**Files:**
- Modify: `src/sdk/types.ts`, `src/host/ctx/` (new `processes.ts`)
- Modify: `src/cli/guide/*.md`, `examples/plugin/sdk/types.ts`
- Create: `test/unit/host-processes.test.ts`

- [x] `spawn(argv, { cwd })` with `write(bytes)`, `onData(bytes)`, `onStderr`, `onExit`, `kill`; argv only, no shell;
  env fixes as in `ctx.exec`
- [x] cap per plugin in the host; every child killed with its process group when the host stops or the plugin reloads
- [x] guide text (not a boundary: host code can spawn anyway) and example types
- [x] write tests: argv with spaces stays one argument, bytes round trip, cap, kill on host stop, exit and stderr
- [x] run tests - must pass before next task

### Task 6: Editor host: files and compare-and-swap [model: opus]

**Files:**
- Create: `plugins/editor/dist/lib/files.js`
- Modify: `plugins/editor/dist/host.js`, `plugins/editor/plugin.json` (`contributes.tabs`, autosave settings)
- Create: `plugins/editor/test/files.test.js`

- [x] every path from the page checked by realpath against the project root; writes go to the realpath
- [x] read: binary, over ~5 MB or not valid UTF-8 → read-only; content in chunks under the message cap
- [x] save `{text, baseHash}`: hold the old descriptor, check hash, temp file in the same dir, re-check inode and hash
  before rename, rename, re-hash the held descriptor; any difference answers `changed {theirs, hash}`; keep EOL, final
  newline, BOM, mode
- [x] directory watch per open file's directory (survives rename-replace); `disk {changed|deleted}` to pages
- [x] write tests: CAS success, mismatch, write-between race, symlink target written, non-UTF-8 read-only, EOL/BOM/mode,
  rename-replace seen
- [x] run tests - must pass before next task

### Task 7: Editor page: CodeMirror 6 file tab and migration [model: opus]

**Files:**
- Create: `plugins/editor/src/page/*.ts`, `plugins/editor/pages/file.html`, `plugins/editor/pages/file.bundle.js`
- Modify: `package.json` (`build:editor`, run by `build`), `plugins/editor/dist/host.js`
- Create: `plugins/editor/test/page-*.test.js`

- [x] CodeMirror 6 with languages (TS/JS, Go, PHP, Python, JSON, YAML, Markdown, HTML, CSS, shell); search and replace,
  multi-cursor, folding, brackets, comment toggle, VS Code-like keys; theme tokens and terminal font
- [x] the page keeps its own base; autosave on focus loss and ~3 s idle (setting), Ctrl+S; dirty reported per view
- [x] open-file provider and the `editor` v1 service `open(path, { line })` open a file tab; an open file focuses its
  tab; outside the project or binary → built-in viewer; "Open in micro" button; `autosaveSeconds` read once as default
  (the editor does not declare `contributes.openFile`: beside the reviewer no project would have a default opener; the
  reviewer's Edit and Files' Edit open the tab; a binary goes to `ctx.files.open`, outside is refused; new
  `ctx.tabs.focus`)
- [x] page state re-sent on a new port (host restart, reconnect)
- [x] write tests: open routing, service compatibility, settings migration, state re-send
- [x] run tests - must pass before next task

### Task 8: Reload and three-way merge in the page [model: opus]

**Files:**
- Create: `plugins/editor/src/page/merge.ts`
- Create: `plugins/editor/test/merge.test.js`

- [x] clean buffer: reload with cursor, scroll and selection mapped; flash changed lines
- [x] dirty buffer: merge (page base, page text, theirs); clean → applied and saved with a notice; conflicts inline
  (Keep mine, Take Claude's, Keep both), no save until resolved, conflict marker on the tab
- [x] deleted on disk: Save (recreate) or Close
- [x] write tests: clean merge, overlapping conflict, identical change, delete, two views (A saves, B merges onto A)
- [x] run tests - must pass before next task

### Task 9: Checkpoint: Oleg tries the editor [model: sonnet]

- [x] build and start the dev app on a test data dir (check for Claude tabs in a running dev app first)
- [x] Oleg opens files from Files, edits, lets autosave run, has a Claude tab change an open file
- [x] record the feedback in this plan; if CodeMirror is rejected, stop and revisit the design before Task 10

Checkpoint result (2026-11-13): Oleg tried the editor in the dev app and approved it ("looks very good"); CodeMirror
stays. A plain click on a file keeps opening the Reviewer's view (the editor does NOT become the open-file provider);
the editor opens through Edit (the file overlay's Edit button, the editor service, `ccc edit`).

### Task 10: `ccc edit path:line:col` [model: sonnet]

**Files:**
- Modify: `plugins/editor/dist/host.js`, `src/cli/guide/*.md`, the editor skill
- Modify: `plugins/editor/test/host.test.js`

- [x] parse `path[:line[:col]]`, check the path, open or focus the tab at that position with the unseen dot; never take
  focus from a terminal being typed in
- [x] guide and skill tell Claude to use it to point at code
- [x] write tests for parsing, path refusal, reuse of an open tab
- [x] run tests - must pass before next task

### Task 11: Quick open and find in files [model: sonnet]

**Files:**
- Create: `plugins/editor/dist/lib/search.js`, `plugins/editor/src/page/quick-open.ts`
- Create: `plugins/editor/test/search.test.js`

- [x] Ctrl+P: `rg --files` (rg's ignore rules), capped, fuzzy filtered in the page
- [x] Ctrl+Shift+F: `rg --json -e <query> -- .`; results list, click opens at line; missing `rg`: install hint
- [x] write tests: a query starting with `-` or `--pre=` stays a pattern, result parsing, caps
- [x] ➕ configurable plain click (Oleg, 2026-11-13: "make it configurable"): the editor declares `contributes.openFile` too, marked with a new general manifest flag (e.g. `"whenPicked": true`) meaning "a candidate for the open-file pick only when the project picked it explicitly"; selection (`selectProvider`/the open-file selection in src/shared/services.ts, used by host and Plugins page alike) ignores such providers unless picked, so with no pick the Reviewer stays the default exactly as now and nothing becomes ambiguous; the existing per-project "Open files with" choice (OPEN_FILE_PICK, src/main/plugins/service-choices.ts, the project settings / Plugins page UI) lists the editor so the person can pick it; the editor's openFile handler opens a file tab (binary/outside → built-in viewer as today). The flag is general (any plugin may use it), never a bundled-plugin special case. Validated in the manifest, documented in the guide (drift tests) and design.md/design-editor.md §2 "Opening", example types copied.
- [x] ➕ tests: no pick → Reviewer; pick Editor → file tab; a whenPicked-only plugin alone with no pick → not chosen (built-in viewer), the pick UI lists it; manifest validation.
- [x] run tests - must pass before next task

### Task 12: LSP client in the host: servers and protocol [model: opus]

**Files:**
- Create: `plugins/editor/dist/lib/lsp/*.js`
- Modify: `plugins/editor/plugin.json` (app setting `servers`)
- Create: `plugins/editor/test/lsp-host.test.js`, `plugins/editor/test/fixtures/fake-lsp.mjs`

- [x] built-in table with fallbacks, `servers` setting; login-shell PATH lookup; missing server → install bar
- [x] one server per language per project, rooted at the project; start on first file, stop a minute after last tab;
  restart backoff (3 in 5 min) then Restart bar
- [x] the host owns `initialize`, `initializationOptions`, configuration and `processId`; one id space per server;
  documents refcounted per URI with one syncing owner; URIs validated; method allow-list; server-to-client requests
  answered by the host; results trimmed under the message cap
- [x] `workspace/didChangeWatchedFiles` from the directory watches and project changes
- [x] write tests against the fake server: initialize once, ids, refcounting, URI refusal, allow-list, configuration
  request, backoff, idle stop, missing server
- [x] run tests - must pass before next task

### Task 13: Language features in the page and workspace edits [model: opus]

**Files:**
- Create: `plugins/editor/src/page/lsp/*.ts`, `plugins/editor/dist/lib/lsp/edits.js`
- Create: `plugins/editor/test/lsp-features.test.js`

- [x] diagnostics (inline, gutter), hover, completion with snippets, signature help, document symbols, format
- [x] go-to-definition (project file → its tab; outside → read-only, only for server-returned locations), references
- [x] rename and code actions: no resource operations declared; host applies `WorkspaceEdit` to open files through
  their pages and to unopened files through compare-and-swap
- [x] slow or dead server never blocks typing (timeouts, cancellation)
- [x] write tests: recorded server messages, a workspace edit to an unopened file, an outside location refused
- [x] run tests - must pass before next task

### Task 14: Claude's changes in the gutter [model: sonnet]

**Files:**
- Create: `plugins/editor/src/page/changes.ts`, `plugins/editor/dist/lib/git.js`
- Create: `plugins/editor/test/git.test.js`

- [x] host reads `git cat-file blob HEAD:<path>` (argv); page marks lines changed vs `HEAD`; hover shows old lines;
  click opens the Reviewer diff
- [x] not a repo or untracked: no marks
- [x] write tests: tracked, untracked, no repo, a path starting with `-`
- [x] run tests - must pass before next task

### Task 15: Ask Claude in the editor [model: sonnet]

**Files:**
- Modify: `plugins/editor/dist/host.js`, `plugins/editor/src/page/ask.ts`
- Modify: `plugins/editor/test/host.test.js`

- [x] Ctrl+L and the context menu trigger core's Discuss for the tab (Task 4); `onDiscuss` returns
  `About: path:start-end` and the fenced selection
- [x] write tests for the context text and line ranges
- [x] run tests - must pass before next task

### Task 16: Quick chat with proposed edits [model: opus]

**Files:**
- Create: `plugins/editor/dist/lib/quick-chat.js`, `plugins/editor/src/page/chat.ts`
- Modify: `plugins/editor/plugin.json` (app setting quick chat model)
- Create: `plugins/editor/test/quick-chat.test.js`, `plugins/editor/test/fixtures/fake-claude.mjs`

- [x] fixed argv `claude -p --restricted --strict-mcp-config --tools Read,Grep,Glob --input-format stream-json
  --output-format stream-json --model <setting>` through `ctx.processes`; refuse to start when `claude --help` lacks the
  flags; check a real headless run once by hand (done with claude 2.1.323, `--model haiku`: the CLI needs `--verbose`
  for stream-json output with -p; init, stream_event text_delta, assistant tool_use, user tool_result and result lines
  as parsed; final argv adds --safe-mode, --permission-prompts none, --verbose, --include-partial-messages)
- [x] prompt with path, selection and ~30 lines as data; streaming Markdown; follow-ups on the same process; close kills
- [x] proposal as an inline diff; range mapped through later edits; dropped when the original text changed; Accept
  into the buffer, Reject drops; Claude never writes
- [x] docs note transcripts in `~/.claude` and Usage counting
- [x] write tests: exact argv, refusal without flags, stream parse, proposal extraction and drop, kill on close
- [x] run tests - must pass before next task

### Task 17: Review notes in the editor [model: sonnet]

**Files:**
- Modify: `plugins/reviewer/` (service `reviewer`: `notes(path)`, `addNote`, `onNotesChange`)
- Modify: `plugins/editor/src/page/notes.ts`, `plugins/editor/dist/host.js`
- Modify: `plugins/reviewer/test/*`, `plugins/editor/test/host.test.js`

- [x] reviewer service addition (versioned), same store as the overlay
- [x] gutter marks with note text on hover; "Add review note" on a selection
- [x] write tests for the service calls and the editor's use of them
- [x] run tests - must pass before next task

### Task 18: e2e: desktop and browser [model: sonnet]

**Files:**
- Create: `test/e2e/editor.spec.ts`, `test/e2e/editor-web.spec.ts`

- [ ] open from Files via Edit, type, autosave lands on disk; external write reloads, merges, conflicts
- [ ] `ccc edit path:line`; diagnostics from the fake language server
- [ ] a file tab in a browser view: edit, reconnect with a dirty buffer, save; the desktop sees the content
- [ ] closing a dirty tab asks; quit with a dirty tab asks
- [ ] run tests - must pass before next task

### Task 19: Verify acceptance criteria [model: sonnet]
- [ ] every point of `docs/design-editor.md` implemented or listed as not in v1
- [ ] edge cases: path escapes, missing servers, host restart with dirty buffers, page tab restore, two views
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:plugins`
- [ ] `npm run test:e2e`

### Task 20: [Final] Update documentation [model: sonnet]
- [ ] `docs/features.md` (editor, page tabs, processes, known limits), `docs/design.md` (tab kinds, `contributes.tabs`,
  `ctx.tabs`, `ctx.processes`, Discuss for page tabs), README if needed
- [ ] CLAUDE.md: State line, page tabs / frames / processes rules in Implementation patterns, `build:editor` in Commands
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- on the Mac: an editor tab in a remote window to this VM, typing latency, LSP over the link
- the four language servers on real projects (this repo, a Go, a PHP and a Python project)
- quick chat on a real file with the locked-down flags: answer, accept, reject

**External system updates:**
- example plugin repo: push the updated `sdk/types.ts` (`ctx.tabs`, `ctx.processes`, `contributes.tabs`; the example
  uses none of them)
