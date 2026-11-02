# The plugin host API (version 1)

`activate(ctx)` receives `ctx`, scoped to ONE project window. Nothing in it takes a project id;
ids it does take (a tab, a panel) are looked up inside that project only.

## Identity and settings

- `ctx.api`: the API major (1). `ctx.pluginId`: your manifest id.
- `ctx.settings.project` and `ctx.settings.app`: validated values with schema defaults applied.
- `ctx.onSettingsChange(listener)`: called with the new settings when the user saves; returns a
  disposer.

## Data

- `ctx.storage.get(key)`, `set(key, value)`, `delete(key)`, `keys()`: per plugin per project
  key-value store, JSON values.
- `ctx.dataDir`: `<data>/plugin-data/<projectId>/<pluginId>/`, created on first read.
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
  `webview` panel throws (it has no page of yours).
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
  the result. At most 3 open and 10 per minute.

## Sessions

- `ctx.sessions.list()`: the window's Claude tabs with their status.
- `ctx.sessions.onChange(listener)`: the whole list again on every change (at most 4 a second).
- `ctx.sessions.send(tabId, text)`: typed only while the tab is waiting for input, queued
  otherwise. Refuses text starting with `/`, `!`, `#` or `&`.
- `ctx.sessions.open({ cwd, prompt })`: a new Claude tab; the prompt is an argument, never typed.

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
  - Plain data only: arguments, results and event data are copied (structured clone); a function
    or symbol throws, a class instance arrives as a plain object.
  - A call rejects when no enabled plugin provides the service, two do and none is picked in
    Settings > Plugins, the major versions differ, the provider failed to activate or never called
    `provide`, the method does not exist, or the provider threw (a fresh Error, its message only).
    No timeout: race your own.
  - Cycles: two plugins that call each other while both are in `activate` would wait forever; the
    call closing the cycle fails at once instead. Call from timers or commands to avoid it.
  - `activate`'s return value is ignored; `ctx.services` is the only way to share an API.
- `ctx.log.info(...)`, `warn`, `error`: lines go to `<data>/logs/<pluginId>.log`.
- `ctx.notify(text)`: a system notification, at most 10 a minute.

Every call that can be abused is rate limited by main; a rejected promise carries the reason.
Types: `PluginContext` in `src/sdk/types.ts`.
