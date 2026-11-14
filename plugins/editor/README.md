# Editor

`cockpit.editor` is cc-cockpit's code editor (design `docs/design-editor.md`): open files are tabs in the main tab bar,
edited with CodeMirror 6, in the desktop window and in a browser view alike. It provides the `editor` plugin service (v1).

```js
const editor = ctx.services.use('editor')   // manifest: "services": { "uses": { "editor": 1 } }
await editor.open('src/app.ts', { line: 42 })  // path relative to the project folder: its file tab
```

- A file tab (`contributes.tabs` type `file`): highlighting for TS/JS, Go, PHP, Python, JSON, YAML, Markdown, HTML, CSS
  and shell; search and replace (Ctrl+F, Ctrl+H; Cmd+Alt+F for replace on macOS), multi-cursor (Alt+click, Ctrl+D), folding, bracket matching, comment
  toggle (Ctrl+/), VS Code's line keys; the app's theme colours and the terminal font.
- Quick open (Ctrl+P): the project's files from `rg --files` (ripgrep's ignore rules: `.gitignore` and the like),
  filtered fuzzily as you type. Find in files (Ctrl+Shift+H, or the context menu; Ctrl+Shift+F too once Toggle Tab Flag,
  which holds it by default, is rebound in Settings > Keybindings): `rg --json`, plain text unless `.*` is on, any case
  unless `Aa` is on, whole words with `ab`; results by file, a click (or Enter) opens the file's tab at the line. Both
  are capped (50,000 files; 2,000 matches in 500 files) and need [ripgrep](https://github.com/BurntSushi/ripgrep) on
  the login-shell PATH (`brew install ripgrep`, `sudo pacman -S ripgrep`, `sudo apt install ripgrep`; a missing `rg`
  is reported with these).
- Language servers (one per language per project, the plugin host their only client; setting `servers` adds or
  replaces one): diagnostics (underlined, in the gutter), hover, completion with snippets, signature help (Ctrl+Shift+Space),
  go to definition (F12), references (Shift+F12), rename (F2), code actions (Ctrl+.), format (Shift+Alt+F) and the
  file's symbols (Ctrl+Shift+O); Cmd instead of Ctrl on macOS. A definition in another project file opens its tab; one
  outside the project (`node_modules`, the module cache) opens read-only, only for a location the server returned,
  and never under `/proc`, `/sys`, `/dev`, `/run` or a hidden (dot) folder or file of the home (`.ssh`, `.config`,
  `.claude`, a project's `.env`...) other than `node_modules` and the toolchain folders the servers use (`.nvm`,
  `.pyenv`, `.local/lib/python*`, `.cache/typescript`, `.composer/vendor`... listed in docs/design-editor.md). A file of over 2 million characters gets no server; at most 256
  files are open in the servers per project, 16 per tab.
  Rename, format and code actions are applied by the host: an open file in its tab (undo works, autosave saves it),
  any other file by the same compare-and-swap save; an edit that would create, rename or delete a file, or change one
  outside the project, is refused whole. A missing server leaves highlighting with its install command on the tab.
- Claude's changes in the gutter: a bar beside each line that differs from git `HEAD` (green added, blue changed, a red
  notch where lines were removed); hover shows the old lines, a click opens the Reviewer's diff (the `reviewer` service,
  so the plugin uses it). The host reads `git cat-file blob HEAD:./<file>` (no shell, one argument); not a repository,
  untracked, binary, a link or git missing: no marks.
- Review notes in place: the Reviewer's line notes of the file show as a dot in a second gutter, the note's text on
  hover; "Add review note…" (Ctrl+Shift+N, Cmd+Shift+N on macOS, or the right-click menu) writes a note on the selected lines (the cursor's line with none) to
  the Reviewer's own store, so it is in the Reviewer's overlay and in what Discuss sends. Through the `reviewer` service
  (`notes`, `addNote`, the event `notesChange`; the Reviewer must be 0.3.0 or newer): with no Reviewer, or an older one,
  there are no dots and no menu item. The Reviewer numbers the lines of the file on disk, so an unsaved buffer is saved
  before the note is added, and a dot follows its line while you type but is placed again from the Reviewer's list when
  that changes. A note cannot be added while the file's review overlay is open (add it there).
- Review notes to Claude: Ask Claude adds all of the file's notes after the selection (`Review notes on this file:`,
  then each in line order as the Reviewer writes a file review's, `1. Lines 40-44:` with its quote and the note, a note
  on the asked lines marked `(on the asked lines)`), on the lines the dots are on (they follow your edits); quotes are
  shortened first, then the block is cut at 8,000 characters with `(review cut: too long)`. Like a review the
  Reviewer's Discuss delivered, the sent notes are then removed (the service's `removeNotes`), so the next ask does not
  send them again: the host watches the project's Claude tabs for a prompt holding the sent text (core does not tell a
  page tab where its Discuss went), for up to an hour; cut notes, a send that never arrives, an older Reviewer or a
  note edited since keeps them.
