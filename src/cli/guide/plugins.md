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
  with a letter (`acme.hello`). It becomes a folder name and a URL host. Ids starting with
  `cockpit.` (any letter case) are reserved for the plugins that ship with the app (`cockpit.browser`,
  `cockpit.reviewer`, `cockpit.editor`, `cockpit.files`): `ccc plugin new`, link, install, the Marketplace and its index
  refuse one, and the app loads one only from its own bundled folder. A plugin becomes built in only
  through an app release, never by asking; under your own id a plugin can do everything a built-in
  one does (they use the same public API).
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
  not provide and use the same name. `collects` (app 0.9.7+) lists used names read from every
  provider with `ctx.services.useAll`; each must also be in `uses`. No other key inside `services`
  (unlike the top level, an unknown one is an error, so an app before 0.9.7 refuses `collects`).
  Only declared names work with `ctx.services` (`api` topic).
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
format for tokens, a `multiline` format for a text area, a `sound` format for a notification sound
picker, `ctx.secrets` for stored credentials and
`ctx.oauth` for a PKCE sign-in.

## Built-in plugins

The app ships `cockpit.browser`, `cockpit.reviewer`, `cockpit.editor` and `cockpit.files`. They are on in every project
until switched off: per project under This project, or for the whole app with "Off in all projects" on
their row in Settings > Plugins. Off in all projects wins over every project's switch (which cannot turn
it on meanwhile) and gives each project its own choice back when undone; only built-in plugins have it.
A built-in plugin has no priority over yours. To replace one, provide the same thing under your own id:
another `editor` or `reviewer` provider appears in "Plugin used for <service>", another `openFile`
plugin in "Plugin used to open files"; with both on, the project picks (until then a service call
fails as ambiguous and a file click opens the built-in viewer). Turn the built-in one off (in the
project or everywhere) and yours is the only provider, used without a pick.

### The reviewer service

The built-in `reviewer` service (v1): `"uses": { "reviewer": 1 }`, then `ctx.services.use('reviewer')`. Both methods
resolve `{ opened: true }` once the overlay is up and reject with `reviewer: <why>` otherwise; the tab picker starts on
`tabId` when it is a live Claude tab of the window, else on the shown tab (`SessionInfo.active`).

- `open(path, { tabId? })`: a project file's diff against the last commit, with notes and a comment.
- `annotate({ title, text, url?, key?, tabId? })`: a text of yours (a ticket, a mail) in the same overlay, one
  read-only pane; the person adds notes on selections and a comment and sends them to Claude. `title` 1-200
  characters, `text` at most 400 KiB, `url` http(s) only (an "Open in browser" icon at the end of the HTML's first `h1`, else
  at the document's top right, which opens it with the reviewer's `ctx.openExternal`, so one with `user:pass@` is
  refused there; the overlay's title bar shows `title`, the page repeats it nowhere), `key` (one overlay
  and one kept draft per key; default from the title) 1-200 of letters, digits and `._:@#+=~/-`.
- `annotate({ title, html, assets?, url?, key?, tabId? })`: the same with HTML (at most 2 MiB) in place of `text`
  (exactly one of the two). The page sanitizes it against an allow-list: headings, paragraphs, lists, `pre`/`code`,
  blockquote, tables, links (http(s)/mailto; see below), `strong`/`em`/`s`/`u`/`sub`/`sup`, `span`/`div`,
  `details`/`summary`, `figure`/`figcaption`, `dl`/`dt`/`dd`; attributes `class` (an allow-list: `jira-panel`,
  `jira-panel-info`, `-note`, `-warning`, `-error`, `-success`, `mention`, `card`, `card-header`, `meta`, `new`,
  `old`, `status`, `lozenge` and `lozenge-info`/`-success`/`-warning`/`-error`, `attachment-list`, `fields`,
  `muted`; on a `dl` only `facts`, a grid of label/value pairs for key fields; on a `span` only `person`, a name
  chip, and the tones `lozenge-neutral`/`-danger`; one lozenge tone per element, the first named),
  `colspan`/`rowspan`, `alt`, `title`; everything else (script, style, on* and style attributes, iframes, forms) is
  dropped. Images only as `<img src="asset:<id>">` naming one of `assets: [{ id, name?, mime, dataUrl }]` (png, jpeg,
  gif or webp as a base64 data: URL; each at most 1,000,000 characters, 8 MiB and 30 in all); any other src is
  dropped and its alt text shown.
