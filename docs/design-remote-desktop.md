# Remote servers in the desktop app — design

Status: revised (2026-11-12). Builds on web access (`docs/design-web.md`) and server mode (§9 there). Read those first:
this design adds no new protocol, only a new kind of desktop window and ways to reach a server.

Revision 2 (2026-11-12): the first version ran the person's own `ssh` in BatchMode, so the person had to manage keys,
the agent and host keys in a terminal before the app could connect. That is too hard to use. SSH is now two choices:
the app's **built-in SSH client** (the `ssh2` library: password, key file and passphrase, agent, host key confirmed in
the app) and **My own tunnel** (the person runs the `ssh -L` command the app shows; the app only connects to the local
port). Spawning the system `ssh` is gone (`ssh-process.ts`, the stderr readiness line, `fake-ssh.mjs`).

## 0. Goal and non-goals

**Goal.** From the desktop app's project picker, connect to a cc-cockpit running in server mode on another machine and
work in its projects in native desktop windows: one window per project, every shortcut the app's own (no browser
eating Cmd+W, Cmd+T, Ctrl+Tab), saved servers. Three ways to reach a server:

- **SSH, built in** (the recommended one): the person gives a host (an alias from `~/.ssh/config` works for its basic
  fields, §5.5), a user and how to sign in: the SSH agent and their keys, a password, or a key file with an optional
  passphrase. The app confirms the host key with the person once, opens the tunnel itself, pairs itself by running
  `ccc web add-device` over the same connection, and the server never needs a port open to the network.
- **My own tunnel**: the person keeps their own `ssh` and its whole config (ProxyJump, hardware keys, certificates).
  The app shows the `ssh -N -L` command to run and the `ccc web add-device` command for pairing; the person picks the
  local port and pastes the add-device link. The app connects to `127.0.0.1:<port>`.
- **Direct**: the person pastes the server's access link (or a one-time `ccc web add-device` link), exactly what they
  would open in a browser.

**Non-goals (v1).**
- A real front/back split of the desktop renderer (swapping Electron IPC for a network transport). The web client
  (`src/renderer/web/`) already is the front end for a remote cockpit and shares the shell components; the desktop
  window loads it. Nothing is gained by a second client.
- Local file access for remote projects. Files are the server's: Reveal, Open with system app, dragging local files in,
  uploads and downloads stay as in the browser (not available).
- A full `ssh_config` in the built-in client: ProxyJump, ProxyCommand, `Match`, certificates and FIDO (`sk-`) keys are
  not supported there. A host that needs them uses My own tunnel; the built-in form says so when the config names one.
- Keyboard-interactive prompts other than one password prompt (2FA codes): later (§9).
- A desktop that is itself a server for others while it is a client (it already can be both: its own web access is
  independent of its remote windows).
- Connecting to a desktop app's web access (not server mode). Direct works the same way as in a browser; built-in SSH
  pairing needs `ccc web add-device`, which is server mode only (§9.4 of design-web). Allowed, not designed for.

## 1. Shape

```
desktop app (client)                                         server (cc-cockpit --server)
┌──────────────────────────────┐                            ┌──────────────────────────────┐
│ picker: Servers section      │  ssh2: exec <ccc> web …    │ ccc web status --json        │
│ RemoteService (main)   ──────┼───────────────────────────▶│ ccc web add-device           │
│ SshLink (main, ssh2)   ──────┼── direct-tcpip ──────────▶ │ gateway 127.0.0.1:P          │
│   listener 127.0.0.1:L ◀─┐   │                            │                              │
│ RemoteWindow (sandboxed  │   │                            │                              │
│  BrowserWindow, partition└───┼── http://127.0.0.1:L/?project=<id> ──▶ web client         │
│  persist:remote-<id>)        │   one WebSocket per window, streamed webviews             │
└──────────────────────────────┘                            └──────────────────────────────┘
My own tunnel: the person's `ssh -N -L 127.0.0.1:L:127.0.0.1:P host` replaces SshLink; the window is the same.
```

- **`RemoteWindow`** is a `BrowserWindow` that loads the server's web client and is treated exactly as a browser tab:
  no preload, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, its own session partition. It is not
  a project window: `ViewRegistry`, plugin hosts and the local socket know nothing of it, and `WindowManager` only
  counts it (§4 "Lifecycle"). Nothing on the remote page can reach local IPC, local files, local Claude tabs or another
  server's session.
