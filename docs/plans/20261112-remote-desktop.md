# Remote servers in the desktop app

## Overview
- The desktop app's picker connects to a cc-cockpit running in server mode on another machine and opens its projects
  in native desktop windows (one per server and project, every shortcut the app's own). Design:
  `docs/design-remote-desktop.md`.
- Two ways in: **SSH** (the app runs the person's `ssh`: `ccc web status --json` and `ccc web add-device` over SSH,
  then `ssh -L` to the server's loopback gateway; the SSH key is the pairing) and **Direct** (the access link or a
  one-time add-device link, as a browser would use).
- A remote window is a sandboxed `BrowserWindow` loading the server's web client, treated exactly as a browser tab:
  no preload, its own in-memory partition, permissions denied, navigation pinned to the server's origin. The device
  cookie lives in the secret store, not in a cookie file.
- One server change: in server mode the gateway's Host check accepts the loopback names on any port (a tunnel's local
  port); `ccc web status --json` reports the app version and the gateway's scheme.
- One web-client change: in a remote window (user agent `cc-cockpit-desktop/…`) the client keeps the desktop's key
  table (Cmd/Ctrl+W, T, N, Ctrl+Tab) and names the device after this machine.

## Context (from discovery)
- Gateway checks: `src/main/web/checks.ts` (`allowedHosts`, `checkHost`, `checkOrigin`), `gateway.ts` (Host check on
  every request, 401 `not signed in`), `auth.ts` (`DEVICE_COOKIE = 'ccc_device'`, `deviceCookie`, token sign-in only in
  link mode, `addDeviceLink` one at a time).
- `ccc web`: `src/cli/args.ts`, `src/cli/client.ts` (`web add-device` prints only the link on stdout),
  `src/main/socket/web-handlers.ts`, `src/shared/web-access.ts › WebCliStatus` (no version or scheme today).
- Web client: `src/renderer/web/main.tsx` (`?project=<id>` routing, picker at `/`, `#t=` sign-in, reconnect banner),
  `sign-in.ts`, `picker.tsx`.
- Web client keys and names: `src/renderer/commands/keybindings.ts › setCommands` (`webKeyTable` when `isWebShell()`),
  `web-keys.ts`; `src/renderer/web/sign-in.ts › deviceName`; `/auth/session` answers 200 `device: null` when signed out.
- Desktop picker: `src/renderer/picker/ProjectPicker.tsx`, shared parts `parts.tsx`, `picker-model.ts`; picker calls go
  through the generic `invoke` (`src/preload/index.ts`) to `src/main/ipc/router.ts` (`ctx.kind === 'picker'`).
- Lifecycle: `src/main/windows/window-manager.ts` (`pickerClosed` quits on Linux with no project window; last-window
  rule; `focusAny`), `index.ts` `browser-window-created` / `focus` handlers and `isOffscreenWindow`.
- Hardening precedent: `src/main/webview/webview-hardening.ts`, `webview-manager.ts` (open budget).
- Secrets: `SecretStore` is `encrypt`/`decrypt` only; `storedSecretValues` lists stored values for the status.
- Main: `src/main/menu.ts` (`AppMenu`, key table `''`), `windows/` (`window-manager.ts`, `create-window.ts`,
  `permissions.ts`), `external/open-external.ts` (`createOpenExternal`), `secrets/secret-store.ts`, `store/json-file.ts`,
  `ipc/`, `src/shared/ipc.ts` (`REMOTE_CLASS`).
- Server e2e: `test/e2e/server-fixtures.ts` (`launchServer`), `test/e2e/web-fixtures.ts`.

## Development Approach
- **testing approach**: Regular (code first, then tests), as in the previous web plans.
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- Electron and process spawns behind adapters (CLAUDE.md): `child_process.spawn` of `ssh` only in
  `main/remote/ssh-process.ts`; `BrowserWindow` / `session` for remote windows only in
  `main/remote/electron-remote-window.ts`. Logic in plain modules with fakes.
- New IPC channels (`remote.*`) get `REMOTE_CLASS` `no` in the same change.
- Dense "why" comments (repo convention). No regexes in link, host or path parsing.
- Revised after a fable plan review (2026-11-12): web-client key table and device name, `WindowManager` lifecycle,
  re-pair through `/auth/session`, the cookie in the server record (SecretStore is encrypt/decrypt only), ssh_config
  overrides and a fixed `sh -c` script, webview-grade hardening, a stable origin for zone sizes, no protocol gate.

## Testing Strategy
- **unit tests** (vitest): every task, fakes for spawn, sessions, windows and the secret store.
- **e2e** (Playwright, `npm run test:e2e`): the desktop app plus a `launchServer` server on loopback; Direct pairing in
  Task 6, SSH through a fake `ssh` on PATH (runs the remote command locally, forwards `-L` with a small Node relay) in
  Task 7.
