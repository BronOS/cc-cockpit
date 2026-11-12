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
  port); `ccc web status --json` reports the app version, the wire protocol version and the gateway's scheme.

## Context (from discovery)
- Gateway checks: `src/main/web/checks.ts` (`allowedHosts`, `checkHost`, `checkOrigin`), `gateway.ts` (Host check on
  every request, 401 `not signed in`), `auth.ts` (`DEVICE_COOKIE = 'ccc_device'`, `deviceCookie`, token sign-in only in
  link mode, `addDeviceLink` one at a time).
- `ccc web`: `src/cli/args.ts`, `src/cli/client.ts` (`web add-device` prints only the link on stdout),
  `src/main/socket/web-handlers.ts`, `src/shared/web-access.ts › WebCliStatus` (no version or scheme today).
- Web client: `src/renderer/web/main.tsx` (`?project=<id>` routing, picker at `/`, `#t=` sign-in, reconnect banner),
  `sign-in.ts`, `picker.tsx`.
- Desktop picker: `src/renderer/picker/ProjectPicker.tsx`, shared parts `parts.tsx`, `picker-model.ts`.
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
- **Server**: Host rule widened for loopback literals in server mode only; `WebCliStatus` gains `version`,
  `protocolVersion` and `scheme`.
- **`RemoteServers`** (main, plain logic): saved servers in `app.json › remoteServers`, validated and capped; cookie in
  the secret store under `remote:<id>:cookie`; tracks windows by (server, project) from their URL.
- **`SshTunnel`** (main, plain logic over a spawn adapter): BatchMode `ssh` commands, free local port, restart with
  backoff, stop 30 s after a server's last window closes.
- **`RemoteWindow`** (adapter): sandboxed window, in-memory partition `remote:<id>`, cookie set from the store and saved
  on change, permission and navigation locks, page-opened windows denied, links through `createOpenExternal`, 401
  watch for re-pairing, user agent suffix naming this machine.
- **Picker**: Servers section, Connect to server form, Rename / Forget / Open server's picker, recent remote projects.

## Technical Details
- `RemoteServer` shape, SSH argv, pairing order, Host rule and its safety argument: design §2, §5.1–5.3.
- Version gate: SSH needs a server whose status has `protocolVersion === PROTOCOL_VERSION` and reports `scheme`
  (absent = older server: "update cc-cockpit on <host> to <version>"); `scheme: 'https'` over SSH is refused (§5.4).
- Default `ccc` on the server: `~/.config/cc-cockpit/bin/ccc`, then `ccc`; an override is single-quoted, `'` refused.
- Host check: `host` refused when empty, starting with `-`, or holding whitespace / control characters.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: a real SSH host, a real revoked device, a dropped network, macOS.

## Implementation Steps

### Task 1: Server side: loopback on any port, version and scheme in the status [model: sonnet]

**Files:**
- Modify: `src/main/web/checks.ts`, `src/main/web/gateway.ts`
- Modify: `src/shared/web-access.ts`, `src/main/web/access-service.ts`, `src/cli/client.ts` (status text)
- Modify: `test/unit/web-checks.test.ts` (or the existing checks test), `test/unit/web-handlers.test.ts`

