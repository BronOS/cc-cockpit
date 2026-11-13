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
  filtered fuzzily as you type. Find in files (Ctrl+Shift+F): `rg --json`, plain text unless `.*` is on, any case
  unless `Aa` is on, whole words with `ab`; results by file, a click (or Enter) opens the file's tab at the line. Both
  are capped (50,000 files; 2,000 matches in 500 files) and need [ripgrep](https://github.com/BurntSushi/ripgrep) on
  the login-shell PATH (`brew install ripgrep`, `sudo pacman -S ripgrep`, `sudo apt install ripgrep`; a missing `rg`
  is reported with these).
- Language servers (one per language per project, the plugin host their only client; setting `servers` adds or
  replaces one): diagnostics (underlined, in the gutter), hover, completion with snippets, signature help (Ctrl+Shift+Space),
  go to definition (F12), references (Shift+F12), rename (F2), code actions (Ctrl+.), format (Shift+Alt+F) and the
  file's symbols (Ctrl+Shift+O); Cmd instead of Ctrl on macOS. A definition in another project file opens its tab; one
  outside the project (`node_modules`, the module cache) opens read-only, only for a location the server returned.
  Rename, format and code actions are applied by the host: an open file in its tab (undo works, autosave saves it),
  any other file by the same compare-and-swap save; an edit that would create, rename or delete a file, or change one
  outside the project, is refused whole. A missing server leaves highlighting with its install command on the tab.
- A plain click on a file (the Sessions panel's changed files, the Files tree) opens the Reviewer's view unless the
  project picks "Editor (a file tab)" in Settings > This Project, "Plugin used to open files" (the manifest's
  `contributes.openFile` with `whenPicked: true`); then it opens the file's tab, and a binary file the built-in viewer.
- `editor.open(path, { line?, col? })` opens the file's tab, or focuses the tab that already shows it and moves to the
  line. The path must resolve inside the project folder (symlinks followed); a binary file goes to the project's file
  opener (the reviewer, else the built-in viewer). A missing file opens as a new one, created by its first save.
- Saving: autosave after you stop typing (setting `autosaveIdleSeconds`, default 3 s, 0 off; an `autosaveSeconds` set
  for micro before is its default) and when you leave the tab (`autosaveOnBlur`); Ctrl+S saves at once. Saves are
  compare-and-swap: when the file changed on disk meanwhile (Claude wrote it), nothing is overwritten.
- Claude changing an open file: a clean tab reloads (the cursor stays where it was, the changed lines flash). A tab
  with unsaved text merges Claude's change into yours (three-way, by line): a clean merge is saved with a notice; lines
  both of you changed show Claude's version above yours with Keep mine, Take Claude's and Keep both, and nothing is
  saved until each is resolved (the tab's title shows ⚠ meanwhile). A file deleted on disk keeps its tab and text, with
  Save (recreate it) or Close. Binary, non-UTF-8 and files over 5 MB open read-only.
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
