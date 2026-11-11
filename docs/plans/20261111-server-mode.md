# Server mode (headless)

External review: sol / high

## Overview

Someone installs cc-cockpit on a Linux server with no display (a home server, a VM) and uses it only through web access,
from browsers. The model is web access v1's: one person with several devices, every signed-in device is that person. What
changes is that no desktop exists, so the three things v1 keeps on the desktop move: who gets in goes to a shell on the
server (`ccc web`), seeing who is in goes to the log, the CLI and the browsers' card, and approving what runs as code goes
to the browsers. Design: `docs/design-web.md` §9 (settled by the owner, reviewed once), with its pointers in §0, §4.1,
§5.6, §6.1, §7 (phase 6), §8 and §11.

Server mode ships in the same branch and PR as web access v1 (`feat/web-access`): it is design phase 6, built on the
committed v1 (plan `docs/plans/completed/20261110-web-access.md`).

Covered: the start (`--server`, detection with no display, the Ozone switches, systemd), web access always on with the
start link, `ccc web`, the key file secret store, the dialog and `openExternal` adapters, the hidden page's own state,
owner approvals in the browser (plugin link, trash), projects opened and closed from the browser, overlays held by
browsers, the web access card and device revoke in a browser, in-page notices, the OAuth paste box, the Claude token
exception. Out (§9.14): macOS and Windows, relink and forget from the browser, `ccc web` writes on the desktop, a Files
"Download" item, more than one person.

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
  `shell.openExternal` after launch. In a test run queued fakes replace the trash, close and link dialogs (`index.ts:449`,
  `:1514-1528`): they hid the crash under Ozone headless (spike).
- Hidden page: `WindowManager` (`focusAny` `:276`, `focusProject` `:290`, `activate` `:306`, `remoteViewGone` `:320-327`,
  `openView` `:420-424`, `closeRequested` `:488-507`), `windows/electron-window-factory.ts` (`finish` `:98`),
  `views/view-sizes.ts` (`canSize` `:183-185`), `tabs/terminal-sizes.ts`, `overlays/overlay-manager.ts` (holder rule
  `:20-25`, `:568`, `:689-702`; terminal overlay answerer `:839`), `hooks/ccc-offer.ts` (wired at `index.ts:1982`).
- Web access: `web/settings.ts` (`applyWebAccessPatch` `:276`, the "never rewritten" rule `:5-8`, `storedWebAccess`
  `:381`), `web/access-service.ts`, `web/auth.ts` (`addDeviceLink`), `web/gateway.ts` (`GET /api/projects` `:541`,
  `MAX_SIGN_IN_BODY` `:97`, `readBody` `:154`), `web/access-log.ts`, `shared/web-protocol.ts` (`CLOSE` `:150`),
  `renderer/web/bridge.ts` (final closes `:211`, `:377`), `renderer/web/picker.tsx`, `picker-model.ts`.
- CLI: `shared/protocol.ts` (`TOKENLESS_COMMANDS` `:32`, `PROJECTLESS_COMMANDS` `:65`, `WINDOW_TOKEN_COMMANDS` `:77`),
  `shared/manifest.ts` (`CORE_CLI_COMMANDS` `:82`), `main/socket/socket-server.ts` (caller kinds `:300-330`),
  `main/socket/handlers.ts`, `cli/args.ts`, `cli/client.ts` (silent exit 0 when the app is not running `:415`),
  `cli/guide/cli.md`. The marketplace tools import `src/shared/manifest` (`marketplace/tools/src/check-entry.ts:23`).
- Secrets: `secrets/secret-store.ts` (`SecretStore` `:34`, `safeStorageSecretStore` `:90`, `selectSecretStore` `:190`,
  `FAKE_PREFIX`), `secrets/plugin-secrets.ts`, `secrets/password-store.ts`.
- Asks and notices: `plugins/link-asks.ts` (`LinkAsks` `:46`, `chooseLinkConfirm` `:130`, `LINK_ASK_MS`),
  `files/trash-dialog.ts`, `files/system-files.ts` (`ConfirmTrash` `:49`), `notifications/notifier.ts` (`NoticeBackend`
  `:54`), `renderer/notices/ShellNotices.tsx` (link asks and link notices), `renderer/notify/chime.ts`.
- Other: `oauth/oauth.ts` (`startLoopback` `:150`, `ERROR_CODE`, `safeEqual`), `oauth/plugin-oauth.ts`,
  `plugins/host-api.ts` (`desktopOnly` `:1543`, `openExternal` `:1496`), `env/pty-env.ts` (`isStrippedVar` `:38`).
- Remote classes today (`shared/ipc.ts:1689+`): `projects.*` `no`, `settings.webAccess*` and `settings.webDevice*` `no`,
  `webAccess.state` / `webAccess.changed` `no`, `notify.chime` `no`, `links.answer` `adapted`.
- Evidence: the spike (Electron 45.1.0, Linux, no session bus; dialogs abort main with SIGTRAP, the page answers
  `tabs.screenAsk`, 250 MB idle) and the design review (`app.relaunch` loses stdout; `spawnSync` with inherited stdio
  keeps it). Both are folded into §9.
