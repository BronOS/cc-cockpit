# cc-cockpit

Electron desktop app: Claude Code terminal tabs, a core Claude status view, and a plugin system
(project = folder, one window per project). Read `docs/design.md` first (source of truth).

## State

Phase 1 is implemented; the plan and its notes are in
`docs/plans/completed/20261029-phase1-cockpit.md`. See README.md for an overview and docs/features.md for features and known
limitations. Concrete data plugins (Jira, Gmail, calendar, Forgejo, file tree, editor) are out
of phase 1; each gets its own design session. The Claude-operable foundation (guide, plugin CLI,
skills, webview, bundled browser plugin) is in `docs/plans/20261031-claude-operable-foundation.md`.
The real-work redesign (component stylesheet, slots, overlay toolbar, settings pages, `cockpit.sessions`, marketplace
previews, Inbox v2 with inbox-feed v2) is designed in `docs/design-next.md` and `cc-cockpit-inbox/docs/design-v2.md`; its plan
is `docs/plans/completed/20261104-redesign-inbox-v2.md`. Plugin pages are checked against `ccc guide style` (`src/cli/guide/style.md`).
Web access v1 (the app in a plain browser: live mirror views over one WebSocket each, sign-in modes, devices) is implemented;
design in `docs/design-web.md`, plan in `docs/plans/20261110-web-access.md`, user docs in `docs/features.md` ("Web access").
Server mode (Linux, no display, browsers only: `--server`, the key file, `ccc web`, approvals in the browser) is implemented
on top of it; design in `docs/design-web.md` §9, plan in `docs/plans/20261111-server-mode.md`, user docs in `docs/features.md`
("Server mode"). Only the unpacked build was run; the AppImage, the deb on a real server and the systemd unit were not.

## Commands

- `npm test` (vitest), `npm run test:coverage`; `npm run test:e2e` (builds, then Playwright). The OAuth spec and the
  gateway's TLS unit tests (`web-gateway.test.ts`) need `openssl` on PATH.
- `npm run typecheck`, `npm run lint`.
- `npm run build` (runs `build:hello`, `build:browser` and `build:reviewer` first), `npm run build:hello` (rebuild after editing
  `plugins/hello`; the dist is committed), `npm run build:reviewer` (bundles the overlay page of `plugins/reviewer` into the committed `overlay/review.bundle.js`; the reviewer, editor, files and sessions hosts are plain JS, with no build), `npm run test:plugins` (`node:test` suites of `plugins/*/test`; CI runs it), `npm run build:browser` (same for `plugins/browser`; its
  `dist/host.js` is committed and shipped through extraResources), `npm run build:example` (same for `examples/plugin`, the
  master copy of the public repo `BronOS/cc-cockpit-plugin-example`; a change here, or to `src/sdk/types.ts`, must also be
  pushed there; `build:example` only bundles `src/host.ts`, so copy the types by hand: `cp src/sdk/types.ts examples/plugin/sdk/types.ts`; the example is listed, so it stays free of exec, sessions, overlays and secrets), `npm run build:marketplace-tools` (rebuild after
  editing `marketplace/tools/src` or the `src/shared` files it imports, `git-source.ts`, `marketplace.ts` and
  `root-absolute-urls.ts` above all;
  `marketplace/tools/dist` is committed because the index repo's CI runs it with plain node and no install, and a unit
  test compares the bytes), `npm run package` (unsigned mac build),
  `npm run package:dir` (unpacked app in `release/`, for a smoke launch).
- `node scripts/server-mode-smoke.mjs [executable]`: server mode's start end to end (no display, no switches, pid kept,
  `ccc web`, SIGTERM, nothing left; the fallback and a taken port too); with no argument it runs `out/` (build first), with
  a packaged executable it ignores the test env and needs no network. Run it after changing `main/server-mode.ts`,
  `server-start.ts` or the start in `main/index.ts`: the re-exec drops Playwright's inspector, so no e2e covers it.
- `node --expose-gc scripts/web-terminal-bench.mjs [tabs] [seconds] [p99ms]`: the headless terminals' cost to main's event
  loop; exits 1 when parsing lands back on main. Run it after changing `main/terminals/mirror.ts` or `mirror-worker.ts`.

