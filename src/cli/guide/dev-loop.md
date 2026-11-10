# Developing a plugin

The whole loop runs from a cc-cockpit tab with `ccc plugin ...`; no Settings screen needed
except for the one confirmation a person gives.

## 1. Scaffold

`ccc plugin new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]` writes a working plugin
into a new folder, or one that already holds files (a nested plugin inside another plugin's
folder, or a parent around a nested one): it refuses only when a file it would write already
exists, and names those files. Works with the app closed.

- default id is `local.<folder name>`; pass `--id acme.todo` for a real one
- `--panel` adds a panel page (`panels/main.html`, `panels/main.js`) wired to the host
- `--cli <name>` declares a command `ccc <name>` and registers its handler
- `--skill` adds a Claude skill (`skills/<id>/SKILL.md`) the plugin brings

The result is plain JavaScript with **no build step**: `plugin.json` plus `dist/host.js` (and the
optional files). It links and runs without `npm install`. For TypeScript, bundle with esbuild into
`dist/host.js` (`format: 'cjs'`, `platform: 'node'`, `target: 'node22'`) and rebuild after every
edit; `plugins/hello` shows the setup (`scripts/build-hello.mjs`).

## 2. Link

`ccc plugin link <dir>` links the folder and enables it in this project. The app first shows a
confirm dialog in this window (name, id and the real folder path): a linked plugin persists and
runs with full Node access, so **a person must click Allow, a session cannot do it alone**. Tell
the person to look at the app window. The command waits for the answer (no timeout) and prints
`linked ...` (warnings about root-absolute URLs in pages go to stderr); Deny exits 1 with `declined`. Limits: one open dialog per window and at most 3 link
requests a minute. A manifest problem, a command name another plugin owns or a plugin id that is
already installed is refused before any dialog, with the reason. Outside the app's tabs (a
terminal of your own) add `--project <path>` after `link`.

Linking (and unlinking) restarts the project's plugin host: every plugin enabled in the project
gets `deactivate()` and then a fresh `activate()`, not only the new one, so a provider that keeps
state in memory is re-activated when another plugin is linked (enabling or disabling a plugin in
a project does the same; `api` topic, "The host process").

A linked folder is watched: after you change a file the plugin host reloads that plugin by itself
(no restart of the others). A manifest problem then shows as the plugin's state in `ccc plugin list`. A plugin
command run right after an edit waits for the reloaded copy (within its 30 s limit, else exit
124) and runs there; one already running in the old copy when the reload starts ends with exit 1.
The plugin's open overlays close on a reload (their `result` resolves as dismissed in the old
copy): open the overlay again to see the new code, and have a page post its draft as it goes.

Nested plugins are fine: a folder inside a linked plugin that has its own `plugin.json` is another
plugin, and the parent's watcher ignores it (as it does `node_modules` and `.git`). Edit it and
only that plugin, if linked, reloads; edit the parent and only the parent reloads. A plugin
folder's own files, including a `test/` folder without a `plugin.json`, still reload the parent.

## 3. Configure

A plugin with `contributes.settings` can be configured from the tab, no Settings screen needed:

- `ccc plugin config <id>` prints its app, global and project settings (`app greeting = "hello"`); a
  secret field shows only `set` or `not set`.
- `ccc plugin config <id> limit=5 endpoint=https://example.com` sets top-level fields (a value
  is JSON if it parses, else text) through the same save and validation as the Settings form, so
  the running plugin gets `ctx.onSettingsChange`, and a plugin that was off because its settings
  were invalid starts. A project field is set as this project's override; `--scope global` sets
  the global value every project without an override gets, and `--use-global <key>` drops the
  override. A key declared in both scopes needs `--scope app` or `--scope project`.
- **Secret fields cannot be set this way**: ask the person to enter them in Settings > Plugins
  (app scope) or Settings > This Project. Write the plugin so it starts without them and says
  what is missing.

## 4. Inspect

- `ccc plugin list [--json]` lists every installed plugin: id, version, source (`git` or
  `linked`), enabled here, and `ok` or the reason it is unusable. `--json` gives an array of
  `{ id, name?, version, source, enabled, state }`.
- `ccc plugin logs <id> [--follow]` prints the last 200 lines of `<data>/logs/<id>.log` (what
  `ctx.log.info/warn/error` wrote, and an uncaught error in the host); `--follow` keeps printing
  new lines until Ctrl+C. A line is `<ISO time, UTC> <level> [<projectId>] <text>`: the `[...]`
  is the id of the project (window) whose host wrote it (16 hex digits, a hash of the folder's real path), there so one file can
  serve every project the plugin runs in. Plugins do not see it. It reads the file directly, so it works while the plugin is broken.
  The log rotates at 5 MiB.
- `ccc plugin unlink <id>` removes a linked plugin at once, with no dialog, and deletes that plugin's stored secrets
  (the folder stays untouched); unlink only what the person asked for. A plugin
  installed from git is managed in Settings > Plugins.
- A plugin that now ships with the app (its `cockpit.` id, e.g. `cockpit.reviewer` or `cockpit.editor`
  developed as a linked folder before it was built in) cannot stay linked: `ccc plugin unlink <id>` the old copy
  before installing the app version that ships it. If it is still linked, the app drops the linked record at
  its next start (logged) and runs the built-in copy; project enablement and settings carry over, same id.

## Checklist when a plugin does not show up

1. `ccc plugin list`: the state column holds the reason when the manifest is invalid (`api` must
   be 1; `main` and every `entry`, `icon`, `file` path must exist inside the folder).
2. Is it enabled in this project (`enabled` column)? `ccc plugin link` enables it.
3. `ccc plugin logs <id>`: the error from `activate` (10 s limit) is there.
4. A panel page does not load: its script is inline, or it reaches for the network (CSP).
5. A `ccc <name>` command is unknown: the plugin must be enabled here and declare it in
   `contributes.cli`; a name another plugin or a core command owns is refused.

## Tips

- Keep the host small: panels ask, the host answers (`ctx.panels`).
- Test pure logic outside the app; the host API is plain objects.
- Never put a secret in a settings default or in `ctx.storage`.