- **Plan-time measurements** (2026-11-11, minimal Electron 45.1.0 apps, Node 24.22.1, no `DISPLAY` / `WAYLAND_DISPLAY`,
  no session bus; not the real app, which Task 1 measures):
  - the lock before `ready` works with no display: `requestSingleInstanceLock` is true, `releaseSingleInstanceLock`
    lets the spawned process take it, and a second no-display launch gets false while the holder receives
    `second-instance` with its `additionalData`;
  - `spawnSync` as §9.1 writes it: a SIGTERM sent to the first process alone kills it and the child lives on,
    reparented;
  - §9.1's fallback does not hold either: with an async `spawn` the first process returns from its top-level script,
    Electron goes on to initialize the platform, fails ("The platform failed to initialize. Exiting.") and exits 1 in
    under 3 s, leaving the child orphaned before any signal could be forwarded;
  - `process.execve` (Node's, present in Electron 45.1.0) replaces the first process's image: same pid, stdout kept, the
    lock taken again, SIGTERM quits it cleanly with status 0. Not in the design; Task 1 says how it is used.
- Project rules (CLAUDE.md): main is the only authority; Electron-only modules behind adapter files; a new IPC channel
  needs its `REMOTE_CLASS` in the same change and an `adapted` handler decides by the caller main bound; no regexes in
  the gateway's settings or path parsing; exec is argv-only; a new `ccc` command or `ctx` behaviour needs its guide text
  in the same change (drift tests); every wait in `src/cli/client.ts` has a deadline; dense "why" comments.

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
- A plan-time check (Tasks 1 and 10) records its result in this file next to its checkbox, and when the result differs
  from what the design assumed, the later tasks it names are updated before they start
- Every manual run of the app in a task uses its own temp data dir and temp `HOME`, with `CC_COCKPIT_SOCK`, `APP_TAB_*`,
  `CLAUDE_CODE_*` and `ELECTRON_*` unset: never the dev app's data dir, never a running dev app
- The design is settled: a task that finds §9 wrong against the code or a measurement records it with ⚠️ and stops for
  the owner instead of choosing a new design

## Testing Strategy

- **unit tests**: required for every task; logic takes fakes (the fake window factory, a recorder `dialog` and `shell`,
  a fake socket, an injected `fstat`), as in web access v1
- **security tests** with each piece: `web` from a session or window token; minting commands outside server mode; a
  remote Allow outside server mode; `no`-class channels from a remote view in server mode; `POST /api/projects` with no
  cookie, a wrong Origin, an oversize body; key file as a symlink, with a wider mode, another owner, a wrong length; the
  OAuth paste with a wrong origin, path or `state`; no secret in any log or in `ccc web status`
- **smoke script** (`scripts/server-mode-smoke.mjs`, Task 1, extended by Tasks 5, 6, 8 and 9): the built app with no
  display and no switches, the only test of the detection and the second process (Playwright attaches to the first
  process, so it cannot cover them)
- **e2e** (Playwright, `npm run test:e2e`): from Task 10 on, the harness launches the server process directly
  (`--server --ozone-platform=headless --disable-gpu --password-store=basic`, no display, Linux only) and drives it from
  the web browser fixture; every task that touches UI adds its steps to `test/e2e/server-mode.spec.ts`. Server-mode
  specs never use the queued test dialogs for the link, trash and close paths: those fakes hid the crash. Existing e2e
  specs keep passing, and tasks that touch always-on desktop paths (2, 3, 6, 7, 11 to 17, 19) run them in their exit
  gate

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

- **Start.** A pure decision (`src/main/server-mode.ts`: platform, env, argv in; `{ server, spawnArgs }` or a refusal
  out) at the top of `index.ts`. When server mode applies and the Ozone switch is not on argv, the first process checks
  the lock, then starts the app again with `--server --ozone-platform=headless --disable-gpu --password-store=basic` and
  inherited stdio. Main keeps `server` for the run.
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

- Spawn args: `[...argv after the executable, '--server', '--ozone-platform=headless', '--disable-gpu',
  '--password-store=basic']`; the executable is `process.env.APPIMAGE` when set, else `process.execPath`. No spawn when
  `--ozone-platform=headless` is already on argv (the second process, a unit with the switches, the e2e harness).
  `--server` off Linux: "server mode runs on Linux only", exit 1.
- stdout lines (exact texts in §9.1 to §9.3): the detected-start line, "server mode: turned web access on in app.json"
  (once), the address, the add-device link (TTY and link mode only) or "add a device: `ccc web add-device`", the
  wrapper's path (`<data>/bin/ccc`), a refused stored setting with its `ccc web set ... --confirm ...` line.
- Key file: 32 random bytes, `O_CREAT | O_EXCL`, mode 0600 at open; opened `O_NOFOLLOW`, checked by `fstat` on the
  descriptor (regular file, the user's, no group or other bits, 32 bytes). Value: `KEYFILE-V1:` + base64(iv 12 bytes,
  tag, ciphertext).
- CLI socket: `HOST_ONLY_COMMANDS` in `shared/protocol.ts` (the `web.*` requests), projectless, not in
  `WINDOW_TOKEN_COMMANDS`, answered only for a caller with no token. `web` joins `CORE_CLI_COMMANDS`.
- Gateway: `GET /api/projects` adds `server: true` and the recent and missing projects in server mode;
  `POST /api/projects` (`{ open: path }` or `{ reopen: id }`, body capped as the sign-in routes') is 404 otherwise.
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

### Task 1: Server-mode start: the decision, the lock, the second process, the no-display proof [model: opus]

**Files:**
- Create: `src/main/server-mode.ts`, `scripts/server-mode-smoke.mjs`, `test/unit/server-mode.test.ts`
- Modify: `src/main/index.ts` (the top, before and around the lock at `:189-194`; `start()` gets `server`),
  `src/main/windows/window-manager.ts` (`projectPathFromArgv`), `test/unit/window-manager.test.ts`

⚠️ Design gap, measured at plan time (Context): neither §9.1's `spawnSync` nor its async-spawn fallback lets a SIGTERM
sent to the first process alone stop the app. The third checkbox below settles it in the real app; using
`process.execve` or the parent watch is outside §9.1 and needs the owner's yes before this task starts.

- [ ] `server-mode.ts`: a pure function, `{ platform, env, argv, execPath }` in; out `{ server: false }`,
      `{ server: true, detected, spawn?: { exe, args } }` or `{ refuse }`. Server mode with `--server`, or on Linux with
      neither `DISPLAY` nor `WAYLAND_DISPLAY`; `spawn` only when `--ozone-platform=headless` is not on argv; `exe` is
      `APPIMAGE` when set; off Linux `--server` refuses and nothing is detected. `projectPathFromArgv` skips `--server`
      and the three switches
- [ ] `index.ts`, before `ready`, when `spawn` is set: check the lock (held: argv goes to the holder as any second
      launch, exit 0, nothing spawned); else release it, print "no display: starting cc-cockpit in server mode, web
      access on; stop with Ctrl-C" (only when detected, not with `--server`), start the second process with inherited
      stdio and exit with its status (128 + n for a signal). `server` is kept for the run and passed into `start()`
- [ ] **plan-time check, the first process and SIGTERM.** Measure in the real app, in this order, keep the first that
      holds and write each result here: (1) §9.1's `spawnSync`: does a SIGTERM to the first pid alone end the second
      process cleanly; (2) §9.1's fallback, an async `spawn` forwarding SIGTERM and SIGINT: does the first process
      outlive its top-level script with no display; (3) `process.execve(exe, [exe, ...args], env)` after releasing the
      lock: one process, same pid, stdout, the lock, SIGTERM and Ctrl-C clean, the status its own; (4) `spawnSync` plus
      the second process quitting as SIGTERM does when its parent pid changes. (3) or (4) kept: update Technical
      Details, Task 11's Stop, the smoke script's pid checks and Task 21's §9.1 and unit text
- [ ] **plan-time check, the lock before `ready`.** In the real app with no display: the first process takes and
      releases the lock, the second takes it, and a second no-display launch loses it and hands over its argv without
      starting a second Electron. If it does not hold: the first process skips the check and the second process loses
      the lock itself (a second launch then costs one more Electron); record which
- [ ] `scripts/server-mode-smoke.mjs` and **the proof of the full app with `--server` under no display**: the built
      app (`out/`, or an executable given as an argument) with no display, a temp data dir and `HOME`, no session bus,
      `app.json` pre-written (web access on, a random loopback port, mode None, the update check off) and
      `CC_COCKPIT_MARKETPLACE_URLS` empty, so no network. Two runs: with `--server`, and with no flag at all (detected).
      Each waits for `<data>/app.sock`, gets `GET /` 200 from the gateway, sends SIGTERM to the first process only, and
      checks the exit status and that no process of the run is left; exits 1 on any failure. Record here: the start
      lines, that `--server` is not a switch Chromium reads (`hasSwitch('headless')` false), the time to quit
- [ ] write tests: the decision table (platform, `DISPLAY`, `WAYLAND_DISPLAY`, `--server`, the switch already present,
      `APPIMAGE`, the refusal off Linux, `--password-store=basic` in the args, an `ssh -X` environment stays desktop);
      argv parsing skips the flag and the switches
- [ ] run tests and the smoke script - must pass before next task

### Task 2: Dialog adapter [model: sonnet]

**Files:**
- Create: `src/main/dialogs/electron-dialog.ts`, `src/main/dialogs/dialogs.ts`, `test/unit/dialogs.test.ts`,
  `test/unit/no-direct-dialog.test.ts`
- Modify: `src/main/index.ts` (the `dialog` import, `:459`, `:489`, `:1527`, `:1600-1608`, `:1655-1663`, `:1686`, the
  RULE comment at the top), `src/main/plugins/link-dialog.ts`, `src/main/windows/close-dialog.ts`,
  `src/main/files/trash-dialog.ts`

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
- [ ] run tests and `npm run test:e2e` (link-confirm, close-confirm, files-menu, project-picker) - must pass before next task

### Task 3: One adapter for `shell.openExternal` [model: opus]

**Files:**
- Create: `src/main/external/electron-open-external.ts`, `src/main/external/open-external.ts`,
  `test/unit/open-external.test.ts`, `test/unit/no-direct-open-external.test.ts`
- Modify: `src/main/index.ts` (`:239`, `:831`, `:1143`, `:1669`, `:2027`, the RULE comment),
  `src/main/windows/create-window.ts` (`:75`), `src/main/overlays/electron-url-view.ts` (`:45`),
  `src/main/plugins/host-api.ts` (`openExternal`, `:1496`), `src/main/ipc/router.ts` (`:440`)

- [ ] every call goes through the adapter: `ctx.openExternal`, `app.openExternal`, the update notice, plugin OAuth, the
      webview manager, the window-open handler, the URL overlay view. It looks `shell.openExternal` up at each call, so
      the e2e recorder that replaces it after launch still runs
- [ ] in server mode never on the server: a link notice (`app.linkNotice`) to the asking view (the view main bound,
      never the payload), or to every browser view of the window when no view asked; with no browser attached, refused
      with a log line that carries no query string (an OAuth URL has its `state` there)
- [ ] the desktop is unchanged: the OS browser for the desktop view, v1's notice for a remote view
- [ ] a grep test: only the adapter file calls `shell.openExternal`
- [ ] write tests: each caller type in both modes, the no-browser refusal, the notice reaching only the asking view,
      nothing opened on the server in server mode
- [ ] run tests and `npm run test:e2e` (the specs that record `openExternal`) - must pass before next task

### Task 4: The key file secret store [model: opus]

**Files:**
- Create: `src/main/secrets/key-file-store.ts`, `test/unit/key-file-store.test.ts`
- Modify: `src/main/secrets/secret-store.ts` (`selectSecretStore` gets `server`), `src/main/secrets/plugin-secrets.ts`,
  `src/main/paths.ts` (the key file's path), `src/main/index.ts` (`:235`), `src/main/web/auth.ts`, the secret settings
  field's state, `test/unit/secret-store.test.ts`, `plugin-secrets.test.ts`, `secret-settings.test.ts`, `web-auth.test.ts`

- [ ] `key-file-store.ts` (node `crypto` and `fs`, no Electron), one more `SecretStore`: the key is made on first start
      with `O_CREAT | O_EXCL` and mode 0600 at open, never chmod after, never made again over an existing file; opened
      with `O_NOFOLLOW` and checked by `fstat` on that descriptor; refused with the reason when it is not a regular
      file, not the user's, readable by group or others, or not 32 bytes
- [ ] values are AES-256-GCM with a random 96-bit IV, stored as `KEYFILE-V1:` + base64(iv, tag, ciphertext)
- [ ] a new key made while `KEYFILE-V1:` values exist (a restored backup, a deleted key file): start logs it with the
      count, those values answer "the key file was replaced: enter it again", and the count is kept for `ccc web status`
- [ ] the mode decides the store: `selectSecretStore` returns the key file in server mode and the keychain on the
      desktop (which keeps refusing `basic_text`); a test run's fake store keeps its place. Each store refuses the
      other's values with "stored by server mode's key file: enter it again here" (or "by the desktop's keychain"), and
      start logs how many stored values belong to the other store
- [ ] what the person sees: a secret settings field shows "stored in the other mode: enter it again" instead of "set";
      `ctx.secrets.get` rejects with that text; devices stay signed in, the access link cannot be shown until it is
      regenerated and the password must be set again
- [ ] write tests in plain Node in a temp dir: made 0600 with `O_EXCL`; a symlink, a wider mode, another owner (an
      injected `fstat`) and a wrong length refused; round trip; one changed byte fails the tag; the replaced-key count
      and text; each store refuses the other's; server mode always picks the key file, the desktop never does
- [ ] run tests - must pass before next task

### Task 5: Web access is on: what server mode writes, refuses and prints [model: opus]

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
- [ ] write tests: the two start writes and the one line; `confirm` and off refused only in server mode; the refused
      stored risk with its exact line and the record unchanged; the link printed only for a TTY; no token in the log.
      The smoke script (stdout is a pipe) checks its output has the address and no `#t=`
- [ ] run tests and the smoke script - must pass before next task

### Task 6: Start order and stop [model: opus]

**Files:**
- Create: `src/main/server-start.ts` (the order as a function over fakes), `test/unit/server-start.test.ts`
- Modify: `src/main/index.ts` (`:2515-2522`, `:2563-2572`), `src/main/web/access-service.ts` (what `apply` reports),
  `src/shared/web-protocol.ts` (`CLOSE`), `src/renderer/web/bridge.ts` (`:211`, `:377`),
  `scripts/server-mode-smoke.mjs`, `test/unit/web-bridge.test.ts`, `web-protocol.test.ts`

- [ ] in server mode main awaits the CLI socket and the gateway before any window opens or tab restores; either failing
      (the port is taken, the socket cannot start) logs the reason and exits 1, so systemd retries without Claude tabs
      resuming and being killed on each try. A stored setting the gateway refuses (Task 5) is not a failure
- [ ] the desktop start is unchanged: the socket's false only logs and the gateway is not awaited
- [ ] a server stop (SIGTERM, `ccc web stop` later) closes every view with a new non-final close code instead of
      `CLOSE.appQuit`; the bridge retries it with backoff and shows the host as away, so open browser tabs come back
      after a restart, an update or a reboot. A desktop quit keeps `CLOSE.appQuit` and its "Reload this page"
- [ ] the smoke script gains a case: the port already taken, expect exit status 1 and that no window opened first
- [ ] write tests: the order (socket, gateway, then windows), each failure exits 1 before a window, a refused setting
      does not exit; the bridge retries the new code and still stops on `appQuit` and `turnedOff`
- [ ] run tests, the smoke script and `npm run test:e2e` (the desktop start and quit) - must pass before next task

### Task 7: The hidden page [model: opus]

**Files:**
- Modify: `src/main/windows/window-manager.ts` (`:276`, `:306`, `:320-327`, `:420-424`, `:488-507`, the bounds write
  near `:447`), `src/main/windows/electron-window-factory.ts` (`finish`), `src/main/views/view-sizes.ts` (`:183-185`),
  `src/main/tabs/terminal-sizes.ts`, `src/main/tabs/tab-manager.ts`, `src/main/overlays/overlay-manager.ts` (terminal
  overlay sizes, `:839`), `src/main/layout/` (zone sizes), `src/main/hooks/ccc-offer.ts`, `src/main/index.ts` (`:489`
  `askClose`, `:1982`)
- Modify: `test/unit/window-manager.test.ts`, `terminal-sizes.test.ts`, `overlay-manager.test.ts`,
  `layout-service.test.ts`, `ccc-offer.test.ts`

- [ ] a state of its own, not Keep running's set: in server mode `WindowManager` never calls `focus`, `show`, `hide` or
      `showPicker`, across `remoteViewGone`, `openView`, `focusAny`, `activate` and a second launch; it never makes the
      picker window, and with no project open the app keeps running with the gateway up
- [ ] no close ask in server mode (`askClose` absent): nobody can press the window's close button
- [ ] the hidden page is never a measured view in `ViewSizes`, for tabs and terminal overlays, so it never sizes a pty
      nor answers their queries; a pty keeps the size the last browser gave it, and a tab no browser has sized (new, or
      restarted with none attached) gets 120x40
- [ ] a crash (`render-process-gone`) or a failed load reloads the page with a log line, with a pause between tries, and
      never closes the window (today a failed load closes it, which would end the project's tabs)
- [ ] server mode writes neither the window's bounds nor the page's zone sizes to the project record, and skips the ccc
      offer (its modal left the hidden page's root inert)
- [ ] write tests with the fake window factory: none of the four calls happens in server mode on each path; the desktop
      view is never measured; 120x40 for a tab nobody sized; a crash and a failed load reload and the window stays;
      bounds and zone sizes not written; the desktop keeps every one of today's behaviours
- [ ] run tests, the smoke script and `npm run test:e2e` (window lifetime, bounds, zones) - must pass before next task

### Task 8: `ccc web` part 1: host-only, `status`, `revoke`, `stop` [model: opus]

**Files:**
- Create: `src/main/socket/web-handlers.ts`, `test/unit/cli-web.test.ts`
- Modify: `src/shared/protocol.ts` (`HOST_ONLY_COMMANDS`), `src/shared/manifest.ts` (`CORE_CLI_COMMANDS`),
  `src/main/socket/socket-server.ts` (`:300-330`), `src/main/web/access-service.ts`, `src/main/index.ts`,
  `src/cli/args.ts`, `src/cli/client.ts` (`:415`), `src/cli/guide/cli.md`, `scripts/server-mode-smoke.mjs`,
  `marketplace/tools/dist` (only if its bytes change)
- Modify: `test/unit/protocol.test.ts`, `socket-server.test.ts`, `cli-args.test.ts`, `cli-client.test.ts`,
  `cli-commands.test.ts`, `cli-guide.test.ts`, `manifest.test.ts`

- [ ] `HOST_ONLY_COMMANDS`: a fixed list in `shared/protocol.ts`, projectless, kept out of `WINDOW_TOKEN_COMMANDS`,
      answered only for a caller with no token; a session or window token gets "run `ccc web` from a shell on the
      server, outside cc-cockpit". The comment says it is not a boundary and why it is there (§9.4)
- [ ] `web` joins `CORE_CLI_COMMANDS`, so a plugin contributing a `web` command becomes invalid; run
      `npm run build:marketplace-tools` and commit `marketplace/tools/dist` if its bytes changed
- [ ] `ccc web status [--json]`, answered in both modes: mode, listen address and external origin, listening or the
      error, the secret store and how many values it cannot read (Task 4), server mode or not, the devices (name, signed
      in with, last seen). Never a link, a token or a hash
- [ ] `ccc web revoke <device>|--all`, answered in both modes; `ccc web stop` quits as SIGTERM does, in server mode only.
      Outside server mode everything but `status` and `revoke` is refused with "use Settings › Web access", decided by
      main's `server`
- [ ] the CLI: with the app not running `ccc web` prints "cc-cockpit is not running" and exits 1 (plugin commands and
      hooks keep their silent 0); every wait has a deadline
- [ ] guide text in `cli.md` in the same change: what it does, and that it is for a shell on the server, not for Claude
- [ ] write tests: `web` refused for a session and a window token and answered tokenless; outside server mode only
      `status` and `revoke`; no secret in `status`; not running exits 1; `web` reserved; guide drift. The smoke script
      now asks `ccc web status --json` and has a second run that stops with `ccc web stop`
- [ ] run tests and the smoke script - must pass before next task

### Task 9: `ccc web` part 2: `link`, `add-device`, `password`, `mode`, `set` [model: opus]

**Files:**
- Modify: `src/main/socket/web-handlers.ts`, `src/main/web/access-service.ts`, `src/main/web/auth.ts`,
  `src/main/web/access-log.ts`, `src/cli/args.ts`, `src/cli/client.ts`, `src/cli/guide/cli.md`,
  `scripts/server-mode-smoke.mjs`
- Modify: `test/unit/cli-web.test.ts`, `cli-args.test.ts`, `cli-client.test.ts`, `cli-commands.test.ts`,
  `cli-guide.test.ts`, `web-access-service.test.ts`

- [ ] server mode only, each refused elsewhere with "use Settings › Web access": `ccc web link [--regenerate]` (made on
      first use; regenerate kills it and its devices) and `ccc web add-device` (one-time, 10 minutes)
- [ ] `ccc web password`: from stdin, never argv (argv shows in `ps`); on a TTY a no-echo prompt read before the 40 s
      deadline starts; stdin capped; the hash through the existing off-thread scrypt
- [ ] `ccc web mode link|password|none`: `confirm` refused; `none` prints §9.12's shared-server warning
- [ ] `ccc web set [--bind] [--port] [--origin] [--host]... [--tls-cert --tls-key | --no-tls] [--confirm
      none-network|plain-http]` through the same `applyWebAccessPatch` as the settings page: a §4.3 risk is refused with
      its confirm text printed (`WEB_RISK_TEXT`) and applies only with its `--confirm`; no regexes in the parsing
- [ ] `web-access.log` gets each change as made from the server shell, never a secret; the guide text in `cli.md` covers
      the new subcommands in the same change
- [ ] write tests: each command in server mode and its refusal outside; the password never in argv, a request line or a
      log; a risk without `--confirm` refused with the text and the record unchanged; `confirm` mode and turning off
      refused; a link is usable once. The smoke script signs in with `ccc web add-device` (a `POST /auth/link`, 200)
- [ ] run tests and the smoke script - must pass before next task

### Task 10: The server-mode e2e harness and its first specs [model: opus]

**Files:**
- Create: `test/e2e/server-fixtures.ts`, `test/e2e/server-mode.spec.ts`, `test/e2e/server-secrets.spec.ts`
- Modify: `test/e2e/fixtures.ts` (extra args, variables removed from the app's env), `test/e2e/web-fixtures.ts`

- [ ] `launchServer`: the second process directly (`--server --ozone-platform=headless --disable-gpu
      --password-store=basic`), `DISPLAY` and `WAYLAND_DISPLAY` removed from the app's env only (the browser fixture
      keeps its display), Linux only (skipped elsewhere), a project folder on argv
- [ ] sign in through `ccc web add-device` (the data dir's wrapper, no tab token in its env) with the browser fixture;
      a terminal tab's output and input in the browser; main is alive at the end of every spec (a helper every later
      server spec calls)
- [ ] a server stop and start on the same data dir: the open browser page comes back by itself (Task 6's close code)
- [ ] `server-secrets.spec.ts`, with no session bus and no fake secret store: `ccc web password`, sign in, restart,
      sign in again; `secret.key` exists with mode 0600
- [ ] **plan-time check, `shell.trashItem` with no session bus** (the spike did not run it): one call through the real
      `shell` in the harness; record whether the file reaches the trash or the call fails cleanly. Task 13's e2e
      expects whichever it is; a crash or a hang is a ⚠️ for the owner
- [ ] existing e2e specs still pass
- [ ] run `npm run test:e2e` - must pass before next task

### Task 11: A desktop launch meets a server [model: opus]

**Files:**
- Create: `src/main/second-launch.ts` (what a losing launch does, as a pure function plus the socket ask),
  `test/unit/second-launch.test.ts`
- Modify: `src/main/windows/window-manager.ts` (`SecondInstanceData`, `asSecondInstanceData`), `src/main/index.ts`
  (`:189-194`, `:2499-2508`), `test/unit/window-manager.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] `SecondInstanceData` carries whether the second launch has a display; data without it (another build holding the
      lock) reads as today
- [ ] a server primary ignores the argv of a launch that has a display (it opens nothing there, logs a line); a launch
      with no display (`cc-cockpit <path>` from a server shell) opens the project as any second launch does
- [ ] a losing launch with a display asks the socket for `web status` with a 2 s deadline and no token; when the answer
      says server mode it shows a native box through the dialog adapter, "cc-cockpit runs in server mode on this machine
      (web access at <address>)", with Stop (`web stop`) or Cancel, then exits; any other answer, or none, exits as today
- [ ] desktop meets desktop is unchanged (`focusAny`, no visible delay)
- [ ] write tests: the decision table; the ask's deadline; the box only for a server answer; Stop sends `web stop`;
      e2e: a second launch with a display against the server process, its box answered Stop (a queued answer in the
      test run: this box is a desktop process's), the server exits cleanly
- [ ] run tests and `npm run test:e2e` - must pass before next task

### Task 12: Plugin link asks: any signed-in device may Allow [model: opus]

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
- [ ] write tests: a remote Allow taken only in server mode; the wait with no browser and the timeout; a joining view
      gets the pending ask; Allow disabled for the first second, Enter and typing never approve; e2e: `ccc plugin link`
      from a tab, Allowed in the browser, the plugin loads, main is alive
- [ ] run tests and `npm run test:e2e` (link-confirm, web-access-plugins) - must pass before next task

### Task 13: Trash confirm as a shared ask [model: opus]

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
      there can see; with no browser, the native confirm as before
- [ ] the three channels with their `REMOTE_CLASS` in the same change; an answer is taken from any view of the window
      main bound, for an ask that is pending there
- [ ] write tests: first answer wins, the timeout denies, a joining view gets the pending ask, the desktop takes it with
      a browser attached and keeps the native box without one, an answer for another window's ask refused
- [ ] e2e, server mode (bundled plugins on, the real `shell`, no session bus): trash a file from Files, confirm in the
      browser, the result Task 10 recorded, main alive; desktop with a browser: a trash from the browser answered there
- [ ] run tests, `npm run test:plugins` and `npm run test:e2e` (files-menu) - must pass before next task

### Task 14: Projects from the browser [model: opus]

**Files:**
- Modify: `src/main/web/gateway.ts` (`:541`, a POST route), `src/shared/web-protocol.ts` (`WebProjectEntry`, the POST
  body and reply), `src/shared/ipc.ts` (`projects.close`, `adapted`), `src/main/ipc/router.ts`, `src/main/index.ts`,
  `src/renderer/web/picker.tsx`, `src/renderer/web/picker-model.ts`, the web shell's project menu
- Modify: `test/unit/web-gateway.test.ts`, `picker-model.test.ts`, `ipc-remote-class.test.ts`, `ipc-router.test.ts`,
  `test/e2e/server-mode.spec.ts`

- [ ] `GET /api/projects` adds `server` and the recent and missing projects only in server mode (`projects.recent` stays `no`)
- [ ] `POST /api/projects`, 404 outside server mode: the device cookie and the Origin check as every state-changing
      POST, the body capped as the sign-in routes'; `{ open: path }` (absolute, resolved, an existing directory, never
      created) or `{ reopen: id }`; main runs `windows.openPath` as the desktop does and answers the project id or the
      error text; no regexes in the parsing
- [ ] the picker in server mode: the recent projects, "Open folder…" with a server path field, a missing project shown
      as missing (no relink or forget), the error in the asking view, then on to `/?project=<id>`
- [ ] Close project in the browser shell: an `ApprovalDialog` in that view ("Close <name> for every device? Its tabs
      end."), then `projects.close`, allowed for a remote view only in server mode (main's `server`); main closes the
      window as "Close for everyone" does and its views go back to the picker
- [ ] `ccc open <path>` and `cc-cockpit <path>` from a server shell open a project too, with nothing shown or focused
- [ ] write tests: the POST 404 off server mode, with no Origin, no cookie, a path that is a file, a relative path, an
      oversize body; the GET lists recent projects only in server mode; `projects.close` from a remote view on the
      desktop refused; e2e: open by path, an error for a bad path, close, the picker again, main alive
- [ ] run tests and `npm run test:e2e` - must pass before next task

### Task 15: Overlays held by browsers only [model: opus]

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
- [ ] run tests and `npm run test:e2e` (overlays, web-access-plugins) - must pass before next task

### Task 16: The web access card and devices in a browser [model: opus]

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
- [ ] the card in a browser, read-only: mode, address, the secret store and Task 4's "other mode" lines, the devices
      with Revoke and Disconnect, Desktop confirm disabled with its reason, None's shared-server warning, and "change
      these with `ccc web` on the server"; it never shows a link or a QR code
- [ ] write tests: each of the six channels from a remote view in both modes, decided by the bound caller and never the
      payload; each minting channel refused for a remote view in server mode; the acting device in the log
- [ ] e2e: the card shows a second device, Revoke from the browser closes that device's socket, and a `ccc web mode`
      change appears on the card without a reload
- [ ] run tests and `npm run test:e2e` (web-access-settings) - must pass before next task

### Task 17: In-page notices [model: opus]

**Files:**
- Modify: `src/main/notifications/notifier.ts` (an in-page `NoticeBackend`), `src/main/index.ts` (the backend choice,
  the core notices at `:381`, the new-device and update notices), `src/shared/ipc.ts` (the notice channels and
  `notify.chime`, each with its class), `src/main/ipc/router.ts`, `src/main/socket/web-handlers.ts` (`status`),
  `src/renderer/notices/ShellNotices.tsx`, `notice-state.ts`, `src/renderer/notify/chime.ts`, the web shell's title,
  `src/cli/guide/api.md`
- Modify: `test/unit/notifier.test.ts`, `notice-state.test.ts`, `notify-sound.test.ts`, `ipc-remote-class.test.ts`,
  `cli-web.test.ts`, `test/e2e/server-mode.spec.ts`

- [ ] in server mode `ctx.notify` and `ccc notify` go to an in-page notice through a `NoticeBackend`, so
      `Notifier.wait` and the click action keep working; it reaches every browser view of the plugin's window. The
      desktop keeps its OS notifications (§6.1)
- [ ] the text is plain text, its length and the queue capped; a click goes through main with the view the router bound
- [ ] the chime reaches browser views (`notify.chime` becomes `adapted`) and never the hidden page; the browser tab's
      title shows a mark while a notice is unseen
- [ ] core notices (a new device, the marketplace revocation notice, the update notice) carry no plugin text: a stdout
      line each, listed in `ccc web status`, the new device beside its `web-access.log` entry. Plugin notification
      text is never logged
- [ ] `api.md` says what `ctx.notify` does in server mode, in the same change (drift tests)
- [ ] write tests: plain text and both caps, `wait` and the click through the bound view, the chime to browser views
      and not the hidden page, core notices on stdout and in `status`, no plugin text in any log; e2e: `ccc notify`
      shows in the browser and its click runs the action
- [ ] run tests and `npm run test:e2e` - must pass before next task

### Task 18: Desktop-only calls refused, and the Claude token [model: sonnet]

**Files:**
- Modify: `src/main/plugins/host-api.ts` (`:1543`, `:1557`, `:1572`, the webview open), `src/main/webview/webview-manager.ts`,
  `src/main/overlays/overlay-manager.ts` (the URL overlay open), `src/main/env/pty-env.ts` (`:38-40`),
  `src/cli/guide/api.md`, `src/cli/guide/webview.md`
- Modify: `test/unit/host-api.test.ts`, `webview-manager.test.ts`, `overlay-manager.test.ts`, `pty-env.test.ts`

- [ ] `ctx.files.reveal` and `openWithSystem` are refused by main's `server`, whatever the origin: `desktopOnly` refuses
      only a call with a remote origin view, a hint that lapses after 10 s, so a timer or a plugin command would reach
      `shell.showItemInFolder` or `shell.openPath` on the server
- [ ] `ctx.webview` and URL overlays are refused at the open call in server mode ("not available in server mode"), so
      main never makes a `WebContentsView` for the hidden page's layout; browsers keep the placeholder
- [ ] `isStrippedVar`: `CLAUDE_CODE_OAUTH_TOKEN` becomes an exact-name exception, with a comment naming the boot-without-
      login setup (§9.10); every other `CLAUDE_CODE_*` is still stripped, in the login-shell capture too
- [ ] the guide says each refusal in the same change
- [ ] write tests: both file calls refused in server mode from a view, a timer and a plugin command, and unchanged on
      the desktop; no view created for a webview panel or a URL overlay in server mode; the token passes and every
      other `CLAUDE_CODE_*` does not
- [ ] run tests - must pass before next task

### Task 19: Plugin OAuth by pasting the failed redirect [model: opus]

**Files:**
- Modify: `src/main/oauth/oauth.ts` (`startLoopback` `:150`: the callback's checks as one function, a way to settle
  in-process), `src/main/oauth/plugin-oauth.ts`, `src/main/plugins/host-api.ts` (the remote-origin refusal),
  `src/shared/ipc.ts` (the paste channel, `adapted`), `src/main/ipc/router.ts`, `src/main/index.ts`,
  `src/renderer/notices/ShellNotices.tsx`, `src/cli/guide/api.md`
- Modify: `test/unit/oauth.test.ts`, `plugin-oauth.test.ts`, `ipc-remote-class.test.ts`, `ipc-router.test.ts`,
  `test/e2e/server-mode.spec.ts` (with `test/fakes/fake-oauth-server.ts`)

- [ ] in server mode `ctx.oauth` from a browser is allowed: the auth URL goes out as a link notice (Task 3) that has a
      box where the person pastes the failed URL. On the desktop a remote view still gets "sign in on the desktop"
- [ ] main settles the pending sign-in in-process with the callback handler's own checks, shared with the HTTP handler:
      the origin equals the pending one, the path is `/callback`, one `state` compared in constant time, the code's
      length, the error code's pattern. No request is made
- [ ] main picks the pending sign-in from the caller's window (the view the router bound), never from the pasted host
      or port; one pending sign-in per plugin as today
- [ ] attempts are limited, the pasted text is capped, and errors never echo the URL
- [ ] `api.md` says how a sign-in works in server mode, in the same change
- [ ] write tests: a wrong origin, path or `state`, an oversize code, the attempt limit, no request made (a fetch
      recorder), the pending sign-in taken from the caller's window, no URL in errors or logs, the desktop unchanged;
      e2e: a plugin signs in against the fake OAuth server by pasting the redirect in the browser
- [ ] run tests and `npm run test:e2e` (plugin-oauth) - must pass before next task

### Task 20: Verify acceptance criteria (final regression pass) [model: sonnet]

- [ ] verify every Overview item is implemented, against §9.11's table row by row and §9.13's test list
- [ ] with web access off nothing listens, and on the desktop every v1 rule stands: a remote view may only Deny a link,
      `ccc web` only reads and revokes, the keychain is the store, the native dialogs and OS notifications are used
- [ ] run the full suite: `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`
- [ ] run `node --expose-gc scripts/web-terminal-bench.mjs` (the mirror worker's cost to main is unchanged)
- [ ] run `node scripts/server-mode-smoke.mjs` against `out/`, then `npm run package:dir` and the smoke script against
      the unpacked executable in `release/` (no app path on argv there)
- [ ] run `npm run test:coverage` and check the new code is covered (`server-mode.ts`, `server-start.ts`,
      `second-launch.ts`, `dialogs/`, `external/`, `secrets/key-file-store.ts`, `asks/`, `files/trash-asks.ts`,
      `socket/web-handlers.ts`)
- [ ] the grep tests hold: only `electron-dialog.ts` imports `dialog`, only its adapter calls `shell.openExternal`,
      `safeStorage` is still imported only by `index.ts`

### Task 21: [Final] Documentation [model: sonnet]

**Files:**
- Modify: `docs/features.md`, `README.md`, `CLAUDE.md`, `docs/design-web.md`, `docs/design.md`, `src/cli/guide/*.md`,
  `examples/plugin/sdk/types.ts` (only if `src/sdk/types.ts` changed)

- [ ] `docs/features.md`, a "Server mode" section: `--server` and the detection, the systemd user unit of §9.1 with
      `loginctl enable-linger`, the supported installs (deb and AUR; the AppImage's limits), the first link and
      `ccc web`, the key file and what it protects, the Claude login and `CLAUDE_CODE_OAUTH_TOKEN`, reaching it
      (SSH tunnel, `tailscale serve`), never root and never `--no-sandbox`
- [ ] the same section says what differs from a desktop: a desktop launch that meets a server, loopback is every local
      user, a notice does not reach a phone in a pocket, a revoke does not undo what an unlocked lost device already did
      from its shell, a start link read by someone else shows as an unknown device; and Known limitations
- [ ] `README.md`: server mode in the overview and the feature list
- [ ] `CLAUDE.md`: State and Commands (the smoke script), and the patterns: `server` as the one flag, the dialog and
      `openExternal` adapters in the adapter rule, the key file store, `HOST_ONLY_COMMANDS`, the hidden page's rules,
      owner approvals; reword the web access rule from "cannot change the auth mode, bind, secrets, hosts or devices"
      to "cannot add or widen access" with the server-mode revoke
- [ ] `src/cli/guide`: check `ccc web` in `cli.md` and the server-mode notes in `api.md` and `webview.md` against what
      was built, with the drift tests (`cli-guide.test.ts`, `claude-plugins.test.ts`)
- [ ] `docs/design-web.md`: mark §9 implemented and write into §9.1 what Task 1 measured and built; `docs/design.md`
      points at it. If `src/sdk/types.ts` changed: `cp src/sdk/types.ts examples/plugin/sdk/types.ts` and
      `npm run build:example`
- [ ] run tests (guide drift, the workflow and packaging tests) - must pass
- [ ] move this plan to `docs/plans/completed/` (left to the orchestrator)

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- **the AppImage on a stock Ubuntu Server** (§9.1's plan-time check; it needs a second machine or VM, so it is not a
  task): does it start with FUSE present, and where unprivileged user namespaces are restricted (Ubuntu 23.10 and
  later) does it abort as the design infers. `docs/features.md` then states the result instead of "inferred"
- the deb on the same Ubuntu Server: the systemd user unit with linger, a reboot, Claude tabs resumed, the open browser
  tab back by itself, `journalctl --user -u cc-cockpit` holding no link
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
