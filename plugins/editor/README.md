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
- The reviewer's Edit button uses it. Another plugin that provides `editor` v1 can replace it (Settings > Plugins).