- **`RemoteService`** (main) keeps the saved servers, opens and tracks remote windows, and owns each server's SSH link
  and device cookie.
- **`SshLink`** (main) is one `ssh2` connection per server: it runs the remote commands and carries the tunnel. `ssh2`
  is imported only in `main/remote/ssh-client.ts` (an adapter like `node-pty`; a grep test keeps it there); the logic
  around it (`ssh-link.ts`: dial, auth order, host key, listener, reconnect) runs under vitest against `ssh2`'s own
  `Server` in-process.

## 2. Saved servers

`app.json › remoteServers: RemoteServer[]` (validated and capped at 32 on read, like every app.json field; a record that
fails validation is dropped: the first version was never released, so the old `ssh` shape is not migrated):

```ts
interface RemoteServer {
  id: string                 // random, local only; names the partition
  name: string               // shown in the picker; default: the host or the URL's host
  via:
    | { kind: 'ssh'; host: string; user?: string; port?: number; auth: SshAuth; ccc?: string }
    | { kind: 'tunnel'; localPort: number; sshHost?: string; remotePort: number }   // sshHost: only to print commands
    | { kind: 'direct'; origin: string }             // scheme://host[:port] of the link, nothing else kept
  recent: { projectId: string; name: string; at: number }[]   // last 8 remote projects opened from this app
  cookie?: string            // the device cookie, encrypted by the SecretStore (`encrypt`/`decrypt`), never plain
  localPort?: number         // built-in SSH: the listener's preferred port, kept so the page's origin stays the same
  hostKey?: { type: string; sha256: string }   // built-in SSH: the host key the person trusted (§5.3), not secret
}
type SshAuth =
  | { kind: 'auto' }                                       // agent, then the config's / default key files
  | { kind: 'password'; secret?: string }                  // secret: encrypted; absent = ask each time
  | { kind: 'key'; path: string; secret?: string }         // secret: the passphrase, encrypted; absent = none or ask
```

- The **device cookie**, the **password** and the **passphrase** are credentials. `SecretStore` is `encrypt`/`decrypt`
  only (`secrets/secret-store.ts`), so each is kept encrypted in the server's own record, like the other stored values,
  and listed in `storedSecretValues` so the secrets status counts them. The cookie never sits in a cookie database:
  Electron does not encrypt its own here (the app has no cookie-encryption fuse).
- **Remember or ask.** The form has "Remember password" / "Remember passphrase" (on by default when the secret store
  works). Not remembered: the picker asks when it opens a project of that server, and main keeps the answer in memory
  for the app's life, so a tunnel reconnect never asks. The key file is kept by path only; its contents are read when
  dialling, never stored.
- **Partition.** Each server gets `persist:remote-<id>`, so the web client's per-origin `localStorage` (zone sizes,
  `renderer/zones/view-geometry.ts`) survives a relaunch; built-in SSH keeps the origin stable by reusing `localPort` when
  it is free, My own tunnel by its fixed port. The cookie is kept out of the partition's database: main sets it from the
  record with `session.cookies.set` **without an expiry** (a session cookie, which Chromium does not write to disk), and
  `session.cookies.on('changed')` picks up a new `ccc_device` from a sign-in, saves it to the record and sets it again as
  a session cookie (a guard stops the second `changed` from looping). Verified: the partition's `Cookies` file never holds
  `ccc_device` after quit.
- Separate partitions also matter for correctness: cookies ignore ports, so two servers on `127.0.0.1:L1` and `:L2`
  would otherwise share one cookie jar.
- **No secret store** (Linux with no keyring: the store refuses): nothing is remembered: every launch pairs again and adds
  a device on the server (cap 64 there), and a password or passphrase is asked each launch. The picker says so on the
  server row ("not remembered: no keyring").
- An access link is never stored: Direct keeps only its origin, My own tunnel only its port; the token is used once to
  sign in and dropped.
- `recent` names come from the server's `/api/projects` (§4), shown as plain text.

## 3. Picker

The desktop picker (`src/renderer/picker/ProjectPicker.tsx`) gets a **Servers** section under the local projects:

