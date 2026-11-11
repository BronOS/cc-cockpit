# Server mode (headless)

External review: sol / high

## Overview

Someone installs cc-cockpit on a Linux server with no display (a home server, a VM) and uses it only through web access,
from browsers. The model is web access v1's: one person with several devices, every signed-in device is that person. What
changes is that no desktop exists, so the three things v1 keeps on the desktop move: who gets in goes to a shell on the
server (`ccc web`), seeing who is in goes to the log, the CLI and the browsers' card, and approving what runs as code goes
to the browsers. Design: `docs/design-web.md` §9 (settled by the owner, reviewed once; §9.1's start path was revised to a
re-exec in place together with this plan), with its pointers in §0, §4.1, §5.6, §6.1, §7 (phase 6), §8 and §11.

Server mode ships in the same branch and PR as web access v1 (`feat/web-access`): it is design phase 6, built on the
committed v1 (plan `docs/plans/completed/20261110-web-access.md`).

Covered: the start (`--server`, detection with no display, the re-exec with the Ozone switches, systemd), web access
always on with the start link, `ccc web`, the key file secret store, the dialog and `openExternal` adapters, the hidden
page's own state, owner approvals in the browser (plugin link, trash), projects opened and closed from the browser,
overlays held by browsers, the web access card and device revoke in a browser, in-page notices, the OAuth paste box, the
Claude token exception. Out (§9.14): macOS and Windows, relink and forget from the browser, `ccc web` writes on the
desktop, a Files "Download" item, more than one person.

## Context (from discovery)

- Start: `src/main/index.ts` takes the single-instance lock at module top (`:189-194`, `SecondInstanceData` =
  `{ argv, cwd }`), `start()` at `:212` (`choosePasswordStore` `:222`, `selectSecretStore` `:235`), `second-instance`
  `:2499-2508` (`windows.focusAny()`), `before-quit` `:2515-2522` (`webConnections.endAll(CLOSE.appQuit)`), `whenReady`
  `:2563-2572` (`await socket.start()` only logs on false, `void webAccess.apply()` not awaited). `projectPathFromArgv`
  and `asSecondInstanceData` are in `src/main/windows/window-manager.ts` (`:656`, `:688`).
- Native calls to adapt: `dialog.showMessageBox` (`index.ts:459` trash, `:489` close, `:1527` link), `showOpenDialog`
  (`:1600`, `:1655`, `:1686`), `showErrorBox` (`:1608`, `:1663`); `shell.openExternal` (`index.ts:239` plugin OAuth,
  `:831` webview manager, `:1143` host API, `:1669` router, `:2027`; `windows/create-window.ts:75`;
  `overlays/electron-url-view.ts:45`). Every one is a lambda looked up at each call, because the e2e recorder replaces
  `shell.openExternal` after launch. `PluginOAuth` is one app-wide object that gets only the URL (`index.ts:239`,
  `oauth/plugin-oauth.ts:113`, `:170`), and so do the webview manager's `deps.openExternal(href)`
  (`webview/webview-manager.ts:162`, `:568`) and the update notice (`index.ts:2023-2028`): none of them knows a window
  today. In a test run queued fakes replace the trash, close and link dialogs (`index.ts:449`, `:1514-1528`): they hid
  the crash under Ozone headless (spike).
- Hidden page: `WindowManager` (`focusAny` `:276`, `focusProject` `:290`, `activate` `:306`, `remoteViewGone` `:320-327`,
  `openView` `:420-424`, `closeRequested` `:488-507`), `windows/electron-window-factory.ts` (`finish` `:98`),
  `views/view-sizes.ts` (`canSize` `:183-185`), `tabs/terminal-sizes.ts`, `overlays/overlay-manager.ts` (holder rule
  `:20-25`, `:568`, `:689-702`; terminal overlay answerer `:839`), `hooks/ccc-offer.ts` (wired at `index.ts:1982`).
- Web access: `web/settings.ts` (`applyWebAccessPatch` `:276`, the "never rewritten" rule `:5-8`, `storedWebAccess`
  `:381`), `web/access-service.ts`, `web/auth.ts` (`addDeviceLink`), `web/gateway.ts` (`GET /api/projects` `:541`,
  `MAX_SIGN_IN_BODY` `:97`, `readBody` `:154`), `web/access-log.ts`, `shared/web-protocol.ts` (`CLOSE` `:150`),
  `renderer/web/bridge.ts` (final closes `:211`, `:377`), `renderer/web/picker.tsx`, `picker-model.ts`.
- CLI: `shared/protocol.ts` (`TOKENLESS_COMMANDS` `:32`, `PROJECTLESS_COMMANDS` `:65`, `WINDOW_TOKEN_COMMANDS` `:77`),
  `shared/manifest.ts` (`CORE_CLI_COMMANDS` `:82`; "main must not import the CLI", `:79-80`),
  `main/socket/socket-server.ts` (`dispatch` and `identify` `:296-330`: identity first, then the handler; a session
  token has no allow-list, so a registered handler is reached by any Claude tab unless `identify` or the handler
  refuses), `main/socket/handlers.ts` (`ccc notify` is projectless, `:126`), `cli/args.ts`, `cli/client.ts` (silent
  exit 0 when the app is not running `:415`), `cli/guide/cli.md`, `main/paths.ts` (`socketPath()`, pure Node). The
  marketplace tools import `src/shared/manifest` (`marketplace/tools/src/check-entry.ts:23`).
- Secrets: `secrets/secret-store.ts` (`SecretStore` `:34`, `safeStorageSecretStore` `:90`, `selectSecretStore` `:190`,
  `FAKE_PREFIX`), `secrets/plugin-secrets.ts`, `secrets/password-store.ts`; a secret settings field's "set" state is
  `secretFieldsView` (`settings/plugin-settings.ts:251`), `project-settings-service.ts:256` and
  `renderer/settings/PluginSettingsForm.tsx`.
- Asks and notices: `plugins/link-asks.ts` (`LinkAsks` `:46`, `chooseLinkConfirm` `:130`, `LINK_ASK_MS`),
  `files/trash-dialog.ts`, `files/system-files.ts` (`ConfirmTrash` `:49`), `notifications/notifier.ts` (`NoticeBackend`
  `:54`), `shared/notify.ts` (the `ctx.notify` limits, guarded by `cli-guide.test.ts:234`),
  `renderer/notices/ShellNotices.tsx` (link asks and link notices), `renderer/notify/chime.ts`.
- Other: `oauth/oauth.ts` (`startLoopback` `:150`, `ERROR_CODE`, `safeEqual`), `oauth/plugin-oauth.ts`,
  `plugins/host-api.ts` (`desktopOnly` `:1543`, `openExternal` `:1496`), `env/pty-env.ts` (`isStrippedVar` `:38`),
  `webview/webview-manager.ts` and the shell page's own webview channels (`index.ts:2105-2108`),
  `plugins/browser/src/host.ts:48` (`ctx.webview.navigate` at activation), `marketplace/marketplace-service.ts:56`
  (`CC_COCKPIT_MARKETPLACE_URLS` is read in a test run only, and every refresh fetches the default index, `:199-206`).
- Remote classes today (`shared/ipc.ts:1689+`): `projects.*` `no`, `settings.webAccess*` and `settings.webDevice*` `no`,
  `webAccess.state` / `webAccess.changed` `no`, `notify.chime` `no`, `links.answer` `adapted`.
- Evidence: the spike (Electron 45.1.0, Linux, no session bus; dialogs abort main with SIGTRAP, the page answers
  `tabs.screenAsk`, 250 MB idle) and the design review (`app.relaunch` loses stdout; `spawnSync` with inherited stdio
  keeps it). Both are folded into §9.