- `aside` (optional, with `text` or `html`): HTML of at most 100,000 characters for a details column at the right
  (about 240 px, scrolling on its own, under the document when the overlay is narrower than 700 px), shown only when
  given and sanitized with the same allow-list (images name the same `assets`). A `dl.facts` there is a vertical list,
  each label above its value: put the key fields (status, assignee, priority) there and the description in the body.
  Notes go on the body only.
- Links in `html` and `aside` open in the system browser on a click (or Enter, or a middle click; a drag-select
  that ends on one does not): http and https only, and only a link present in the `html` or `aside` you sent (the
  host matches the page's href against your strings, entities decoded), through the reviewer's `ctx.openExternal`
  (3 per 10 s; a refusal shows in the overlay's status line). A `mailto:` link is named there, not opened. Each link
  shows its URL as a tooltip unless it has a `title`.
- `start: 'top' | 'end'` (optional, HTML form, app 0.9.4+): where the document opens. `'end'` suits a conversation whose
  newest messages are last (a chat or mail thread): the page opens at the bottom and stays there while pictures load,
  until the person scrolls. An older reviewer ignores it.
- `companion: { title, html, assets?, url?, facts? }` (optional, with `html` only; app 0.9.3+): a second document shown
  beside yours (the Jira issue a mail is about). Checked like the main one: `title` 1-200 characters, `html` at most
  2 MiB sanitized with the same allow-list, `facts` HTML of at most 100,000 characters, `url` http(s). Its `assets`
  share the main document's budget and id namespace (30 and 8 MiB for both together, ids unique across both; an
  `asset:<id>` in either names the same image). The page then shows two columns, yours left and the companion right,
  each scrolling on its own, with a divider the person drags (remembered for the next companion). Above them, one
  header row that stays put while they scroll, its two cells the same height (the taller one's, at most 40% of the
  overlay): each a bar with the column's label and an `Open in <urlLabel> ↗` button (`Open in browser ↗` without a
  `urlLabel`; only with a `url`), then its details block (`aside` in yours, `facts` in the companion's, `dl.facts`
  as a grid). The details column at the right and the icon after the `h1` are not shown then. Under 700 px the
  columns stack, each header above its own document. The companion's links open like yours; notes go on either.
- `label`, `urlLabel`, `companion.label`, `companion.urlLabel` (optional plain text, one line; label 1-60, urlLabel
  1-30 characters): the header bars beside a companion, e.g. `label: 'Mail', urlLabel: 'Gmail'` and
  `companion: { label: 'Jira · PROJ-123', urlLabel: 'Jira', ... }`. A label defaults to the title, cut. Without a
  companion they are checked but not shown.
- `prepare({ key, title })` (feature `'prepare'`): opens the overlay of an annotate still to come at once, with a
  loader, so a click on a mail or an issue shows something while you fetch it. The `annotate` with the same `key`
  then fills that overlay (its title stays the one `prepare` gave) instead of starting another. Call
  `cancel({ key })` when no annotate follows (the fetch failed, you show your own page): it closes a loader never
  filled and resolves `{ closed: false }` otherwise, so call it in a `finally`. A loader the person closes makes the
  next annotate of that key resolve `{ opened: false }` with nothing shown; one left unfilled closes after 60 s. An
  older reviewer rejects `prepare` with "has no method": just annotate when ready. The pattern:
  `const p = await reviewer.prepare({ key, title }).then(() => true, () => false)`, fetch, annotate, and
  `finally { if (p) await reviewer.cancel({ key }).catch(() => {}) }`.
- `features()` (app 0.9.3+): resolves the optional annotate features this reviewer has, `['companion', 'prepare']`. An older
  reviewer ignores an option it does not know (a companion would just not be shown) and has no `features`: the call
  rejects with `service "reviewer" (plugin cockpit.reviewer) has no method "features"`, which means none. Ask before
  relying on one: `const f = await reviewer.features().catch(() => [])`, then `f.includes('companion')`, else fall
  back (e.g. append the second document to `html`).

Claude gets `About <title> (<url>)`, then the comment and the numbered notes: `Lines 2-4:` with the quote for a text,
`On «quote»: note` for HTML. With a companion the head adds `, with <title> (<url>) beside it` and a note on it reads
`In <title>, on «quote»: note`. With no comment and no note Discuss still sends: the head, a request to discuss it,
then the text itself (your `aside` and `html` as plain text, the companion after; cut to 20,000 characters in all),
since Claude cannot read your mail or ticket otherwise; a file review asks Claude to read the file and its diff. New
session selects the tab it opens. The reviewer README has the details and a Jira example.

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
