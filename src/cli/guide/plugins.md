# Writing a plugin

A plugin is a folder (or git repo) with a `plugin.json` and built JavaScript. The app never
compiles anything and never runs a build at install. It runs with full Node access as the user,
so a person chooses to install or link it.

## Manifest (`plugin.json`)

```json
{
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "api": 1,
  "main": "dist/host.js",
  "contributes": {
    "panels": [{ "id": "hello", "title": "Hello", "icon": "icons/hello.svg",
                 "entry": "panels/hello.html", "defaultZone": "left" }],
    "settings": { "project": { "type": "object", "properties": {} },
                  "app": { "type": "object", "properties": {} } },
    "commands": [{ "id": "say-hello", "title": "Hello: Say hello", "key": "Cmd+Shift+H" }],
    "themes": [{ "id": "dusk", "file": "themes/dusk.json" }],
    "cli": [{ "name": "hello", "summary": "Say hello", "usage": "hello [name]" }],
    "skills": [{ "id": "hello", "dir": "skills/hello" }],
    "openFile": { "title": "Hello viewer" }
  },
  "services": { "provides": { "greetings": 1 }, "uses": { "triage": 1 } }
}
```

- `id`: lower case, reverse-DNS-like, at least two dot-separated labels, the last one starting
  with a letter (`acme.hello`). It becomes a folder name and a URL host.
- `version`: semver (`1.2.3`). `api`: the plugin API major, currently `1`; others are refused.
- `main`: path to the host entry, optional (a theme-only plugin has none).
- All paths are plugin-relative, with `/` separators, no `..`, no absolute path. They must exist.
- `contributes` ids (panel, command, theme) match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- Known top-level keys: `id`, `name`, `version`, `api` (all four required), `main`, `contributes`,
  `services`. Every other key (`description`, `author`, `license`, `homepage`, ...) is tolerated
  and ignored: nothing in the app shows it (a marketplace entry has its own `description`). Known
  keys are strict. Unknown keys inside `contributes` and its entries are ignored as well; only
  `services` rejects them.
- Fields per contribution: panel `id`, `title`, `kind`, `icon`, `entry`, `defaultZone`; command
  `id`, `title`, `key`; theme `id`, `file`; skill `id`, `dir`; cli `name`, `summary`, `usage`,
  `stdin`; openFile `title`. There is no `description` field on a command or a cli entry: a command is one palette
  line (`title`), a cli entry is a `summary` (200 chars) and a `usage` (500 chars).
- `services` (optional, top level; used from the host code in `main`): `provides` and `uses` map a service name
  (`^[a-z][a-z0-9-]{0,63}$`) to its major version (integer 1..9999), at most 32 each. A plugin may
  not provide and use the same name. No other key inside `services` (unlike the top level, an
  unknown one is an error). Only declared names work with `ctx.services` (`api` topic).
- `openFile` (an object, not a list; needs `main`): the plugin can take over a click on a changed
  file in the Sessions panel, through `ctx.files.onOpen` (`api` topic). `title` (1-100 chars)
  names the choice in Settings > Plugins, where a project with several such plugins picks one (or
  the built-in viewer); with one, it gets the clicks unless the project picks the built-in viewer.
- `skills`: each entry has `id` and `dir` (a plugin-relative folder holding `SKILL.md`), at most
  10 per plugin. The front matter of `SKILL.md` is exactly two lines, `name: <id>` and
  `description: <one line, at most 1024 chars>`; any other key, a multi-line value, a `name`
  other than the id or CRLF line ends refuse the whole plugin. The description and the name (so
  the skill id) must be plain YAML strings: no leading quote, no `: ` or ` #` inside, and not
  something YAML reads as a boolean, null, number or date (`yes`, `null`, `1.5`, `2024-01-01`). At most 50 files, 1 MiB, 50 folders, 1000 directory entries and 8
  folders deep per plugin, all skill dirs together; no symlinks; no `SKILL.md` (any letter case) in a folder below the skill's own; dot-files and dot-folders are skipped (never copied). The copy is private to you: a file is written mode 0600, or 0700 when its owner may execute it (only that bit is kept: `chmod u+x` a helper script the skill runs). Skills load only into new Claude tabs.

## The host side

`main` is a CommonJS module run in the plugin host (a Node process, one per project window):

```js
exports.activate = (ctx) => {
  ctx.commands.register('say-hello', () => ctx.notify('Hello'))
}
exports.deactivate = () => {}
```

`activate(ctx)` has 10 s; its return value is ignored (share an API with `ctx.services`). `ctx` is scoped to one project window. See the `api` topic for every
member. Types: `ccc guide types` prints the SDK types (`PluginContext`; the file is `src/sdk/types.ts` in the cc-cockpit repo); a starting point to copy, with the
types and a build: https://github.com/BronOS/cc-cockpit-plugin-example.

## CLI commands

`contributes.cli` adds top-level `ccc` commands: `ccc hello world` runs the handler registered
with `ctx.cli.register('hello', handler)` in the caller's project window. A plugin with `cli`
needs `main`.

