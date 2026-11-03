# Friction log

Where the guide was unclear or wrong, an API was missing, or I had to guess, found while building
`cockpit.reviewer` using only `ccc guide` and the `ccc` commands. Same rules as the jev plugin's log.

## Guide unclear or silent

- `api`: there is no `ctx.projectDir`. The project folder only appears as `ctx.exec`'s default `cwd` (in the types,
  `ExecOptions.cwd`), so the host runs `pwd -P` to learn it (`dist/lib/files.js`, `projectRoot`). An `openFile`
  path is "relative to the project folder", and reading that file needs the folder.
  **Outcome: fixed.** `ctx.projectDir` (real path); the host no longer runs `pwd -P`.
- `api` / types: `SessionInfo.files` (each tab's changed files) appears only in `ccc guide types`, with no comment.
  Observed: absolute paths of every file the session wrote, including files outside the project
  (`ccc sessions --json`). The guide should say so.
  **Outcome: documented** in the guide (`SessionInfo.files`: absolute paths, outside-project files included).
- `api` / files (design question): a session often edits files outside its project (here: sibling repos). Those
  appear in the Sessions panel but always open in the built-in viewer, so the reviewer cannot review them. Allowing
  them would need the app to hand such paths to the plugin and the plugin to read outside the project folder. Worth
  deciding on purpose rather than by accident.
  **Outcome: decided.** Files outside the project stay in the built-in viewer; plugins only get project-relative paths. The guide says so.
- `plugins`: bundled plugins. Nothing says whether the `cockpit.*` id prefix is reserved for the app, or how a plugin
  becomes bundled (the browser plugin is). That matters for a plugin meant to ship with the app.
  **Outcome: settled.** `cockpit.*` ids are reserved for plugins loaded from the app's bundled root; bundling is an app release.
- `api` / overlay: there is no way to focus or find an overlay that is already open. A second click on the same
  file can only be ignored (`open` map in `dist/host.js`) or open a second overlay.
  **Outcome: fixed.** `handle.focus()` on the overlay handle; a second click on the same file calls it.
- `api` / storage: `ctx.storage` key limits are not stated (`ctx.appStorage` says "other limits as `ctx.storage`",
  but `ctx.storage` lists none). Draft keys embed the file path (`draft:<path>`), so a long path makes a long key.
  **Outcome: documented.** The guide states the key and value limits; draft keys over the key limit are hashed (`draftKey`).
- `panels` / overlay: whether an overlay page may use module scripts (`type="module"`, dynamic `import()`) under
  the sandbox's opaque origin is not stated. I assumed not and bundle one classic script (1 MB), which rules out
  loading languages on demand.
  **Outcome: answered.** Module scripts and `import()` of sibling files work in html overlays (panels topic); this plugin still ships one classic bundle.
- `api` / services: there is no way to ask whether a service has a provider without calling it (something like
  `ctx.services.available('editor')`). The design hides Edit when no editor plugin is enabled; instead the button is
  always shown, and a click that fails with the "no enabled plugin ... provides" text shows a hint (`dist/host.js`).
  Matching that error text is brittle.
  **Outcome: fixed.** `ctx.services.available('editor')`; Edit is hidden when false, and the error-text match is gone.
- `dev-loop` (question, not checked): what happens to an open overlay when its plugin reloads (edit of a linked file)
  is not documented. Does it close, stay with its handle dead, or stay connected to the new copy?
  **Outcome: decided.** Main closes a plugin's open overlays when it reloads, stops or is disabled; the guide says so.
- `api` / overlay (annotate's HTML mode, 2026-11-02): a plugin page has no way to open a link outside the app (no
  `openExternal` for plugins; the frame may not navigate), so links in annotated HTML only show their URL when
  clicked. **Outcome: partly fixed.** `ctx.openExternal(url)` (core, the system browser through main); the
  annotation's `url` is an "Open in browser" icon (in the document's first `h1`) that the host opens with it. Links inside the
  annotated HTML still only show their URL: opening them would take a URL from the page's content, not the caller.
- `api` / overlay (same): an html overlay page cannot claim Esc (main pops the overlay before the page sees the key),
  so an in-page modal (the image lightbox) cannot close on Esc first; Esc closes the whole review. **Outcome: open.**
