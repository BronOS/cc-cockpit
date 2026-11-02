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
- `ctx.settings`: a frozen snapshot `{ project, app }` of the validated values with schema
  defaults applied. A save replaces the whole snapshot: read `ctx.settings` again instead of
  keeping `ctx.settings.app` in a variable. A secret field is in it as plaintext when set and
  absent when not (`settings-secrets` topic).
- `ctx.onSettingsChange(listener)`: after a save of this plugin's app or project settings
  (Settings > Plugins or `ccc plugin config`) `listener(settings)` is called with the new whole
  `{ project, app }`, both scopes whichever one changed; `ctx.settings` already holds it. It is
  not called at start (read `ctx.settings` in `activate`). Returns a disposer; a listener that
  throws is logged and the others still run.

## Data

- `ctx.storage.get(key)`, `set(key, value)`, `delete(key)`, `keys()`: per plugin per project
  key-value store, JSON values.
- `ctx.dataDir`: `<data>/plugin-data/<projectId>/<pluginId>/`, created on first read.
- `ctx.appStorage.get(key)`, `set(key, value)`, `delete(key)`, `keys()`, `increment(key, by = 1)`:
  the same store, but app-wide: every project window sees the same keys. `increment` adds `by`
  (a finite number; absent key counts as 0) and resolves the new value; it rejects when the
  stored value is not a number. Values at most 1 MiB less 8 KiB as JSON; other limits as
  `ctx.storage`.
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
  panel comes back, a closed one opens and its zone expands. Use it when a command should make
  the panel visible (`ccc browser open`). Throws for an undeclared id; a refusal is logged.
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

## Sessions

- `ctx.sessions.list()`: the window's Claude tabs with their status. `needs-permission` also
  covers a question or plan-approval dialog (`tool` is `AskUserQuestion` or `ExitPlanMode`).
- `ctx.sessions.onChange(listener)`: the whole list again on every change (at most 4 a second).
- `ctx.sessions.send(tabId, text)`: typed only while the tab is waiting for input, queued
  otherwise. Refuses text starting with `/`, `!`, `#` or `&`.
- `ctx.sessions.open({ cwd, prompt })`: a new Claude tab; the prompt is an argument, never typed.

## Files

- `ctx.files.onOpen(listener)`: take over a click on a changed file in the Sessions panel; returns
  a disposer. Needs `"contributes": { "openFile": { "title": "Review" } }` (`plugins` topic), else
  it throws. `listener({ path, tabId })` gets the file relative to the project folder (`src/a.ts`,
  `/` separators, never outside the project) and the Claude tab whose list was clicked; both come
  from the app. Clicks reach the plugin only when the project uses it to open files: it is the
  only enabled plugin declaring `openFile`, or the one picked in Settings > Plugins ("Plugin used
  to open files", where "Built-in viewer" is also a choice). The built-in viewer (a diff or the
  file in a pager) opens instead when the plugin is not active, has no listener, or every listener
  throws or rejects within 1 s; a listener still running after 1 s counts as handled, so one that
  awaits an overlay is fine. The app waits at most 2 s for the host. A file outside the project
  always opens in the built-in viewer. Only this click goes through the hook: other plugins that
  want to open a file call a service of yours.

## Commands and misc

- `ctx.commands.register(id, run)`: `id` must be declared in `contributes.commands`.
- `ctx.cli.register(name, handler)`: implements `ccc <name> …`; `name` must be declared in
  `contributes.cli`, one handler per name. `handler(argv, { stdin, cwd, signal })` gets the words
  after the name verbatim, the caller's stdin (only with `"stdin": true`, else `''`), the caller's
  cwd (resolve relative paths against it) and an AbortSignal (Ctrl+C, the 30 s limit, deactivate).
  It returns `{ stdout?, stderr?, code? }` (code 0-255, default 0); each output is cut at 256 KiB
  once JSON-encoded. A throw is exit 1 with the message on stderr, 30 s without an answer is exit
  124, and at most 4 calls of one plugin run at once.
- `ctx.services`: calls between the plugins of one project window, declared in the manifest's
  `services` (`plugins` topic). Only names declared there are accepted, else it throws.
  - `ctx.services.provide(name, impl)`: `impl` is a plain object of functions (no method `on`,
    `then`, `constructor` or starting with `_`); providing again replaces it; withdrawn at
    deactivate.
  - `ctx.services.use(name)` returns a handle: `await handle.method(...args)` calls the provider
    (async always). The provider is resolved on every call, so a handle got in `activate` keeps
    working across provider reloads. A call waits for a provider that is still activating.
  - `ctx.services.emit(name, event, data)`: only the provider the project selected reaches
    consumers (others are dropped, logged once); `handle.on(event, listener)` subscribes and
    returns the unsubscriber. Listeners run later, never inside `emit`.
  - `ctx.services.caller()`: in a provider, the id of the plugin whose call it is serving, for
    per-caller usage counts or caps. It holds inside the provided method and in what that method
    awaits or starts (timers, promise callbacks) while the call is still running; with nested calls
    it is the innermost caller (A calls B, B's method calls C: C sees B). `undefined` in `activate`,
    in event listeners, outside any call, and after the call returned (a late timer), and it never
    answers another plugin's call (only calls into your own plugin). The registry takes it from the
    caller's own `ctx`, so it cannot be set or faked through arguments, unlike a `label` argument.
    It is not a security boundary: all plugins of a project share one JS realm, so it guards
    against honest mistakes, not against a hostile plugin.
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
    `plugins A and B both provide service "x"; pick one in Settings > Plugins`; `"x": A uses version
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
    providers, the one picked in Settings > Plugins); a consumer whose `uses` major differs gets no
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
- `ctx.notify(text)`: a system notification, at most 10 a minute.

Calls that reach main (`exec`, `overlay`, `notify`, `webview`, ...) are limited there and
a rejected promise carries the reason; `ctx.services` calls never reach main, see above.
Types: `PluginContext` in the SDK types; `ccc guide types` prints the file.