- `name`: `^[a-z][a-z0-9-]{1,31}$`, at most 10 per plugin. Core command names and `app`,
  `config`, `version` are reserved. A name another installed plugin already has is refused at
  install or link, naming the owner.
- `summary` (one line, shown by `ccc help`) and `usage` (shown by `ccc <name> --help`, starts with
  the name). Both are one line of plain text: a line break becomes a space. `ccc <name> --help`
  (as the first word) is answered by the app from these two and never reaches your handler, so
  for several subcommands (`jev usage|balance|ask`) put the synopsis in `usage`, e.g. `jev
  usage|balance|ask [args]; jev help for details`, and handle `help` and `<sub> --help` in the
  handler, which gets those words verbatim.
- `stdin`: `true` to receive the caller's stdin; without it, stdin is never read.

## Walkthrough: a plugin in five files

A complete plugin with a panel, a `ccc` command and a Claude skill, plain JavaScript, no build
step. Make a new folder, write these five files exactly as shown (the word after the language on
each opening fence is the file path; write the lines between the fences), then run `ccc plugin link <folder>` and tell the person to Allow it in the
app window (see the `dev-loop` topic). Then check it: `ccc greet world` prints `hello world`;
`ccc plugin list` shows acme.greeter ok and enabled; `ccc plugin logs acme.greeter` shows
`activated`; ask the person to open the Greeter panel in the left zone (it is not shown by
itself), where it shows `{"echo":{"ping":1}}`; the skill appears only in a new Claude tab. An automated test builds this very plugin from this
topic, so the blocks stay correct.

```json plugin.json
{
  "id": "acme.greeter",
  "name": "Greeter",
  "version": "1.0.0",
  "api": 1,
  "main": "dist/host.js",
  "contributes": {
    "panels": [{ "id": "main", "title": "Greeter", "entry": "panels/main.html", "defaultZone": "left" }],
    "cli": [{ "name": "greet", "summary": "Greet someone", "usage": "greet [name]" }],
    "skills": [{ "id": "greet", "dir": "skills/greet" }]
  }
}
```

```js dist/host.js
'use strict'
exports.activate = (ctx) => {
  ctx.log.info('activated')
  // The panel page posts a message; the host answers it.
  ctx.panels.onMessage('main', (message) => ctx.panels.post('main', { echo: message }))
  // `ccc greet world` runs this and prints stdout.
  ctx.cli.register('greet', (argv) => ({ stdout: `hello ${argv.join(' ') || 'there'}\n` }))
}
exports.deactivate = () => {}
```

```html panels/main.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Greeter</title>
    <script src="/__sdk/panel.js"></script>
    <script src="main.js"></script>
  </head>
  <body>
    <h1>Greeter</h1>
    <pre id="out">waiting</pre>
  </body>
</html>
```

```js panels/main.js
'use strict'
ccPanel.onMessage((message) => {
  document.getElementById('out').textContent = JSON.stringify(message)
})
ccPanel.post({ ping: 1 })
```

```markdown skills/greet/SKILL.md
---
name: greet
description: Use when the user asks to greet someone through the Greeter plugin of cc-cockpit.
---

Run `ccc greet <name>`; it prints a greeting.
```

New Claude tabs of a project that enables the plugin load the skill; a running session keeps
what it started with.

## Panels

A panel is an html page the app shows in a zone (left, right, bottom). It runs in a sandboxed
frame under a strict CSP: its own files only, no network, no inline script (put the script in a
separate `.js` file). The page talks only to its own plugin through the panel SDK, a classic
script served at `/__sdk/panel.js`. See the `panels` topic.

## Settings, secrets, sign-in

See the `settings-secrets` topic. In short: JSON Schema forms from the manifest, a `secret`
format for tokens, `ctx.secrets` for stored credentials and `ctx.oauth` for a PKCE sign-in.

## Build and ship

Plugins ship built JavaScript. Plain JS needs no build step. For TypeScript, bundle with esbuild
(CommonJS, node22) into `dist/host.js` and commit the dist; import only types from the SDK so
nothing of the app ends up in the bundle. See the `dev-loop` topic for linking and logs.

## Reference plugin

`plugins/hello` in the cc-cockpit repo uses every contribution point; copy it as a starting
point.

## Publishing in the Marketplace

Commit the built `main` file, tag the commit, then open a PR on the index repo adding `plugins/<id>.json`
(id, name, description, author, https `repo`, `version`, `tag`, the full 40-character `commit`, `api`, `owners` as
numeric GitHub user ids). CI checks the entry against your repo at the tag; "listed" means well formed and matching,
not reviewed. Users install the pinned commit and the app refuses a tag that has moved, so never move a published
tag: tag a new version and send a PR that changes `version`, `tag` and `commit`. A listed owner's version bump merges
by itself when checks pass. A plugin whose id and commit are in `revoked.json` is disabled in apps where that index is the default one or the one the
plugin was installed from; any other index only produces a warning.
See `marketplace/README.md` in the cc-cockpit repo.
