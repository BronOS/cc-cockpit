# The plugin host API (version 1)

`activate(ctx)` receives `ctx`, scoped to ONE project window. Nothing in it takes a project id;
ids it does take (a tab, a panel) are looked up inside that project only.

## The host process

All plugins enabled in a project window share one Node process (a utility process of the app),
with full Node access.

- Node: the one built into the app's Electron (Node 24 in this build; `process.versions.node`
  says). The standard globals are there: `fetch`, `Headers`, `Request`, `URL`, `AbortController`,
  `structuredClone`, `TextDecoder`, `WebSocket`, `crypto`, `Blob`, `FormData`. Network access is
  plain Node: the app adds no proxy, allow-list or limit (the panel CSP does not apply here).
- `main` is loaded with Node's own `require`, relative to its folder, so `require('./lib/x')`, a
  `.json` file and a `node_modules` folder in or above the plugin folder all work. One bundled file
  is not required. A git install runs no `npm install`: commit what you `require`. On a dev reload
  every module under the plugin folder is read again; a dependency outside the folder keeps its
  cached copy until the host restarts.
- The host restarts, and with it every plugin of the project (each gets `deactivate()`, then a
  fresh process and `activate()`; in-memory state is gone), when: a plugin is enabled or disabled
  in the project; a plugin the project runs or has enabled is linked, unlinked, installed,
  updated or uninstalled (so `ccc plugin link` of a second plugin re-activates the first); the
  host crashed (with backoff). It does not restart for a settings save, and a dev edit of a
  linked plugin reloads only that plugin. Keep state worth keeping in `ctx.storage`, not in
  memory.

## Identity and settings

- `ctx.api`: the API major (1). `ctx.pluginId`: your manifest id.
- `ctx.projectDir`: the project folder, absolute and its real path (symlinks resolved, read when
  the host started your plugin), the default cwd of `ctx.exec`. No need for `pwd -P`.
