# Remote servers in the desktop app — design

Status: draft (2026-11-12). Builds on web access (`docs/design-web.md`) and server mode (§9 there). Read those first:
this design adds no new protocol, only a new kind of desktop window and a way to reach a server.

## 0. Goal and non-goals

**Goal.** From the desktop app's project picker, connect to a cc-cockpit running in server mode on another machine and
work in its projects in native desktop windows: one window per project, every shortcut the app's own (no browser
eating Cmd+W, Cmd+T, Ctrl+Tab), system notifications, saved servers. Two ways to reach a server:

- **SSH** (the recommended one): the person gives an SSH host (`devbox`, as in their `~/.ssh/config`). The app opens a
  tunnel with the person's own `ssh`, pairs itself by running `ccc web add-device` over SSH, and the server never needs
  a port open to the network (it stays on its default loopback bind). The SSH key is the pairing.
- **Direct**: the person pastes the server's access link (or a one-time `ccc web add-device` link), exactly what they
  would open in a browser.

**Non-goals (v1).**
- A real front/back split of the desktop renderer (swapping Electron IPC for a network transport). The web client
  (`src/renderer/web/`) already is the front end for a remote cockpit and shares the shell components; the desktop
  window loads it. Nothing is gained by a second client.
- Local file access for remote projects. Files are the server's: Reveal, Open with system app, dragging local files in,
  uploads and downloads stay as in the browser (not available).
- A desktop that is itself a server for others while it is a client (it already can be both: its own web access is
  independent of its remote windows).
- Connecting to a desktop app's web access (not server mode). It works in a browser today; the remote window would work
  the same way through Direct, but pairing over SSH needs `ccc web add-device`, which is server mode only (§9.4). Direct
  to a desktop app is allowed, not designed for.

## 1. Shape

```
desktop app (client)                                   server (cc-cockpit --server)
┌────────────────────────────┐                        ┌──────────────────────────────┐
│ picker: Servers section    │  ssh devbox <ccc> …    │ ccc web status --json        │
│ RemoteServers (main)  ─────┼───────────────────────▶│ ccc web add-device           │
│ SshTunnel (main)      ─────┼── ssh -N -L L:127.0.0.1:P ──▶ gateway 127.0.0.1:P     │
│ RemoteWindow (sandboxed    │                        │                              │
│  BrowserWindow, partition  │── http://127.0.0.1:L/?project=<id> ──▶ web client     │
│  remote:<serverId>)        │   one WebSocket per window, streamed webviews         │
└────────────────────────────┘                        └──────────────────────────────┘
```

- **`RemoteWindow`** is a `BrowserWindow` that loads the server's web client and is treated exactly as a browser tab:
  no preload, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, its own session partition. It is not
  a project window: `WindowManager`, `ViewRegistry`, plugin hosts and the local socket know nothing of it. Nothing on
  the remote page can reach local IPC, local files, local Claude tabs or another server's session.
- **`RemoteServers`** (main) keeps the saved servers, opens and tracks remote windows, and owns each server's tunnel and
  device cookie.
- **`SshTunnel`** (main, behind an adapter like `node-pty`: spawn only in `main/remote/ssh-process.ts`) runs the
  person's `ssh` binary, argv only.

## 2. Saved servers

`app.json › remoteServers: RemoteServer[]` (validated and capped at 32 on read, like every app.json field):

```ts
interface RemoteServer {
  id: string                 // random, local only; names the partition and the secret
  name: string               // shown in the picker; default: the SSH host or the URL's host
  via:
    | { kind: 'ssh'; host: string; ccc?: string }   // host as typed (an ssh_config alias works); ccc: path override
    | { kind: 'direct'; origin: string }             // scheme://host[:port] of the link, nothing else kept
  recent: { projectId: string; name: string; at: number }[]   // last 8 remote projects opened from this app
}
```

- The **device cookie** is a credential: it is kept in the secret store (`remote:<id>:cookie`, the keychain on the
  desktop), never in a persistent partition (Electron does not encrypt its cookie database here; the app has no
  cookie-encryption fuse). Each server's partition is in-memory (`remote:<id>`, no `persist:`): at the first window
  main sets the cookie from the store with `session.cookies.set`, and `session.cookies.on('changed')` saves a new or
  removed `ccc_device` cookie back. Separate partitions also matter for correctness: cookies ignore ports, so two
  servers tunnelled to `127.0.0.1:L1` and `:L2` would otherwise share one cookie jar.
- An access link is never stored: Direct keeps only its origin; the token is used once to sign in and dropped.
- `recent` holds names as the server's page reported them (the window title), shown as plain text.

## 3. Picker

The desktop picker (`src/renderer/picker/ProjectPicker.tsx`) gets a **Servers** section under the local projects:

- Each server: its name, `via` as a small label (`ssh devbox`, `https://box.ts.net`), its recent remote projects as
  rows, and a menu with Rename, Forget (drops the entry, its cookie and its partition; the device stays in the server's
  list until revoked there, and Forget says so), and Open server's picker.
- **Connect to server…** opens a small form: SSH host, or Link (the access link / add-device link), plus an optional
  name; under "Advanced" for SSH, the `ccc` path.
