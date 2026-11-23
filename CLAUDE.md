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
design in `docs/design-web.md`, plan in `docs/plans/completed/20261110-web-access.md`, user docs in `docs/features.md` ("Web access").
Server mode (Linux, no display, browsers only: `--server`, the key file, `ccc web`, approvals in the browser) is implemented
on top of it; design in `docs/design-web.md` §9, plan in `docs/plans/completed/20261111-server-mode.md`, user docs in `docs/features.md`
("Server mode"). Only the unpacked build was run; the AppImage, the deb on a real server and the systemd unit were not.
Server mode on macOS (a LaunchAgent starts `--server` in the person's login session: no re-exec, windows never shown, no Dock
icon, held awake, off the keychain, a reopen notice; the plist is documented in `docs/features.md`, not a `ccc web` command) is
implemented; design in `docs/design-web.md` §9.1 and §9.15, plan in `docs/plans/20261119-server-mode-mac.md`. Run from the repo's
Electron only: a packaged Mac, the LaunchAgent, Gatekeeper's first open, App Nap and a sleeping display were not.
Streamed web views (server mode: the Browser and every webview panel rendered off-screen on the server and streamed to
browsers over the view's WebSocket, one port) are implemented; design in `docs/design-web-browser.md`, plan in
`docs/plans/completed/20261111-streamed-webviews.md`, user docs in `docs/features.md` ("Server mode" › "The Browser panel").
Remote servers (the desktop picker connects to a server-mode cockpit over built-in SSH, My own tunnel or a Direct link and
opens its projects in sandboxed desktop windows running the server's web client) are implemented; design in
`docs/design-remote-desktop.md` (revision 2), plans in `docs/plans/completed/20261112-remote-desktop.md` and
`docs/plans/completed/20261112-remote-ssh-builtin.md`, user docs in `docs/features.md` ("Remote servers").

The code editor (`cockpit.editor` rewritten as a main coding editor: page tabs, CodeMirror 6, language servers, merge with
Claude's writes, Ask Claude, quick chat, `ccc edit`, `ctx.processes`) is implemented; design in `docs/design-editor.md`, plan in
`docs/plans/completed/20261112-code-editor.md`, user docs in `docs/features.md` (the editor entry under the bundled plugins).
Its language servers were only run against fakes.

Split groups (tabs side by side, tmux-like: `shared/tab-groups.ts`, main's `TabGroups`, the `groups.*` channels)
are implemented; design in `docs/design.md` §3 "Split groups", user docs in `docs/features.md` ("Split view"). Page tabs
are panes too (a file beside Claude); design in `docs/design-split-pages.md`.

Downloads to the person's device (Files menu Download and `ccc download`, a file or a folder as a streamed `.zip`, to a browser view
or the desktop's remote window: `main/files/downloads.ts`, `zip-writer.ts`, the gateway's `/d/<token>`, `main/remote/remote-downloads.ts`)
are implemented; design in `docs/design-download.md`, plan in `docs/plans/completed/20261114-download.md`, user docs in
`docs/features.md` ("Web access" › "Downloads", "Remote servers" › "Downloads"). Not run on a packaged Mac, iOS Safari or Firefox
(the plan's Post-Completion list).

Rooms (messages and shared docs between Claude tabs, plus the per-plugin caps the person sets) are implemented; design in
`docs/design-rooms.md`, plan in `docs/plans/completed/20261114-rooms.md`, user docs in `docs/features.md` ("Rooms").

Guests (the owner invites a person into one project, read-only or write, from a browser or the guest's own app through
Remote servers' Direct window; plugins hidden from guests unless shown) are implemented; design in `docs/design-guests.md`
(decisions D-1 to D-35 in its §17), summary in `docs/design-web.md` §10, user docs in `docs/features.md` ("Web access" ›
"Guests"). The D-29 certificate pin runs in real Electron in `guest-direct.spec.ts` against a self-signed loopback host
only (never a host on another machine); the server-mode guest e2e spec (`guest-server.spec.ts`, through `launchServer`)
passes on macOS (2026-11-19) and has not run on Linux.

Overlays in every view (html overlays of plugins that declare `overlays.perView` load one live copy per view: the owner's
desktop and browsers and allowed guests; provenance `via` keeps what a hidden plugin opened away from guests;
`ctx.openExternal(url, { view })`; the bundled Reviewer with replayable state and notes shared across screens) are
implemented; design in `docs/design-overlay-views.md` (D-1 to D-4), plan in `docs/plans/completed/20261120-overlay-views.md`,
user docs in `docs/features.md` ("Web access" › "Guests", the Reviewer entry). Three external review passes (sol/high);
the guest e2e (`guest-overlay-views.spec.ts`) has run on macOS only.

Uploads from the person's device (Files' Upload here and drops, a drop or paste of files onto a Claude or shell tab with the
paths pasted into the prompt; owner and write guests, browser views and the desktop's remote window: `main/files/uploads.ts`,
`upload-writer.ts`, the gateway's `/u/<token>`, `renderer/web/upload-*.ts`, `ccPanel.upload`) are implemented; design in
`docs/design-upload.md` (§13 "As built"), plan in `docs/plans/20261122-upload.md`, user docs in `docs/features.md`
("Web access" › "Uploads", "Remote servers" › "Uploads"). Run: unit tests (Node, vitest), e2e in Electron's Chromium on macOS only (browser views, guests, server mode through darwin's
`--server` start, never Linux; the remote window one case, Upload here over Direct, no drop or tab paste) and the bench's 1 GiB phase
through the real writer; Firefox and WebKit ran only the spike harness, never the app. Not run: the app on Firefox, Safari and iOS, a real
Finder drop, a packaged Mac's remote window (native chooser, SSH tunnel, My own tunnel), Claude Code attaching an image from
the pasted path, clipboard cases (Excel, Word, Copy image), a 1 GiB upload over the internet (the plan's Post-Completion list).

## Commands

- `npm test` (vitest), `npm run test:coverage`; `npm run test:e2e` (builds, then Playwright). The OAuth spec and the
  gateway's TLS unit tests (`web-gateway.test.ts`) need `openssl` on PATH.
- `npm run typecheck`, `npm run lint`.
- `npm run build` (runs `build:hello`, `build:browser`, `build:reviewer` and `build:editor` first), `npm run build:hello` (rebuild after editing
  `plugins/hello`; the dist is committed), `npm run build:reviewer` (bundles the overlay page of `plugins/reviewer` into the committed `overlay/review.bundle.js`; the reviewer, editor, files and sessions hosts are plain JS, with no build), `npm run build:editor` (bundles the editor's page
  sources, plain JS in `plugins/editor/src/page` and eslint-ignored, into the committed `dist/pages/file.bundle.js`;
  also emits `dist/lib/outside-paths.js` from `src/shared/outside-paths.ts`; deterministic, a unit test rebuilds and compares the bytes of both), `npm run test:plugins` (`node:test` suites of `plugins/*/test`; CI runs it), `npm run build:browser` (same for `plugins/browser`; its
  `dist/host.js` is committed and shipped through extraResources), `npm run build:example` (same for `examples/plugin`, the
  master copy of the public repo `BronOS/cc-cockpit-plugin-example`; a change here, or to `src/sdk/types.ts`, must also be
  pushed there; `build:example` only bundles `src/host.ts`, so copy the types by hand: `cp src/sdk/types.ts examples/plugin/sdk/types.ts`; the example is listed, so it stays free of exec, sessions, overlays, rooms and secrets; its copy of `types.ts` carries `ctx.rooms`, which the example host must not use, and the public repo needs the push before a release), `npm run build:marketplace-tools` (rebuild after
  editing `marketplace/tools/src` or the `src/shared` files it imports, `git-source.ts`, `marketplace.ts` and
  `root-absolute-urls.ts` above all;
  `marketplace/tools/dist` is committed because the index repo's CI runs it with plain node and no install, and a unit
  test compares the bytes), `npm run package` (unsigned mac build),
  `npm run package:dir` (unpacked app in `release/`, for a smoke launch).
- `node scripts/server-mode-smoke.mjs [executable]`: server mode's start end to end (no display, no switches, pid kept,
  `ccc web`, SIGTERM, nothing left; the fallback and a taken port too); with no argument it runs `out/` (build first), with
  a packaged executable it ignores the test env and needs no network. Run it after changing `main/server-mode.ts`,
  `server-start.ts` or the start in `main/index.ts`: the re-exec drops Playwright's inspector, so no e2e covers it.
- `node scripts/ssh2-electron-check.mjs [executable]`: the built `out/main/ssh-client.js` (ssh2 bundled in, native parts
  stubbed) under Electron's BoringSSL, which has no chacha20, so a vitest run under Node proves nothing about the ciphers:
  a handshake, an exec and a `forwardOut` against an in-process ssh2 server; with no argument it runs `out/` as this repo's
  Electron main (build first, headless on Linux), with a packaged executable it runs that as Node (`ELECTRON_RUN_AS_NODE`);
  exits 1 on failure. Run it after changing `ssh-client.ts`, the ssh2 version or the bundling in `electron.vite.config.ts`.
- `node --expose-gc scripts/web-terminal-bench.mjs [tabs] [seconds] [p99ms]`: the headless terminals' cost to main's event
  loop, plus a streamed animated off-screen page (1280x800, then 1920x1080) through the real `FrameStream`, a 1 GiB zip through the real zip writer, and a 1 GiB upload through the real upload writer; it re-runs itself
  as Electron's main (headless on Linux, no `npm run build` needed) and exits 1 when a phase's p99 is over the limit (parsing
  back on main, or encoding frames stalling it). Run it after changing `main/terminals/mirror.ts`, `mirror-worker.ts`,
  `main/webview/frame-stream.ts` or `main/files/zip-writer.ts` / `downloads.ts` or `main/files/upload-writer.ts`.

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
  notice, never to the server's own browser) and `powerSaveBlocker` only in `main/power/electron-power.ts` (behind
  `PowerHolds`, `main/power/power-holds.ts`: one blocker per hold, so keep-awake and a server's whole-run hold never
  release each other's; logic in `keep-awake.ts`, fake `test/fakes/fake-power-backend.ts`; on Linux each hold also spawns its
  own `systemd-inhibit ... --mode=block cat`, only in `main/power/logind-inhibit.ts`, grep test `no-direct-systemd-inhibit.test.ts`),
  each with a grep test
  (`no-direct-dialog.test.ts`, `no-direct-open-external.test.ts`, `no-direct-power-save-blocker.test.ts`); `safeStorage` is imported only by
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
  It has its own IIFE build (`panelSdk`, run when the main build closes; bundling ssh2 put rolldown's runtime in a shared
  chunk), and that build fails if `panel.js` has an import or a `require(`.
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
  `DISPLAY`, and never from a payload. On Linux start re-executes the image in place (`process.execve` with the headless
  switches: same pid and stdio, so a unit's main pid is the app); the re-exec, the `--server-parent` watch and the Ozone
  switch are Linux-only: on darwin only `--server` starts a server (never detected), with no re-exec, and `refuseWhenHeld`
  makes a `--server` launch that loses the lock print `HELD_LINE` and `process.exit(1)` (desktop and server run one at a
  time on a Mac; a desktop primary ignores a darwin server launch, `SecondInstanceData.serverLaunch`; win32 refuses). What a
  darwin server needs from main is `server-platform.ts`'s row (`serverPlatform(platform, server)`, pure, effects injected):
  before `ready` the accessory policy, `disableHardwareAcceleration()` and `use-mock-keychain`, after it one
  `powerHolds.hold('server-mode')` for the run (never a direct `powerSaveBlocker`: `PowerHolds` keeps it apart from
  keep-awake's holds); the desktop and a Linux server get an empty row. The launchd plist is docs, never a `ccc` command (an
  install would be a CLI-local command outside `HOST_ONLY_COMMANDS`); `mac:` in `electron-builder.yml` never gets `extendInfo`,
  `LSUIElement` or `LSBackgroundOnly` (they would hide the desktop's Dock icon; `packaging-config.test.ts`). The path is chosen at run time by `typeof process.execve` and
  `accessSync(exe, X_OK)` and the fallback is `spawnSync` plus the `--server-parent` watch, never a `try` / `catch` around
  `execve` (a failed `execve` aborts the process, nothing to catch). Unit tests inject `lock`, `execve`, `spawnSync`. The
  lock-losing re-exec exits with `process.exit(0)`, not `app.quit()` (with no display a quit returns to Electron, which fails
  platform init). `runStartOrder` (`server-start.ts`) awaits the CLI socket and the gateway before any window opens; either
  failing exits 1 after the mirror worker is awaited (exiting while it bootstraps segfaults) and `app.exit(1)` at the end of
  `will-quit` (`process.exitCode` is ignored).
- Server mode secrets: `main/secrets/key-file-store.ts` is one more `SecretStore`, chosen by `selectSecretStore` from `server`
  (server mode always the key file, the desktop always the keychain, never by keychain state). Chromium's own store is kept off
  the keychain too: `--password-store=basic` is Linux-only (the re-exec's argv), and on darwin main appends `use-mock-keychain`
  before `ready` (`server-platform.ts`); the keychain would prompt with nobody at the screen and the ad-hoc signature resets its
  ACL on every update. Whether Electron honours it is unverified (the owner's check on the packaged app).
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
- The hidden page (the project's `BrowserWindow` in server mode, never shown, on macOS as on Linux: `createWindow` forces `show:
  false` and `backgroundThrottling: false` under `server`, after the caller's options): `WindowManager {server}` never calls `focus`,
  `show`, `hide` or `showPicker`, never writes bounds, and reloads a crashed or failed page with a backoff (never closes the
  window); `ViewSizes` never measures it, so a tab keeps the last browser's size and a new unsized one gets 120x40; an overlay
  with no origin view is held by a browser, never by it. A new window or layout call must keep these under `server`.
- The one dialog a server may show (`reopen-notice.ts`): `serverDialogs` stays on macOS (nobody is at the screen), except the
  reopen notice, reached only from `activate` (macOS server only), through `electronDialogs()` (the adapter, never `dialog`
  directly), one box at a time, `app.focus({ steal: true })` first. LaunchServices turns the reopened process into a Dock app, so the
  accessory policy is re-applied once the box is answered (before a Stop quits) and when an `activate` comes while one is up;
  a test run answers from `SECOND_LAUNCH_ANSWER_ENV`. A new box a server may show needs the same case made, never a call
  from elsewhere.
- Core notices in server mode (`notifications/core-notices.ts`, in-page `PageNoticeBackend` for plugins): a stdout line each, last
  50 kept for `ccc web status`, plain text with no link and no plugin text, never logged with a mail subject.
- Web e2e specs drive Electron's own Chromium as the "plain browser" (`test/fixtures/web-browser/main.cjs`, helpers in
  `test/e2e/web-fixtures.ts`: `enableWebAccess` on a random loopback port, retried on `failed`, and `openBrowser`); a spec that
  needs plugin panels launches with `env: { CC_COCKPIT_NO_BUNDLED: '' }`. Server-mode specs use `launchServer`
  (`test/e2e/server-fixtures.ts`: on Linux the headless switches passed directly, no display, no session bus; on darwin `--server`
  alone, the LaunchAgent's real start, so the e2e covers that start path there; `ccc` run from the data dir's wrapper;
  `expectMainAlive` also asserts no visible `BrowserWindow` and, on darwin, no Dock icon); they never go through the Linux re-exec,
  which only `scripts/server-mode-smoke.mjs` covers.
- With web access on, a headless terminal mirror worker (`main/terminals/mirror-worker.ts`; `view-terminals.ts` for browser views) owns pty flow control and answers the
  program's terminal queries; views get numbered chunks and snapshots and resync from them, the desktop included. Do not add a
  second consumer of pty data or a reply path that bypasses the worker. Terminal size has one owner (last typer or "Fit to this
  screen"); only a person's gesture in a view takes it (a window regaining focus or a page shown again takes nothing until
  the first press or key there), and an automatic fallback (sizer hidden or dropped) goes back to that view or its device's
  reconnect unless someone took the size meanwhile (`view-sizes.ts` `departed`, `RECONNECT_GRACE_MS`); a pty-less tab refits
  in main.
- A plugin host call's *origin view* (`src/host/ctx/origin-view.ts`, `AsyncLocalStorage`, kept until the listener returns, 10 s cap)
  is a hint for focus-like calls only (a wrong view costs a focus on the wrong screen); main's checks never rest on it. Plugins
  keep working unchanged; `ctx.panels.post` takes the optional `{ view }`.
- Streamed webviews (design-web-browser.md, `main/webview/`): in server mode `WebviewManager` keeps every decision and only its
  factory differs: `OffscreenWebviewFactory` (`electron-offscreen-webview.ts`), chosen by `server` once at start, never by a
  payload. Any off-screen page needs `disableDialogs: true` (one `alert` aborts main under Ozone headless) and the shared hardening's
  cancels (`webview-hardening.ts`: print locked to a no-op, file choosers and pickers cancelled through the page's DevTools
  protocol, `login` cancel, `certificate-error` reject); a new native UI a page can raise gets its cancel there and a "main
  survives" test. Binary frames (JPEG, `PROTOCOL_VERSION` 2) go server to browser only, through `ViewSink.sendFrame`, which only
  browser sinks have (desktop and hidden-page sinks cannot); the gateway still closes a client that sends binary. Frames, cursor,
  selection and select popups go only to the webview's viewers (`WebviewViewers`: a remote view that shows the panel and is not
  hidden), selection and select only to the acting view. `webviews.input`, `insertText` and `selectChoose` are `adapted`: accepted
  only when `server && view.remote`, from a current viewer, the panel key resolved through the caller's layout, never trusted
  from the payload. Clipboard chords (Ctrl/Cmd+C, X, V, Shift+Insert) are never forwarded to the page; scripts run in the page
  use the isolated world `WEBVIEW_WORLD_ID` (1717), never the main world, and a cross-site frame's scripts an isolated world
  `Page.createIsolatedWorld` makes on the frame's own session, bracketed by the frame's `loaderId`. Input goes on the page's DevTools protocol through
  its `PageInputRouter` (`page-input.ts`, one queue per page): keys, text and edit commands on the page's session, pointer
  events on the session of the deepest cross-site frame under the point (the hardening's auto-attached child sessions, never
  a second debugger), `sendInputEvent` only once the protocol detached; a frame's refusal falls back to the page's session,
  never to another frame. Run `node scripts/offscreen-input-check.mjs` after changing it, `webview-input.ts` or the key table.
- Streamed-page input (`main/webview/page-input.ts`, design-web-browser.md §4.1): `PageInputRouter` sends each pointer event
  to the deepest cross-site frame's DevTools session and keys and text on the page's, through one sink that checks the epoch
  and the session synchronously; press records are the only press state; every external await (commands, hit-test queries,
  detached sends, calls) has a deadline and counts as outstanding on its road, and the renderer going is a full reset. Its
  contract is checked by the seeded fuzz `test/unit/page-input.fuzz.test.ts` (`FUZZ_SEEDS=n`; never relax a check inside a
  fix commit) and in real Electron by `scripts/offscreen-input-check.mjs` (run it on macOS and Linux after a change there).
  Input held in `webview-input.ts` carries the epoch it arrived under. A frame budget (`frame-budget.ts`) lowers animating
  pages' frame rates together past 250 Mpx/s (floor 5 fps; bench phase 8).
- Hung streamed pages (`main/webview/hung-navigation.ts`, pure): main's own reload, load, back or forward of an off-screen
  page that has not ended in 3 s while the page answers no probe gets its renderer SIGKILLed and is retried once it is gone,
  unless a newer navigation started; the pid is read and the kill sent only in `main/webview/renderer-kill.ts` (grep test
  `no-direct-renderer-kill.test.ts`), re-read in the same step, never `forcefullyCrashRenderer` (a core-dumping Linux host
  holds that crash about 40 s); that kill's `render-process-gone` is not the manager's `gone`.
- Remote servers (design-remote-desktop.md, `main/remote/`): a remote window is a browser tab, never a project window: no
  preload, sandboxed, partition `persist:remote-<id>` (only `electron-remote-window.ts` makes one; grep test), the webview
  hardening plus a loopback-request block, and `WindowManager` only counts it (`remoteWindowCount`). The device cookie lives
  encrypted in the server's `app.json` record and is kept in the jar as a session cookie only (`remote-cookie.ts`), never
  on disk. `ssh2` is imported only in `main/remote/ssh-client.ts` (grep test; a devDependency bundled into main, its native
  parts stubbed, checked in Electron by `scripts/ssh2-electron-check.mjs`) and nothing in `main/remote` imports
  `child_process` (grep test): the system `ssh` is never spawned. The remote command is `remoteCommand` (every word
  single-quoted, `'`, `\`, `!` and control characters refused). The app owns the loopback listener of a built-in SSH tunnel
  (no other local process can hold the port that gets the cookie); My own tunnel cannot verify what listens on its port, which
  the docs say. Nothing from a connect's answers (host key, secret, new record) is saved before the window opens. A changed
  host key is never a question (refused, fixed only by Edit › Forget the trusted host key). Secrets (password, passphrase,
  cookie) sit beside the cookie in the record, never in `via`, and never in `remote.list`, a log or an event.
  For a My own tunnel server, every request main makes with the device cookie (title lookup, open check and reopen, machine
  poll) goes through `RemoteWindows.cleared`: only after the window's current load passed the probe, or a fresh probe passes.
  The wrong `ccc` on a machine running both a desktop cockpit and a server is named by `isWrongCcc` (remote-status.ts),
  matched on the CLI's and main's exact texts.
  `remote.*` channels are `no` and answer the local picker only. Machine chips in the sessions strip (design §4.1) carry
  counts only (`GET /api/sessions`, polled by `main/remote/machine-status.ts`) under opaque per-run ids minted by main, never
  the saved server id; "This computer" is a navigation (`?cc-desktop=local`) main cancels, reading nothing else from the URL.
- Plugin pages over HTTP are served by path token (`/p/<token>/`, one per device and plugin, killed on revoke; inline overlays
  under `/o/<token>/`): the token is the only credential, since a sandboxed page's requests carry no cookie. Responses carry the
  rewritten plugin CSP, no redirects, `no-store`. Pages must use relative URLs (the server rewrites only root-absolute `src` and
  `href` in HTML; `ccc plugin link` warns). Link asks (`links.ask`/`answer`/`settled`) are shared by every view and a remote view
  may only Deny.
- `CliCall.tabId` is set by main only when the `ccc` caller is a Claude tab (never from anything the caller sends); a plugin
  command may use it to know which tab ran it (`ccc autopilot stop`) and must answer an unknown and a foreign id the same way.
- Page tabs (`TabKind` `page`, design.md §4 "Page tabs", design-editor §1): the frames sit outside the React root (a remount keeps
  them), mount on first select, an LRU of 6 stays mounted, never in server mode's hidden page. A host restart or a web
  reconnect hands the frame a new port without a reload (the page re-sends its buffers). In the web relay (`port-relay.ts`) a page-tab port is
  never closed: past its own high water (64 MiB) it is paused and resynced, and a single message too large for a frame
  is dropped alone, logged once per port (pausing for it looped: the page re-sent the same message until the connect cap
  cut the tab off). Dirty is per (tab, view), kept by main from the page's report; closing a tab dirty in any
  view asks in core's dialog (`ApprovalDialog` in server mode) and the page cannot block it. Page keys: the app table and
  `keyOverrides` win, a manifest's declared chords go to the page while it has focus. The unseen dot (`ccc edit`) is core's,
  never a flag. A page tab is never typed into: no send gate, `typed` or Claude status; Discuss asks the page's `onDiscuss`.
  It can be a split pane (see Split groups): `SplitArea` draws its header and an empty body, and `PageTabArea` places one frame
  per shown page pane over the bodies (`frameBoxes`; placing never reloads). A frame takes the keys only with shell-side
  evidence (its own focus or the pointer seen near it, never a page's hint alone), and a chord or Ask Claude from a frame
  carries that frame's tab id, never `activeId`.
- Downloads (design-download.md, `main/files/downloads.ts`): the outside-file rule is one source, `src/shared/outside-paths.ts`,
  that main imports and `build:editor` emits into the editor host (`dist/lib/outside-paths.js`); core to plugin, never back, so a
  plugin edit cannot widen what main hands out. `/d/<token>` (gateway, after the Host check, before the cookie-and-key check):
  one-use, 60 s, 32 random bytes in main's memory, bound to device, view, window and path, cookie-bound (None mode: the token
  alone); every refusal is a 204 with no body plus `downloads.failed` to the token's view; the token is consumed in the same
  synchronous step as the 200 head; revoke, disconnect, leaving None mode and gateway stop drop live streams. Never a token for
  the desktop page or the hidden page. `ccc download` offers go through `SharedAsks` with `hold` (a browser joining later finds
  them in `ready.downloadOffers`); `downloads.accept` is `adapted` (a remote view of the offer's window, taken from the
  connection) and the accept runs the Files path; the `ccc` call waits at most 30 s (`DOWNLOAD_REPLY_TIMEOUT_MS`) for main. The
  Files menu always shows both zip items on a folder (the page cannot know whether `.git` or `node_modules` would be left out).
  The remote window's `will-download` is the desktop's own gate set (`remote-windows.ts`; the save in `remote-downloads.ts`): own
  server's `/d/` origin only, a click within 5 s, one at a time and 3 per 10 s per server, 4 GiB cap, sanitised name, a hidden
  `.cc-download-*` temp then an exclusive `fs.link` (never overwrite or follow), never opened. Its `setSavePath` must be called
  inside the event (else Electron shows a dialog), and nothing there may call `dialog`.
- Uploads (design-upload.md, `main/files/uploads.ts`, `upload-writer.ts`): `/u/<token>` is the one route that takes a PUT, admitted
  before the guest 404 block and behind the full cookie-and-key check (`/d/` skips the device key; in None mode both are the token alone); a token is per file and
  multi-use (chunks at `offset`), minted by `uploads.begin` / `resolve` for the device and bound to it, one idle clock (60 s of
  body bytes) per upload, chunks sized to finish inside the 30 s request bound (`connectionsCheckingInterval` 5 s, a cut is a
  408). Answers are JSON with real statuses; a guest not entitled gets the guest block's 404 byte for byte. Teardowns are
  revoke, disconnect, leaving None mode, gateway stop, window close, every narrowing of a guest (`dropTransfersOf`; a widening's reconnect leaves it running); each
  deletes its temp (a cancel or the idle clock of an upload with a settled file finishes it instead, so its paths still
  paste). While the writer holds a chunk the socket's idle timeout is ignored (a no-hard-link commit copies with nothing
  on the socket). The writer writes `.cc-upload-<hex>` beside the target, then commits by exclusive `link` (`rename` only
  for Replace; no-hard-link volumes use `copyExclusive`), and records each temp with its project root in
  `<data>/uploads/temps.json` before creating it; the start sweep deletes only what that record names and still lies in its
  root. Names are checked in main (`HIDDEN_TEXT`, `.git` refused); never trust a name, size or folder from the page.
  Deletes are checked against the written file's identity (`removeIfOwn`, its `fstat`), but check and `unlink` are two
  syscalls: an entry renamed over the name in between is deleted. Accepted (design-upload.md §13 "Name-based deletes"):
  the names are random hidden temps or ones this call just made exclusively, deleted on a cancel or a failure, and only
  a same-user process aiming at that name in that gap wins, which could delete the file itself; an aside rename does not
  close it. A committed temp is never truncated (a hard link's temp is the placed file); only an abort's `discard` truncates.
- `ccPanel.upload` (`src/sdk/panel*.ts`) posts `cc-plugin.upload` to the parent only, and the shell accepts it from a mounted
  panel frame alone (`PluginFrame`, checked against `event.source`; overlays, slots and page tabs never), then names the panel
  key in `uploads.begin`, which main resolves against the layout. A file is read only in the page (the `File` goes to
  `fetch` PUT as `slice`, never XHR: an XHR PUT of a whole `File` failed in the spike; slices because the chunk size adapts).
- The terminal paste after an upload (`uploads.paste`): main checks and writes in one synchronous step (`Uploads.paste` calls
  `facts.input`): the text goes in as the calling view's own `tabs.input` (the owner's or the write guest's handler, after
  `IpcRouter.writesTabNow`, so the tab is `typed`), wrapped for bracketed paste when the page says its terminal is in that
  mode; the shell types nothing (typing main's answer itself left a round trip in which Claude could reach a permission
  dialog). Main allows the automatic one only for a shown, live tab at `waiting` (a shell tab needs no status), once per
  upload; otherwise it is held and the person's Paste path click is the retry. Never an `await` between the check and the
  write (the router's `paste` dep is synchronous). A path with a control, bidi or invisible character is never pasted. The five `uploads.*` invoke channels are all `adapted` (served only to `view.remote`) with `GUEST_CLASS` `write`; there
  is no upload event channel.
- `ctx.processes` (host-local, design.md §4 "Processes"): argv only, bytes not text, 16 live children per plugin, process
  groups SIGKILLed on `kill`, when the leader exits, on plugin dispose and on host stop; not a capability (the host could `ctx.exec` anyway), so the cap and the kill are the control.
- Editor host rules (`plugins/editor`): saves are compare-and-swap against what was last read, so a write Claude made
  meanwhile is merged or conflicted, never overwritten; the host is the only LSP client (it owns `initialize`, the config,
  URI checks and the method allow-list; a page never sends LSP and never names a binary); quick chat's argv is fixed
  (`claude -p --restricted --safe-mode --strict-mcp-config --tools Read,Grep,Glob --permission-prompts none` plus
  stream-json in and out, `--verbose`, `--include-partial-messages` and `--model`; `REQUIRED_FLAGS` in
  `dist/lib/quick-chat.js`) and the host refuses to spawn when `claude --help` lacks any of them. The page's model and
  effort pick (`--model`, `--effort`, and `--resume <uuid>` when a pick changes mid-chat) is checked against the host's
  own lists (`checkPick`), never passed through; `--effort` and `--resume` are not required flags, a pick needing a
  missing one is refused. `--safe-mode` is the one
  that keeps the person's plugins, hooks, skills and CLAUDE.md out (`--restricted` alone still ran their hooks) and
  `--permission-prompts none` denies what would ask (a prompt would wait forever); never drop either.
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
- Split groups (design.md §3 "Split groups", `src/shared/tab-groups.ts`, `main/tabs/tab-groups.ts`): main's `TabGroups` is
  the one writer; pages send small intents naming tab ids (`groups.*`, `tabs.create` `beside`, `tabs.reorder` `block`),
  never a tree, and get a whole `groups.changed` snapshot ordered by `seq`. A group's members are contiguous in the one
  tab order; saved leaves name `TabRecord.id` and are remapped on restore. A view's focused pane is its selected tab;
  zoom and focus are per view. Nothing done elsewhere (another view, a plugin, an exit) moves a view's keys to another
  terminal: that view goes keys-off (one exception, decided by main: a pane that exits within 1.5 s of the person's own
  keys in that view hands that view the keys to its last used pane of the group, `ViewSelections.exitFocus`), and while keys-off no command acts on the active tab and a `tabs.select` naming a
  visible pane is ignored. Plugins reach groups only through `beside` on `ctx.sessions.open*` (only the new tab is
  placed, never focused; `no-plugin-group-edits.test.ts`). Every tab kind is a pane: `isPaneKind`
  (`shared/tab-groups.ts`) is the one rule, used by `TabGroups` (`not-a-pane` stays for the next kind, through its `kindOf`
  dep) and the strip; HostApi's `beside` check takes any tab of the window (`hasTab`); `joinOrder` lists terminal members only.
- Rooms (design-rooms.md, `main/rooms/`): pull only. Hooks and the send gate carry the fixed pointer, never room text; text
  enters a session only through its own `ccc room read`, fenced with a per-delivery nonce, and `ccc` acks the read (and a
  Stop block) before main dequeues or counts it as printed. A hook-path function never writes anything else (grep test).
  `ccc hook Stop` acks the block, then prints it, all inside `STOP_HOOK_BUDGET_MS` (2 s, `cli/client.ts`); a connection that
  closes unacked means nothing was printed, so main applies the plain Stop and offers the pointer again (`RoomStop.closedUnacked`,
  `unblocked`). The gate path honours the per-tab Stop cap too (held `why` `capped`), so a loop cannot run through pastes.
- The room mark (`Deliver room messages automatically`) is ON at every join (`TabManager.setRoom`, main's constant, never
  an argument: a deliberate loosening, design-rooms.md §2, so typing in a member tab no longer holds it for good; the
  draft bit still holds the gate paste until the next prompt), then the
  person's alone, like the tab flag: changed only from the shell page (top frame, own tabs), grep-tested, bound to (tab,
  room) (a new membership starts marked again), held by the draft bit; never a host API, hook or `ccc` path. Pause,
  Resume and Remove are the person's too. Membership and the mark live in the tab record; a restart restores the mark as
  saved, members as typed and rooms paused.
- Room identity comes from the caller's tab token or the host's own plugin, never a payload; a plugin acts only on its
  own rooms in its own window and can never pull a tab in (an invite is redeemed by the tab itself). Rooms end with
  their plugin, and room calls are refused while the plugin is off.
- Room tests: the fake `claude` emulates Claude Code's Stop-block cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 8) and scripts a turn
  from env: `FAKE_CLAUDE_ON_PASTE` and `FAKE_CLAUDE_ON_BLOCK` (one scripted line each, `/ccc <args>`, `/sleep <ms>`,
  `/waitfile <path>`, `/later <ms> <line>`), with every `/ccc` run, block and unknown line in `FAKE_CLAUDE_RUN_LOG`; the
  fixture plugins are `test/fixtures/plugins/room*` (`rooms-test` drives the e2e).
- Room docs (`room-docs.ts`): a fixed scheme (`shared/`, `members/<name>/`), refused = missing, `O_NOFOLLOW` + `fstat`, main
  writes only, caps in the docs; the log is capped and `seq`-cursored.
- Per-plugin caps (`shared/plugin-limits.ts`, `main/plugins/plugin-limits.ts`): stored per plugin id in `app.json`, read
  clamped on every call, dropped on uninstall; the write is `plugin.limits.set`, under `HOST_ONLY_FAMILIES`
  (`plugin.limits.`) so it is shell-only like `ccc web`, and not a boundary. `room` is a reserved core command name.
- Guests (design-guests.md): main decides who a caller is from the connection it bound, never from a payload: `who` is
  frozen at `hello` (`'owner'` or `{ guest }`), `ViewRegistry.addRemote(..., who)` takes it with no default and
  `ViewRegistry.whoOf` is the one lookup for code holding a `ViewId` (`views/view-access.ts` `accessOfView`). Rights are
  read live, every call, event, port frame and HTTP route, through `GuestStore.access` (tagged `GuestAccess`; `revoked`
  is nobody, never the owner). "The person" is `isOwner(view)` (router), never `view.remote`: a new `.remote` line in
  `router.ts` or `room-handlers.ts` must check `isOwner(` or join the transport list of `no-remote-authority.test.ts`.
- Every new invoke channel needs its `GUEST_CLASS` row (`shared/guest-class.ts`, `no` / `read` / `write`, a target
  extractor when the request names a tab, panel, frame, plugin, overlay, group or ask) and every new event channel its
  `GUEST_EVENT` row (`main/web/guest-events.ts`, `drop` / `pass` / a filter), in the same change as its `REMOTE_CLASS`.
  Both are full mapped types over the channel unions, so a missing row fails typecheck; default to `no` / `drop`.
  `GUEST_CLASS` only narrows `REMOTE_CLASS`; extractors take `unknown` and fail closed. Guest events are filtered at the
  guest connection's one sink (`WebConnection.event`, D-18); the `ready` snapshot, `paths`, ports and HTTP routes at
  their own points with the pure filters of `shared/guest-filter.ts`. The gateway answers a guest's refusal with 404.
- Guest-visible text never carries a host path or the project record (D-33): `window.info` and `project.updated` are
  `{ id, name, colour }` for guests, asks and offers carry a file name only.
- Fail closed when a guest dep is absent: an unwired router refuses every guest call, an unwired plugin-visibility,
  page-path or access-service check hides or refuses, and a guest view with no store behind it is `revoked`; never a
  default that treats a guest as the owner. Handlers that await before a change re-check the role after the await.
- Guest sockets have their own 10 s ping (`GUEST_HEARTBEAT_MS`, `gateway.ts`); the owner's 30 s beat stays. Every guest
  end (kick, lifetime, revoke, forgotten project) goes through `GuestStore`'s one path: close the views with the code
  first, then tombstone and revoke. Invite tokens are kept only as SHA-256 hashes, live only in the link's fragment, and
  are never logged (`web-access.log` names a guest by its invite name and device id, never the link or the token).
  `GuestStore.onChange` is the one feed of `guests.changed` (sent to every view, dropped by `GUEST_EVENT` for guests): the
  owner's chip and guest list read `guests.list` once and then only that event.
- Plugin guest visibility (design.md §5 "Guests"): hidden by default, bundled included, one resolver
  (`shared/guest-access.ts`) for main and the Plugins page; a plugin learns `access` from main's port tag only; read
  guests of a plugin that is not `guests.aware` get one-way ports (D-17). Bundled plugins adopt it through the public API.
- Overlay copies and `via` (design-overlay-views.md): a plugin that declares `overlays.perView` gets one page per view of an
  html overlay, not a holder. Main's copies map (`main/overlays/overlay-manager.ts`) mints each copy id and binds it to
  the view main bound; every page call for a copy (`ready`, `loaded`, `message`, `result`, `release`) carries it and is
  accepted only from that view while the copy is live (a replaced copy's traffic is dropped), and the router branches on
  `OverlayManager.isPerView`, never on a payload's `copy`. Owner views always get a copy (never server mode's hidden page:
  the shell checks `window.info.hiddenPage` too); a guest is admitted by `mayConnectCopy` (`main/web/guest-wiring.ts`,
  `mayConnectCopyOf` over `overlayVisibleOf`), read live on every connect, message and growth, and a read guest of a
  plugin that is not `guests.aware` gets a one-way copy. `origin.via` (every plugin an overlay was opened or filled for)
  only grows, from main's own bound caller chain, `handle.addSources` and `requestedBy`, and only narrows: a guest sees
  the overlay only when the opener and every `via` plugin are visible to it, and a growth releases that guest's copies
  before the triggering post is delivered; an unreadable source fails closed. Release and hide are separate:
  `overlays.release { copy }` only lets go (unmount, reload; every caller), `overlays.release { hide: true }` is a read
  guest's ✕ (recorded per guest id, `PerViewState.hiddenFrom`, for the overlay's life, refused for the owner and a write
  guest, who `overlays.close` for everyone). A plugin's `from` (`{ view, access, person? }`) is filled by main and parsed
  in one place (`host/ctx/views.ts` `viewFromOf`); an author such as a note's comes from `from.person`, never the page.
  Guest rows: `overlays.ready`, `.loaded`, `.message`, `.release` are `read` with the overlay target and refuse a
  non-`perView` overlay, `.close`, `.result` stay `write`, `.take` `no`; the events `overlays.message`, `.hide`,
  `.reload` reach a guest for its own copies only (`ownCopyEvent`, `guest-events.ts`).
- Guest e2e (`test/e2e/guest-fixtures.ts`): a spec makes a guest with `__ccTest.guestInvite` (the invite dialog's own
  service, `GuestStore.invite`; only a hand-test spec drives the dialog), redeems it as the page does and holds a raw socket
  that records frames, the close code and its time ("no further frame" and "within 1 s" need a client that does not
  reconnect). A guessed URL is asserted equal to the answer for something that does not exist, never only its status.

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