- Ask Claude (Ctrl+L, Cmd+L on macOS, or the editor's right-click menu): core's Discuss for the tab. Core draws the
  question box; the host answers with `path:start-end` (1-based) and the selected text in a code fence one backtick
  longer than any run in it (cut to 8,000 characters, with a note), or just `path:line` with no selection. Only the main selection is sent (with several cursors the others are ignored). The text goes to
  the Claude tab you pick (or a new session, under Discuss's own budget) as your own text, delivered when it waits for
  input. Needs an app with page tabs' Discuss.
- Quick chat (Ctrl+K, Cmd+K on macOS, or the right-click menu): a chat docked under the editor about the selection (the cursor's line with none,
  at most 20,000 characters). The host runs Claude Code headless and read-only in the project folder, with a fixed argv
  (`claude -p --restricted --safe-mode --strict-mcp-config --tools Read,Grep,Glob --permission-prompts none` plus
  stream-json in and out and the model of the setting `quickChatModel`, default `sonnet`): no Bash, no edits, no MCP
  server, no settings files, plugins, hooks or CLAUDE.md; the chat is refused when the installed `claude --help` lacks
  any of these flags (update Claude Code). The prompt carries the file's path, the selection and about 15 lines on each
  side as data; answers stream as Markdown (shown as text, links not followed); follow-ups go to the same Claude, and
  closing the chat (×, Esc) ends it (so do 15 idle minutes, a turn over 5 minutes, and a reconnect of the tab's page).
  A proposed change is a replacement for the selection, shown as an inline diff (the lines it removes tinted, its text
  below) with Accept and Reject; it follows later edits and is dropped when the selected text changes (you typed, or
  Claude's write was reloaded or merged). Accept puts it in the buffer as your edit (undo works, autosave saves it);
  Claude never writes. At most 3 chats run at once in a window. Each chat is an ordinary Claude Code session: it leaves
  a transcript in `~/.claude/projects` and counts in Usage like any other.
- A plain click on a file (the Sessions panel's changed files, the Files tree) opens the Reviewer's view unless the
  project picks "Editor (a file tab)" in Settings > This Project, "Plugin used to open files" (the manifest's
  `contributes.openFile` with `whenPicked: true`); then it opens the file's tab, and a binary file the built-in viewer.
- `editor.open(path, { line?, col? })` opens the file's tab, or focuses the tab that already shows it and moves to the
  line. The path must resolve inside the project folder (symlinks followed); a binary file goes to the project's file
  opener (the reviewer, else the built-in viewer). A missing file opens as a new one, created by its first save.
- Saving: autosave after you stop typing (setting `autosaveIdleSeconds`, default 3 s, 0 off; an `autosaveSeconds` set
  for micro before is its default, except 5, the old schema default, which main stored with every save and so reads
  as unset) and when you leave the tab (`autosaveOnBlur`); Ctrl+S saves at once. Saves are
  compare-and-swap: when the file changed on disk meanwhile (Claude wrote it), nothing is overwritten.
- Claude changing an open file: a clean tab reloads (the cursor stays where it was, the changed lines flash). A tab
  with unsaved text merges Claude's change into yours (three-way, by line): a clean merge is saved with a notice; lines
  both of you changed show Claude's version above yours with Keep mine, Take Claude's and Keep both, and nothing is
  saved until each is resolved (the tab's title shows ⚠ meanwhile). A file deleted on disk keeps its tab and text, with
  Save (recreate it) or Close. Binary, non-UTF-8 and files over 5 MB open read-only; a file over 16 MiB is not shown at
  all (the tab says why). A file that turns read-only while the tab has unsaved text keeps the text and stays unsaved
  (closing asks; Reload drops it), and is saved once it is writable again.
- "Open in micro" on a file tab: [micro](https://micro-editor.github.io) on the same file in a terminal overlay (settings
  `microPath`, `colorscheme`). `ccc edit <file>[:line[:col]]` opens the file's tab at that position, marked and not selected (an open tab gets the mark again; a missing or binary file is refused; micro on an app without page tabs). Needs micro on the login-shell PATH
  (`brew install micro`, `sudo pacman -S micro`, `sudo apt install micro`; a missing micro is reported with these
  commands and the `microPath` setting). On Wayland, copy and paste in micro need `wl-clipboard`.
- "Edit" on every overlay of the well-known type `file` (`ctx.overlay.buttons('file', …)`): a review of a file, or any
  plugin's overlay that says it shows one. Shown only when `path` resolves inside the project folder (no absolute path,
  no `..`, and still inside after following symlinks) to a regular text file (no NUL byte in its first 8,000 bytes);
  `run` opens the file's tab and closes the overlay. A failure is a notification.
- Another plugin that provides `editor` v1 can replace `editor.open` (Settings > This Project); the `file` button is
  this plugin's own.
- The page is built from `src/page` into `dist/pages/file.bundle.js` by `npm run build:editor` (committed).