## Implementation patterns

- Distribution (design.md "Distribution"): `.github/workflows/` has `ci.yml`, `release.yml` (a `v*` tag makes a draft
  release) and `publish-cask.yml` (publishing writes the Homebrew cask). Keep first-party actions only, pinned to commit SHAs, least
  permissions, and the token only in the step that needs it; unit tests read the workflow files. `publish: null` in
  `electron-builder.yml` stays: electron-builder never uploads. The update check (`main/updates/update-check.ts`) is
  notice-only, setting `updateCheck`, never the real network in test runs. `ccc` warns on stderr when the app's version
  differs (`appVersion` in the reply); hooks never print.

- Core is the foundation for plugins plus the base functions every user needs without any plugin
  (docs/design.md §1, "What belongs in core"); everything else is a plugin. No accounts in core.
- Electron-only modules sit behind adapter files so logic stays testable under vitest:
  `node-pty` only in `main/pty/node-pty-backend.ts` (fake: `test/fakes/fake-pty-backend.ts`),
  `utilityProcess` only in `main/plugins/host-process.ts`; `WebContentsView` for plugin web views only in
  `main/webview/electron-webview.ts` (fake in `test/unit/webview-manager.test.ts`); `Notification` only in
  `main/notifications/electron-notification.ts` (logic and test backend in `notifier.ts`); `shell`'s file calls
  (`showItemInFolder`, `openPath`, `trashItem`, behind `ctx.files.reveal` / `openWithSystem` / `trash`) only in
  `main/files/electron-shell.ts` (logic in `main/files/system-files.ts`, a recorder `SystemShell` in tests; the e2e replaces the
  three `shell` members, as it does `shell.openExternal`); `dialog` only in `main/dialogs/electron-dialog.ts` (under Ozone
  headless a message box aborts main with SIGTRAP, so server mode gets `serverDialogs`, where a box rejects, an open dialog is
  canceled and an error box is a log line; logic in `dialogs.ts`) and `shell.openExternal` only in
  `main/external/electron-open-external.ts` (behind `createOpenExternal`: in server mode a link goes to browser views as a
  notice, never to the server's own browser), each with a grep test (`no-direct-dialog.test.ts`,
  `no-direct-open-external.test.ts`); `safeStorage` is imported only by
  `main/index.ts` and reached through `main/secrets/secret-store.ts`. Do not import them elsewhere
  (rule stated in `main/index.ts`).
- `CC_COCKPIT_DATA_DIR` overrides the data dir (default: Electron `userData`); tests always set it.
- `CC_COCKPIT_TEST=1` enables test hooks on `globalThis.__ccTest`; never active in packaged builds.
  `CC_COCKPIT_FAKE_SECRETS=1` swaps the keychain for an in-memory store; it needs
  `CC_COCKPIT_TEST=1` and is ignored when packaged.
  `CC_COCKPIT_NO_BUNDLED=1` skips all bundled plugins (browser, reviewer, editor, files, sessions, usage); it too needs `CC_COCKPIT_TEST=1`
  and is ignored when packaged (`isTestRun`, `main/test-run.ts`, checked in `main/plugins/bundled.ts`). The e2e harness sets
  it, so a spec has no Sessions panel and no top-bar strip unless it launches with `env: { CC_COCKPIT_NO_BUNDLED: '' }`
  (core has no panels of its own: zone specs declare test panels with the `pluginPanels` hook).
- Electron takes one `registerSchemesAsPrivileged` call: `cc-overlay`, `cc-plugin` and `cc-preview`
  are registered together (`overlay-protocol.ts`, `plugin-protocol.ts`, `preview-protocol.ts`). A new scheme goes in that call.
- `<data>/claude-plugins/` is generated (by `main/claude-plugins/`) and rebuilt at start and when the
  plugin set changes; never edit it. Claude tabs get it through `--plugin-dir`; nothing goes to
  `~/.claude`. The guide topics in `src/cli/guide/*.md` are bundled into the CLI and guarded by
  drift tests (`cli-guide.test.ts`, `claude-plugins.test.ts`): a new `ccc` command, `ctx` member or
  skill rule needs its guide text in the same change.