- **Plan-time measurements** (2026-11-11, minimal Electron 45.1.0 apps, Node 24.22.1, no `DISPLAY` / `WAYLAND_DISPLAY`,
  no session bus; not the real app, which Task 1 measures first):
  - the lock before `ready` works with no display: `requestSingleInstanceLock` is true, `releaseSingleInstanceLock`
    lets the next image or process take it, and a second no-display launch gets false while the holder receives
    `second-instance` with its `additionalData`;
  - a `spawnSync` child keeps stdout, but a SIGTERM sent to the first process alone kills it and the child lives on,
    reparented;
  - an async `spawn` cannot forward signals: the first process returns from its top-level script, Electron goes on to
    initialize the platform, fails ("The platform failed to initialize. Exiting.") and exits 1 in under 3 s, leaving
    the child orphaned;
  - `process.execve` (Node's, present in Electron 45.1.0) replaces the first process's image: same pid, stdout kept, the
    lock taken again, SIGTERM quits it cleanly with status 0 and leaves nothing. The first image's two zygote processes
    exit but stay as `<defunct>` children of that pid for the whole run (the new image never reaps them): accepted;
  - a failed `process.execve` does not throw in Electron 45.1.0 (`ELECTRON_RUN_AS_NODE=1`, `/nonexistent/x`): it prints
    "process.execve failed with error code ENOENT" and aborts (SIGABRT, status 134, core dumped). Plain Node 26 throws,
    so a test of the failure in plain Node would mislead, and the fallback can never be a `try` / `catch`.
- **The start path is decided** (owner, after the plan review; §9.1): re-exec in place with `process.execve`. The
  fallback, a `spawnSync` child with a parent-pid watch, is chosen at run time before the call, by two checks
  (`typeof process.execve === 'function'`, the target is executable), and both paths ship.
- Project rules (CLAUDE.md): main is the only authority; Electron-only modules behind adapter files; every event and
  port post goes through `ViewRegistry` (`toProject`, `toWindow`, `toView`, `toAll`, `postPort`), never
  `webContents.send`, guarded by `no-direct-webcontents-send.test.ts`; a new IPC channel needs its `REMOTE_CLASS` in the
  same change and an `adapted` handler decides by the caller main bound; no regexes in the gateway's settings or path
  parsing; exec is argv-only; a new `ccc` command or `ctx` behaviour needs its guide text in the same change (drift
  tests); every wait in `src/cli/client.ts` has a deadline; terminal size has one owner and nothing bypasses the mirror
  worker; dense "why" comments.

## Development Approach

- **testing approach**: Regular (code first, then tests); every task ends with its tests
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** (`npm test`, `npm run typecheck`, `npm run lint`, and
  `npm run test:plugins` when a bundled plugin changes)
- **CRITICAL: update this plan file when scope changes during implementation**
- Everything new hangs on main's `server` flag (Task 1), which is false on every desktop start: with web access off, and
  on the desktop, the app behaves as before after every task. Modules take `server` as an option, never read argv or the
  environment themselves, so unit tests cover both values
- "Every browser view of a window" (or of every window), never the hidden page, is one `ViewRegistry` method (Task 4
  adds it, covered by `no-direct-webcontents-send.test.ts`), not a filter written at each call site: link notices, trash
  asks, overlays, notices and the chime all use it
- A plan-time check (Tasks 1, 2 and 13) records its result in this file next to its checkbox, and when the result
  differs from what the design assumed, the later tasks it names are updated before they start
- Every manual run of the app in a task uses its own temp data dir and temp `HOME`, with `CC_COCKPIT_SOCK`, `APP_TAB_*`,
  `CLAUDE_CODE_*` and `ELECTRON_*` unset: never the dev app's data dir, never a running dev app
- "No session bus" always means the same two variables in the app's env: a dead `DBUS_SESSION_BUS_ADDRESS`
  (`unix:path=/nonexistent/bus`) and a temp `XDG_RUNTIME_DIR`. Unsetting the address is not enough: on a systemd desktop
  libdbus then finds `$XDG_RUNTIME_DIR/bus`
- A task that changes `src/sdk/types.ts` (a doc comment of `ctx.notify`, `ctx.oauth`, `ctx.files`, `ctx.webview`) copies
  it in the same change, `cp src/sdk/types.ts examples/plugin/sdk/types.ts`, and runs `npm run build:example`:
  `cli-guide.test.ts:56` compares the two byte for byte
- The design is settled: a task that finds §9 wrong against the code or a measurement records it with ⚠️ and stops for
  the owner instead of choosing a new design

## Testing Strategy

- **unit tests**: required for every task; logic takes fakes (the fake window factory, a recorder `dialog` and `shell`,
  a fake socket, an injected `fstat`), as in web access v1
- **security tests** with each piece, the refusals as much as the successes: `web` from a session or window token, for
  every one of the eight requests; minting commands outside server mode; a remote Allow outside server mode; `no`-class
  channels from a remote view in server mode; `POST /api/projects` with no cookie, a wrong Origin, an oversize or
  non-JSON body, an unknown `reopen` id; `projects.close` naming another project; key file as a symlink, a FIFO, a
  directory, with a wider mode, another owner, a wrong length; the start link off a TTY and in the other modes; the
  OAuth paste with a wrong origin, path, `state` or sign-in id; a notice click for another window's notice; no secret in
  any log or in `ccc web status`
- **smoke script** (`scripts/server-mode-smoke.mjs`, Task 1, extended by Tasks 7, 8, 11 and 12): the built app with no
  display and no switches, the only test of the detection and the re-exec (the re-exec replaces the image Playwright
  launched and drops its inspector connection, so the e2e cannot cover them)
- **e2e** (Playwright, `npm run test:e2e`): from Task 2 on, the harness starts the app with the switches directly
  (`--server --ozone-platform=headless --disable-gpu --password-store=basic`, no display, Linux only), which is what
  the re-exec starts, and drives it from the web browser fixture; Tasks 3, 4, 9 and 10 each add a spec that drives the
  real hidden page, and every later task that touches UI adds its steps to `test/e2e/server-mode.spec.ts`. Server-mode
  specs never use the queued test dialogs for the link, trash and close paths: those fakes hid the crash. Existing e2e
  specs keep passing, and every task that edits an always-on desktop path names the specs of its exit gate: Tasks 1, 3
  to 12 and 14 to 24 (Tasks 2, 13 and 25 run the whole suite)

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

- **Start.** A pure decision (`src/main/server-mode.ts`: platform, env, argv in; `{ server, exec: { exe, args } }` or a
  refusal out) at the top of `index.ts`. When server mode applies and the Ozone switch is not on argv, main checks the
  lock, then re-executes itself in place (`process.execve`) with `--server --ozone-platform=headless --disable-gpu
  --password-store=basic`: one process, the same pid and stdio, its exit status its own. A failed `execve` aborts
  instead of throwing, so the fallback is chosen before the call and never by catching: when `process.execve` is missing
  or the executable fails its check, main runs a `spawnSync` child that watches its parent pid. Main keeps `server` for
  the run.
- **Two adapters that fail closed.** `dialogs/electron-dialog.ts` is the only importer of `dialog`, and one adapter owns
  `shell.openExternal`. In server mode neither calls Electron: a message box rejects, an open dialog is canceled, an
  error box is a log line, a link becomes a link notice in a browser. A call site this plan missed then fails closed
  instead of killing main.
- **Web access is the only way in.** Server mode writes `enabled: true` (and `link` over a stored `confirm`) at start,
  refuses turning it off and the desktop-confirm mode, awaits the gateway and the CLI socket before any window opens,
  and prints the first link only to a terminal.
- **`ccc web`** from a shell on the server (a tokenless caller only): status, revoke and stop, and in server mode the
  link, add-device, password, mode and bind settings, all through `applyWebAccessPatch`. On the desktop it only reads
  and revokes.
- **Secrets**: the mode decides the store. Server mode always uses a key file (`<data>/secret.key`, AES-256-GCM), the
  desktop always the keychain; each refuses the other's values with a text that says so.
- **The hidden page** keeps the window's desktop view alive under rules of its own: never measured, never shown,
  focused or hidden, reloaded when it crashes, nothing of it persisted.
- **Any signed-in device is the owner** in server mode: it may Allow a plugin link, answer a trash confirm, open and
  close projects, hold overlays, revoke devices, read the web access card and settle a plugin's OAuth sign-in. Minting
  sign-in material stays on the server shell. On the desktop v1's rules stay.

## Technical Details

- Exec args: `[exe, ...argv after the executable, '--server', '--ozone-platform=headless', '--disable-gpu',
  '--password-store=basic']`; `exe` is `process.execPath`, in an AppImage too (under `execve` the image's mount lives on
  with the pid, and executing `APPIMAGE` again would nest a second runtime and mount). No re-exec when
  `--ozone-platform=headless` is already on argv (the re-executed image, a unit that passes the switches, the e2e
  harness). `--server` off Linux: "server mode runs on Linux only", exit 1, before the lock.
- The start path is chosen at run time, at each start, before the lock is released: `exec` when
  `typeof process.execve === 'function'` and `accessSync(exe, X_OK)` passes, else `watch`. `watch` runs
  `spawnSync(exe, [...args, '--server-parent=<own pid>'], { stdio: 'inherit' })` and exits with the child's status
  (128 + n for a signal; 1 with a line when the spawn itself fails, which a non-executable `exe` does without aborting).
  The second process arms the parent watch only when `--server-parent=<pid>` is on its argv: a timer compares the marker
  with `process.ppid` and quits as SIGTERM does when they differ. A direct start with the switches carries no marker,
  so the watch is never armed in the e2e harness or under a unit that passes the switches; unit tests run the watch as a
  function over an injected `ppid` reader and timer and start no process.
- stdout lines (exact texts in §9.1 to §9.3): the detected-start line, "server mode: turned web access on in app.json"
  (once), the address, the add-device link (TTY and link mode only) or "add a device: `ccc web add-device`", the
  wrapper's path (`<data>/bin/ccc`), a refused stored setting with its `ccc web set ... --confirm ...` line.
- Key file: 32 random bytes, `O_CREAT | O_EXCL`, mode 0600 at open; opened `O_NOFOLLOW | O_NONBLOCK`, checked by `fstat`
  on the descriptor (regular file, the user's, no group or other bits, 32 bytes). Value: `KEYFILE-V1:` + base64(iv 12
  bytes, tag, ciphertext).
- CLI socket: `HOST_ONLY_COMMANDS` in `shared/protocol.ts`, all eight requests from the first `ccc web` task on
  (`web.status`, `web.revoke`, `web.stop`, `web.link`, `web.add-device`, `web.password`, `web.mode`, `web.set`),
  projectless, not in `WINDOW_TOKEN_COMMANDS`, refused in `identify` for any token before a handler is looked up, and
  refused again by each handler for any caller kind but the tokenless one. `web` joins `CORE_CLI_COMMANDS`.
- `openExternal` adapter: `open(url, target)`, `target` = `{ windowId, viewId? }` taken from what main bound (the
  router's caller, the plugin host's window and origin view, the window a view or overlay belongs to) or `'app'` for a
  call tied to no window. Never a window or view id from a payload.
- Gateway: `GET /api/projects` adds `server: true` and the recent and missing projects in server mode;
  `POST /api/projects` (`{ open: path }` or `{ reopen: id }`, exactly one, body capped as the sign-in routes') is 404
  otherwise.
- Web snapshot: `ready.snapshot.server` (a UI hint only: which dialog text and which items a browser shows; main's
  checks never rest on it), pending trash asks next to `linkAsks`.
- Remote classes changed or added, each decided by `view.remote` and main's `server`, never the payload:
  `settings.webAccess`, `webAccess.state`, `webAccess.changed`, `settings.webDeviceRevoke`, `webDevicesRevokeAll`,
  `webDeviceDisconnect`, `notify.chime`, `projects.close` (new), the OAuth paste (new) and the notice click (new) are
  `adapted`; `trash.ask` / `trash.answer` / `trash.settled` (new) are `yes`. `settings.webAccessSet`, `Link`,
  `Regenerate`, `AddDevice`, `SetPassword` and `webAccess.confirmAnswer` stay `no`.
- A new close code in `CLOSE` for a server stop: not final, the bridge retries it with backoff.
- Sizes: the hidden page is never a measured view; a pty keeps the size the last browser gave it; a tab no browser has
  sized gets 120x40.

## What Goes Where

- **Implementation Steps**: code, tests, the smoke script and docs in this repo
- **Post-Completion**: the AppImage and the deb on a stock Ubuntu Server, the systemd unit across a reboot, a phone,
  `tailscale serve`, the Claude login in a browser tab; the example plugin repo; release

## Implementation Steps

### Task 1: Server-mode start: the decision, the re-exec in place, the no-display proof [model: opus]

**Files:**
- Create: `src/main/server-mode.ts`, `scripts/server-mode-smoke.mjs`, `test/unit/server-mode.test.ts`
- Modify: `src/main/index.ts` (the top, before and around the lock at `:189-194`; `start()` gets `server`),
  `src/main/windows/window-manager.ts` (`projectPathFromArgv`), `test/unit/window-manager.test.ts`

The start path is decided (§9.1, Context): `process.execve`, with the parent-pid watch chosen at run time by two
checks before the call. A failed `execve` aborts the process (SIGABRT, no exception), so no step below catches it.

- [x] `server-mode.ts`, the decision: a pure function, `{ platform, env, argv, execPath }` in; out `{ server: false }`,
      `{ server: true, detected, exec?: { exe, args } }` or `{ refuse }`. Server mode with `--server`, or on Linux with
      neither `DISPLAY` nor `WAYLAND_DISPLAY`; `exec` only when `--ozone-platform=headless` is not on argv; `exe` is
      `execPath`, with `APPIMAGE` set too; off Linux `--server` refuses and nothing is detected. A second pure function
      picks the start path: `{ hasExecve, executable }` in, `'exec'` only when both hold, else `'watch'`.
      `projectPathFromArgv` skips `--server`, the three switches and `--server-parent=<pid>`
- [x] **plan-time check, `process.execve` in the real app, before anything else is built on it.** With the smallest
      change at the top of `index.ts` (release the lock, `process.execve(exe, [exe, ...args], process.env)`), run the
      built app (`out/`) with no display and no session bus, a temp data dir and `HOME`. It passes when every line
      holds, and each result is written here:
      - the pid is the same before and after the re-exec;
      - `/proc/<pid>/fd/1` and `fd/2` point at the same target before and after, once with stdout a pipe and once under
        a pty;
      - the re-executed image holds the lock again (it must find the lock released: an unreleased lock names its own
        pid), and a second no-display launch hands over its argv and exits 0 with nothing re-executed (its
        detected-start line is not printed);
      - SIGTERM to that one pid exits 0, and so does SIGINT, and so does Ctrl-C typed into the pty; the time to quit
        for each;
      - the exit status is the app's own (a start that fails exits 1, not a signal status);
      - the detected-start line is printed once;
      - after exit no live process of the run is left. During the run the first image's two zygote processes stay as
        `<defunct>` children of the pid (accepted, measured at plan time): record how many.

      A line that fails is a ⚠️ for the owner (the watch path exists, but making it the only path is the owner's call).
      If only the lock check before `ready` fails: the first image skips it and the re-executed image loses the lock as
      any launch does; record which
      **Result (2026-11-11, real app `out/`, Electron 45.1.0, no display, no session bus, measured with the full
      wiring of the next items rather than a throwaway change): every line holds, `execve` stays the path.**
      - pid: the same (`/proc/<pid>/cmdline` of the launched pid carries `--ozone-platform=headless` after the re-exec);
      - fd 1 and 2: the same target before and after, `pipe:[…]` with a pipe and `/dev/pts/N` under a pty;
      - lock: the re-executed image holds it (the CLI socket comes up); a second no-display launch with a folder exits
        0 in 0.17 s, prints nothing (no detected-start line), nothing re-executed. The lock check before `ready` works;
      - SIGTERM: exit 0 in 40 ms (pipe) / 51 ms (pty); SIGINT: exit 0 in 35 ms; Ctrl-C typed into the pty: exit 0 in
        32 ms;
      - exit status is the app's own: a re-executed image that calls `process.exit(1)` (a temporary patch of the built
        `out/main/index.js`, restored after) exits 1;
      - the detected-start line is printed once per run;
      - after exit nothing of the run's session is alive; during the run the first image leaves 2 `<defunct>` children
        of the pid (as at plan time)
- [x] `index.ts`, before `ready`, wiring one function of `server-mode.ts` that takes `lock`, `print`, `exit`, `access`,
      `execve` and `spawnSync` as arguments, so unit tests run every branch: `{ refuse }` prints "server mode runs on
      Linux only" and exits 1 before the lock is asked for. With `exec` set: check the lock (held: argv goes to the
      holder as any second launch, exit 0, nothing re-executed); pick the start path with
      `typeof process.execve === 'function'` and `accessSync(exe, X_OK)`; release the lock; print "no display: starting
      cc-cockpit in server mode, web access on; stop with Ctrl-C" (only when detected, not with `--server`); then
      `process.execve`. `server` is kept for the run and passed into `start()`
- [x] the `watch` path, taken only when a check fails: `spawnSync(exe, [...args, '--server-parent=<own pid>'],
      { stdio: 'inherit' })`, exit with the child's status (128 + n for a signal), or 1 with a line when the spawn
      itself fails. In the second process the watch is armed only when the marker is on argv: a timer compares it with
      `process.ppid` and quits as SIGTERM does when they differ; a marker that already differs at start quits at once.
      No marker (the re-executed image, a unit with the switches, the e2e harness), no watch. `CC_COCKPIT_NO_EXECVE=1`,
      read only in a test run (`isTestRun`), makes the first check fail, so the smoke script can run this path
- [x] `scripts/server-mode-smoke.mjs` and **the proof of the full app with `--server` under no display**: the built
      app (`out/`, or an executable given as an argument) with no display, a temp data dir and `HOME`, no session bus
      (a dead `DBUS_SESSION_BUS_ADDRESS` and a temp `XDG_RUNTIME_DIR`; the script prints the two values it used) and
      `app.json` pre-written (web access on, a random loopback port, mode None, the update check off). The `out/` run
      sets `CC_COCKPIT_TEST=1` and an empty `CC_COCKPIT_MARKETPLACE_URLS`, so it makes no request (the variable is read
      in a test run only); no queued fake dialog is on a path the script touches. A packaged executable ignores both,
      makes one background fetch of the default index, and must pass offline (Task 25 runs it). Runs: with `--server`;
      with no flag at all (detected); with `CC_COCKPIT_NO_EXECVE=1` (the watch path, `out/` only). Each waits for
      `<data>/app.sock`, checks the pid it started still is the app's (the `exec` runs), gets `GET /` 200 from the
      gateway, sends SIGTERM to the first pid only, checks the exit status, and after exit counts the live processes of
      the run, zombies not counted: none; exits 1 on any failure. Record here: the start lines, that `--server` is not
      a switch Chromium reads (`hasSwitch('headless')` false), the time to quit on each path
      **Result (2026-11-11, `out/`): all three runs pass.** Start lines: `--server` prints nothing of its own (today's
      start lines come with Task 7); detected prints "no display: starting cc-cockpit in server mode, web access on;
      stop with Ctrl-C" once. Socket after about 0.4 s on each path. Quit after SIGTERM: `--server` 28 ms, detected
      30 ms (both status 0); fallback: the first process, blocked in `spawnSync` before `ready` with no handler,
      dies by SIGTERM (signal status, 143 from a shell) and the parent watch quits the child within its 1 s tick
      (the script expects SIGTERM there, not 0). `--server --ozone-platform=headless --disable-gpu
      --password-store=basic` on a minimal Electron 45.1.0 app: `hasSwitch('headless')` false (`hasSwitch('server')`
      true, harmless). The run's processes are counted by session id (the app is started as a session leader), not by
      environment: Chromium's process titles overwrite `/proc/<pid>/environ`. The app.json the script writes carries
      `schemaVersion: 1`, or the registry sets it aside as unusable
- [x] write tests: the decision table (platform, `DISPLAY`, `WAYLAND_DISPLAY`, `--server`, the switch already present,
      `execPath` as `exe` with and without `APPIMAGE`, the refusal off Linux, `--password-store=basic` in the args, an
      `ssh -X` environment stays desktop); both pre-checks (`execve` missing, `exe` not executable: `'watch'`, and
      `execve` is never called); the wired function over fakes: the refusal prints and exits 1 before the lock, a held
      lock exits 0 with nothing started, the detected line only when detected, the lock released before the start, the
      watch path's status, signal status and spawn error; the watch armed only by the marker, quitting when the parent
      pid changes, never armed without it; argv parsing skips the flag, the switches and the marker
- [x] run tests, the smoke script and `npm run test:e2e` (`restore`, `project-picker`, `cli`, `socket`: the lock, the
      top of `index.ts` and `projectPathFromArgv` are every desktop start's) - must pass before next task

### Task 2: The server-mode e2e harness: its core [model: opus]

**Files:**
- Create: `test/e2e/server-fixtures.ts`, `test/e2e/server-mode.spec.ts`
- Modify: `test/e2e/fixtures.ts` (extra args, variables removed from the app's env), `test/e2e/web-fixtures.ts`

Right after Task 1, so Tasks 3, 4, 9 and 10 can each drive the real hidden page: the spike found its faults only by
driving, and this is the first time Playwright meets a `--ozone-platform=headless` process.

- [ ] `launchServer`: the app started with the switches directly (`--server --ozone-platform=headless --disable-gpu
      --password-store=basic`), because the re-exec replaces the image Playwright launched and drops its inspector
      connection; no `--server-parent` marker, so the parent watch is never armed. `DISPLAY` and `WAYLAND_DISPLAY`
      removed from the app's env only (the browser fixture keeps its display), no session bus (a dead
      `DBUS_SESSION_BUS_ADDRESS`, a temp `XDG_RUNTIME_DIR`), Linux only (skipped elsewhere), a project folder on argv
- [ ] **plan-time check**: Playwright's Electron launch against an Ozone headless process (the launch resolves, the
      test hooks on `__ccTest` answer). Record it here; if it cannot attach, `launchServer` starts the process itself
      and specs use the browser fixture, `ccc` and the gateway only, and the later tasks' hook steps are reworded
- [ ] sign in with mode None on loopback from a pre-written `app.json` (web access on, a random loopback port, mode
      None), as the smoke script does: server mode does not turn web access on by itself before Task 7, and
      `ccc web add-device` does not exist before Task 12
- [ ] the "main is alive" helper (the pid lives and `GET /` answers 200), called at the end of every server spec from
      here on
- [ ] the first spec: a terminal tab's output and input in the browser, main alive
- [ ] existing e2e specs still pass
- [ ] run `npm run test:e2e` - must pass before next task

### Task 3: Dialog adapter [model: sonnet]

**Files:**
- Create: `src/main/dialogs/electron-dialog.ts`, `src/main/dialogs/dialogs.ts`, `test/unit/dialogs.test.ts`,
  `test/unit/no-direct-dialog.test.ts`
- Modify: `src/main/index.ts` (the `dialog` import, `:459`, `:489`, `:1527`, `:1600-1608`, `:1655-1663`, `:1686`, the
  RULE comment at the top), `src/main/plugins/link-dialog.ts`, `src/main/windows/close-dialog.ts`,
  `src/main/files/trash-dialog.ts`, `test/e2e/server-mode.spec.ts`

- [ ] `dialogs.ts`: the `Dialogs` interface (message box, open dialog, error box) and the server-mode implementation
      that never calls Electron: a message box rejects with `ServerDialogError`, an open dialog answers canceled, an
      error box becomes a log line
- [ ] `electron-dialog.ts`: the only importer of Electron's `dialog`; `index.ts` picks one of the two by `server` and
      hands it to `link-dialog.ts`, `close-dialog.ts`, `trash-dialog.ts` and the open-folder, relink and `pickFolder`
      call sites
- [ ] on the desktop nothing changes: the same boxes, the same parents, the queued fakes of a test run as before
- [ ] a grep test like `no-direct-webcontents-send.test.ts`: only `electron-dialog.ts` imports or calls `dialog`
- [ ] write tests with a recorder `dialog`: server mode never calls it (box rejects, open dialog canceled, error box
      logged), desktop mode passes parent and options through unchanged
- [ ] e2e in the real server process (`server-mode.spec.ts`): a test hook calls the three methods of the adapter main
      wired, with no queued fake in the way: the message box rejects, the open dialog is canceled, the error box is a
      log line, and main is alive after each (the same calls on Electron's `dialog` abort main there)
- [ ] run tests and `npm run test:e2e` (`server-mode`, `link-confirm`, `close-confirm`, `files-menu`, `project-picker`)
      - must pass before next task

### Task 4: One adapter for `shell.openExternal` [model: opus]

**Files:**
- Create: `src/main/external/electron-open-external.ts`, `src/main/external/open-external.ts`,
  `test/unit/open-external.test.ts`, `test/unit/no-direct-open-external.test.ts`
- Modify: `src/main/index.ts` (`:239`, `:831`, `:1143`, `:1669`, `:2023-2028`, the RULE comment),
  `src/main/windows/create-window.ts` (`:75`), `src/main/overlays/electron-url-view.ts` (`:45`),
  `src/main/plugins/host-api.ts` (`openExternal`, `:1496`), `src/main/ipc/router.ts` (`:437-440`),
  `src/main/oauth/plugin-oauth.ts` (`:113`, `:170`), `src/main/webview/webview-manager.ts` (`:162`, `:568`),
  `src/main/views/view-registry.ts`
- Modify: `test/unit/plugin-oauth.test.ts`, `webview-manager.test.ts`, `view-registry.test.ts`,
  `no-direct-webcontents-send.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] the adapter's one call is `open(url, target)`. `target` is `{ windowId, viewId? }`, always from what main bound
      (the router's caller for `app.openExternal` and the update notice's click, the plugin host's window and origin
      view for `ctx.openExternal`, the window a webview, a URL overlay or a window-open belongs to), or `'app'` for a
      call tied to no window. No caller builds a target from a payload
- [ ] every call goes through it: `ctx.openExternal`, `app.openExternal`, the update notice, plugin OAuth, the webview
      manager, the window-open handler, the URL overlay view. It looks `shell.openExternal` up at each call, so the e2e
      recorder that replaces it after launch still runs. The remote-view branches the call sites have today
      (`router.ts:437-440`, `index.ts:2026`) move into it
- [ ] `PluginOAuth` and the webview manager pass the window on: `PluginOAuth` takes the calling host's window and
      origin view with each sign-in and hands them to `openExternal(url, target)`, the webview manager passes the
      window of the view. Task 24 binds its paste box to that same pending sign-in
- [ ] `ViewRegistry` gets the one method for "the browser views of a window, or of every window, never the hidden
      page" (it answers how many it reached); the adapter and every later task use it instead of filtering views
- [ ] in server mode never on the server: with a `viewId` that is a browser view, a link notice (`app.linkNotice`) to
      that view; with a window only, or the hidden page's view, to every browser view of the window; `'app'` goes to
      every browser view of every window. With no browser reached, refused with a log line that carries no query string
      (an OAuth URL has its `state` there)
- [ ] the desktop is unchanged: the OS browser for the desktop view and for a call with no view, v1's notice for a
      remote view
- [ ] a grep test: only the adapter file calls `shell.openExternal`
- [ ] write tests: each caller type in both modes with the target it passes; `'app'` in both modes; the no-browser
      refusal and its log line without the query; the notice reaching only the asking view; a plugin's sign-in URL
      reaching the window of the host that asked and no other; nothing opened on the server in server mode
- [ ] e2e in the real server process: a link opened from a browser view shows as a link notice there, one opened with
      no asking view (a test hook) shows in the attached browser, and the `shell.openExternal` recorder saw no call;
      main alive
- [ ] run tests and `npm run test:e2e` (`server-mode`, `plugin-oauth`, `webview-panel`, `update-notice`, `plugin-ctx`,
      `web-access-plugins`) - must pass before next task

### Task 5: The key file secret store [model: opus]

**Files:**
- Create: `src/main/secrets/key-file-store.ts`, `test/unit/key-file-store.test.ts`
- Modify: `src/main/secrets/secret-store.ts` (`selectSecretStore` gets `server`), `src/main/paths.ts` (the key file's
  path), `src/main/index.ts` (`:235`), `test/unit/secret-store.test.ts`

- [ ] `key-file-store.ts` (node `crypto` and `fs`, no Electron), one more `SecretStore`: the key is made on first start
      with `O_CREAT | O_EXCL` and mode 0600 at open, never chmod after, never made again over an existing file; opened
      with `O_NOFOLLOW | O_NONBLOCK` (a FIFO at the path would block a plain `open` for ever) and checked by `fstat` on
      that descriptor; refused with the reason when it is not a regular file, not the user's, readable by group or
      others, or not 32 bytes
- [ ] an existing file that fails a check is left untouched, never replaced: the store is unavailable with the reason,
      as a missing keychain is on the desktop
- [ ] values are AES-256-GCM with a random 96-bit IV, stored as `KEYFILE-V1:` + base64(iv, tag, ciphertext)
- [ ] a new key made while `KEYFILE-V1:` values exist (a restored backup, a deleted key file): start logs it with the
      count, those values answer "the key file was replaced: enter it again", and the count is kept for `ccc web status`
- [ ] the mode decides the store: `selectSecretStore` returns the key file in server mode and the keychain on the
      desktop (which keeps refusing `basic_text`); a test run's fake store keeps its place. Each store refuses the
      other's values with "stored by server mode's key file: enter it again here" (or "by the desktop's keychain"), and
      start logs how many stored values belong to the other store
- [ ] write tests in plain Node in a temp dir: made 0600 with `O_EXCL`; a symlink, a FIFO (the open returns, refused),
      a directory, a wider mode, another owner (an injected `fstat`) and a wrong length refused, each with the file
      left as it was and the store unavailable with its reason; round trip; one changed byte fails the tag; the
      replaced-key count and text; each store refuses the other's; server mode always picks the key file, the desktop
      never does
- [ ] run tests and `npm run test:e2e` (`plugin-secrets`, `web-access-settings`: `selectSecretStore` at `index.ts:235`
      is every start's) - must pass before next task

### Task 6: Secrets of the other mode: what the person sees [model: sonnet]

**Files:**
- Modify: `src/main/secrets/plugin-secrets.ts`, `src/main/settings/plugin-settings.ts` (`secretFieldsView`, `:251`),
  `src/main/settings/project-settings-service.ts` (`:256`), `src/shared/ipc.ts` (the secret field's view),
  `src/renderer/settings/PluginSettingsForm.tsx`, `src/main/web/auth.ts`
- Modify: `test/unit/plugin-secrets.test.ts`, `secret-settings.test.ts`, `web-auth.test.ts`

- [ ] a secret settings field shows "stored in the other mode: enter it again" instead of "set": the field's view
      carries a third state next to set and not set, for app, global and project values alike, and saving a new value
      replaces the unreadable one
- [ ] `ctx.secrets.get` rejects with Task 5's text, so the plugin shows its own sign-in again; the same for a value of
      a replaced key file
- [ ] web access: devices stay signed in (cookies and the access token are checked by hash), the access link cannot
      be shown until it is regenerated and the password must be set again; `web/auth.ts` reports both as states, for
      `ccc web status` (Task 11) and the card (Task 20) to show
- [ ] write tests: the third state for each of the three value kinds and after a save; `ctx.secrets.get` with the
      other store's value and with a replaced key's value; the auth states with a link and a password stored by the
      other mode, and a sign-in with an existing device cookie still passing
- [ ] run tests and `npm run test:e2e` (`plugin-secrets`, `settings-form`, `settings-project`) - must pass before next
      task

### Task 7: Web access is on: what server mode writes, refuses and prints [model: opus]

**Files:**
- Modify: `src/main/web/settings.ts` (`applyWebAccessPatch` takes `server`), `src/main/web/access-service.ts`,
  `src/main/web/auth.ts`, `src/main/web/access-log.ts`, `src/main/index.ts`, `scripts/server-mode-smoke.mjs`
- Modify: `test/unit/web-access-service.test.ts`, `web-auth.test.ts`, `web-gateway.test.ts` (the settings cases)

- [ ] at start in server mode a stored `enabled: false` is written `true` and a stored `confirm` mode is written `link`,
      and stdout says so once ("server mode: turned web access on in app.json"); no overlay, the stored record is what runs
- [ ] `applyWebAccessPatch` in server mode refuses the `confirm` mode with its reason (nobody can answer the request)
      and turning web access off ("server mode: web access is the only way in"); None on loopback needs no confirm and
      the §4.3 confirms apply to network binds as on the desktop
- [ ] a stored risky setting without its confirm is refused as v1 does, never rewritten to something safer: nothing
      listens, start prints the reason and the exact line that applies it (`ccc web set --bind ... --confirm ...`, built
      from the stored record), and the app keeps running
- [ ] the first lines: the address (the external origin when set, else the listen address); on a TTY in link mode a
      one-time add-device link (`addDeviceLink`: used once, 10 minutes, only its hash in memory, never on disk);
      otherwise "add a device: `ccc web add-device`"; password mode the address; None the address and §9.12's warning
      (every local user reaches loopback); then the wrapper's path (`<data>/bin/ccc`)
- [ ] `web-access.log` records that a start link was issued and the sign-in that used it, never the link
- [ ] write tests: the two start writes and the one line; a fresh data dir (enabled, link mode, loopback, the "turned
      web access on" line on the first start and not on the second); `confirm` and off refused only in server mode; the
      refused stored risk with its exact line and the record unchanged; the link printed only for a TTY in link mode: no
      link on a TTY in password mode or in None, none off a TTY, none when the stored setting is refused and nothing
      listens; no token in the log
- [ ] the smoke script: with stdout a pipe its output has the address and no `#t=`; one more run under a pty (node-pty,
      a dependency; `script -qfc` if its build does not load in plain Node): the `#t=` line appears, a `POST /auth/link`
      with it answers 200 once and is refused the second time
- [ ] run tests, the smoke script and `npm run test:e2e` (`web-access-settings`: `applyWebAccessPatch` is the desktop
      settings page's too) - must pass before next task

### Task 8: Start order and stop [model: opus]

**Files:**
- Create: `src/main/server-start.ts` (the order as a function over fakes), `test/unit/server-start.test.ts`
- Modify: `src/main/index.ts` (`:2515-2522`, `:2563-2572`), `src/main/web/access-service.ts` (what `apply` reports),
  `src/shared/web-protocol.ts` (`CLOSE`), `src/renderer/web/bridge.ts` (`:211`, `:377`),
  `scripts/server-mode-smoke.mjs`, `test/unit/web-bridge.test.ts`, `web-protocol.test.ts`

- [ ] in server mode main awaits the CLI socket and the gateway before any window opens or tab restores; either failing
      (the port is taken, the socket cannot start) logs the reason and exits 1, so systemd retries without Claude tabs
      resuming and being killed on each try. A stored setting the gateway refuses (Task 7) is not a failure
- [ ] the desktop start is unchanged: the socket's false only logs and the gateway is not awaited
- [ ] a server stop (SIGTERM, `ccc web stop` later) closes every view with a new non-final close code instead of
      `CLOSE.appQuit`; the bridge retries it with backoff and shows the host as away, so open browser tabs come back
      after a restart, an update or a reboot. A desktop quit keeps `CLOSE.appQuit` and its "Reload this page"
- [ ] the smoke script gains a case: the port already taken, expect exit status 1 and that no window opened first
- [ ] write tests: the order (socket, gateway, then windows), each failure exits 1 before a window, a refused setting
      does not exit; the bridge retries the new code and still stops on `appQuit` and `turnedOff`
- [ ] run tests, the smoke script and `npm run test:e2e` (`server-mode`, `restore`, `web-access-terminal`,
      `web-access-settings`: the desktop start and quit) - must pass before next task

### Task 9: The hidden page: lifetime [model: opus]

**Files:**
- Modify: `src/main/windows/window-manager.ts` (`:276`, `:306`, `:320-327`, `:420-424`, `:488-507`),
  `src/main/windows/electron-window-factory.ts` (`finish`), `src/main/hooks/ccc-offer.ts`, `src/main/index.ts` (`:489`
  `askClose`, `:1982`)
- Modify: `test/unit/window-manager.test.ts`, `ccc-offer.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] a state of its own, not Keep running's set: in server mode `WindowManager` never calls `focus`, `show`, `hide` or
      `showPicker`, across `remoteViewGone`, `openView`, `focusAny`, `activate` and a second launch; it never makes the
      picker window, and with no project open the app keeps running with the gateway up
- [ ] no close ask in server mode (`askClose` absent): nobody can press the window's close button
- [ ] a crash (`render-process-gone`) or a failed load reloads the page with a log line, with a pause between tries, and
      never closes the window (today a failed load closes it, which would end the project's tabs)
- [ ] server mode skips the ccc offer (its modal left the hidden page's root inert)
- [ ] write tests with the fake window factory: none of the four calls happens in server mode on each path; no picker
      window and no quit with the last project closed; a crash and a failed load reload and the window stays, with the
      pause; no offer in server mode; the desktop keeps every one of today's behaviours
- [ ] e2e in the real server process: crash the hidden page (`forcefullyCrashRenderer` through a test hook), it
      reloads, the tab and the browser view keep working, main alive
- [ ] run tests, the smoke script and `npm run test:e2e` (`server-mode`, `close-confirm`, `project-picker`, `restore`,
      `ccc-install`) - must pass before next task

### Task 10: The hidden page: sizes [model: opus]

**Files:**
- Modify: `src/main/views/view-sizes.ts` (`:183-185`), `src/main/tabs/terminal-sizes.ts`,
  `src/main/tabs/tab-manager.ts`, `src/main/overlays/overlay-manager.ts` (terminal overlay sizes, `:839`),
  `src/main/layout/` (zone sizes), `src/main/windows/window-manager.ts` (the bounds write near `:447`)
- Modify: `test/unit/terminal-sizes.test.ts`, `overlay-manager.test.ts`, `layout-service.test.ts`,
  `window-manager.test.ts`, `test/e2e/server-mode.spec.ts`

CLAUDE.md's rule holds here: terminal size has one owner (the last typer or "Fit to this screen"), a pty-less tab
refits in main, and nothing adds a second consumer of pty data or a reply path that bypasses the mirror worker. This
task only takes the hidden page out of the set of views that may own a size or answer a query.

- [ ] the hidden page is never a measured view in `ViewSizes`, for tabs and terminal overlays, so it never sizes a pty
      nor answers their queries; a pty keeps the size the last browser gave it
- [ ] a tab no browser has sized (new, or restarted with none attached) gets 120x40
- [ ] server mode writes neither the window's bounds nor the page's zone sizes to the project record, so a later
      desktop start finds the person's own
- [ ] write tests: the desktop view is never measured in server mode, for a tab and for a terminal overlay; the size a
      browser gave survives that browser leaving; 120x40 for a tab nobody sized; bounds and zone sizes not written; the
      desktop keeps every one of today's behaviours, the hidden Keep running view included
- [ ] e2e in the real server process: a tab opened with no browser attached reports 120x40 (it writes `stty size` to a
      file: `40 120`); a browser that attaches then sizes it; main alive
- [ ] run tests, `node --expose-gc scripts/web-terminal-bench.mjs` (only if `mirror.ts` or `mirror-worker.ts` changed)
      and `npm run test:e2e` (`server-mode`, `window-bounds`, `zones`, `tabs`, `web-access-terminal`,
      `tab-command-overlays`) - must pass before next task

### Task 11: `ccc web` part 1: host-only, `status`, `revoke`, `stop` [model: opus]

**Files:**
- Create: `src/main/socket/web-handlers.ts`, `test/unit/cli-web.test.ts`
- Modify: `src/shared/protocol.ts` (`HOST_ONLY_COMMANDS`), `src/shared/manifest.ts` (`CORE_CLI_COMMANDS`),
  `src/main/socket/socket-server.ts` (`:296-330`), `src/main/web/access-service.ts`, `src/main/index.ts`,
  `src/cli/args.ts`, `src/cli/client.ts` (`:415`), `src/cli/guide/cli.md`, `scripts/server-mode-smoke.mjs`,
  `marketplace/tools/dist` (only if its bytes change)
- Modify: `test/unit/protocol.test.ts`, `socket-server.test.ts`, `cli-args.test.ts`, `cli-client.test.ts`,
  `cli-commands.test.ts`, `cli-guide.test.ts`, `manifest.test.ts`

- [ ] `HOST_ONLY_COMMANDS`: a fixed list in `shared/protocol.ts` with all eight request names now (`web.status`,
      `web.revoke`, `web.stop`, `web.link`, `web.add-device`, `web.password`, `web.mode`, `web.set`), projectless and
      kept out of `WINDOW_TOKEN_COMMANDS`. `identify` refuses a listed request that carries any token, a session's
      included, before a handler is looked up: "run `ccc web` from a shell on the server, outside cc-cockpit". The five
      that have no handler yet answer "unknown command" to a tokenless caller until Task 12. The comment says it is not
      a boundary and why it is there (§9.4)
- [ ] each `web.*` handler refuses any caller kind but the tokenless one itself, as the session-only handlers refuse a
      window token again: a `web.*` handler that is registered but missing from the list would otherwise be reached by
      any Claude tab, which could print the access link
- [ ] a drift test: every request `web-handlers.ts` registers, and every registered handler whose name starts with
      `web.`, is in `HOST_ONLY_COMMANDS`
- [ ] `web` joins `CORE_CLI_COMMANDS`, so a plugin contributing a `web` command becomes invalid; run
      `npm run build:marketplace-tools` and commit `marketplace/tools/dist` if its bytes changed
- [ ] `ccc web status [--json]`, answered in both modes: mode, listen address and external origin, listening or the
      error, the secret store and how many values it cannot read (Task 5), the link and password states of Task 6,
      server mode or not, the devices (name, signed in with, last seen). Never a link, a token or a hash
- [ ] `ccc web revoke <device>|--all`, answered in both modes; `ccc web stop` quits as SIGTERM does, in server mode only.
      Outside server mode everything but `status` and `revoke` is refused with "use Settings › Web access", decided by
      main's `server`
- [ ] the CLI: with the app not running `ccc web` prints "cc-cockpit is not running" and exits 1 (plugin commands and
      hooks keep their silent 0); every wait has a deadline
- [ ] guide text in `cli.md` in the same change: what it does, and that it is for a shell on the server, not for Claude
- [ ] write tests: each of the eight requests refused for a session token and for a window token, with the same text,
      whether or not it has a handler; answered tokenless (`unknown command` for the five); a handler called directly
      with a session, window or project caller refuses; outside server mode only `status` and `revoke`; no secret in
      `status`; not running exits 1; `web` reserved; the drift test; guide drift. The smoke script now asks
      `ccc web status --json` and has a second run that stops with `ccc web stop`
- [ ] run tests, the smoke script and `npm run test:e2e` (`cli`, `socket`, `plugin-cli`: `identify`, `cli/args.ts` and
      `cli/client.ts` serve every `ccc` call) - must pass before next task

### Task 12: `ccc web` part 2: `link`, `add-device`, `password`, `mode`, `set` [model: opus]

**Files:**
- Modify: `src/main/socket/web-handlers.ts`, `src/shared/protocol.ts` (the list is complete since Task 11: only its
  comment, if a name's meaning changed), `src/main/web/access-service.ts`, `src/main/web/auth.ts`,
  `src/main/web/access-log.ts`, `src/cli/args.ts`, `src/cli/client.ts`, `src/cli/guide/cli.md`,
  `scripts/server-mode-smoke.mjs`
- Modify: `test/unit/cli-web.test.ts`, `socket-server.test.ts`, `protocol.test.ts`, `cli-args.test.ts`,
  `cli-client.test.ts`, `cli-commands.test.ts`, `cli-guide.test.ts`, `web-access-service.test.ts`

- [ ] server mode only, each refused elsewhere with "use Settings › Web access": `ccc web link [--regenerate]` (made on
      first use; regenerate kills it and its devices) and `ccc web add-device` (one-time, 10 minutes)
- [ ] `ccc web password`: from stdin, never argv (argv shows in `ps`); on a TTY a no-echo prompt read before the 40 s
      deadline starts; stdin capped; the hash through the existing off-thread scrypt. The password travels only in the
      request's args over the private socket: never in argv, an error text, a reply or any log
- [ ] `ccc web mode link|password|none`: `confirm` refused; `none` prints §9.12's shared-server warning
- [ ] `ccc web set [--bind] [--port] [--origin] [--host]... [--tls-cert --tls-key | --no-tls] [--confirm
      none-network|plain-http]` through the same `applyWebAccessPatch` as the settings page: a §4.3 risk is refused with
      its confirm text printed (`WEB_RISK_TEXT`) and applies only with its `--confirm`; no regexes in the parsing. The
      CLI makes `--tls-cert` and `--tls-key` absolute against its own cwd, as it does `--project`, and main refuses a
      relative one (main's cwd means nothing to the caller)
- [ ] each of the five handlers is registered in `web-handlers.ts` under its name from `HOST_ONLY_COMMANDS` and refuses
      a caller that is not tokenless itself; the drift test of Task 11 covers them
- [ ] `web-access.log` gets each change as made from the server shell, never a secret; the guide text in `cli.md` covers
      the new subcommands in the same change
- [ ] write tests: each command in server mode and its refusal outside; each of the five run with a session token and
      with a window token, refused before its handler with the host-only text (`socket-server.test.ts`), and nothing
      minted, printed or changed; the password absent from argv, every error text, the reply and every log; a relative
      TLS path refused by main and made absolute by the CLI; a risk without `--confirm` refused with the text and the
      record unchanged; `confirm` mode and turning off refused; a link is usable once. The smoke script signs in with
      `ccc web add-device` (a `POST /auth/link`, 200)
- [ ] run tests, the smoke script and `npm run test:e2e` (`cli`, `socket`, `plugin-cli`) - must pass before next task

### Task 13: Server-mode e2e: `ccc web` sign-in, stop and start, secrets [model: sonnet]

**Files:**
- Create: `test/e2e/server-secrets.spec.ts`
- Modify: `test/e2e/server-fixtures.ts`, `test/e2e/server-mode.spec.ts`

- [ ] sign in through `ccc web add-device` (the data dir's wrapper, no tab token in its env) with the browser fixture;
      Task 2's mode None sign-in stays for the specs that do not test sign-in
- [ ] a server stop and start on the same data dir: the open browser page comes back by itself (Task 8's close code)
- [ ] `server-secrets.spec.ts`, with no session bus (the dead `DBUS_SESSION_BUS_ADDRESS` and the temp
      `XDG_RUNTIME_DIR`) and no fake secret store: `ccc web password`, sign in, restart, sign in again; `secret.key`
      exists with mode 0600
- [ ] **plan-time check, `shell.trashItem` with no session bus** (the spike did not run it): one call through the real
      `shell` in the harness; record whether the file reaches the trash or the call fails cleanly. It records what this
      machine does, where `gio` is installed: a stock server may lack it, which Task 16's unit test and the
      Post-Completion list cover. Task 16's e2e expects whichever it is here; a crash or a hang is a ⚠️ for the owner
- [ ] existing e2e specs still pass
- [ ] run `npm run test:e2e` - must pass before next task

### Task 14: A desktop launch meets a server [model: opus]

**Files:**
- Create: `src/main/second-launch.ts` (what a losing launch does, as a pure function plus the socket ask),
  `test/unit/second-launch.test.ts`
- Modify: `src/main/windows/window-manager.ts` (`SecondInstanceData`, `asSecondInstanceData`), `src/main/index.ts`
  (`:189-194`, `:2499-2508`), `test/unit/window-manager.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] `SecondInstanceData` carries whether the second launch has a display; data without it (another build holding the
      lock) reads as today
- [ ] a server primary ignores the argv of a launch that has a display (it opens nothing there, logs a line); a launch
      with no display (`cc-cockpit <path>` from a server shell) opens the project as any second launch does, with
      nothing shown or focused
- [ ] a losing launch with a display asks the socket for `web.status` with a 2 s deadline and no token; when the answer
      says server mode it shows a native box through the dialog adapter, "cc-cockpit runs in server mode on this machine
      (web access at <address>)", with Stop (`web.stop`) or Cancel, then exits; any other answer, or none, exits as today
- [ ] the losing launch is an Electron process speaking the CLI protocol, and main may not import the CLI
      (`manifest.ts:79-80`): `second-launch.ts` uses the request and reply types of `src/shared/protocol.ts` and
      `socketPath()` of `src/main/paths.ts`, never `src/cli/client.ts`
- [ ] the box's answer in a test: an env variable read only when `isTestRun` (a queue filled through a hook cannot
      reach a process that shows its box right after start and then exits)