- Clicking a recent remote project opens (or focuses) its window. Open server's picker opens a remote window on `/`,
  the server's own web picker, where the person opens a folder or an open project.
- Picker rows render through the shared picker parts (`src/renderer/picker/parts.tsx`), so a remote project looks like
  a local one with a server badge.
- The picker asks main through new `remote.*` channels; all are `REMOTE_CLASS` `no` (they spawn processes and store
  credentials on this machine: a browser view of this desktop must never drive them).

## 4. Remote windows

- **One window per (server, project).** Main learns which project a window shows from its URL (`?project=<id>` on
  `did-navigate` / `did-navigate-in-page`, the web client's own routing, `renderer/web/main.tsx`). Opening a project
  that already has a window focuses it. When the server's web picker navigates a window to a project that another
  window shows, that window is focused and this one goes back to the picker.
- Title: the page's `document.title`, prefixed by the server name (`devbox — api`), so two servers' projects with the
  same name differ in the taskbar.
- **Shortcuts.** The web client already maps every chord itself (`commandForEvent`); in a desktop window no browser
  steals any. The app menu's accelerators (`main/menu.ts`: Open Folder, edit roles, quit) are resolved for a focused
  remote window as for the picker (`''` key table): Open Folder opens the local picker's dialog, which is what the
  person expects from the desktop app; edit roles stay so copy and paste work in the page.
- **Links and new windows.** `setWindowOpenHandler` denies every page-opened window; an `http(s)` URL goes to
  `openExternal` on this machine through the existing `createOpenExternal` (the person's own browser). Navigation away
  from the server's origin is blocked (`will-navigate`), so a remote page cannot turn the window into a general browser.
- **Notifications.** The web client's in-page notices and chime work as in a browser. HTML5 `Notification` is not
  granted (`setPermissionRequestHandler` denies everything: camera, mic, notifications, clipboard read), as a page of
  untrusted origin; system notifications for remote sessions are a later item (§9).
- **Permissions and certificates.** Default Chromium checks. A Direct server with a self-signed certificate fails with
  the page's error; there is no "proceed anyway" (as with plugin webviews, `webview-hardening.ts`).
- **Connection loss.** The web client already reconnects with a backoff and shows its banner. Below it, the tunnel
  (§5) restarts on its own; the page needs nothing new. Closing the last window of a server stops its tunnel after
  30 s (a quick reopen reuses it).

## 5. SSH

### 5.1 The commands

All through the person's `ssh` (found on PATH, `ssh` on mac and Linux; Windows is not a target), argv only:

```
ssh -o BatchMode=yes -o ConnectTimeout=10 -- <host> <ccc> web status --json
ssh -o BatchMode=yes -o ConnectTimeout=10 -- <host> <ccc> web add-device
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -N -L 127.0.0.1:<L>:127.0.0.1:<P> -- <host>
```

- `host` is refused when it starts with `-` or holds whitespace or control characters (an option, not a host); `--`
  ends options anyway.
- The remote command is a string the server's login shell parses. Its fixed words are constants; `<ccc>` is the
  person's own path for their own server, still single-quoted with `'` refused, so a typo cannot run something else.
  Default `<ccc>`: `~/.config/cc-cockpit/bin/ccc` (server mode's wrapper in the default data dir; `~` left unquoted so
  the remote shell expands it), then plain `ccc` when that is missing (a deb that puts one on PATH).
- **BatchMode, no prompts.** The app never shows a password or passphrase prompt and never answers a host-key question:
  that stays between the person, their terminal and their agent. A failure shows ssh's last stderr line and the one
  command that fixes most of them: "Run `ssh devbox` once in a terminal (accept the host key; add your key to the
  agent)". This keeps SSH's trust decisions out of the app entirely.
- `<P>` is the gateway port from `web status --json`; `<L>` is a free local port: main listens on `127.0.0.1:0`,
  reads the port, closes, starts ssh; on `ExitOnForwardFailure` (taken in between) it retries twice with a new port.

### 5.2 Pairing

On Connect, and whenever the window's page lands on the sign-in screen (a revoked or expired cookie):

1. `web status --json`: server mode on (else: "this is not a cc-cockpit server; Direct works with a desktop's link"),
   the gateway listening, its port, sign-in mode, TLS (§5.4), the app version (§8).
2. Mode **link**: `web add-device` gives `<origin>/#t=<token>`; main keeps the token only. The window loads
   `http://127.0.0.1:<L>/#t=<token>`, and the page signs in as any browser does (`renderer/web/sign-in.ts`: posts the
   fragment, gets the device cookie, clears the URL). The cookie lands in the partition and §2 saves it.
3. Mode **password**: the window shows the server's own password page; the person types it once.
4. Mode **none**: nothing to do (loopback only, so only through the tunnel).

A re-pair is automatic in link mode: when one of the window's requests gets the gateway's `401 not signed in` (the
socket upgrade or an `/api` call, seen by main through the partition's `webRequest.onCompleted`), main
mints a new add-device link over SSH once and reloads; a second failure in a row shows the error instead of looping.
Each pairing is a new device on the server's list, named by the page from its user agent; the remote window sets its
user agent suffix to `cc-cockpit-desktop/<version> (<this hostname>)` so the server's list says which machine it is.

### 5.3 The server change: loopback on any port

The gateway's Host check (`checks.ts › allowedHosts`) lists `127.0.0.1:<P>`, `localhost:<P>` and `[::1]:<P>`. Through
a tunnel Chromium sends `Host: 127.0.0.1:<L>` and `Origin: http://127.0.0.1:<L>`, so today it is refused.

Change: in server mode, `checkHost` also accepts the three loopback names **on any port**, and `checkOrigin` is
unchanged (it already compares the Origin with the request's own Host, so it accepts `http://127.0.0.1:<L>` for
`Host: 127.0.0.1:<L>` and nothing else).

Why this is safe: the Host check is the DNS-rebinding defence; a rebound name is never a loopback literal, so it stays
refused. A Host of `127.0.0.1:<L>` reaches the gateway only when the browser connected to some port that forwards here
(a tunnel or a proxy the person set up). A page on another loopback port of either machine (a dev server at
`127.0.0.1:3000`) sends `Origin: http://127.0.0.1:3000` with `Host: 127.0.0.1:<P>`, which the unchanged Origin check
refuses as today. Cookies were never port-scoped, so nothing about them changes. The desktop app (not server mode)
keeps the exact list.

### 5.4 TLS on the gateway

The tunnel already encrypts. With `web set` TLS on, the tunnel carries `https://127.0.0.1:<L>` and the certificate
cannot match `127.0.0.1`. v1 refuses with a clear message ("this server serves https; connect Direct with its address,
or turn TLS off: the SSH tunnel encrypts already"). Pinning the certificate's fingerprint learned over SSH is §9.

## 6. Direct

- The form takes the access link or an add-device link. Main parses it with `URL` (no regexes), keeps `origin`, takes
  `#t=` as the token, refuses anything but `http:` / `https:`, a userinfo part, or a path other than `/`.
- `http:` to a non-loopback address is allowed (the server's own §4.3 confirm already made that choice) with a line
  under the entry: "not encrypted".
- The window loads `<origin>/#t=<token>`; the page signs in; the cookie is saved as in §2. Password and None modes as in
  §5.2. A revoked cookie shows the server's sign-in page; Direct has no way to re-pair by itself, the person pastes a new
  link (the form opens with the server prefilled).

## 7. Security

The rule of design-web.md §4 holds unchanged: a signed-in device is the person with a shell on the server. What is new
is on the client:

- **The remote page is a browser page.** Sandboxed, no preload, no IPC, its own in-memory partition, permissions denied,
  navigation pinned to its origin, page-opened windows denied, links to the person's own browser through
  `createOpenExternal`. A compromised server can do to this desktop what a website in a sandboxed tab can, no more.
  A grep test keeps `RemoteWindow` without a preload and keeps `remote:` partitions off every other window.
- **Credentials.** The device cookie in the keychain; the SSH key never touched (ssh and its agent own it); access
  tokens used once and dropped; nothing written to logs but the server's name and what happened.
- **Processes.** Only `ssh`, argv only, BatchMode; the host and `ccc` path checked as in §5.1. Spawned only from the
  picker's `remote.*` channels (`no` class) and from main's own re-pair, never from a page, a plugin or a remote view.
- **Ports.** The tunnel binds `127.0.0.1` only (`-L 127.0.0.1:…`, never `-g`). Any local process of this user can
  connect to it, as to any local port; it still needs the device cookie (or the server is in None mode, which the
  person chose on the server, loopback only).

## 8. Versions

`web status --json` carries the server's app version. A remote window needs a server with §5.3 (for SSH) and the
current wire protocol (`PROTOCOL_VERSION`). An older server gets a plain message naming both versions, before any
window opens. Direct needs no server change; an old server's web client works as it does in a browser.

## 9. Later

- System notifications for remote sessions (waiting for input) through a narrow, main-checked bridge instead of HTML5
  `Notification`.
- TLS through the tunnel with the certificate pinned from `web status --json`.
- Remote projects in the picker's search and the recent list across servers; the server's open projects listed live
  (the picker asking `/api/projects` through the server's session).
- File upload and download (shared with the browser).
- A desktop app's web access over SSH (needs `ccc web add-device` outside server mode).

## 10. Testing

- Unit: `RemoteServers` (store, validation, caps, Forget), link parsing, `ssh` argv building and the host / `ccc`
  checks, the tunnel's restart and port retry (fake spawn), cookie save and restore (fake session), window tracking by
  URL, the Host rule (any loopback port in server mode, exact list on the desktop, Origin unchanged).
- e2e: a server started with `launchServer` (`test/e2e/server-fixtures.ts`), the desktop app connecting Direct over
  loopback: pair, a project window opens, a chord reaches the shell, a link goes to the recorded `openExternal`, reopen
  restores the cookie, Forget. SSH in e2e through a fake `ssh` on PATH that runs the command locally and forwards with
  a small Node relay (no real sshd in CI).
- Manual: a real SSH host, a revoked device re-pairing, a dropped network.