- Send gate (`main/sessions/send-gate.ts`): text is delivered only in *waiting for input* (idle
  is not sendable), as a bracketed paste plus Enter, paste markers stripped, text starting
  with `/`, `!`, `#` or `&` refused, queued while busy, one delivery per `Stop`.
- Plugin services (`ctx.services`, design.md §5 "Plugin services") are host-local: calls and events are dispatched inside the
  plugin host with no round trip to main, resolved on every call (never a cached provider), and carry plain data only
  (`structuredClone` both ways). Main decides the specs and the project's provider picks; `selectProvider` /
  `serviceStatus` in `src/shared/services.ts` are the one rule for host and Plugins page, so use them, never a copy.
- Collected services (`services.collects` + `ctx.services.useAll`, `src/host/services.ts`): every provider of the name
  answers and emits to a collector, the project's pick does not apply, and `serviceStatus` marks a name only collectors use
  `collectedOnly` (no pick row, no problem). A collected name is still in `uses`; `useAll` refuses one not in `collects`.
- App-wide plugin state is owned by main (`ctx.appStorage`, `main/plugins/app-storage.ts`): each window has its own plugin host,
  so a store the hosts wrote themselves would lose updates; main applies calls one at a time (design.md §5 "App-wide plugin
  storage"). A new app-wide plugin store goes through main the same way, never a file a host writes.
- `src/sdk/panel.ts` is built as a classic script with no `require`: a module both it and main/host import becomes a shared
  chunk that `out/sdk/panel.js` loads with `require`, which throws in a page (`electron.vite.config.ts`). So a constant main
  or the host needs (`MAX_OVERLAY_MESSAGE_LENGTH`) lives in its own file (`src/shared/overlay-message.ts`), not in `panel-core.ts`.
- `serviceProviders` in the project record also holds the reserved key `@open-file` (plugin id or `@builtin`; a service name
  never starts with `@`): code that walks the picks as services must skip it (`OPEN_FILE_PICK`, `src/shared/services.ts`).
- `SessionInfo.typed` (`session-registry.ts`) is set from the person's input only (the renderer's terminal `onData` through
  `TabManager.viewInput`, which strips a view's own query replies while web access is on); terminal reports (focus, cursor and size replies) do not count. It is sticky for the tab's life. Main
  enforces it: a plugin `sessions.send` to a typed tab is rejected and that tab's queued plugin texts are dropped, so a plugin
  never has to be trusted to check. `QueuedText.origin` in the send gate (`send-gate.ts`) tells a plugin's text from the
  person's (Discuss), and only plugin-origin texts are dropped.
- A tab's flag (`shared/tab-flag.ts`, design.md §3 "Tab flags") is the person's alone: `TabManager.setFlag` / `toggleFlag`
  are its only writers, reached only from the shell page's `tabs.flag` / `tabs.toggleFlag` (top frame, sender's own tabs);
  the registry mirrors it for `SessionInfo.flag` (summaries get the colour only). Never give host-api or a plugin a way to
  write it, nor read a flag from a hook or plugin payload: a mark a plugin could set would mean nothing.
- Web access (design-web.md, `src/main/web/`, `src/main/views/`, `src/renderer/web/`): a project window has several live views
  (the desktop `webContents`, browser views over one WebSocket each). Every event and port post goes through `ViewRegistry`
  (`toProject`, `toWindow`, `toView`, `toAll`, `postPort`); never `webContents.send`, `webContents.postMessage` or
  `BrowserWindow.getAllWindows()` outside the adapters (`no-direct-webcontents-send.test.ts`). A new channel in
  `src/shared/ipc.ts` needs its `REMOTE_CLASS` (`yes`, `no`, `adapted`) in the same change: classify conservatively, `no` for what
  needs the host's screen or widens a view's own access; an `adapted` handler decides by the caller main bound (`view.remote`),
  never by the payload. `ViewRegistry.toBrowserViews(window | 'all')` is the one way to reach browsers only (a link notice,
  an in-page notice, the chime), never the desktop page or the hidden page.