- [ ] desktop meets desktop is unchanged (`focusAny`, no visible delay)
- [ ] write tests: the decision table; the ask's deadline; the box only for a server answer; Stop sends `web.stop`;
      the env answer ignored outside a test run; a no-display second launch opens its path with none of `show` and
      `focus`; e2e: a second launch with a display against the server process, its box answered Stop by the env
      variable (this box is a desktop process's), the server exits cleanly
- [ ] run tests and `npm run test:e2e` (`server-mode`, `restore`, `project-picker`, `cli`) - must pass before next task

### Task 15: Plugin link asks: any signed-in device may Allow [model: opus]

**Files:**
- Create: `src/main/asks/shared-asks.ts` (the shared-ask core, moved out of `LinkAsks`), `test/unit/shared-asks.test.ts`,
  `src/renderer/notices/ApprovalDialog.tsx` (the guarded dialog) with its test
- Modify: `src/main/plugins/link-asks.ts` (`chooseLinkConfirm` `:130`, `answer`), `src/main/index.ts` (`:1514-1528`),
  `src/shared/web-protocol.ts` (`WebSnapshot.server`), `src/main/web/connection.ts`,
  `src/renderer/notices/ShellNotices.tsx`, `test/unit/link-asks.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] the shared-ask core (first answer wins, `settled`, the timeout, pending ones for a joining view) is one class
      `LinkAsks` uses; its existing tests pass unchanged
- [ ] in server mode `chooseLinkConfirm` always takes the shared ask, never the native dialog and never a test run's
      queued fake; with no browser attached the ask waits (the hidden page takes it), a browser that joins finds it in
      `ready.linkAsks`, and after 5 min it is Deny as now
- [ ] `LinkAsks.answer` accepts an Allow from a view main counts as owner (`!view.remote || server`), never from the
      payload; on the desktop a remote view may still only Deny
- [ ] `ApprovalDialog`: Allow is never the default, Enter does nothing, the dialog never takes keyboard focus from a
      terminal by itself, and Allow is enabled only after the dialog has been visible for about a second. In server
      mode the link dialog uses it and drops "Approve on the desktop" (`snapshot.server`, a UI hint only)
- [ ] write tests: a remote Allow taken only in server mode, and refused on the desktop whatever the payload says; the
      wait with no browser and the timeout; a joining view gets the pending ask; an answer for another window's ask
      refused; Allow disabled for the first second, Enter and typing never approve; e2e: `ccc plugin link` from a tab,
      Allowed in the browser, the plugin loads, main is alive
- [ ] run tests and `npm run test:e2e` (`server-mode`, `link-confirm`, `web-access-plugins`) - must pass before next task

### Task 16: Trash confirm as a shared ask [model: opus]

**Files:**
- Create: `src/main/files/trash-asks.ts`, `test/unit/trash-asks.test.ts`
- Modify: `src/main/index.ts` (`:449-460`), `src/main/files/system-files.ts`, `src/shared/ipc.ts` (`trash.ask`,
  `trash.answer`, `trash.settled`, class `yes`), `src/main/ipc/router.ts`, `src/shared/web-protocol.ts` and
  `src/main/web/connection.ts` (pending asks in `ready`), `src/renderer/notices/ShellNotices.tsx`
- Modify: `test/unit/system-files.test.ts`, `ipc-remote-class.test.ts`, `test/e2e/server-mode.spec.ts`,
  `test/e2e/web-access-plugins.spec.ts`

- [ ] `TrashAsks` on the shared-ask core: first answer wins, 5 min then "not moved", pending ones in `ready`; the file
      name shown as plain text in an `ApprovalDialog`
- [ ] chosen as `chooseLinkConfirm` chooses: always in server mode (never the queued fake); on the desktop while a
      browser is attached, on every view, so a trash started from a browser no longer waits on a native box nobody
      there can see; with no browser, the native confirm as before. The ask goes out through `ViewRegistry` to the
      window's views (Task 4's method for the browser views in server mode)
- [ ] the three channels with their `REMOTE_CLASS` in the same change; an answer is taken from any view of the window
      main bound, for an ask that is pending there
- [ ] a `trashItem` that rejects (no `gio` on a stock server, no trash on the volume) answers "not moved" with the
      reason, shown in the asking view, and main lives
- [ ] write tests: first answer wins, the timeout denies, a joining view gets the pending ask, the desktop takes it with
      a browser attached and keeps the native box without one, an answer for another window's ask refused, an answer
      for an unknown or settled ask refused; a recorder `SystemShell` whose `trashItem` rejects gives "not moved" with
      the reason
- [ ] e2e, server mode (bundled plugins on, the real `shell`, no session bus): trash a file from Files, confirm in the
      browser, the result Task 13 recorded, main alive; desktop with a browser: a trash from the browser answered there
- [ ] run tests, `npm run test:plugins` and `npm run test:e2e` (`server-mode`, `files-menu`, `web-access-plugins`) -
      must pass before next task

### Task 17: Projects from the browser: open and reopen [model: opus]

**Files:**
- Modify: `src/main/web/gateway.ts` (`:541`, a POST route), `src/shared/web-protocol.ts` (`WebProjectEntry`, the POST
  body and reply), `src/main/index.ts`, `src/renderer/web/picker.tsx`, `src/renderer/web/picker-model.ts`
- Modify: `test/unit/web-gateway.test.ts`, `picker-model.test.ts`, `window-manager.test.ts`,
  `test/e2e/server-mode.spec.ts`

- [ ] `GET /api/projects` adds `server` and the recent and missing projects only in server mode (`projects.recent` stays `no`)
- [ ] `POST /api/projects`, 404 outside server mode: the device cookie and the Origin check as every state-changing
      POST, the body capped as the sign-in routes'; exactly one of `{ open: path }` (absolute, resolved, an existing
      directory, never created) or `{ reopen: id }`, where the id is looked up in main's own recent list and nothing
      else of the body is used; main runs `windows.openPath` as the desktop does and answers the project id or the
      error text; no regexes in the parsing
- [ ] the picker in server mode: the recent projects, "Open folder…" with a server path field, a missing project shown
      as missing (no relink or forget), the error in the asking view, then on to `/?project=<id>`
- [ ] `ccc open <path>` from a server shell opens a project too, with nothing shown or focused (the no-display second
      launch, `cc-cockpit <path>`, is Task 14's)
- [ ] write tests: the POST 404 off server mode, with no Origin, a wrong Origin, no cookie, a path that is a file, a
      relative path, an oversize body, a non-JSON body, both keys, neither key, a missing or unknown `reopen` id; the
      GET lists recent projects only in server mode; `ccc open <path>` in server mode calls none of `show` and `focus`;
      e2e: open by path, an error for a bad path, reopen a recent one, main alive
- [ ] run tests and `npm run test:e2e` (`server-mode`, `web-access-settings`, `project-picker`, `cli`) - must pass
      before next task

### Task 18: Projects from the browser: close [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts` (`projects.close`, `adapted`), `src/main/ipc/router.ts`, `src/main/index.ts`, the web
  shell's project menu (`src/renderer/web/`), `src/renderer/notices/ApprovalDialog.tsx` (its use)
- Modify: `test/unit/ipc-remote-class.test.ts`, `ipc-router.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] `projects.close` takes no id: main closes the window it bound the calling view to, as "Close for everyone" does,
      and that window's views go back to the picker. A payload that names a project is ignored
- [ ] allowed for a remote view only in server mode (main's `server` and `view.remote`, never the payload); its
      `REMOTE_CLASS` (`adapted`) in the same change
- [ ] Close project in the browser shell: an `ApprovalDialog` in that view ("Close <name> for every device? Its tabs
      end."), then the call
- [ ] write tests: from a remote view on the desktop refused; in server mode the bound window closes; a payload naming
      another project still closes only the caller's window; the other windows and their views untouched; e2e: close,
      the picker again in every browser of that project, main alive with no project open
- [ ] run tests and `npm run test:e2e` (`server-mode`, `close-confirm`, `web-access-terminal`) - must pass before next
      task

### Task 19: Overlays held by browsers only [model: opus]

**Files:**
- Modify: `src/main/overlays/overlay-manager.ts` (`:20-25`, `:568`, `:689-702`), `src/main/index.ts` (the last-acting
  view it is given), `test/unit/overlay-manager.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] in server mode an HTML overlay with no origin view (`ccc overlay` from a Claude tab, the reviewer from a plugin
      command or a timer) is held by the window's last-acting browser view, else by the first browser to list it, never
      by the hidden page
