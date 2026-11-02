# Friction log

Where the guide was unclear or wrong, an API was missing, or I had to guess, found while building
`cockpit.reviewer` using only `ccc guide` and the `ccc` commands. Same rules as the jev plugin's log.

## Guide unclear or silent

- `api`: there is no `ctx.projectDir`. The project folder only appears as `ctx.exec`'s default `cwd` (in the types,
  `ExecOptions.cwd`), so the host runs `pwd -P` to learn it (`dist/lib/files.js`, `projectRoot`). An `openFile`
  path is "relative to the project folder", and reading that file needs the folder.
- `api` / types: `SessionInfo.files` (each tab's changed files) appears only in `ccc guide types`, with no comment.
  Observed: absolute paths of every file the session wrote, including files outside the project
  (`ccc sessions --json`). The guide should say so.
- `api` / files (design question): a session often edits files outside its project (here: sibling repos). Those
  appear in the Sessions panel but always open in the built-in viewer, so the reviewer cannot review them. Allowing
  them would need the app to hand such paths to the plugin and the plugin to read outside the project folder. Worth
  deciding on purpose rather than by accident.
- `plugins`: bundled plugins. Nothing says whether the `cockpit.*` id prefix is reserved for the app, or how a plugin
  becomes bundled (the browser plugin is). That matters for a plugin meant to ship with the app.
- `api` / overlay: there is no way to focus or find an overlay that is already open. A second click on the same
  file can only be ignored (`open` map in `dist/host.js`) or open a second overlay.
- `api` / storage: `ctx.storage` key limits are not stated (`ctx.appStorage` says "other limits as `ctx.storage`",
  but `ctx.storage` lists none). Draft keys embed the file path (`draft:<path>`), so a long path makes a long key.
- `panels` / overlay: whether an overlay page may use module scripts (`type="module"`, dynamic `import()`) under
  the sandbox's opaque origin is not stated. I assumed not and bundle one classic script (1 MB), which rules out
  loading languages on demand.