- [ ] `checkHost` (or the gateway's call) accepts `127.0.0.1:<n>`, `localhost:<n>`, `[::1]:<n>` for any port `n` in
      1–65535 when `server` is set; the desktop keeps the exact list; comment carries design §5.3's argument
- [ ] `checkOrigin` unchanged; a test proves `Origin: http://127.0.0.1:3000` with `Host: 127.0.0.1:<P>` is still
      refused and `Origin` = `Host` on another loopback port is accepted in server mode only
- [ ] `WebCliStatus` gains `version` (app version), `protocolVersion` (`PROTOCOL_VERSION`) and `scheme`
      (`http` / `https`, the gateway's own); `ccc web status` text shows the version
- [ ] tests: Host rule (server mode on/off, malformed ports, names that only look loopback such as `127.0.0.1.evil`),
      status fields
- [ ] run unit tests and `node scripts/server-mode-smoke.mjs` - must pass before task 2

### Task 2: Saved servers and the link parser [model: sonnet]

**Files:**
- Create: `src/shared/remote-servers.ts` (types, `parseRemoteLink`, `checkSshHost`, `cccCommand`)
- Create: `src/main/remote/remote-servers.ts` (store over `app.json`, secret keys)
- Create: `test/unit/remote-servers.test.ts`

- [ ] `RemoteServer` type and validation of `app.json › remoteServers` on read (cap 32 servers, 8 recents, string
      lengths, unknown `via` kinds dropped)
- [ ] `parseRemoteLink(text)`: `URL` only, `http:`/`https:`, no userinfo, path `/`, optional `#t=<token>`; returns
      `{ origin, token? }` or a refusal text
- [ ] `checkSshHost`, `cccCommand(path?)` (default path, `ccc` fallback, quoting, `'` refused)
- [ ] store: add, rename, forget (drops the secret `remote:<id>:cookie`), record a recent project; ids random
- [ ] tests for each (success and refusals)
- [ ] run tests - must pass before task 3

### Task 3: SSH commands and the tunnel [model: opus]

**Files:**
- Create: `src/main/remote/ssh-process.ts` (spawn adapter, the only `child_process` use here)
- Create: `src/main/remote/ssh-tunnel.ts` (`runRemote`, `SshTunnel`)
- Create: `test/unit/ssh-tunnel.test.ts`

- [ ] `runRemote(host, words)`: `ssh -o BatchMode=yes -o ConnectTimeout=10 -- host <command>`, bounded (20 s), stdout
      capped, last stderr line kept for the error text
- [ ] `status(server)`: parses `web status --json` (checked fields only), applies the version gate and the https
      refusal; `addDevice(server)`: the link's token only
- [ ] `SshTunnel`: free local port on `127.0.0.1:0`, `-N -L 127.0.0.1:L:127.0.0.1:P` with `ExitOnForwardFailure`
      and keepalives, ready when the port accepts a connection, two retries on a taken port, restart with backoff on
      exit while windows are open, stop 30 s after the last window, killed on app quit (child registry)
- [ ] error texts for the common ssh failures (host key, auth, timeout, `ccc` missing, server not running)
- [ ] tests with a fake spawn: argv exactly, timeouts, restart, port retry, stop delay, quit
- [ ] run tests - must pass before task 4

### Task 4: Remote window adapter [model: opus]

**Files:**
- Create: `src/main/remote/electron-remote-window.ts` (adapter)
- Create: `src/main/remote/remote-windows.ts` (logic: tracking, focus, pairing loop)
- Create: `test/unit/remote-windows.test.ts`, `test/unit/no-remote-preload.test.ts` (grep test)

- [ ] window: no preload, `sandbox`, `contextIsolation`, no node; partition `remote:<id>` (in-memory); user agent suffix
      `cc-cockpit-desktop/<version> (<hostname>)`
- [ ] session locks: `setPermissionRequestHandler` / `setPermissionCheckHandler` deny all; `will-navigate` and
      redirects pinned to the server's origin; `setWindowOpenHandler` denies, `http(s)` to `createOpenExternal`;
      default certificate checks
- [ ] cookie: set from the secret store before the first load; `cookies.on('changed')` saves / clears `ccc_device`
- [ ] tracking: (server, project) from `?project=` on navigation; focus an existing window; title `<server> — <page
      title>`; record the recent project
- [ ] re-pair: a 401 from the gateway (`webRequest.onCompleted`) over SSH in link mode mints one add-device link and
      reloads with `#t=`; a second 401 in a row shows the error page instead of looping
- [ ] grep test: no preload in the adapter, `remote:` partitions used nowhere else
- [ ] tests with fake window and session: locks, cookie save/restore, tracking, re-pair once
- [ ] run tests - must pass before task 5

### Task 5: Main wiring, IPC and the menu [model: sonnet]

**Files:**
- Modify: `src/shared/ipc.ts` (`remote.list`, `remote.connect`, `remote.open`, `remote.rename`, `remote.forget`,
  `remote.changed` event; all `REMOTE_CLASS` `no`)
- Modify: `src/main/index.ts`, `src/main/menu.ts`, the preload's picker API
- Modify: tests of the IPC classes and the menu

- [ ] handlers accept calls only from the desktop picker page (top frame, the local picker), never a browser view
- [ ] `remote.connect`: SSH (status → add-device when link mode → tunnel → window) or Direct (parse → window with
      `#t=`); errors returned as text for the form
- [ ] `AppMenu` resolves a focused remote window as the picker (`''` table); Open Folder opens the local picker
- [ ] tunnels and remote windows closed on quit; a remote window never counts as a project window (restore, close-all,
      the window list)
- [ ] tests: classes, the menu table, the caller check
- [ ] run tests - must pass before task 6

### Task 6: Picker Servers section and Direct e2e [model: opus]

**Files:**
- Modify: `src/renderer/picker/ProjectPicker.tsx`, `picker-model.ts`, `parts.tsx`
- Create: `src/renderer/picker/connect-form.tsx`
- Create: `test/e2e/remote-desktop.spec.ts`

- [ ] Servers section: server rows with `via` label, recent remote projects with a server badge, menu (Rename, Forget
      with its note, Open server's picker); live from `remote.changed`
- [ ] Connect to server form: SSH host / Link, name, Advanced `ccc` path; the error text in place; busy state while
      connecting
- [ ] unit tests for the picker model (grouping, sorting, empty state)
- [ ] e2e: desktop app + `launchServer` on loopback, Direct with `ccc web add-device`: a project window opens, a chord
      reaches the remote shell, a link reaches the recorded `openExternal`, relaunch reuses the stored cookie, Forget
      removes the server
- [ ] run unit and e2e tests - must pass before task 7

### Task 7: SSH e2e with a fake ssh [model: sonnet]

**Files:**
- Create: `test/fixtures/fake-ssh.mjs` (and its PATH wrapper)
- Modify: `test/e2e/remote-desktop.spec.ts`

- [ ] fake `ssh`: checks BatchMode and `--`, runs the remote command locally (the server's `ccc` wrapper), forwards
      `-L` with a Node TCP relay, exits like ssh on errors
- [ ] e2e: connect by SSH host, project window opens through the tunnel (Host on another port accepted); revoke the
      device with `ccc web revoke` and see the window re-pair once; the fake failing auth shows the "run `ssh <host>`
      once" text
- [ ] run e2e - must pass before task 8

### Task 8: Docs and guide [model: sonnet]

**Files:**
- Modify: `docs/features.md` ("Remote servers"), `docs/design-web.md` (§9 cross-reference, Host rule),
  `src/cli/guide/*.md` if `ccc web status` output is documented there, `README.md`

- [ ] user docs: connect by SSH (prerequisites: `ssh <host>` works without prompts, server mode running), Direct,
      Forget vs revoke, limits (files are the server's, no uploads, TLS over SSH refused, no system notifications)
- [ ] design-web.md: the Host rule change and why
- [ ] drift tests pass
- [ ] run tests - must pass before task 9

### Task 9: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled (taken local port, server restart, revoked device, old server, https server)
- [ ] run full test suite: `npm run typecheck && npm run lint && npm test && npm run test:plugins`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] `node scripts/server-mode-smoke.mjs`

### Task 10: [Final] Update documentation [model: sonnet]
- [ ] update README.md if needed
- [ ] update CLAUDE.md (State line; an Implementation patterns bullet for remote windows: sandboxed, no preload,
      in-memory partition, cookie in the secret store, ssh BatchMode argv only)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- a real SSH host (this VM → another machine), with an ssh_config alias and an agent key
- revoke the desktop's device from a browser and watch it re-pair
- drop the network for a minute; the tunnel and the page reconnect
- macOS desktop connecting to the Linux server (shortcuts, Dock, keychain)