- [ ] a holder that leaves passes it to another browser; with none attached it waits for the first, its queued messages kept
- [ ] the desktop is unchanged: the desktop view holds by default and takes back from a leaving browser
- [ ] write tests: no origin view goes to the last-acting browser, a leaving holder passes it on, none attached waits,
      never the desktop view in server mode; every existing holder test passes
- [ ] e2e: `ccc overlay` from a Claude tab opens in the browser with no "Take over" and its answer reaches the caller
- [ ] run tests and `npm run test:e2e` (`server-mode`, `overlays`, `web-access-plugins`) - must pass before next task

### Task 20: The web access card and devices in a browser [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts` (the six classes), `src/main/ipc/router.ts`, `src/main/index.ts`,
  `src/main/web/access-service.ts`, `src/main/web/access-log.ts`, `src/renderer/settings/GeneralPage.tsx` (`:308`),
  `WebAccessSection.tsx`, `web-access-model.ts`, `src/renderer/status/WebAccessChip.tsx`
- Modify: `test/unit/ipc-remote-class.test.ts`, `ipc-router.test.ts`, `web-access-service.test.ts`,
  `web-access-model.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] `settings.webAccess` (the read), `webAccess.state` and `webAccess.changed` become `adapted`: open to a remote view
      only in server mode, so the card follows changes live
- [ ] `settings.webDeviceRevoke`, `webDevicesRevokeAll` and `webDeviceDisconnect` become `adapted` the same way, behind
      an `ApprovalDialog`; `web-access.log` names the acting device
- [ ] everything that adds or widens stays `no` in both modes: `webAccessSet`, `Link`, `Regenerate`, `AddDevice`,
      `SetPassword`, `confirmAnswer`
- [ ] the card in a browser, read-only: mode, address, the secret store and Task 6's "other mode" states, the devices
      with Revoke and Disconnect, Desktop confirm disabled with its reason, None's shared-server warning, and "change
      these with `ccc web` on the server"; it never shows a link or a QR code
- [ ] write tests: each of the six channels from a remote view in both modes, decided by the bound caller and never the
      payload; each minting channel refused for a remote view in server mode; the acting device in the log
- [ ] e2e: the card shows a second device, Revoke from the browser closes that device's socket, and a `ccc web mode`
      change appears on the card without a reload
- [ ] run tests and `npm run test:e2e` (`server-mode`, `web-access-settings`) - must pass before next task

### Task 21: In-page notices for plugins [model: opus]

**Files:**
- Modify: `src/main/notifications/notifier.ts` (an in-page `NoticeBackend`), `src/shared/notify.ts` (the in-page caps),
  `src/main/index.ts` (the backend choice), `src/shared/ipc.ts` (the notice channels and `notify.chime`, each with its
  class), `src/main/ipc/router.ts`, `src/renderer/notices/ShellNotices.tsx`, `notice-state.ts`,
  `src/renderer/notify/chime.ts`, the web shell's title, `src/cli/guide/api.md`, `docs/design.md` (the limits text the
  guide test reads)
- Modify: `test/unit/notifier.test.ts`, `notice-state.test.ts`, `notify-sound.test.ts`, `ipc-remote-class.test.ts`,
  `ipc-router.test.ts`, `cli-guide.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] in server mode `ctx.notify` and `ccc notify` go to an in-page notice through a `NoticeBackend`, so
      `Notifier.wait` and the click action keep working. `ctx.notify`, and `ccc notify` from a tab or with `--project`,
      reach every browser view of that window; `ccc notify` with no project (it is projectless, `handlers.ts:126`)
      reaches every browser view of every window. Both through Task 4's `ViewRegistry` method. The desktop keeps its OS
      notifications (§6.1)
