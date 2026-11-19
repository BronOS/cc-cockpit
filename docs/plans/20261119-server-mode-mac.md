# Server mode on macOS: design note and plan

Base: master 9a12431, spike `spike/server-mode-darwin` (d9e2019; report in the guest-invite run folder,
`spike-server-mac.md`). Backlog item: `docs/backlog/server-mode-on-macos.md`. Owner decisions (2026-11-19), taken as
given: started by a launchd LaunchAgent only (no LaunchDaemon); desktop and server one at a time on a Mac; a feature of
this release, with every `launchServer` spec (the guest server spec included) green on the dev Mac.

## Decisions

1. **No Ozone: never-shown windows.** macOS has no headless platform; the server runs in the user's Aqua session.
   Under `server` (both platforms) the window factory, given `server` at construction, never shows a window (today
   `createWindow`'s `ready-to-show` → `show()` shows the hidden page) and sets `backgroundThrottling: false`, so the
   page should stay `visibilityState` visible with unthrottled timers for `tabs.screenAsk` (S1 measures). On darwin,
   before `ready`: `app.setActivationPolicy('accessory')` (no Dock icon, no menu bar) and
   `app.disableHardwareAcceleration()` (the spike ran GPU-off; nothing is composited on screen). Off-screen webviews
   unchanged (already `show: false`).
2. **No re-exec, no `--server-parent` on darwin.** The re-exec only puts the Ozone switch on argv; everything darwin
   needs is settable from main before `ready`. `decideServerMode`: darwin + `--server` →
   `{ server: true, detected: false, refuseWhenHeld: true }`, no exec, no test-run gate; nothing detected (a Mac always
   has a WindowServer); win32 still refuses ("server mode runs on Linux and macOS only"). `refuseWhenHeld`: losing the
   lock prints "server mode: not started: cc-cockpit already runs with this data dir (the desktop app or another
   server)" and `process.exit(1)`. Its argv still reaches the holder via `second-instance`; a desktop primary ignores a
   launch whose data says server (logged), opening and focusing nothing.
3. **Opening the app while the server runs.** LaunchServices routes Finder, Spotlight and `open` to the running
   bundle, so the server gets `activate`, which in server mode shows the **reopen notice**:
   `serverBoxMessage(address)` with Stop/Cancel, detail "Stop ends this run; the LaunchAgent starts it again at your
   next login". The one named exception to `serverDialogs`: through `electronDialogs()` (the adapter), reached only from
   `activate` (macOS-only, a gesture at this screen), one box at a time, `app.focus({ steal: true })` first; Stop is
   `quitLikeSigterm`; a test run answers from `SECOND_LAUNCH_ANSWER_ENV`. A direct exec is a second process: it loses
   the lock and gets the existing box (`losingLaunchAsks` accepts darwin).
   **Amended after T0 (S3, 2026-11-19):** `open -a` routes to the server as planned, but LaunchServices then turns the
   process from `UIElement` to `Foreground` and its Dock icon stays. So the `activate` handler re-applies
   `app.setActivationPolicy('accessory')` once the notice is answered (Cancel or Stop), and also when an `activate`
   arrives while a notice is already up and dismissed; T5 tests that the Dock icon is gone again after the box (on the
   unlocked screen, O1 repeats it with the packaged app).
4. **Sleep.** Darwin server: `powerSaveBlocker.start('prevent-app-suspension')` for the run (an IOPM no-idle-sleep
   assertion, which should also keep App Nap off: S4 measures); the plist sets `ProcessType Interactive` (unset,
   launchd throttles CPU and IO). Docs line: "A sleeping Mac serves nothing. Server mode keeps it from idle sleep (the
   display may sleep). Closing a MacBook's lid sleeps it unless on power with an external display; a manual Sleep, a
   logout or a flat battery stops the server, and after a reboot it starts only once you log in."
5. **Secrets.** The key file, as `selectSecretStore(server)` already does: the keychain would prompt with nobody at the
   screen, and the ad-hoc signature (`identity: '-'`) changes every update, resetting its ACL.
   `--password-store=basic` is Linux-only, not used. Chromium's cookie key ("cc-cockpit Safe Storage", webview
   partitions) must stay off the keychain too: main appends `use-mock-keychain` before `ready`, darwin's counterpart of
   `basic` (S2: does Electron 45 honour it?). Cookies do not move between desktop and server, as on Linux.
6. **`serverDialogs` stays.** A box would not abort main, but nobody is at the screen and approvals are the browsers'.
   Only exception: 3.