- Each server: its name, `via` as a small label (`ssh oleg@devbox`, `tunnel :7331`, `https://box.ts.net`), its recent
  remote projects as rows, and a menu with Rename, Edit (the form, prefilled), Forget (drops the entry, its secrets,
  its trusted host key and its partition; the device stays in the server's list until revoked there, and Forget says
  so), and Open server's picker.
- **Connect to server…** opens a small form with three tabs:
  - **SSH**: Host, User (empty: the config's `User`, else the local user name), Port (empty: the config's, else 22),
    Sign in with: *Agent and my keys* / *Password* / *Key file* (a path field with a Browse button, the native open
    dialog through main) plus Passphrase; Remember. Under "Advanced", the `ccc` path. When the host is an alias in
    `~/.ssh/config`, the resolved HostName, User, Port and key show as greyed hints; a config with ProxyJump or
    ProxyCommand for it shows "This host goes through a jump host: use My own tunnel".
  - **My own tunnel**: SSH host (only for the commands), Server port (default 7330, the server's gateway port), Local
    port (default: a free one suggested by main). Below, two commands to copy, built from those fields and updated as
    they change:
    ```
    ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 devbox
    ssh devbox ccc web add-device
    ```
    and a field for the link the second one printed. A note: "On the server, `ccc` may be at
    `~/.config/cc-cockpit/bin/ccc`".
  - **Link**: the access link or an add-device link.
  An optional Name on every tab.
- **Prompts** are picker dialogs, answered in the picker, never in a remote window:
  - **Trust this host?** The host's address, key type and SHA256 fingerprint, the line "Compare with
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server", Trust and Cancel (no default button, as
    `ApprovalDialog`). Shown on a first connect when `~/.ssh/known_hosts` does not already vouch for the key (§5.3).
  - **Password** / **Passphrase for <key>**: a masked field and Remember. A wrong one asks again once, then the error.
- Clicking a recent remote project opens (or focuses) its window. Open server's picker opens a remote window on `/`,
  the server's own web picker, where the person opens a folder or an open project.
- Picker rows render through the shared picker parts (`src/renderer/picker/parts.tsx`), so a remote project looks like
  a local one with a server badge.
- The picker asks main through the `remote.*` channels; all are `REMOTE_CLASS` `no` (they dial out and store
  credentials on this machine: a browser view of this desktop must never drive them). They are routed in
  `main/ipc/router.ts` beside the other picker-only calls (`ctx.kind === 'picker'`), through the generic `invoke`. A
  call that needs an answer from the person returns `{ need: 'hostKey' | 'password' | 'passphrase', … }` and the
  picker calls again with the answer; main keeps no pending state across those calls (§5.4).
- Connecting closes the picker as opening a local project does; the remote window then counts as an open window for
  `WindowManager`'s rules (§4 "Lifecycle").

## 4. Remote windows