- [ ] the text is plain text, cut by the limits `src/shared/notify.ts` already has (`MAX_NOTIFY_TEXT`,
      `MAX_NOTIFY_TITLE`, `MAX_NOTIFY_ACTION_LABEL`); the one new number, the queue cap per window, goes into that file,
      and `api.md` and `docs/design.md` state it (`cli-guide.test.ts:234` guards the limits)
- [ ] a click goes through main with the view the router bound, for a notice main is showing in that view's window:
      refused for an unknown id, for another window's notice, and from a remote view on the desktop
- [ ] the chime reaches browser views (`notify.chime` becomes `adapted`) and never the hidden page; the browser tab's
      title shows a mark while a notice is unseen
- [ ] plugin notification text is never logged (it carries mail subjects)
- [ ] `api.md` says what `ctx.notify` does in server mode, in the same change (drift tests); if `src/sdk/types.ts`
      changed, copy it to the example and run `npm run build:example` in the same change
- [ ] write tests: plain text and the caps, the queue cap, `wait` and the click through the bound view, the three
      refused clicks, where a projectless `ccc notify` goes, the chime to browser views and not the hidden page, no
      plugin text in any log; e2e: `ccc notify` shows in the browser and its click runs the action
- [ ] run tests and `npm run test:e2e` (`server-mode`, `plugin-ctx`, `cli`) - must pass before next task