7. **Edit chords in streamed pages.** On macOS edit commands come from the menu and responder chain, not key events.
   On every server (the browser's OS is not the server's), a key down of Ctrl or Cmd alone (no Alt) with A, Z,
   Shift+Z, or Ctrl+Y carries `selectAll`, `undo` or `redo` as `Input.dispatchKeyEvent` with `commands` through the
   attached page protocol: the page still sees the keydown (preventing it keeps the page's own undo), it keeps its
   place on the input pipe, and the lane waits on its promise, as for `insertText`. `webContents.selectAll/undo/redo`
   is the detached fallback only (S6 checks).
8. **LaunchAgent: a documented plist, not `ccc web`.** `ccc web` is the running app's socket surface (exits 1 with no
   app; writes refuse outside server mode); an install runs when no server exists, so it would be a CLI-local command
   outside `HOST_ONLY_COMMANDS`: a weaker gate on the one command that creates a login-persistent, network-reachable
   process, which the gate exists to keep from a prompt-injected tab. Same model as the systemd unit (docs, not
   shipped). `features.md` carries, between markers, a heredoc writing
   `~/Library/LaunchAgents/dev.cc-cockpit.server.plist`: Label `dev.cc-cockpit.server`; ProgramArguments
   `/Applications/cc-cockpit.app/Contents/MacOS/cc-cockpit --server`; RunAtLoad; KeepAlive `{Crashed: true}` (a crash
   restarts; a refusal, failed start or Stop exits and stays down: no retry loop while the desktop runs); ProcessType
   Interactive; LimitLoadToSessionType Aqua; Umask 63 (0077); Soft/HardResourceLimits Core 0; StandardOut/ErrorPath
   `$HOME/Library/Logs/cc-cockpit-server.log` (launchd does not expand `~`). Then `launchctl bootstrap gui/$(id -u) …`,
   `kickstart -k` after an update, `bootout` + `rm` to remove. No token in the plist.
9. **e2e.** Darwin `launchServer` passes `--server` alone, the agent's real start, so on a Mac the e2e covers the start
   path. `expectMainAlive` also checks no visible `BrowserWindow` and, on darwin, no Dock icon.
10. **Smoke.** Darwin: processes by `ps -A -o pid=,pgid=,stat=` instead of `/proc`; runs `--server` (pipe), pty link
    mode, `ccc web stop`, off-screen webviews, taken port; detection and fallback skipped with a line; checks argv
    without Ozone, the pid's idle-sleep line in `pmset -g assertions` (`NoIdleSleepAssertion named: "Electron"`, the
    per-pid name of the PreventUserIdleSystemSleep kind), `lsappinfo` type UIElement; a second `--server` on the same
    data dir exits 1 with the held line. Reopen case (`out/` only, no launchd): `--server` from a copy of Electron.app
    with its own bundle id, `open -a <copy>`: no second process; the notice prints nothing, so it is seen by its
    effect, with `SECOND_LAUNCH_ANSWER_ENV` stop (the server exits 0) and cancel (type back to UIElement, still
    serving); nothing left. A real LaunchAgent (bootstrap the docs plist, `open -a`, `bootout`) is the owner's, O1.