- `node scripts/server-mode-smoke.mjs` after Task 1 (the status reply and Host rule change server code).

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with actual work done

## Solution Overview
- **Server**: Host rule widened for loopback literals in server mode only; `WebCliStatus` gains `version` and
  `scheme`.
- **Web client**: desktop key table and device name when the UA carries `cc-cockpit-desktop/`.
- **`RemoteServers`** (main, plain logic): saved servers in `app.json › remoteServers`, validated and capped; the
  device cookie encrypted in the record; the preferred local port; tracks windows by (server, project) from their URL.
- **`SshTunnel`** (main, plain logic over a spawn adapter): BatchMode `ssh` commands, free local port, restart with
  backoff, stop 30 s after a server's last window closes.
- **`RemoteWindow`** (adapter): sandboxed window, partition `persist:remote-<id>` with the cookie kept as a session
  cookie (never on disk), webview-grade hardening, re-pair through `/auth/session`, user agent suffix naming this
  machine; counted by `WindowManager`.
- **Picker**: Servers section, Connect to server form, Rename / Forget / Open server's picker, recent remote projects.

## Technical Details
- `RemoteServer` shape, SSH argv, pairing order, Host rule and its safety argument: design §2, §5.1–5.3.
- Version gate: SSH needs a server whose status reports `scheme` (absent = older server: "update cc-cockpit on
  <host>"); `scheme: 'https'` over SSH is refused (§5.4). No protocol-version gate.
- Remote command: one fixed `sh -c` script (`$CCC`, else `$HOME/.config/cc-cockpit/bin/ccc`, else `ccc`), the override
  passed as a single-quoted `CCC=` assignment with `'` refused; empty stdout is an error; only the last line is parsed.
- ssh options on every run: `-T`, `BatchMode=yes`, `ControlMaster=no`, `ControlPath=none`, `RemoteCommand=none`,
  `ClearAllForwardings=yes` (design §5.1).
- Host check: a character allowlist (letters, digits, `.`, `-`, `_`, `@`, `:`, `[`, `]`), not starting with `-`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: a real SSH host, a real revoked device, a dropped network, macOS.

## Implementation Steps

### Task 1: Server side: loopback on any port, version and scheme in the status [model: opus]

**Files:**
- Modify: `src/main/web/checks.ts`, `src/main/web/gateway.ts`
- Modify: `src/shared/web-access.ts`, `src/main/web/access-service.ts`, `src/cli/client.ts` (status text)
- Modify: the existing checks test (`test/unit/*checks*.test.ts`), `test/unit/cli-web.test.ts`

- [x] `checkHost` (or the gateway's call) accepts `127.0.0.1:<n>`, `localhost:<n>`, `[::1]:<n>` for any port `n` in
      1–65535 when `server` is set; the desktop keeps the exact list; comment carries design §5.3's argument
- [x] `checkOrigin` unchanged; a test proves `Origin: http://127.0.0.1:3000` with `Host: 127.0.0.1:<P>` is still
      refused and `Origin` = `Host` on another loopback port is accepted in server mode only
- [x] `WebCliStatus` gains `version` (app version) and `scheme` (`http` / `https`, the gateway's own); `ccc web
      status` text shows the version
- [x] tests: Host rule (server mode on/off, malformed ports, names that only look loopback such as `127.0.0.1.evil`),
      status fields
- [x] run unit tests and `node scripts/server-mode-smoke.mjs` - must pass before task 2

### Task 2: Web client in a desktop window: key table and device name [model: sonnet]

**Files:**
- Create: `src/shared/remote-agent.ts` (`DESKTOP_UA_TOKEN = 'cc-cockpit-desktop/'`, `parseDesktopAgent(ua)`)
- Modify: `src/renderer/commands/keybindings.ts`, `src/renderer/web/sign-in.ts`
- Modify: their unit tests

- [x] `parseDesktopAgent`: version and hostname from the suffix, length-capped, plain text only; undefined otherwise
- [x] `setCommands`: skip `webKeyTable` when the UA parses as the desktop app (comment: the UA only picks the chords
      the page listens to; a forged one changes nothing on the server)
- [x] `deviceName`: "cc-cockpit desktop on <hostname>" for the desktop agent
- [x] tests: parse (good, missing, oversize, control characters), the key table both ways, the device name
- [x] run tests - must pass before task 3

### Task 3: Saved servers and the link parser [model: sonnet]

**Files:**
- Create: `src/shared/remote-servers.ts` (types, `parseRemoteLink`, `checkSshHost`, `remoteCommand`)
- Create: `src/main/remote/remote-servers.ts` (store over `app.json`, secret keys)
- Create: `test/unit/remote-servers.test.ts`

- [x] `RemoteServer` type (with encrypted `cookie` and `localPort`) and validation of `app.json › remoteServers` on
      read (cap 32 servers, 8 recents, string lengths, unknown `via` kinds dropped)
- [x] `parseRemoteLink(text)`: `URL` only, `http:`/`https:`, no userinfo, path `/`, optional `#t=<token>`; returns
      `{ origin, token? }` or a refusal text
- [x] `checkSshHost` (allowlist), `remoteCommand(args, override?)` (the fixed `sh -c` script and its argv, `CCC=` quoting,
      `'` refused)
- [x] store: add, rename, forget (drops the record and its cookie), set / clear the cookie through `SecretStore`
      (`encrypt`/`decrypt`; no store → not kept, flagged for the picker), record a recent project, save `localPort`;
      ids random; the cookie added to `storedSecretValues`
- [x] tests for each (success and refusals)
- [x] run tests - must pass before task 4

### Task 4: SSH commands and the tunnel [model: opus]

**Files:**
- Create: `src/main/remote/ssh-process.ts` (spawn adapter, the only `child_process` use here)
- Create: `src/main/remote/ssh-tunnel.ts` (`runRemote`, `SshTunnel`)
- Create: `test/unit/ssh-tunnel.test.ts`

- [x] `runRemote(host, args)`: `ssh` with the common options (`-T`, BatchMode, ConnectTimeout, ControlMaster=no,
      ControlPath=none, RemoteCommand=none, ClearAllForwardings) `-- host sh -c <script> sh …`, bounded (20 s),
      stdout capped, last stdout line parsed, empty stdout an error, last stderr line kept for the error text
- [x] `status(server)`: parses `web status --json` (checked fields only), applies the version gate and the https
      refusal; `addDevice(server)`: the link's token only
- [x] `SshTunnel`: the saved `localPort` when free, else a free one on `127.0.0.1:0` (saved), `-N -L
      127.0.0.1:L:127.0.0.1:P` with the common options, `ExitOnForwardFailure` and keepalives, ready when the port
      accepts a connection, two retries when stderr names that port, restart with backoff on exit while windows are
      open, stop 30 s after the last window, killed on app quit (child registry)
- [x] error texts for the common ssh failures (host key, auth, timeout, `ccc` missing, server not running)
- [x] tests with a fake spawn: argv exactly, timeouts, restart, port retry, stop delay, quit
- [x] run tests - must pass before task 5

### Task 5: Remote window adapter [model: opus]

**Files:**
- Create: `src/main/remote/electron-remote-window.ts` (adapter)
- Create: `src/main/remote/remote-windows.ts` (logic: tracking, focus, pairing loop)
- Create: `test/unit/remote-windows.test.ts`, `test/unit/no-remote-preload.test.ts` (grep test)

- [ ] window: no preload, `sandbox`, `contextIsolation`, no node, `devTools` off when packaged; partition
      `persist:remote-<id>`; user agent suffix `cc-cockpit-desktop/<version> (<hostname>)` (`remote-agent.ts`)
- [ ] hardening as webviews: `setWindowOpenHandler` denies, `http(s)` to `createOpenExternal` under the webview open
      budget; `will-navigate` and redirects pinned to the server's origin; `will-download`, `login` cancelled;
      `will-prevent-unload` ignored; the WebRTC IP policy; `onBeforeRequest` cancels loopback hosts other than the
      server's origin; default certificate checks; permissions denied (check the existing non-default-session handler
      covers the partition)
- [ ] cookie: set from the record as a session cookie (no expiry) before the first load; `cookies.on('changed')`
      saves a new `ccc_device` (encrypted) and re-sets it without expiry, loop-guarded; a removal clears it
- [ ] spike check, kept as an e2e assertion in Task 7: after quit the partition's `Cookies` file holds no
      `ccc_device`; if it does, switch to an in-memory partition and note it (zone sizes then reset each launch)
- [ ] tracking: (server, project) from `?project=` on navigation; focus an existing window; name from the server's
      `/api/projects` through `ses.fetch`; title `<server> — <project>`; record the recent project
- [ ] re-pair: on `did-finish-load` or a completed `/auth/session` request, main fetches `/auth/session`; `device:
      null` in link mode over SSH mints one add-device link (serialised per server) and reloads with `#t=`, the
      server's other windows reload after; a second failure in a row shows the error instead of looping
- [ ] grep test: no preload in the adapter, `persist:remote-` partitions used nowhere else
- [ ] tests with fake window and session: hardening, cookie save/restore and loop guard, tracking and names, re-pair
      once and serialised
- [ ] run tests - must pass before task 6

### Task 6: Main wiring, IPC and window lifecycle [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts` (`remote.list`, `remote.connect`, `remote.open`, `remote.rename`, `remote.forget`,
  `remote.changed` event; all `REMOTE_CLASS` `no`)
- Modify: `src/main/ipc/router.ts` (beside the `ctx.kind === 'picker'` calls), `src/main/index.ts`,
  `src/main/windows/window-manager.ts`
- Modify: tests of the IPC classes, the router and the window manager

- [ ] handlers accept calls only from the desktop picker page (`ctx.kind === 'picker'`), never a browser view
- [ ] `remote.connect`: SSH (status → add-device when link mode → tunnel → window) or Direct (parse → window with
      `#t=`); errors returned as text for the form
- [ ] `WindowManager` gets `remoteWindowCount()`: `pickerClosed` does not quit and the last-window rule does not
      reopen the picker while a remote window is open; the last remote window closing shows the picker; `focusAny` /
      `activate` include remote windows; Connect closes the picker as opening a project does
- [ ] remote windows excluded from the `browser-window-created` / `focus` handlers in `index.ts` (as
      `isOffscreenWindow`); the menu already resolves them to `''` (verify with a test, no change)
- [ ] tunnels and remote windows closed on quit; a remote window is never restored or listed as a project window
- [ ] tests: classes, the caller check, the lifecycle rules (Linux quit, mac stays, last remote window → picker)
- [ ] run tests - must pass before task 7

### Task 7: Picker Servers section and Direct e2e [model: opus]

**Files:**
- Modify: `src/renderer/picker/ProjectPicker.tsx`, `picker-model.ts`, `parts.tsx`
- Create: `src/renderer/picker/connect-form.tsx`
- Create: `test/e2e/remote-desktop.spec.ts`

- [ ] Servers section: server rows with `via` label, recent remote projects with a server badge, menu (Rename, Forget
      with its note, Open server's picker), "not remembered: no keyring" when the store refuses; live from
      `remote.changed`
- [ ] Connect to server form: SSH host / Link, name, Advanced `ccc` path; the error text in place; busy state while
      connecting
- [ ] unit tests for the picker model (grouping, sorting, empty state)
- [ ] e2e: desktop app + `launchServer` on loopback, Direct with `ccc web add-device`: a project window opens, a chord
      reaches the remote shell with the desktop table (Ctrl+T opens a tab, not Alt+T), the device is named after
      this machine, a link reaches the recorded `openExternal`, closing the picker keeps the app running, relaunch
      reuses the stored cookie and the partition's `Cookies` file holds no `ccc_device`, Forget removes the server
- [ ] run unit and e2e tests - must pass before task 8

### Task 8: SSH e2e with a fake ssh [model: sonnet]

**Files:**
- Create: `test/fixtures/fake-ssh.mjs` (and its PATH wrapper)
- Modify: `test/e2e/remote-desktop.spec.ts`

- [ ] fake `ssh`: checks the common options and `--`, runs the remote command through `sh -c` locally with `HOME` (or
      the `CCC` override) pointing at the test server's data dir, forwards `-L` with a Node TCP relay, exits like ssh
      on errors
- [ ] e2e: connect by SSH host, project window opens through the tunnel (Host on another port accepted); revoke the
      device with `ccc web revoke` and see the window re-pair once (two windows of the server: one add-device); the
      fake failing auth shows the "run `ssh <host>` once" text
- [ ] run e2e - must pass before task 9

### Task 9: Docs and guide [model: sonnet]

**Files:**
- Modify: `docs/features.md` ("Remote servers"), `docs/design-web.md` (§9 cross-reference, Host rule),
  `src/cli/guide/*.md` if `ccc web status` output is documented there, `README.md`

- [ ] user docs: connect by SSH (prerequisites: `ssh <host>` works without prompts, server mode running), Direct,
      Forget vs revoke, limits (files are the server's, no uploads, TLS over SSH refused, no system notifications,
      ssh_config's ControlMaster / LocalForward / RemoteCommand overridden, no keyring → re-pair each launch)
- [ ] design-web.md: the Host rule change and why
- [ ] drift tests pass
- [ ] run tests - must pass before task 10

### Task 10: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled (taken local port, server restart, revoked device, old server, https server)
- [ ] run full test suite: `npm run typecheck && npm run lint && npm test && npm run test:plugins`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] `node scripts/server-mode-smoke.mjs`

### Task 11: [Final] Update documentation [model: sonnet]
- [ ] update README.md if needed
- [ ] update CLAUDE.md (State line; an Implementation patterns bullet for remote windows: sandboxed, no preload,
      own partition with the cookie never on disk, counted by `WindowManager`, ssh BatchMode argv only)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- a real SSH host (this VM → another machine), with an ssh_config alias and an agent key
- revoke the desktop's device from a browser and watch it re-pair
- drop the network for a minute; the tunnel and the page reconnect
- macOS desktop connecting to the Linux server (shortcuts, Dock, keychain)