### Task 22: Core notices in server mode [model: sonnet]

**Files:**
- Modify: `src/main/index.ts` (the core notices at `:381`, the new-device and update notices),
  `src/main/socket/web-handlers.ts` (`status`), `src/main/web/access-log.ts`, `src/cli/guide/cli.md`
- Modify: `test/unit/cli-web.test.ts`, `web-access-service.test.ts`, `cli-guide.test.ts`

- [ ] in server mode the core notices (a new device, the marketplace revocation notice, the update notice) carry no
      plugin text and go to stdout, one line each, instead of an OS notification
- [ ] `ccc web status` lists them (`--json` too), the new device beside its `web-access.log` entry; `cli.md` says so
- [ ] the desktop is unchanged
- [ ] write tests: each of the three on stdout and in `status` in server mode, none of them an OS notification there;
      no link, token or plugin text in a line; the desktop path as before
- [ ] run tests and `npm run test:e2e` (`update-notice`, `marketplace-revoked`, `web-access-settings`) - must pass
      before next task

### Task 23: Desktop-only calls refused, and the Claude token [model: opus]

**Files:**
- Modify: `src/main/plugins/host-api.ts` (`:1543`, `:1557`, `:1572`, the webview open), `src/main/webview/webview-manager.ts`,
  `src/main/index.ts` (the shell page's webview channels, `:2105-2108`), `src/main/overlays/overlay-manager.ts` (the
  URL overlay open), `src/main/env/pty-env.ts` (`:38-40`), `src/cli/guide/api.md`, `src/cli/guide/webview.md`,
  `plugins/browser/skills/browser/SKILL.md` or the browser plugin's command reply