- **One window per (server, project).** Main learns which project a window shows from its URL (`?project=<id>` on
  `did-navigate` / `did-navigate-in-page`, the web client's own routing, `renderer/web/main.tsx`). Opening a project
  that already has a window focuses it. When the server's web picker navigates a window to a project that another
  window shows, that window is focused and this one goes back to the picker.
- **Title and names.** The web shell's only title is the static `cc-cockpit` (`renderer/web/index.html`), so main does
  not read the page's title: after a navigation to `?project=<id>` it asks the server's `/api/projects` through the
  window's own session (`ses.fetch`, the device cookie applies) for that project's name. The window title is
  `<server> — <project>` and `recent` stores the name.
- **Shortcuts.** In a browser the web client moves Cmd/Ctrl+W, T, N and Ctrl+Tab to their Alt variants
  (`webKeyTable`, `renderer/commands/web-keys.ts`, applied in `keybindings.ts › setCommands` whenever `isWebShell()`),
  because the browser keeps those. In a remote window nothing keeps them, so the web client skips `webKeyTable` when its
  user agent carries `cc-cockpit-desktop/` (§5.6): the same table as the desktop app. A UA is page-visible and
  forgeable, which is fine here: it only picks which chords the page itself listens to. The app menu needs no change: a
  focused window that is not a project window already resolves to the `''` key table (`index.ts › focusedProjectId`).
- **Lifecycle.** `WindowManager` quits on Linux when the picker closes with no project window (`pickerClosed`) and shows
  the picker when the last project window closes. Remote windows count for both: `WindowManager` gets a
  `remoteWindowCount()` hook, used by `pickerClosed`, the last-window rule, `focusAny` and `activate`, so the app
  neither quits under a remote window nor leaves the person with no window when the last remote one closes.
- **Hardening**, the webview precedent (`webview/webview-hardening.ts`, `webview-manager.ts`) applied to the window:
  - `setWindowOpenHandler` denies every page-opened window; an `http(s)` URL goes to the person's own browser through
    `createOpenExternal`, under the same open budget webviews use (a page cannot flood the desktop with tabs).
  - `will-navigate` and redirects pinned to the server's origin; `will-download` cancelled; `login` cancelled;
    `will-prevent-unload` ignored (closing always closes); the WebRTC IP policy as webviews; `devTools: false` when
    packaged.
  - Through a tunnel (either kind) the page's origin is loopback, and its requests carry cookies to any `127.0.0.1` port
    (cookies ignore ports): `webRequest.onBeforeRequest` cancels requests to any loopback host other than the server's
    own origin.
  - Remote windows are excluded from the app's `browser-window-created` and `focus` handlers (`index.ts`), as
    `isOffscreenWindow` excludes off-screen webviews.
- **Notifications.** The web client's in-page notices and chime work as in a browser. HTML5 `Notification` is not
  granted: non-default sessions are already denied every permission (`index.ts`, the permission handlers), which covers
  camera, mic, notifications and clipboard read. System notifications for remote sessions are a later item (§9).
- **Certificates.** Default Chromium checks. A Direct server with a self-signed certificate fails with the page's
  error; there is no "proceed anyway" (as with plugin webviews).
- **Connection loss.** The web client already reconnects with a backoff and shows its banner. Below it, the built-in
  link redials on its own (§5.2) and its listener stays bound, so the page's origin and its reconnects are unchanged.
  Closing the last window of a server ends its link after 30 s (a quick reopen reuses it). My own tunnel: §6.

## 5. SSH, built in

### 5.1 The connection

One `ssh2` `Client` per server, opened when a window of that server needs it and shared by every window and command of
that server:

- `host`, `port`, `username` from the record, filled from `~/.ssh/config` where the record leaves them empty (§5.5);
  `readyTimeout` 10 s, `keepaliveInterval` 15 s, `keepaliveCountMax` 3 (the old `ServerAliveInterval` / `CountMax`).
- **Sign-in order**, through `authHandler` so the order is ours and every method is tried at most once:
  1. *auto*: the agent (`SSH_AUTH_SOCK`, when set), then each key file: the config's `IdentityFile`s, else
     `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` (the ones that exist). A key that needs a passphrase and has none is
     skipped and named in the error ("`~/.ssh/id_ed25519` needs a passphrase: choose Key file").
  2. *password*: `password`, then `keyboard-interactive` answered with the same password only when the server sends one
     prompt with echo off (many servers offer only that); anything else fails with the server's prompt text in the
     error ("this server asks for more than a password: use My own tunnel").
  3. *key*: that file with its passphrase (the agent is not tried, so a wrong agent key cannot use up the server's
     `MaxAuthTries` first).
- The key file is read by main (`fs.readFile`, capped at 64 KiB, not following into anything but a regular file) and
  handed to `ssh2`, which parses OpenSSH, PEM and PPK keys; a parse error says "not a private key `ssh2` can read
  (FIDO and certificate keys need My own tunnel)".
- Errors keep `ssh2`'s level (`client-authentication`, `client-timeout`, `client-socket`) and map to one plain line
  each; a wrong password or passphrase is its own result, so the picker asks again (§3).

### 5.2 The tunnel

- Main listens on `127.0.0.1:<L>` (`net.createServer`), `L` = the saved `localPort` when it is free, else `0`; the port
  it got is saved. The listener exists before the window loads and belongs to the app, so no other local process can
  be holding the port when the page sends its cookie: the readiness race of the first version (another process on the
  port, readiness only from ssh's stderr line) is gone.
- Each accepted socket becomes `client.forwardOut('127.0.0.1', <its source port>, '127.0.0.1', <P>)` and the two are
  piped; either side closing or erroring closes both. `P` is the gateway port from `web status --json` (§5.6).
- **Reconnect.** When the connection drops while windows are open, the listener stays and the client redials with a
  backoff (1, 2, 4, … 30 s), reusing remembered or in-memory secrets; sockets accepted while it is down are closed at
  once (the page's own reconnect retries). A redial that fails on authentication or on a changed host key stops and the
  windows show that error (§4: the page's banner, then main's error page with the line).
- `release` after the last window of the server closes, with the 30 s grace of §4; `dispose` at quit ends client and
  listener.

### 5.3 Host keys

`hostVerifier` gets the server's key; main computes its SHA256 fingerprint (`ssh-keygen -l` format) and decides:

1. The record's `hostKey` matches: go on. It differs: refuse ("the host key of devbox changed; if the server was
   reinstalled, Forget the trusted key in Edit"), never ask.
2. No `hostKey` yet: read `~/.ssh/known_hosts` (read only, never written; plain and hashed `|1|` entries, the
   `[host]:port` form for a port other than 22, `@revoked` honoured, `@cert-authority` ignored). A matching line trusts
   the key without a question and saves it as `hostKey`; a line for the host with a different key of the same type
   refuses as above; nothing for the host asks the person (§3, "Trust this host?").
3. Trusted: `hostKey` is saved in the record (not secret).

The connection waits on the verifier while the picker asks; the picker's answer arrives as a second `remote.*` call
(§5.4), so a first connect dials twice: once to learn the key, once to use it. Cheaper and simpler than keeping a
half-open connection across calls.

### 5.4 Asking the person

Main never waits on the picker inside a call. A connect or open runs until it needs something the record and memory
do not have, then fails with a typed result: `{ need: 'hostKey', type, sha256, address }`,
`{ need: 'password' }`, `{ need: 'passphrase', path }`, or `{ need: 'password', again: true }` after a wrong one. The
picker shows the dialog and calls again with `answers: { hostKey?: sha256; password?; passphrase?; remember? }`.
Main checks a host-key answer against the key it sees on that new dial (a different key than the one shown asks again).
Only the picker gets these results; a reconnect in the background never asks: it stops with the error.

### 5.5 `~/.ssh/config`, the basic fields

A small reader (`main/remote/ssh-config.ts`, no regexes, as every parser in main): `Host` blocks with `*`, `?` and `!`
patterns, first value wins as in `ssh`, `Include` (relative to `~/.ssh`, globs, depth 4), and the keywords `HostName`,
`User`, `Port`, `IdentityFile` (`~` and `%d`, `%u`, `%h`, `%r` expanded; others make the line ignored), `IdentitiesOnly`
and `ProxyJump` / `ProxyCommand` (only to say "use My own tunnel"). `Match` blocks are skipped with a hint. The record
wins over the config; the config is re-read at each dial, so editing it needs no Edit in the app.

### 5.6 Pairing

On Connect, and whenever the window's page lands on the sign-in screen (a revoked or expired cookie):

1. `web status --json` over `client.exec`: server mode on (else: "this is not a cc-cockpit server; Direct works with a
   desktop's link"), the gateway listening, its port, sign-in mode, TLS (§5.8), the app version (§8).
2. Mode **link**: `web add-device` gives `<origin>/#t=<token>`; main keeps the token only. The window loads
   `http://127.0.0.1:<L>/#t=<token>`, and the page signs in as any browser does (`renderer/web/sign-in.ts`: posts the
   fragment, gets the device cookie, clears the URL). The cookie lands in the partition and §2 saves it.
3. Mode **password**: the window shows the server's own password page; the person types it once.
4. Mode **none**: nothing to do (loopback only, so only through the tunnel).

The remote command is unchanged from the first version: `exec` still runs it through the person's login shell on the
server, so it is the one fixed POSIX `sh -c` script with every word single-quoted (`remoteCommand`, `shared/remote-servers.ts`:
`'`, `\`, `!` and control characters refused), which parses the same in sh, bash, zsh, fish and csh. It runs `$CCC`
when set (the record's `ccc`), else `$HOME/.config/cc-cockpit/bin/ccc`, else `ccc` on PATH, and exits 127 with a known
line when none exists. Empty stdout is an error ("cc-cockpit is not installed there, or the server is not running");
only the last stdout line is parsed. Output is capped (64 KiB) and the command has a 20 s deadline.

A re-pair is automatic in link mode. A revoked cookie gives no 401 on the page's first call: `/auth/session` answers
200 with `device: null` and the page draws its sign-in screen. So main treats `did-finish-load` and a completed request
to the session path only as triggers, then asks `/auth/session` itself through the window's session (`ses.fetch`);
`device === null` with mode `link` mints one add-device link over SSH and reloads the window with `#t=`. Re-pairing is
serialised per server: the server holds one add-device token at a time (`auth.ts › addDeviceLink`). A second failure in
a row shows the error instead of looping.

Each pairing is a new device on the server's list. The remote window's user agent carries the suffix
`cc-cockpit-desktop/<version> (<this hostname>)`, and the web client's `deviceName` reads it, so the server's list shows
"cc-cockpit desktop on <hostname>" instead of "Chrome on Linux".

### 5.7 The server change: loopback on any port

The gateway's Host check (`checks.ts › allowedHosts`) listed `127.0.0.1:<P>`, `localhost:<P>` and `[::1]:<P>`. Through
a tunnel Chromium sends `Host: 127.0.0.1:<L>` and `Origin: http://127.0.0.1:<L>`. In server mode `checkHost` also
accepts the three loopback names **on any port**; `checkOrigin` is unchanged (it compares the Origin with the request's
own Host). Built in the first version and unchanged: both tunnel kinds rely on it.

Why this is safe: the Host check is the DNS-rebinding defence; a rebound name is never a loopback literal, so it stays
refused. A page on another loopback port of either machine (a dev server at `127.0.0.1:3000`) sends
`Origin: http://127.0.0.1:3000` with `Host: 127.0.0.1:<P>`, which the unchanged Origin check refuses as today. Cookies
were never port-scoped, so nothing about them changes. The desktop app (not server mode) keeps the exact list.

### 5.8 TLS on the gateway

The tunnel already encrypts. With `web set` TLS on, the tunnel carries `https://127.0.0.1:<L>` and the certificate
cannot match `127.0.0.1`. v1 refuses with a clear message ("this server serves https; connect Direct with its address,
or turn TLS off: the SSH tunnel encrypts already"). Pinning the certificate's fingerprint learned over SSH is §9.

## 6. My own tunnel

- The form keeps `localPort` and `remotePort` (and `sshHost` only to print the commands; it is checked by the same host
  allowlist as before, so a printed command never carries shell metacharacters). The origin is
  `http://127.0.0.1:<localPort>`; the link pasted on Connect is parsed as in §7 and only its `#t=` token is used (its own
  origin may not be reachable from here). An `https` link is refused as in §5.8.
- **Before every load** main asks `GET /auth/session` on `127.0.0.1:<localPort>` with no cookie (2 s timeout). Nothing
  answers: the window shows main's page "Nothing answers on 127.0.0.1:7331. Start the tunnel:" with the `ssh -N -L`
  command, and main retries every 3 s while the window is open, loading the server's page when it answers. An answer
  that is not a cc-cockpit session reply: "something else is listening on 127.0.0.1:7331", no load (the cookie is not
  sent to it).
- **Re-pair** is not automatic (the app cannot run commands there): a revoked cookie shows the server's sign-in page
  and the picker's Edit opens the form with the add-device command and the link field.
- **What the app cannot check:** whether the process on that port is really the person's tunnel. The probe above stops
  an obvious mistake, not a local process that imitates the reply; such a process gets the device cookie on the next
  load. The person's own ssh has the same property, and any local process of theirs could read their files anyway.
  The docs say so, and say that the built-in client does not have it (it owns its port).

## 7. Direct

- The form takes the access link or an add-device link. Main parses it with `URL` (no regexes), keeps `origin`, takes
  `#t=` as the token, refuses anything but `http:` / `https:`, a userinfo part, or a path other than `/`.
- `http:` to a non-loopback address is allowed (the server's own §4.3 confirm already made that choice) with a line
  under the entry: "not encrypted".
- The window loads `<origin>/#t=<token>`; the page signs in; the cookie is saved as in §2. Password and None modes as in
  §5.6. A revoked cookie shows the server's sign-in page; Direct has no way to re-pair by itself, the person pastes a new
  link (Edit opens the form prefilled).

## 8. Security

The rule of design-web.md §4 holds unchanged: a signed-in device is the person with a shell on the server. What is new
is on the client:

- **The remote page is a browser page.** Sandboxed, no preload, no IPC, its own partition (the cookie never on disk,
  §2), permissions denied, navigation pinned to its origin, page-opened windows denied, links to the person's own
  browser through `createOpenExternal`. A compromised server can do to this desktop what a website in a sandboxed tab
  can, no more. A grep test keeps `RemoteWindow` without a preload and keeps `persist:remote-` partitions off every
  other window.
- **Credentials.** Device cookie, password and passphrase encrypted by the secret store in the record, or held in
  main's memory only when not remembered; never in a log, an IPC event, a renderer or a URL. The picker sends a secret
  to main in the call that uses it and gets none back (`remote.list` reports only "remembered" flags). Key files stay
  where they are; only their path is kept. Access tokens are used once and dropped.
- **Host keys.** Trust on first use, confirmed by the person with the fingerprint, or vouched for by their own
  `known_hosts`; a changed key always refuses and is never offered as a question (the one case where a click-through
  would be the attack). The verifier's decision is main's; the picker's answer is only a fingerprint main compares.
- **The library.** `ssh2` (pinned exact, MIT, deps `asn1` and `bcrypt-pbkdf`; its native crypto binding and
  `cpu-features` are optional and it runs on plain JS without them) is a new dependency in a security path. It is
  imported only in `ssh-client.ts`; only `Client` is used in main (`Server` only in tests); its `debug` output is off.
  Algorithms: `ssh2`'s defaults minus `ssh-rsa` (SHA-1) host keys, CBC ciphers and `diffie-hellman-group1-sha1` / `group14-sha1`.
- **Processes.** None: no `ssh` is spawned any more. Dialling happens only from the picker's `remote.*` channels (`no`
  class) and from main's own re-pair and reconnect, never from a page, a plugin or a remote view.
- **Ports.** The listener binds `127.0.0.1` only. Any local process of this user can connect to it, as to any local
  port; it still needs the device cookie (or the server is in None mode, which the person chose on the server,
  loopback only). My own tunnel: §6.

## 9. Versions

`web status --json` carries the server's app version and the gateway's `scheme`. No wire-protocol gate: the window runs
the server's own web client, so this app's protocol constant is irrelevant. Built-in SSH and My own tunnel need a server
with §5.7, recognised by `scheme` being present in the status (built-in) or by the page loading at all (own tunnel: an
old server's Host check refuses `127.0.0.1:<L>` with 403, and main's probe says "update cc-cockpit on the server").
Direct needs no server change.

## 10. Later

- Keyboard-interactive prompts beyond a password (2FA codes) through the picker's prompt dialog.
- ProxyJump in the built-in client (chained `ssh2` connections).
- System notifications for remote sessions (waiting for input) through a narrow, main-checked bridge instead of HTML5
  `Notification`.
- TLS through the tunnel with the certificate pinned from `web status --json`.
- Remote projects in the picker's search and the recent list across servers; the server's open projects listed live.
- File upload and download (shared with the browser).
- A desktop app's web access over SSH (needs `ccc web add-device` outside server mode).

## 11. Testing

- Unit: the store (validation, caps, Forget clears secrets and the host key, remember vs memory), link parsing, the
  host and `ccc` checks, `remoteCommand`, the `ssh_config` reader (patterns, first wins, Include depth, `%` tokens,
  Match skipped), the known_hosts reader (plain, hashed, `[host]:port`, `@revoked`), the fingerprint format.
- `SshLink` against `ssh2`'s `Server` in-process on a random port: each auth kind (agent through a fake agent socket,
  password, keyboard-interactive with one prompt and with two, key with and without passphrase, wrong secret), host key
  first use / trusted / changed, exec with output cap and deadline, forwarding to a local echo server, a dropped
  connection redialled with the listener and port unchanged, release grace, dispose.
- The own-tunnel probe: nothing listening, a non-cockpit answer, a cockpit answer.
- e2e: a server started with `launchServer`; the desktop connecting Direct (as now); built-in SSH through a small
  `ssh2` server fixture (`test/fixtures/ssh-server.mjs`: password and key auth, exec runs the command locally with
  `sh -c`, `direct-tcpip` connects locally): the host-key dialog, the password prompt with Remember off, pairing, one
  re-pair after a revoke, a dropped link reconnecting; My own tunnel with a Node relay as the person's tunnel: the
  "nothing answers" page, then starting the relay loads the project.
- Manual: a real SSH host (agent, password, key with passphrase), macOS (agent from the Dock), a dropped network.