11. **Packaging.** Same bundle; `electron-builder.yml` `mac:` has no `extendInfo`, and must never get
    `LSUIElement`/`LSBackgroundOnly` (they would hide the desktop's Dock icon): asserted in `packaging-config.test.ts`.
12. **Docs.** T6 lists them; user-facing additions: macOS start, plist, one at a time, sleep, Gatekeeper (open the app
    once from Finder first), privacy prompts (Desktop, Documents, Downloads granted once at the Mac, again after an
    update; a network bind with the firewall on asks there), log path.

## Plan

- **T0 Spike, tab-runnable on `out/`** [model: opus]. S1: never shown + `backgroundThrottling: false`:
  visibilityState, `tabs.screenAsk`, timers after 6 min (intensive throttling starts at 5). S3: `open -a` on the repo's
  Electron.app routes to a `--server` run, starts no process; no `activate` at start or under Playwright. S4: App Nap
  "No", the assertion, a browser terminal echo after 10 idle minutes and `pmset displaysleepnow`, frames still stream.
  S6: `commands` on an unfocused off-screen page, order against `sendInputEvent`, a prevented keydown. Numbers into
  design-web.md §9.15; a changed decision goes to the lead first.
- **O1 Owner checklist** (desktop quit; a packaged build ignores test answers): S2 on `npm run package:dir`, observe
  only (never delete the real Safe Storage item): any keychain access or prompt from a server whose Browser panel sets
  a cookie, with and without `use-mock-keychain`; if not honoured, the lead decides in-memory webview partitions.
  Finder routing and a Dock flash with the real bundle under the agent; Gatekeeper first open; the LaunchAgent run (docs plist bootstrapped, `open -a`, `bootout`, nothing left) with
  the packaged executable.
- **T1 Start on darwin** [model: opus]. `server-mode.ts`, `second-launch.ts`, `windows/window-manager.ts`
  (`SecondInstanceData`), `index.ts` (decision 2, `losingLaunchAsks`, GPU off so T2's baseline is final),
  `server-fixtures.ts` (darwin args). Unit: `server-mode.test.ts` (win32 refusal; `refuseWhenHeld` exits 1 with the
  line, never quits), `second-launch.test.ts` (desktop primary ignores a darwin server launch; Linux rows unchanged).
  Acceptance: units, lint, typecheck green; `launchServer` starts on the Mac.
- **T2 Server specs on the Mac** [model: sonnet]. server-mode, server-download, server-secrets, server-webview,
  remote-desktop, rooms-view, editor-split-web, marketplace-revoked, guest-server specs. Skip win32 only; the spike's
  test fixes (Meta chords, the folder-browser goto race fixed by waiting for the picker URL, the Ozone assertion per
  platform); new spec: `--server` against a desktop on the same data dir exits 1 with the line, the desktop opens
  nothing; select-all `fixme` on darwin until T4. `guest-server` never ran: a product failure goes to the lead, not
  patched here. Acceptance: the list passes twice in a row on the Mac.
- **T3 Hidden, Dock-less, no sleep, no keychain** [model: opus]. New `src/main/server-platform.ts` (pure, injected
  effects), `index.ts`, `windows/create-window.ts`, `windows/electron-window-factory.ts`, `expectMainAlive`, test hook
  `serverPlatform`. Unit: platform table (darwin server, darwin desktop, Linux server), window options under `server`.
  e2e: no visible window, Dock hidden, acceleration off, blocker on, hidden page visible. Acceptance: the T2 list
  passes with no window or Dock icon appearing.
- **T4 Edit chords** [model: opus]. `shared/webview-keys.ts` (`editCommandOf`), `main/webview/webview-input.ts`,
  `electron-offscreen-webview.ts`. Unit: mapping (Ctrl/Cmd, Alt excluded, Ctrl+Y), the lane holds behind a command.
  e2e: select-all unfixme'd, Cmd+Z / Cmd+Shift+Z, a page preventing Cmd+Z undoes nothing. Acceptance: server-webview
  green on the Mac; Backspace, arrows, Option/Cmd+arrows probed, failures filed to backlog.
- **T5 Reopen notice** [model: sonnet]. Includes the decision 3 amendment (accessory policy re-applied after the box). New `src/main/reopen-notice.ts`, `second-launch.ts` (shared text), `index.ts`
  (`activate` under `server`). Unit: one box at a time, Stop quits, Cancel nothing, test answer. Acceptance: e2e shows
  no notice after start (hook count 0); `app.emit('activate')` with cancel leaves main alive, with stop exits 0.
- **T6 Docs and packaging** [model: sonnet]. `docs/features.md`, `CLAUDE.md` (top line; server-mode bullet: re-exec
  Linux-only, `refuseWhenHeld`, darwin setup; secrets: `basic` Linux-only, `use-mock-keychain`; hidden page; dialogs
  exception; harness, smoke and guest e2e lines), `docs/design-web.md` (§9.1, §9.14, §9.15), `docs/design.md`, backlog
  item deleted, `packaging-config.test.ts`. Acceptance: `grep -rn "Linux only"` over docs, `src/cli/guide`, tests
  leaves only true statements; `plutil -lint` of the plist block passes.
- **T7 Smoke on darwin** [model: opus]. `scripts/server-mode-smoke.mjs` per decision 10. Acceptance: passes on `out/`,
  the reopen case included; LaunchAgent and packaged runs in O1; results recorded in `features.md` and §9.15.
- **R1 Release gate** (the lead owns or waives in writing): T1, T3 and T4 touch Linux paths with no Linux e2e; run the
  Linux smoke and server specs on a VM.

## Risks

- S2: an unanswered keychain prompt could stall webview cookies after every update.
- S3: if LaunchServices starts a second process instead, the loser's box covers it.
- Privacy and firewall prompts, the lid, and an update leaving the old image running: docs only.