- Modify: `test/unit/host-api.test.ts`, `webview-manager.test.ts`, `overlay-manager.test.ts`, `pty-env.test.ts`,
  `test/e2e/server-mode.spec.ts`

- [ ] `ctx.files.reveal` and `openWithSystem` are refused by main's `server`, whatever the origin: `desktopOnly` refuses
      only a call with a remote origin view, a hint that lapses after 10 s, so a timer or a plugin command would reach
      `shell.showItemInFolder` or `shell.openPath` on the server
- [ ] no `WebContentsView` in server mode, whoever asks. The design's line is marked "inferred", so the refusal sits
      where a view is made, in `WebviewManager`, not only at `ctx.webview`'s open call: it covers the hidden page's own
      layout asking for a webview panel's view (the shell page's channels, `index.ts:2105-2108`) and the bundled browser
      plugin's `ctx.webview.navigate` at activation (`plugins/browser/src/host.ts:48`), which gets "not available in
      server mode" and must not fail the plugin's activation. URL overlays are refused at their open call with the same
      text. Browsers keep the placeholder
- [ ] the browser plugin says it once: one line in its skill or its command's reply, that the panel is not available
      in server mode, so Claude does not send the person to a panel that shows a placeholder
- [ ] `isStrippedVar`: `CLAUDE_CODE_OAUTH_TOKEN` becomes an exact-name exception, with a comment naming the boot-without-
      login setup (§9.10); every other `CLAUDE_CODE_*` is still stripped, in the login-shell capture too
