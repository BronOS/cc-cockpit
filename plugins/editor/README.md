# Editor (micro)

`cockpit.editor` provides the `editor` plugin service (v1) for cc-cockpit by running
[micro](https://micro-editor.github.io) in a large terminal overlay.

```js
const editor = ctx.services.use('editor')   // manifest: "services": { "uses": { "editor": 1 } }
await editor.open('src/app.ts', { line: 42 })  // path relative to the project folder
```

- `ccc edit <file> [line]` opens a file from a tab.
- Settings (app): autosave interval (default 5 s, 0 off), micro colour scheme, path to micro.
- Needs micro on the login-shell PATH (`brew install micro`, `sudo pacman -S micro`, `sudo apt install micro`; a missing micro is reported with these commands and the `microPath` setting). On Wayland, copy and paste need
  `wl-clipboard`.
- "Edit" on every overlay of the well-known type `file` (`ctx.overlay.buttons('file', …)`): a review of a file, or any
  plugin's overlay that says it shows one. Shown only when `path` resolves inside the project folder (no absolute path,
  no `..`, and still inside after following symlinks) to a regular text file (no NUL byte in its first 8,000 bytes);
  `run` opens micro on top, and the overlay under it stays. A failure (micro missing) is a notification.
- Another plugin that provides `editor` v1 can replace `editor.open` (Settings > Plugins); the `file` button is this
  plugin's own.