- The gateway (`main/web/gateway.ts`) listens on loopback by default and runs the Host check, the Origin check (upgrade and every
  state-changing POST) and the secret compare in every mode, None included; a non-loopback bind over http or with no sign-in
  listens only with the confirm recorded by `applyWebAccessPatch`; secrets are hashed (scrypt off-thread) and failures are slowed
  by one global bucket, never locked out and never keyed by peer address (behind a proxy every peer is 127.0.0.1). No regexes in
  the settings or path parsing there. A remote view cannot add or widen access (mode, bind, secrets, hosts, new devices: `no` channels); in server mode it may narrow it
  (revoke, disconnect: `adapted`, by `server && view.remote`, the acting device logged from the view main bound).
- Server mode (`main/server-mode.ts`, design-web.md §9): `server` is the one flag, decided before `ready` by
  `decideServerMode` (platform, env, argv) and passed into `start()` and every service that differs; never re-derive it from
  `DISPLAY`, and never from a payload. Start re-executes the image in place (`process.execve` with the headless switches: same
  pid and stdio, so a unit's main pid is the app); the path is chosen at run time by `typeof process.execve` and
  `accessSync(exe, X_OK)` and the fallback is `spawnSync` plus the `--server-parent` watch, never a `try` / `catch` around
  `execve` (a failed `execve` aborts the process, nothing to catch). Unit tests inject `lock`, `execve`, `spawnSync`. The
  lock-losing re-exec exits with `process.exit(0)`, not `app.quit()` (with no display a quit returns to Electron, which fails
  platform init). `runStartOrder` (`server-start.ts`) awaits the CLI socket and the gateway before any window opens; either
  failing exits 1 after the mirror worker is awaited (exiting while it bootstraps segfaults) and `app.exit(1)` at the end of
  `will-quit` (`process.exitCode` is ignored).
- Server mode secrets: `main/secrets/key-file-store.ts` is one more `SecretStore`, chosen by `selectSecretStore` from `server`
  (server mode always the key file with `--password-store=basic`, the desktop always the keychain, never by keychain state).
  `<data>/secret.key` is made `O_EXCL` 0600, read `O_NOFOLLOW` and checked by `fstat` on that descriptor, never made again over
  an existing file; values are `KEYFILE-V1:` AES-256-GCM, and each store refuses the other's values with its own text
  (`storedValueState`: readable, other-mode, replaced), so a view never shows "set" for a value it cannot read.
- `ccc web` writes are shell-only: `HOST_ONLY_COMMANDS` (`shared/protocol.ts`) are refused for any caller with a token before
  lookup, and `SocketServer.handle` throws for a `web.*` name not on the list (a registered handler cannot skip it); each
  handler refuses non-anonymous callers again and the writes refuse outside server mode. Not a boundary (a tab's process is the
  same OS user); it keeps a prompt-injected Claude from reconfiguring access. `web` is in `CORE_CLI_COMMANDS`.
- Approvals in server mode are the browsers': `SharedAsks` (`main/asks/shared-asks.ts`) is the one core of `LinkAsks` and
  `TrashAsks` (first answer wins, replayed in `ready`, timeout denies), and an Allow counts from a view when
  `!view.remote || server`, decided by main. The page is `ApprovalDialog`: no default Allow, Enter and Space blocked inside, no
  focus taken from a terminal, Allow armed after about a second of visibility (`ApprovalArm`); a backdrop click answers nothing.
  Close project, device revoke and disconnect, `oauth.paste` and notice clicks use `adapted` channels the same way. A new
  approval a browser may give needs an `ApprovalDialog`, never a plain `confirm`.
- The hidden page (the project's `BrowserWindow` in server mode, never shown): `WindowManager {server}` never calls `focus`,
  `show`, `hide` or `showPicker`, never writes bounds, and reloads a crashed or failed page with a backoff (never closes the
  window); `ViewSizes` never measures it, so a tab keeps the last browser's size and a new unsized one gets 120x40; an overlay
  with no origin view is held by a browser, never by it. A new window or layout call must keep these under `server`.
- Core notices in server mode (`notifications/core-notices.ts`, in-page `PageNoticeBackend` for plugins): a stdout line each, last
  50 kept for `ccc web status`, plain text with no link and no plugin text, never logged with a mail subject.
- Web e2e specs drive Electron's own Chromium as the "plain browser" (`test/fixtures/web-browser/main.cjs`, helpers in
  `test/e2e/web-fixtures.ts`: `enableWebAccess` on a random loopback port, retried on `failed`, and `openBrowser`); a spec that
  needs plugin panels launches with `env: { CC_COCKPIT_NO_BUNDLED: '' }`. Server-mode specs use `launchServer`
  (`test/e2e/server-fixtures.ts`: the headless switches passed directly, no display, no session bus, `ccc` run from the data
  dir's wrapper); they never go through the re-exec, which only `scripts/server-mode-smoke.mjs` covers.
- With web access on, a headless terminal mirror worker (`main/terminals/mirror-worker.ts`; `view-terminals.ts` for browser views) owns pty flow control and answers the
  program's terminal queries; views get numbered chunks and snapshots and resync from them, the desktop included. Do not add a
  second consumer of pty data or a reply path that bypasses the worker. Terminal size has one owner (last typer or "Fit to this
  screen"); a pty-less tab refits in main.
- A plugin host call's *origin view* (`src/host/ctx/origin-view.ts`, `AsyncLocalStorage`, kept until the listener returns, 10 s cap)
  is a hint for focus-like calls only (a wrong view costs a focus on the wrong screen); main's checks never rest on it. Plugins
  keep working unchanged; `ctx.panels.post` takes the optional `{ view }`.
- Plugin pages over HTTP are served by path token (`/p/<token>/`, one per device and plugin, killed on revoke; inline overlays
  under `/o/<token>/`): the token is the only credential, since a sandboxed page's requests carry no cookie. Responses carry the
  rewritten plugin CSP, no redirects, `no-store`. Pages must use relative URLs (the server rewrites only root-absolute `src` and
  `href` in HTML; `ccc plugin link` warns). Link asks (`links.ask`/`answer`/`settled`) are shared by every view and a remote view
  may only Deny.
- `CliCall.tabId` is set by main only when the `ccc` caller is a Claude tab (never from anything the caller sends); a plugin
  command may use it to know which tab ran it (`ccc autopilot stop`) and must answer an unknown and a foreign id the same way.
- Plugin command tabs (`ctx.sessions.openCommand`, design.md §3 "Custom commands"): kind `command` with `argv` and
  `openedBy` instead of a user `command` line; spawned as argv with no shell, never both fields (a saved record with
  both is dropped). `openedBy` is set by main from the host's own plugin, shown in the tab tooltip, and restore drops
  the tab when that plugin is gone or revoked. A plugin substituting untrusted text (a file name) must keep it one
  argv element and never inside a word a shell will parse (cockpit.files `lib/open-with.js`).
- `sessions.open({ model, effort })` is validated in `src/shared/session-options.ts` (one list for host, main and the guide) and
  turned into argv by `claudeArgv`; it is never applied to a resume, which keeps the session's own settings.
- Plugin `ccc` commands and their stdin are always bounded (30 s plugin limit, 40 s client deadline and stdin read, exit 124
  `CLI_TIMEOUT_CODE`): a new wait in `src/cli/client.ts` needs a deadline, never an unbounded await.
- Bundled plugins (`plugins/browser`, `plugins/reviewer`, `plugins/editor`, `plugins/files`, `plugins/sessions`, `plugins/usage`, `BUNDLED_PLUGINS` in `main/plugins/bundled.ts`) use only
  the public plugin API: no privilege for `cockpit.*` beyond being shipped, so a gap goes into the API or the guide, never a
  special case. Ids starting with `cockpit.` are reserved (`isReservedPluginId`): they load only from the bundled root (checked
  at load by realpath) and every install path and the marketplace tools refuse them; templates use `example.hello` and
  `example.plugin`. A bundled plugin can be off app-wide (`disabledBundled`) and is replaced through the picks, with no priority.
  The Claude status view is `cockpit.sessions` (Sessions panel, `sessions-strip` top-bar slot): the renderer draws no session
  list of its own, and a stored `core/sessions` layout key is read as `cockpit.sessions/sessions` (`RENAMED_PANEL_KEYS`,
  `src/shared/layout.ts`).
  `cockpit.usage` (Usage panel, `usage-meter` top-bar slot) reads Claude Code's transcripts itself; one window scans for all
  (a lease and the published aggregate in `ctx.appStorage`, its offsets in `ctx.appDataDir`), the others only read.
- Slots (`src/shared/slots.ts`, design.md §5 "Slots"): a host plugin only *places* a slot (`ctx.panels.slots`), the shell draws
  the provider's page in its own frame with its own `MessagePort` to the provider's backend (`ctx.slots.onOpen`); plugin code
  never runs in another plugin's page. The project's provider is picked under `serviceProviders` key `@slot:<type>` (plugin id
  or `@none`, resolved by `slotStatus` over `selectProvider`); every walk of the picks as services skips `@` keys. App slot
  types (`sessions-strip`) are a constant list; a plugin panel may not place one. Heights, counts and `params` are clamped in
  main, never trusted from the host.
- Overlay buttons (`src/shared/overlay-buttons.ts`, design.md §4 "Overlay toolbar"): the opener's buttons and the by-type buttons
  other plugins add (`ctx.overlay.buttons`) live in the plugin host's registry; main asks the window's host, shows only what
  it got and accepts a click only for a button it currently shows, from that window's host. A click never reaches the page, and
  the overlay `type` is untrusted data from the opener. Discuss with Claude is core's (`main/overlays/discuss.ts`): main asks
  the opener's `onDiscuss`, re-checks the target tab and sends through the send gate; the text always starts with `About:`.
- Settings overrides (design.md §6): a plugin's project fields have a global value (`app.json` › `pluginProjectDefaults[id]`,
  secret `setting:projectDefault:<field>`) and a project override (the project record, secret
  `setting:project:<projectId>:<field>`); "use global" is the key absent, effective = override, global, schema default, and a
  save is checked against every open project's merged values. `app` fields are never overridden.
- Plugin settings schemas may not use regexes (ReDoS in main). `"format": "secret"` goes only on a
  top-level string property, with no `default` and no keyword but type/format/title/description/
  `$comment`, and a schema with one has no `$ref`/`$anchor`/`$id` or other reference keyword
  (design.md §6 "Secret settings field"; enforced in `main/plugins/validate.ts`).

## Conventions

- TypeScript throughout; React for the shell UI.
- Dense explanatory comments: say why, name the edge case or the incident behind a check.
- Exec is argv-only, never through a shell; untrusted text travels as one argument or on stdin.
- main is the only authority: renderers and plugin hosts ask, main checks which window/host is
  asking. Never trust a project or tab id passed by a plugin.
- A marketplace index is untrusted input: validate and cap it, show its repos as plain text, enforce revocations only from the default index or the one a plugin was installed from.
- Marketplace install and update: main clones the tag, checks `rev-parse HEAD` against the pinned commit in staging, and
  refuses when the repo and commit the UI showed (`expect`) differ from the current entry. See `src/shared/marketplace.ts`,
  `src/main/marketplace/`, `docs/design.md` §5 "Marketplace".
- `marketplace/` is the template of the separate index repo, not app code. Its CI runs the tools from the base commit or
  main, never from a PR branch, and auto-merge fails closed: a revoked commit, a `repo` change or duplicate head commits go
  to a human.
- Never type into a Claude session unless its status is *waiting for input*; a keystroke could
  answer a permission prompt.
- The CLI must never fail a Claude hook: when the app is not running it exits 0 silently.
- Tests use temp dirs and fakes (a fake `claude` script); nothing touches the real app data dir
  or `~/.claude`.
- Do not edit the `[model: x]` tags or `External review:` line in plan files.