- [ ] the guide says each refusal in the same change; if `src/sdk/types.ts` changed, copy it to the example and run
      `npm run build:example` in the same change
- [ ] write tests: both file calls refused in server mode from a view, a timer and a plugin command, and unchanged on
      the desktop; no view created in server mode for a webview panel asked by `ctx.webview`, by the shell page's
      channel or for a URL overlay; the token passes and every other `CLAUDE_CODE_*` does not
- [ ] e2e, server mode with bundled plugins on (`env: { CC_COCKPIT_NO_BUNDLED: '' }`): the Browser panel shows the
      placeholder, main made no view (a test hook counts them), the browser plugin is active, main alive
- [ ] run tests, `npm run test:plugins` and `npm run test:e2e` (`server-mode`, `webview-panel`, `browser-plugin`,
      `files-menu`, `tabs`) - must pass before next task

### Task 24: Plugin OAuth by pasting the failed redirect [model: opus]

**Files:**
- Modify: `src/main/oauth/oauth.ts` (`startLoopback` `:150`: the callback's checks as one function, a way to settle
  in-process), `src/main/oauth/plugin-oauth.ts`, `src/main/plugins/host-api.ts` (the remote-origin refusal),
  `src/shared/ipc.ts` (the paste channel, `adapted`), `src/main/ipc/router.ts`, `src/main/index.ts`,
  `src/renderer/notices/ShellNotices.tsx`, `src/cli/guide/api.md`
- Modify: `test/unit/oauth.test.ts`, `plugin-oauth.test.ts`, `ipc-remote-class.test.ts`, `ipc-router.test.ts`,
  `test/e2e/server-mode.spec.ts` (with `test/fakes/fake-oauth-server.ts`)

- [ ] in server mode `ctx.oauth` from a browser is allowed: the auth URL goes out as a link notice (Task 4, to the
      window and origin view `PluginOAuth` got with the sign-in) that has a box where the person pastes the failed URL.
      On the desktop a remote view still gets "sign in on the desktop"
- [ ] main mints an id for each pending sign-in and sends it with the notice. A paste names that id, and main looks it
      up among the pending sign-ins of the caller's window only (the view the router bound), never by the pasted host
      or port: two plugins of one window that each wait are told apart by it. One pending sign-in per plugin as today
- [ ] main settles the pending sign-in in-process with the callback handler's own checks, shared with the HTTP handler:
      the origin equals the pending one, the path is `/callback`, one `state` compared in constant time, the code's
      length, the error code's pattern. No request is made
- [ ] attempts are limited, the pasted text is capped, and every refusal has the same text and never echoes the URL
- [ ] `api.md` says how a sign-in works in server mode, in the same change; if `src/sdk/types.ts` changed, copy it to
      the example and run `npm run build:example` in the same change
- [ ] write tests: a wrong origin, path or `state`, an oversize code, the attempt limit, no request made (a fetch
      recorder), two pending sign-ins of one window settled each by its own id, no URL in errors or logs, the desktop
      unchanged; refused with the same text: no pending sign-in, a second paste after a settle, a paste from a remote
      view on the desktop, an id of another window's sign-in, an unknown id; e2e: a plugin signs in against the fake
      OAuth server by pasting the redirect in the browser
- [ ] run tests and `npm run test:e2e` (`server-mode`, `plugin-oauth`) - must pass before next task

### Task 25: Verify acceptance criteria (final regression pass) [model: sonnet]

- [ ] verify every Overview item is implemented, against §9.11's table row by row and §9.13's test list
- [ ] with web access off nothing listens, and on the desktop every v1 rule stands: a remote view may only Deny a link,
      `ccc web` only reads and revokes, the keychain is the store, the native dialogs and OS notifications are used
- [ ] run the full suite: `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`
- [ ] run `node --expose-gc scripts/web-terminal-bench.mjs` (the mirror worker's cost to main is unchanged)
- [ ] run `node scripts/server-mode-smoke.mjs` against `out/`, then `npm run package:dir` and the smoke script against
      the unpacked executable in `release/` (no app path on argv there). The packaged run ignores `CC_COCKPIT_TEST`,
      so it makes its one background fetch of the default index: run it once with the network off too, it must pass
- [ ] run `npm run test:coverage` and check the new code is covered (`server-mode.ts`, `server-start.ts`,
      `second-launch.ts`, `dialogs/`, `external/`, `secrets/key-file-store.ts`, `asks/`, `files/trash-asks.ts`,
      `socket/web-handlers.ts`)
- [ ] the grep and drift tests hold: only `electron-dialog.ts` imports `dialog`, only its adapter calls
      `shell.openExternal`, `safeStorage` is still imported only by `index.ts`, nothing sends past `ViewRegistry`, every
      `web.*` handler is in `HOST_ONLY_COMMANDS`, `examples/plugin/sdk/types.ts` equals `src/sdk/types.ts`

### Task 26: [Final] Documentation [model: sonnet]

**Files:**
- Modify: `docs/features.md`, `README.md`, `CLAUDE.md`, `docs/design-web.md`, `docs/design.md`, `src/cli/guide/*.md`

- [ ] `docs/features.md`, a "Server mode" section: `--server` and the detection, the systemd user unit of §9.1 with
      `loginctl enable-linger`, the first link and `ccc web`, the key file and what it protects, the Claude login and
      `CLAUDE_CODE_OAUTH_TOKEN`, reaching it (SSH tunnel, `tailscale serve`), never root and never `--no-sandbox`
- [ ] the installs, each marked as run or not run until the manual check has been done: the unpacked build (run by the
      smoke script), the deb (built and unpacked, never launched, `electron-builder.yml:39-42`), the AUR package
      (unpublished), the AppImage (its limits inferred). No install is called supported beyond what was run
- [ ] the same section says what differs from a desktop: a desktop launch that meets a server, a later desktop start on
      the same data dir finds web access on and its secrets asked for again, loopback is every local user, a notice
      does not reach a phone in a pocket, a revoke does not undo what an unlocked lost device already did from its
      shell, a start link read by someone else shows as an unknown device; and Known limitations
- [ ] `README.md`: server mode in the overview and the feature list
- [ ] `CLAUDE.md`: State and Commands (the smoke script), and the patterns: `server` as the one flag, the re-exec and
      its run-time fallback (never a `try` / `catch` around `execve`), the dialog and `openExternal` adapters in the
      adapter rule, the browser-views method of `ViewRegistry`, the key file store, `HOST_ONLY_COMMANDS`, the hidden
      page's rules, owner approvals; reword the web access rule from "cannot change the auth mode, bind, secrets, hosts
      or devices" to "cannot add or widen access" with the server-mode revoke
- [ ] `src/cli/guide`: check `ccc web` in `cli.md` and the server-mode notes in `api.md` and `webview.md` against what
      was built, with the drift tests (`cli-guide.test.ts`, `claude-plugins.test.ts`)
- [ ] `docs/design-web.md`: mark §9 implemented and add Task 1's real-app numbers to §9.1 (its re-exec text was
      committed with this plan); `docs/design.md` points at it. `examples/plugin/sdk/types.ts` was copied by the tasks
      that changed `src/sdk/types.ts`; only the push to the public repo is left (Post-Completion)
- [ ] run tests (guide drift, the workflow and packaging tests) - must pass
- [ ] move this plan to `docs/plans/completed/` (left to the orchestrator)

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- **the AppImage on a stock Ubuntu Server** (§9.1's check; it needs a second machine or VM, so it is not a task): does
  it start with FUSE present, and where unprivileged user namespaces are restricted (Ubuntu 23.10 and later) does it
  abort as the design infers. Under `execve`: one mount for the run, stdout kept, SIGTERM clean, with `process.execPath`
  as the executable; if that fails, §9.1 and Task 1's `exe` change. `docs/features.md` then states the result instead of
  "not run"
- the deb on the same Ubuntu Server: the systemd user unit with linger, a reboot, Claude tabs resumed, the open browser
  tab back by itself, `journalctl --user -u cc-cockpit` holding no link; `systemctl --user stop` reaching the app
  directly (the unit's main pid is the app)
- trash on that server: a file trashed from Files with no `gio` installed answers "not moved" with the reason, and with
  it installed reaches the trash
- a real session bus present but locked (a desktop distro started with no display): the key file is used and nothing
  waits on an unlock prompt
- `claude` signed in from a browser terminal tab, and a boot with `CLAUDE_CODE_OAUTH_TOKEN` in the unit's environment file
- a phone and a laptop signed in at once: a plugin link Allowed on the phone, a notice on both, Revoke of the phone
  from the laptop
- through `tailscale serve` and an SSH tunnel; `cc-cockpit` typed in a desktop session on a machine whose data dir a
  server run holds (the box and its Stop)
- the idle cost on the server (about 250 MB and under 1 % of a core in the spike)

**External system updates:**
- `BronOS/cc-cockpit-plugin-example` gets the types if `src/sdk/types.ts` changed
- the AUR files and the deb notes name server mode; release notes for the app version that ships web access and server mode
