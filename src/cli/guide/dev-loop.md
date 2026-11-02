# Developing a plugin

The whole loop runs from a cc-cockpit tab with `ccc plugin ...`; no Settings screen needed
except for the one confirmation a person gives.

## 1. Scaffold

`ccc plugin new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]` writes a working plugin
into a new or empty folder (it refuses anything else). Works with the app closed.

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
`linked ...`; Deny exits 1 with `declined`. Limits: one open dialog per window and at most 3 link
requests a minute. A manifest problem, a command name another plugin owns or a plugin id that is
already installed is refused before any dialog, with the reason. Outside the app's tabs (a
terminal of your own) add `--project <path>` after `link`.

A linked folder is watched: after you change a file the plugin host reloads that plugin by itself
(no restart). A manifest problem then shows as the plugin's state in `ccc plugin list`. A plugin
command run right after an edit waits for the reloaded copy (within its 30 s limit, else exit
124) and runs there; one already running in the old copy when the reload starts ends with exit 1.

## 3. Inspect

- `ccc plugin list [--json]` lists every installed plugin: id, version, source (`git` or
  `linked`), enabled here, and `ok` or the reason it is unusable. `--json` gives an array of
  `{ id, name?, version, source, enabled, state }`.
- `ccc plugin logs <id> [--follow]` prints the last 200 lines of `<data>/logs/<id>.log` (what
  `ctx.log.info/warn/error` wrote, and an uncaught error in the host); `--follow` keeps printing
  new lines until Ctrl+C. It reads the file directly, so it works while the plugin is broken.
  The log rotates at 5 MiB.
- `ccc plugin unlink <id>` removes a linked plugin at once, with no dialog, and deletes that plugin's stored secrets
  (the folder stays untouched); unlink only what the person asked for. A plugin
  installed from git is managed in Settings > Plugins.

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