- `ctx.settings`: a frozen snapshot `{ project, app }` of the validated values with schema
  defaults applied (`project`: this project's override of each field, else its global value). A save replaces the whole snapshot: read `ctx.settings` again instead of
  keeping `ctx.settings.app` in a variable. A secret field is in it as plaintext when set and
  absent when not (`settings-secrets` topic).
- `ctx.onSettingsChange(listener)`: after a save of this plugin's app or project settings
  (Settings or `ccc plugin config`) that changed this project's values `listener(settings)` is called with the new whole
  `{ project, app }`, both scopes whichever one changed; `ctx.settings` already holds it. It is
  not called at start (read `ctx.settings` in `activate`). Returns a disposer; a listener that
  throws is logged and the others still run.

## Data

- `ctx.storage.get(key)`, `set(key, value)`, `delete(key)`, `keys()`: per plugin per project
  key-value store, JSON values. Limits: a key is a non-empty string of at most 200 characters (any
  characters; keys are never paths); a value at most 1 MiB as JSON text; keys plus values at most
  16 MiB in total per plugin and project. No separate key count: the total caps it. Every call is
  async: a write past a limit rejects (`RangeError`, the limit in its message) and stores nothing.
- `ctx.dataDir`: `<data>/plugin-data/<projectId>/<pluginId>/`, created on first read.
- `ctx.appStorage.get(key)`, `set(key, value)`, `delete(key)`, `keys()`, `increment(key, by = 1)`:
  the same store, but app-wide: every project window sees the same keys. `increment` adds `by`
  (a finite number; absent key counts as 0) and resolves the new value; it rejects when the
  stored value is not a number. Values at most 1 MiB less 8 KiB as JSON, and the key list (as
  `keys()` returns it, as JSON) at most 1 MiB less 8 KiB, since each answer is one message; other
  limits as `ctx.storage` (16 MiB in total per plugin, across all projects).
- `ctx.appDataDir`: `<data>/plugin-data/_app/<pluginId>/`, the same in every project, created on
  first read. Use these two paths; don't derive others from the layout. Leave `storage.json` in
  either folder alone: it is the store's own file.
- Which store: per-project state (a project's board, its last sync) goes in `ctx.storage`;
  state that must add up across windows (a monthly usage cap, a cache all projects share) goes
  in `ctx.appStorage`. Each window runs its own host, so two windows can act at the same time.
  `ctx.storage` has one writer (the project's host). `ctx.appStorage` lives in main, which
  applies calls one at a time: each call is atomic, and `increment` is the safe counter across
  windows. A `get` followed by a `set` is not atomic (another window can write in between);
  there are no locks. Files you write in `ctx.appDataDir` yourself have no such guarantee.
- Both stores and both folders are kept when the plugin is uninstalled (only `ctx.secrets` is
  deleted), and a reinstall finds them again. Forgetting a project keeps its `ctx.storage` too.
- `ctx.secrets.get(key)`, `set(key, value)`, `delete(key)`, `keys()`: encrypted with the OS
  keychain, app-wide per plugin. Keys `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, values at most 64
  KiB, at most 100 keys. The `setting:` prefix is reserved.
- `ctx.oauth.authorize(spec)` and `ctx.oauth.refresh(spec, refreshToken)`: authorization code +
  PKCE through the system browser and a loopback redirect. `spec` is `{ authUrl, tokenUrl,
  clientId, clientSecret?, scopes }`; both URLs must be https.

## Work

- `ctx.schedule(seconds, fn)`: run every 1 to 86400 s; no overlap; a run over 60 s is abandoned;
  returns a disposer.
- `ctx.exec(argv, { stdin, cwd, timeoutMs })`: run a program, argv only, never a shell; argv[0]
  is looked up on the login-shell PATH. Resolves `{ code, stdout, stderr }` (a non-zero code
  resolves; output over 10 MiB rejects).

## UI

- `ctx.panels.post(panelId, message)` and `ctx.panels.onMessage(panelId, listener)`: JSON
  messages (at most 1 MiB) to and from your own html panels. `panelId` must be declared; a
  `webview` panel throws (it has no page of yours). `onMessage` returns a disposer; its listeners
  stay across panel reloads, so register once in `activate`. `post` returns nothing and is
  fire-and-forget: when the panel has no page connected (never opened, closed, or reloading) the
  message is dropped silently, not queued, and nothing throws; it throws only for a message that
  is not JSON or over 1 MiB. So do not push state at the panel from `activate`: have the page
  send a first message when it loads (`ccPanel.post({ hello: 1 })`) and answer that.
- `ctx.panels.show(panelId)`: bring one of your own panels into sight (either kind): a hidden
  panel comes back, a closed one opens and its zone expands (a side zone the window auto-hid for a
  narrow terminal shows again too). Use it when a command should make
  the panel visible (`ccc browser open`). Throws for an undeclared id; a refusal is logged.
- `ctx.panels.header(panelId, { meta?, actions? } | null)`: the title bar of one of your own
  panels (either kind): `meta` is muted text after the title (at most 120 characters), `actions`
  up to 3 icon buttons `{ id, icon, title, busy?, disabled? }` before the "…" menu, `icon` a core
  name (`refresh`, `add`, `search`, `filter`, `settings`, `open-external`, `check`, `sort`) or an
  `.svg` path in your folder. Each call replaces the header, `null` clears it; over a limit it
  throws a TypeError. Cleared when the plugin stops or reloads (`ccc guide panels`).
- `ctx.panels.onAction(panelId, (actionId) => …)`: a click on one of that panel's header actions
  (never a busy or disabled one); returns a disposer.
- `ctx.panels.slots(panelId, placements | null)`: place slots (pages another plugin draws) above or
  below one of your own panels: `[{ type, position: 'top' | 'bottom', height, params? }]`, at most
  4; `type` must be in that panel's manifest `slots` (and not an app slot such as
  `sessions-strip`), `height` 24-600 px, `params` plain JSON of at most 4 KiB that only the
  provider sees. Each call replaces the set, `null` removes it; a bad placement throws a TypeError
  or Error, a refusal from the app is logged. Cleared when the plugin stops or reloads. Who draws a
  type is the project's pick (`@slot:<type>`); with several providers and no pick, none is drawn.
- `ctx.slots` (the provider side; an older app has none, so check `typeof ctx.slots === 'object'`):
  `onOpen(type, (slot) => …)` hears a frame of a type from your manifest `contributes.slots`
  opening (it throws for another type) and returns a disposer. `slot` is `{ id, type, host,
  params, post(message), onMessage(fn), onClose(fn) }`: `post` and `onMessage` talk to the slot's
  page with the panel message rules (JSON, 1 MiB; `ccPanel.post` / `ccPanel.onMessage` on the
  page), `onClose` fires when the frame ends (host panel hidden or reloaded, placement removed,
  provider changed). `available(type)` resolves whether a placement of `type` would draw now.
  Known slot types: `agenda` (today's events, a compact strip a panel places above or below itself) and
  `sessions-strip` (an app slot: the Claude sessions of other windows in one line, drawn in the top bar,
  which a panel may not place; core draws no strip of its own, the bundled `cockpit.sessions` provides it;
  its page reports its width with `ccPanel.slot.setWidth`, `ccc guide panels`). A type is a name
  `^[a-z][a-z0-9-]{0,63}$`; any plugin defines one by using it. The user picks the provider per type under
  Settings > This Project > Services ("None" turns it off).
- `ctx.settingsPage` (an older app has none, so check `typeof ctx.settingsPage === 'object'`):
  `onOpen((page) => …)` is the backend of your html settings page (manifest
  `contributes.settings.page`, `ccc guide settings-secrets`); it throws when the manifest declares
  none and returns a disposer. `page` is `{ scope, post(message), onMessage(fn), onClose(fn) }`:
  `scope` is `'app'` (the Plugins page) or `'project'` (This Project), `post` / `onMessage` follow
  the panel message rules, `onClose` fires when the page goes. One page of a plugin is open at a time.
- `ctx.webview`: drives the native web view of one of your `"kind": "webview"` panels (`ccc guide
  webview`). `navigate(panelId, target)` shows an http(s) URL or an absolute file path (a local
  file is served read-only with the files next to it); `back(panelId)`, `forward(panelId)`,
  `reload(panelId)`; `current(panelId)` resolves `{ url, title }`; `onNavigate(panelId, fn)`
  hears every page the view commits and returns a disposer. Any other panel id throws; at most
  60 navigations a minute.
- `ctx.badge(panelId, value)`: a count, `'dot'` or `null` on a panel icon.
- `ctx.overlay.open(spec)`: a `terminal`, `url` or `html` overlay above the window; resolves with
  the result. The plugin's overlays close when it stops: its host stops, or the plugin is reloaded
  (a linked folder changed), disabled, updated or uninstalled; `result` resolves as
  `{ kind: 'dismissed' }` in the old copy and the new copy starts with none. At most 3 open and 10 per minute. Every kind takes `size?: 'default' | 'large' | 'full'`:
  a centered dialog at 75 % of the window, about 90 %, or the whole window below the top bar with a
  small margin; the title bar and close button stay, a terminal program is resized to fit. Any other
  value is refused.
- `ctx.overlay.start(spec)`: the same overlay as a handle `{ result, post, onMessage, close, focus }`
  (`open(spec)` is `start(spec).result`), so an `html` page and the plugin talk while it is open.
  `post(message)` sends JSON to the page (`ccPanel.onMessage`), queued until the page has loaded;
  `onMessage(fn)` hears what the page posts without a `result` key and returns a disposer;
  `close()` dismisses it; `focus()` brings it to the front of the window's overlay stack (the others
  stay open under it), e.g. on a second click for the file it already shows. `post`/`onMessage` throw for a terminal or url overlay. A message is at
  most 1,040,384 chars of JSON (1 MiB less 8 KiB for the transport); a larger one throws. Once the
  overlay ended, `post`, `close` and `focus` do nothing and the listeners are dropped. Esc, the close button
  and Cmd+Shift+W resolve `result` as `{ kind: 'dismissed' }` without asking the page, so a page
  that keeps a draft should post it as it goes (each change, or debounced), not only on submit.
  The handle's `onButton(id, fn)` hears a click on one of the spec's `buttons` (any kind of
  overlay; the button shows busy until `fn` settles, at most 30 s), and `setButtons(list)` replaces
  them (same rules: at most 4, ids 1-40 of `A-Z a-z 0-9 . _ -`, labels 1-40 characters).
  The toolbar's Discuss with Claude shows on an overlay with a `type` or an `onDiscuss` handler
  (`discuss: false` in the spec hides it; `discuss: { tabId }` preselects that Claude tab). It is a
  split button: the main part discusses in a new Claude session at once (no picker), the ▾ part lists
  the window's existing Claude tabs (the preselected one first, then waiting, then busy ones, queued
  until free; disabled with none); there is no note field, so a page that wants the person's words first keeps its own and returns them from `onDiscuss`; `onDiscuss(fn)` answers
  `{ text }` (the context, within 5 s) or `null` for none, and a throw shows its error and sends
  nothing. `setDiscussPrimary(on)` draws Discuss as the accent (primary) button, or plain again
  (e.g. primary once there is something to send). The app sends `About: <title>`, the type, your text (20,000 characters at
  most, your text cut first; the person may add a closing prompt in Settings, which comes after your text and is never cut), closes the overlay with `{ kind: 'discussed', tabId, queued }` and
  shows the tab.
- `ctx.overlay.buttons(typeName, provider)`: add buttons to every overlay of that `type` in the
  window, whoever opened it. `provider(info)` gets `{ type: { name, data }, title, opener }` and
  answers up to 4 buttons, each with a `run(info)`; it is asked when such an overlay opens, after
  every click on its buttons and when the opener calls `setButtons`, and has 500 ms (a slower or
  throwing one is skipped and logged in your plugin's log). `data` came from the opener: check it
  (an id is yours, a path resolves inside the project). `opener` is the app's own record of the
  plugin whose request opened the overlay (never taken from the spec or `data`): a button that acts
  on an account checks it too, as a source adds its `inbox-item` buttons only on overlays it or the
  reviewer it handed the item to (`cockpit.reviewer`) opened. A click shows the button busy until `run`
  settles (at most 30 s); `{ close: true }` closes the overlay. A click never reaches the
  overlay's page. Returns a disposer; dropped when the plugin stops. Check
  `typeof ctx.overlay.buttons === 'function'` first: an older app has none.
- Overlay extras, in the spec of any kind: `type: { name, data }` (what the overlay shows: `name` a
  plain noun `^[a-z][a-z0-9-]{0,63}$`, `data` plain JSON of at most 4,096 characters), `buttons` (the
  opener's own, at most 4), `discuss` (`false` or `{ tabId }`, above) and, for `html` only,
  `ready: 'load' | 'manual'`. Well-known types, so plugins agree on them: `file` `{ path, mime? }`
  (`path` relative to the project folder; the editor adds Edit, the reviewer's file reviews have it) and
  `inbox-item` `{ source, id }` (`source` is the providing plugin's id; Discuss names it
  `Item: <source> <id>`). The toolbar reads, left to right: the title, the opener's buttons, a divider,
  the type buttons of other plugins (in plugin-title order), Discuss, and the close button where the tab
  close side setting puts it; more than 6 buttons fold the rest into "...". Plain text, no chords, no
  icons beyond the core names and plugin `.svg` files.
- Loader: an overlay is on screen as soon as it is requested, with a spinner (and "Still loading..."
  after 10 s) until its content is up: an `html` page when it has loaded (`ready: 'load'`, the default),
  or when it calls `ccPanel.ready()` (`ready: 'manual'`); a `url` view at its first load or failed load;
  a terminal at the first output. The close button works throughout.
- Open first, fetch after: for a page that needs data before it can show, open the overlay at once with
  `ready: 'manual'` and the `type`, fetch, `post` the content, and have the page call `ccPanel.ready()`
  when it has drawn it. The person sees the toolbar and the loader instead of nothing, and Discuss and
  the type buttons are there from the start. Close the overlay (`close()`) when the fetch fails and
  tell the person with `ctx.notify`.

## Sessions

- `ctx.sessions.list()`: the window's Claude tabs with their status. `needs-permission` also
  covers a question or plan-approval dialog (`tool` is `AskUserQuestion` or `ExitPlanMode`).
  `sessionId` is Claude Code's own session id once its SessionStart reported one; `notes` and `steps`
  (`{ done, total }`) are what the tab's Claude posted with `ccc session note` and `ccc session steps`.
  `files` lists what the tab's Claude wrote (Write, Edit, MultiEdit, NotebookEdit): absolute paths
  as Claude gave them, files outside the project included, each once, in the order first written,
  kept for the tab's life and capped at 500 (later files are not added). Only the ones inside
  the project can reach a plugin through a click (see Files); make a path project-relative
  yourself against `ctx.projectDir` when you need one. `title` is the short topic Claude Code
  put in its terminal title (spinner glyph removed), what the Sessions panel and the tab strip
  name the tab; absent until Claude has one. `lastPrompt` is the person's last prompt with Claude
  Code's own markup taken out (a turn of system reminders or task notifications only keeps the
  one before). `gist` is a one-line summary of the session, present only while the app's Session gist
  setting is on and after its first run. `active: true` marks the tab the window shows (selected in its tab pane), the one
  the person is looking at; absent on the others, and on all of them while a shell tab is
  selected. Selection only: the window may be in the background.
  `typed` is `true` once the person typed or pastes into the tab (a key before Enter counts); `false` until then. Terminal
  reports the terminal sends by itself (focus on switching to the tab, mouse clicks, cursor position and device replies) do
  not count; a wheel scroll does (it arrives as arrow keys). It is never cleared while the tab exists (a restart of the same
  tab keeps it), not persisted across an app restart, and reaches `onChange`. An older app has no `typed`: detect support with
  `typeof typed === 'boolean'` on some session (unknown until a Claude tab exists). Once `typed`, `ctx.sessions.send` to the
  tab rejects with "the person is typing in this tab", and texts already queued by plugins for it are dropped at that moment,
  with no event to the plugin; a paste already being delivered is not undone. Discuss with Claude is unaffected.
  `flag` is the person's flag on the tab, `{ color, note? }`, absent when it has none: they marked the tab to come back
  to. `color` is one of `red`, `orange`, `yellow`, `green`, `blue`, `purple` (draw it with the panel token
  `--cc-flag-<color>`, never a colour of your own); `note` an optional reminder, 1 to 80 characters of plain text.
  Read-only: only the person sets or clears it (the tab's right-click menu, the Toggle Tab Flag command); no plugin API
  writes it. Sticky until cleared and kept across an app restart; a change reaches `onChange`. An older app never sends it.
- `ctx.sessions.onChange(listener)`: the whole list again on every change, a selection change
  included (at most 4 a second).
- `ctx.sessions.list({ scope: 'all' })` and `onChange(listener, { scope: 'all' })`: every window's
  Claude tabs as summaries `{ tabId, own, project: { name, color? }, status, tool?, title?, name?, flag? }` (`own`: a
  tab of this window; `color` a CSS value, `var(--cc-project-blue)` or `#rrggbb`; `flag` is `{ color }` only, the
  note stays in the tab's own window), never prompts, notes, files, cwd or terminal content. Only with `"access": { "sessions": "all-windows" }` in plugin.json
  (`plugins` topic); without it both throw. An older app ignores the option and answers this window's
  list: check `typeof ctx.sessions.focus === 'function'` first.
- `ctx.sessions.focus(tabId)`: select a Claude tab of any window and raise that window; `false` for an
  id that is no Claude tab. At most 10 in 10 s.
- `ctx.sessions.close(tabId)`: close a Claude tab of this window the person's way: a running tab asks
  first (the close dialog, unless they turned it off) in this window, raised for it. Resolves
  `{ closed: false }` on Cancel or when the dialog could not be shown (another dialog, an overlay, the
  settings screen up). Rejects for another window's tab. At most 10 a minute.
- `ctx.sessions.openFile(tabId, path)`: open one of the tab's `files` (verbatim) as a click in the
  Sessions panel would: through the plugin picked to open files when it is inside the project, else in
  the built-in viewer. Rejects for another window's tab or a path not in its list. At most 20 in 10 s.
- `ctx.sessions.rename(tabId, name)`: name a Claude tab of this window (`SessionInfo.name`, also in the scope
  `all` summaries); the tab strip and the Sessions panel show it instead of Claude's topic. `name` is 1-60
  characters without control, bidi or invisible format characters (surrounding spaces trimmed), or `null` to go back to Claude's
  title; a bad name rejects with an Error naming the rule. It survives a restart of the app. A tab of
  another window rejects as unknown; at most 30 a minute per plugin. The tab menu's Rename does the same
  for the person. An older app has no `rename`: check `typeof ctx.sessions.rename === 'function'`.
- `ctx.sessions.send(tabId, text)`: typed only while the tab is waiting for input, queued
  otherwise (a just-opened tab takes it about a second after Claude is at its prompt). Refuses text starting with `/`, `!`, `#` or `&`.
- `ctx.sessions.open({ cwd, prompt, focus, model, effort })`: a new Claude tab; the prompt is an argument, never typed.
  `model` (`haiku`, `sonnet`, `opus`, `fable`) and `effort` (`low`, `medium`, `high`, `xhigh`, `max`) start it with
  `--model` / `--effort`; leave them out for the person's default, anything else rejects naming the field.
  The tab opens unselected (the person may be typing in another one); `focus: true` selects it in the
  window, for a click the person made that means "go there" (Discuss in a new session). An older app ignores
  `focus`, `model` and `effort`, silently: it starts the tab with the default model.

## Files

- `ctx.files.onOpen(listener)`: take over a click on a changed file in the Sessions panel; returns
  a disposer. Needs `"contributes": { "openFile": { "title": "Review" } }` (`plugins` topic), else
  it throws. `listener({ path, tabId })` gets the file relative to the project folder (`src/a.ts`,
  `/` separators, never outside the project) and the Claude tab whose list was clicked; both come
  from the app. `tabId` is absent when the open did not come from a tab (a `ctx.files.open` call
  without one), so check it before use. Opens reach the plugin only when the project uses it to open files: it is the
  only enabled plugin declaring `openFile`, or the one picked in Settings > This Project ("Plugin used
  to open files", where "Built-in viewer" is also a choice). The built-in viewer (a diff or the
  file in a pager) opens instead when the plugin is not active, has no listener, or every listener
  throws or rejects within 1 s; a listener still running after 1 s counts as handled, so one that
  awaits an overlay is fine. The app waits at most 2 s for the host. A file outside the project
  (a session can write anywhere: `/tmp`, another repo) always opens in the built-in viewer, so a
  plugin only ever receives project-relative paths. Clicks and `ctx.files.open` calls (below) both
  reach the listener.
- `ctx.files.open(path, { tabId }?)`: open a project file the way a Sessions panel click does, with
  the person's "Plugin used to open files" pick (that plugin's `onOpen` listener; it may be your
  own), else the built-in viewer. Resolves `{ via: 'plugin' | 'builtin' }`. `path` is relative to the
  project folder with `/` separators; it rejects for an absolute path, a `..` segment, a path whose
  real path (symlinks resolved) is outside the project, a missing file or one that is not a regular
  file. `tabId` is passed to the listener when it is a Claude tab of this project, else silently
  dropped. Needs no manifest declaration; at most 20 calls per 10 s per plugin and window. Use it
  instead of calling another plugin's service directly, so the person's pick holds.

## Commands and misc

- `ctx.commands.register(id, run)`: `id` must be declared in `contributes.commands`.
- `ctx.cli.register(name, handler)`: implements `ccc <name> …`; `name` must be declared in
  `contributes.cli`, one handler per name. `handler(argv, { stdin, cwd, signal })` gets the words
  after the name verbatim, the caller's stdin (only with `"stdin": true`, else `''`; with `"stdinDash": true` too, `''` unless an argument is `-`), the caller's
  cwd (resolve relative paths against it) and an AbortSignal (Ctrl+C, the 30 s limit, deactivate).
  It returns `{ stdout?, stderr?, code? }` (code 0-255, default 0); each output is cut at 256 KiB
  once JSON-encoded. A throw is exit 1 with the message on stderr, 30 s without an answer is exit
  124, and at most 4 calls of one plugin run at once. The call also has `tabId`: the Claude tab that ran
  the command, set by the app from the caller's session token (never from the arguments, so a tab cannot name
  another); absent for a shell tab, a command tab, an overlay terminal, `--project` and on an app older than 0.11.
  Use it to accept a command only from the tab you opened (`ccc myplugin stop` from its own session).
- `ctx.services`: calls between the plugins of one project window, declared in the manifest's
  `services` (`plugins` topic). Only names declared there are accepted, else it throws.
  - `ctx.services.provide(name, impl)`: `impl` is a plain object of functions (no method `on`,
    `then`, `constructor` or starting with `_`); providing again replaces it; withdrawn at
    deactivate.
  - `ctx.services.use(name)` returns a handle: `await handle.method(...args)` calls the provider
    (async always). The provider is resolved on every call, so a handle got in `activate` keeps
    working across provider reloads. A call waits for a provider that is still activating.
  - `ctx.services.emit(name, event, data)`: only the provider the project selected reaches
    `use` consumers (others are dropped, logged once while a `use` consumer exists);
    `handle.on(event, listener)` subscribes and returns the unsubscriber. Listeners run later,
    never inside `emit`. Every provider reaches `useAll` consumers.
  - `ctx.services.useAll(name)` (app 0.9.7+): every provider of `name`, for a plugin that reads
    from all of them (an inbox merging every `inbox-feed`) instead of the one the project picked.
    The name must be in your `services.uses` and in `services.collects` (a list of names; an older
    app refuses a manifest with `collects`). It returns a set:
    - `set.providers()`: `[{ pluginId, handle }]`, every enabled plugin that provides `name` at
      your `uses` major and has called `provide`, read fresh on each call, in plugin order. Each
      `handle` calls that plugin only (it waits while the plugin activates, rejects once it no
      longer provides the name), and its `handle.on` hears that plugin's events only. A provider
      still activating joins when it provides; one whose activate failed is left out.
    - `set.on(event, (data, pluginId) => ...)`: events from every provider, with the sender's id.
    - `set.onChange(listener)`: the provider set may have changed (provided, withdrawn, reloaded,
      enabled, disabled): call `providers()` again. Several changes at once call it once.
    The Plugins page shows no "pick one" for a name only collectors use. Use `use` when one
    answer is wanted (the person's pick holds), `useAll` when every provider's answer is.
  - `ctx.services.caller()`: in a provider, the id of the plugin whose call it is serving, for
    per-caller usage counts or caps. It holds inside the provided method and in what that method
    awaits or starts (timers, promise callbacks) while the call is still running; with nested calls
    it is the innermost caller (A calls B, B's method calls C: C sees B). `undefined` in `activate`,
    in event listeners, outside any call, and after the call returned (a late timer), and it never
    answers another plugin's call (only calls into your own plugin). The registry takes it from the
    caller's own `ctx`, so it cannot be set or faked through arguments, unlike a `label` argument.
    It is not a security boundary: all plugins of a project share one JS realm, so it guards
    against honest mistakes, not against a hostile plugin.
  - `ctx.services.available(name)`: `true` when a call on `name` would reach a provider now
    (`name` is in your `services.uses`, an enabled plugin provides it at the same major, and with
    several providers the project picked one), else `false`; never throws, an undeclared or
    unknown name is `false`. Asked fresh each time, so call it when you need the answer (e.g. to
    hide an Edit button when no editor is enabled) rather than once in `activate`. A provider
    still activating, or whose activate failed, counts: a call waits for it, or rejects with the
    failure.
  - `ctx.services.provider(name)`: the id of the plugin a call on `name` would reach now (the
    only provider, or the project's pick among several), or `null` when none would (no enabled
    provider, several and no pick, the selected one at another major). Same rule as `available`,
    asked fresh each time. Use it to check an overlay's `opener` against the provider the person
    picked (a replacement reviewer, not a hardcoded `cockpit.reviewer`). It throws for a name not
    in your `services.uses`, and for one in your `services.collects`: the pick does not apply to
    a collector, read `useAll(name).providers()`. An older app has no `provider`: feature-test
    `typeof ctx.services.provider === 'function'` and keep a fallback.
  - No limits: a service call is a plain call inside the host process, it never reaches main, so
    there is no rate, concurrency, argument or result size cap and no timeout. A provider that
    must protect itself counts and caps its own callers (`caller()` says who).
  - Plain data only: arguments, results and event data are copied (structured clone). A function
    or symbol throws `<what> must be plain data (no functions or symbols): ...`; shared memory (a
    SharedArrayBuffer, a typed array or DataView over one, a shared WebAssembly.Memory), nested too,
    throws `<what> must be plain data (no shared memory): ...`, as a clone would share it; a class instance
    arrives as a plain object (prototype and methods gone). `provide` takes a plain object, not a
    class instance (`service "x": the implementation must be a plain object (not a class instance)`).
  - Errors a consumer can get (a call rejects, `use`/`on` throw): `plugin <id> does not declare
    service "x" in services.uses`; `no enabled plugin in this project provides service "x"`;
    `plugins A and B both provide service "x"; pick one in Settings > This Project`; `"x": A uses version
    1, B provides version 2` (major versions differ); `service "x": plugin P failed to activate:
    <reason>`; `P declares service "x" but did not provide it`; `service "x" (plugin P) has no
    method "m"`; and the provider's own throw (a fresh Error with its message only). No timeout:
    race your own.
  - Cycles: plugins that call each other while one is in `activate` would wait forever: two (or
    more) both in `activate`, or A's `activate` calling an active B whose method calls back into A.
    The call closing the cycle fails at once with `A -> B -> A: services called in a cycle during
    activate`. Calls started during `activate` (timers, unawaited calls) count while it runs. Call
    from commands, or after `activate` returned, to avoid it.
  - Events: `emit` only reaches consumers when the caller is the selected provider (with several
    providers, the one picked in Settings > This Project); a consumer whose `uses` major differs gets no
    events; an `emit` with no subscriber is a silent no-op; the event name and data are checked
    even then (plain data, else it throws). A handle from before the consumer's reload (or
    deactivate, or failed `activate`) can no longer call or subscribe (`service "x": this handle
    belongs to a previous copy of plugin C; call ctx.services.use again`); a call already running in
    the provider finishes. Call `use` again in `activate`.
  - Provider pick: when several enabled plugins provide a service, the Plugins page shows "Plugin
    used for <service>" in its Services group, stored per project. A pick naming a plugin that is
    disabled or gone counts as no pick. Each plugin row shows Provides/Uses lines and warnings
    (same texts as above).
  - Example. Provider manifest `"services": { "provides": { "greetings": 1 } }`, host code:
    `ctx.services.provide('greetings', { hello: async (n) => `hi ${n}` }); ctx.services.emit('greetings', 'ready', {})`.
    Consumer manifest `"services": { "uses": { "greetings": 1 } }`, host code:
    `const g = ctx.services.use('greetings'); g.on('ready', () => ctx.log.info('up')); ctx.commands.register('hi', async () => ctx.log.info(await g.hello('Ann')))`.
  - `activate`'s return value is ignored; `ctx.services` is the only way to share an API.
- `ctx.log.info(...)`, `warn`, `error`: lines go to `<data>/logs/<pluginId>.log` (`ccc plugin logs`
  reads it): `<ISO time> <level> [<projectId>] <text>`, at most 4000 chars and 100 lines per 10 s,
  line breaks written as `\n`.
- `ctx.notify(text, options?)`: a system notification; text is cut at 500 characters, at most 10 a
  minute per plugin and window, and only while the project's window is open. Resolves `{ clicked }`.
  Options (unknown keys are ignored; a bad value rejects with a TypeError at the call site):
  - `title`: plain text, 1 to 80 characters. Default `cc-cockpit: <pluginId>`.
  - `sound: true`: a short sound from the project window, the same on every OS (OS notification
    sounds are unreliable, most Linux daemons play none), and the OS notification is then silent.
    It is the sound the person picked (Settings > General > Notifications > Sound: a
    built-in tone or a system sound file). The person can turn every sound off there ("Notification
    sounds"); at most one chime per 5 s per window, however many plugins ask.
  - `sound: "<id>"`: the sound the person picked for this plugin, the value of a `"format": "sound"`
    settings field (see `settings-secrets`), passed on as it is: `""` (the field's "App default")
    is the same as `true`. A plugin never names a file: the app rings the id only when it is one of
    its own sounds now (a built-in, or a system sound file still listed), and otherwise rings the
    app's sound and logs it once. `false` or no `sound`: none. Older apps take a string here as no
    sound (0.9.4 ignores every option).
  - `action: { label }` (1 to 40 characters): the call waits for the person. It resolves
    `{ clicked: true }` on a click on the notification or its button (macOS and Windows show the
    label as a button; on Linux the click on the notification is the action), `{ clicked: false }`
    when it is dismissed, after 10 minutes (it is then closed), or when the plugin deactivates. On
    Linux and Windows it stays on screen until one of those. Without an action the call resolves
    `{ clicked: false }` as soon as it is shown. What a click does is up to the plugin: a meeting
    reminder does `const { clicked } = await ctx.notify('Standup in 2 min', { title: 'Calendar', sound: true, action: { label: 'Join' } }); if (clicked) await ctx.openExternal(meetUrl)`
    (`openExternal` has its own limit, below). Do not await it inside a command or `ccc` handler
    with a time limit; keep the promise and act when it settles.
- `ctx.openExternal(url)`: open a web page in the person's default browser, outside the app.
  `url` is http or https, at most 2048 characters, with no `user:pass@` in it; anything else
  rejects, and so does a call past 3 per 10 s per plugin and window. The app opens the normalized
  URL (`new URL(url).href`) and resolves once it handed it to the system. Use this, not
  `ctx.exec(['xdg-open', url])` or `open`: the host process has no display or desktop session in
  its env, so those fail on Linux. Open a page on the person's click, not unasked. A panel or an
  html overlay page cannot open links itself: post a message to the host and let it call this,
  with a URL the host chose (never one taken from the page as is).

Calls that reach main (`exec`, `overlay`, `notify`, `webview`, `openExternal`, ...) are limited there and
a rejected promise carries the reason; `ctx.services` calls never reach main, see above.
Types: `PluginContext` in the SDK types; `ccc guide types` prints the file.
