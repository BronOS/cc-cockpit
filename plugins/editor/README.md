# Editor

`cockpit.editor` is cc-cockpit's code editor (design `docs/design-editor.md`): open files are tabs in the main tab bar,
edited with CodeMirror 6, in the desktop window and in a browser view alike. It provides the `editor` plugin service (v1).

```js
const editor = ctx.services.use('editor')   // manifest: "services": { "uses": { "editor": 1 } }
await editor.open('src/app.ts', { line: 42 })  // path relative to the project folder: its file tab
```

- A file tab (`contributes.tabs` type `file`): highlighting for TS/JS, Go, PHP, Python, JSON, YAML, Markdown, HTML, CSS
  and shell; search and replace (Ctrl+F, Ctrl+H), multi-cursor (Alt+click, Ctrl+D), folding, bracket matching, comment
  toggle (Ctrl+/), VS Code's line keys; the app's theme colours and the terminal font.
- `editor.open(path, { line?, col? })` opens the file's tab, or focuses the tab that already shows it and moves to the
  line. The path must resolve inside the project folder (symlinks followed); a binary file goes to the project's file
  opener (the reviewer, else the built-in viewer). A missing file opens as a new one, created by its first save.
- Saving: autosave after you stop typing (setting `autosaveIdleSeconds`, default 3 s, 0 off; an `autosaveSeconds` set
  for micro before is its default) and when you leave the tab (`autosaveOnBlur`); Ctrl+S saves at once. Saves are
  compare-and-swap: when the file changed on disk meanwhile (Claude wrote it), nothing is overwritten and the tab asks.
  A clean tab reloads a file changed on disk by itself. Binary, non-UTF-8 and files over 5 MB open read-only.
- "Open in micro" on a file tab: [micro](https://micro-editor.github.io) on the same file in a terminal overlay (settings
  `microPath`, `colorscheme`). `ccc edit <file> [line]` opens micro too, for now. Needs micro on the login-shell PATH
  (`brew install micro`, `sudo pacman -S micro`, `sudo apt install micro`; a missing micro is reported with these
  commands and the `microPath` setting). On Wayland, copy and paste in micro need `wl-clipboard`.
- "Edit" on every overlay of the well-known type `file` (`ctx.overlay.buttons('file', …)`): a review of a file, or any
  plugin's overlay that says it shows one. Shown only when `path` resolves inside the project folder (no absolute path,
  no `..`, and still inside after following symlinks) to a regular text file (no NUL byte in its first 8,000 bytes);
  `run` opens the file's tab and closes the overlay. A failure is a notification.
- Another plugin that provides `editor` v1 can replace `editor.open` (Settings > This Project); the `file` button is
  this plugin's own.
- The page is built from `src/page` into `dist/pages/file.bundle.js` by `npm run build:editor` (committed).
