# Web access (remote cockpit) — design draft

Status: v1 implemented (2026-11-10, branch `feat/web-access`; plan `docs/plans/20261110-web-access.md`, phases 1 to 5 of §7).
Revised after two architecture reviews. Sections 9 and 10 and the phone layout stay later. The code's own comments
carry the finer points (`src/main/web/`, `src/main/views/`, `src/renderer/web/`); this document keeps the reasons.

**What v1 implements:** the gateway (http + one WebSocket per view), the Host and Origin checks, the four sign-in modes
(access link, password, desktop confirm, None), devices with Disconnect and Revoke, the confirms of §4.3, the view
registry and the remote class of every IPC channel, a headless terminal per tab with numbered chunks and snapshots for
every view, ports and slots per view, plugin pages under path tokens, shared link asks, overlay and settings-page
take-over, window lifetime (§5.6), the native mapping of §6.1, and the settings page, top-bar chip and devices list.
How to use it: `docs/features.md` "Web access".

**Later, not in v1:** the desktop as a remote client (§10), more than one person (§10), a phone layout, headless mode
(§9), Web Notifications and `ctx.notify` to a browser, a remote Allow of a plugin link, the browser panel and URL
overlays in a browser, sign-in of a plugin's OAuth from a browser.

## 0. Goal, direction, non-goals

**Goal.** The person opens cc-cockpit in a browser on another device and works with the cockpit running on their
machine: the same project window, Claude tabs, terminals, panels and plugins, live on both screens at once. Claude
keeps running on the host.

**Direction (shapes v1, built later).** The same protocol later carries:
- **another cc-cockpit desktop** connecting to a remote machine's project (the desktop renderer using the network
  bridge instead of local IPC);
- **two people in one project at the same time** (pair development on one Claude session).

So the core of v1 is **views**: a project window can have several live views, each showing the same state, any of
them able to act. A browser is the first kind of remote view.

**Shape.** Borrowed from VS Code's remote model: the UI and the backend already talk only through messages, so the
web version swaps the transport. The same React shell is served over HTTP and talks to main over one WebSocket.
Plugins do not change.

**Non-goals (v1).**
- More than one person. v1 views all belong to the person (§10 keeps multi-user as the next step, and v1 must not
  close the door on it: every view carries an identity).
- A cloud relay run by us. Reaching the machine from outside is the person's network (Tailscale, SSH tunnel, their
  own reverse proxy).
- A headless server with no desktop app (§9).
- Windows hosts. A phone-first layout (later phase).

## 1. What the survey and review found

Already transport-agnostic:
- The bridge is two functions, `invoke(channel, payload)` and `on(channel, listener)` (`src/preload/index.ts`), over
  the channels allow-listed in `src/shared/ipc.ts` (~111 invoke, 22 event). Payloads are JSON except two
  `Uint8Array`s (`notify.soundData`, `settings.marketplacePreview`).
- `IpcRouter` (`src/main/ipc/router.ts`) takes `ipcMain` through an interface; handlers get `{ windowId, projectId }`
  from `authenticate()` (`router.ts:161`), never from the payload.
- Tabs, the session registry, the send gate and `typed` are keyed by project or tab, not by window, so several views
  of one window need no re-keying there.
- Terminal I/O is plain messages (`tabs.data` out; `tabs.input`, `tabs.resize`, `tabs.ack` in).

What assumes **one page per project window** (the real cost of mirroring):

| Assumption | Where | Mirror fix (§5) |
|---|---|---|
| One port per panel; a new attach closes the old | `src/host/ctx/ui.ts:168`; slots and settings pages `src/main/plugins/panel-ports.ts:196,239` | ports fan out per view |
| One flow-control counter per pty; `attach` resets it | `src/main/tabs/tab-manager.ts:289`, `pty-service.ts` | main's headless terminal is the one consumer |
| Every xterm answers terminal queries (DSR, DA, OSC) | `terminal-reports.ts` keeps them out of `typed` only | one view answers |
| One `activeTab` per project from `tabs.selected` | `router.ts:867`, `host-api.ts:1139` | the last-acting view's selection |
| Close asks answered by one window | `src/main/sessions/close-asks.ts`, `index.ts:553` | sent to all views, first answer wins |
| Overlays: a main-owned stack per window, owed to the opener | `overlay-manager.ts:385`; `ccc overlay` via `windowIdOf(project)` (`socket/handlers.ts:228`) | shown on all views, first answer wins |
| Events by `webContents.send`, broadcasts by `BrowserWindow.getAllWindows()`, ports by `webContents.postMessage` | `index.ts:315,553,1062,1193,1711` | one view registry (§2.2) |
| Closing the desktop window closes the project and its tabs | `TabManager.closeProject`, `tab-manager.ts:608` | policy in §5.6 |

Also native-only, no browser equivalent: the Browser panel and URL overlays (`WebContentsView`,
`electron-url-view.ts`), folder and link-confirm dialogs (`socket/handlers.ts:404`), window chrome.

## 2. Architecture

```
 Electron main                                               Remote view (browser)
 ┌────────────────────────────────────────────┐              ┌───────────────────────────────┐
 │ IpcRouter ◄── Caller { window, view, who } │              │ web-bridge: window.cockpit    │
 │   handlers unchanged                       │◄── one WS ──►│ same React shell (web build)  │
 │ ViewRegistry: views per project window     │   per view   │ MessageChannel per panel      │
 │   desktop view: webContents  | remote: WS  │              │   ↔ WS 'port' frames          │
 │ PanelPortHub: host ↔ fan-out to views      │              │ plugin iframes (sandboxed)    │
 │ Headless terminal per tab (authoritative)  │              │                               │
 │ WebGateway (main/web/): http + ws, sign-in │              │                               │
 └────────────────────────────────────────────┘              └───────────────────────────────┘
```

New code: `src/main/web/` (gateway, sign-in, devices), `src/main/views/` (view registry, fan-out),
`src/renderer/web/` (the bridge). Node's `http` plus `ws` (pinned). The gateway is off until the person turns it on.

### 2.1 Caller

`IpcRouter.authenticate(channel, event)` becomes `authenticate(channel, caller)`. A caller resolves to the project
window's **existing** `SenderContext` (same window id, same project) plus a `viewId` and, for the future, a `who`
(the person in v1):
- `ElectronCaller`: today's checks (top frame, app page, `sender.id`), view = the desktop window's own view.
- `WebCaller`: the connection's view, bound at handshake to one project window (§4). Nothing in a frame can name
  another window, project or view.

Handlers that need view state (selection, overlay answers, terminal size) get `viewId`; the rest ignore it.

### 2.2 View registry instead of webContents

Every event main sends goes through `ViewRegistry`: `toProject`, `toWindow`, `toView`, `toAll` (today's
`getAllWindows()` broadcasts), and `postPort` (today's `webContents.postMessage`). A desktop view wraps its
`webContents`; a remote view wraps its WebSocket. A lint rule (or a grep test) forbids `webContents.send` and
`getAllWindows()` outside the registry, so a new event cannot skip remote views.

### 2.3 Which channels a remote view may call

Every invoke and event channel gets a remote class in `src/shared/ipc.ts` next to its declaration, and a unit test
fails when one has none:
- `yes`: project work (tabs, panels, plugin settings, marketplace browsing and installs).
- `no`: needs the host's screen or would let a remote view widen its own access — the auth mode, bind and secrets, device management,
  device management, `projects.openFolder`, `settings.pluginLink` (native dialogs), `window.reopen`, full screen,
  `webviews.*`, URL overlays.
- `adapted`: answered differently for a remote view (§6.3).

## 3. Wire protocol

One WebSocket per remote view, JSON text frames, at most 4 MiB each (a 1 MiB panel message wrapped in a frame must
fit); a terminal snapshot larger than that is sent in numbered parts.

| Frame | Direction | Fields |
|---|---|---|
| `hello` / `ready` | both | protocol version; on `ready`, the view id and the window's snapshot (§5.1) |
| `invoke` / `result` | client → main / back | `id`, `ch`, `p` / `id`, `ok`, `v` or `err` |
| `event` | main → client | `ch`, `p` |
| `port.open` / `port.msg` / `port.close` | main → client / both / both | `key` (panel key, `@slot/…`, `@settings/…`), `nonce` (the connect's), `m` |
| `term.snapshot` | main → client | `tabId`, `seq` (the last chunk it contains), serialized state, part n of m |
| `term.data` | main → client | `tabId`, `seq`, data (replaces `tabs.data` for remote views) |

- `Uint8Array` payloads travel as `{ $bytes: <base64> }`.
- Main checks the allow-lists and the remote class on every frame; the browser bridge checks them too, as the preload
  does.
- No resume tokens in v1: a dropped view reconnects with its device cookie and gets a fresh snapshot.

## 4. Access and identity

Off by default (Settings > General > Web access). **A signed-in device is the person at the keyboard** (a shell and
Claude on the host). How exposed to be is the person's choice; the app makes each choice explicit and keeps the
protections that cost nothing always on.

### 4.1 Always on (not settings)

They guard against attacks the person never chose, such as any web page they visit driving their machine through
their own browser. They apply in every auth mode, None included:
- **Host check** on every HTTP request and WebSocket upgrade, against a list the person keeps (the IP, an mDNS name,
  the proxy's name). Blocks DNS rebinding of a loopback or LAN port.
- **Origin check** on the WebSocket upgrade and every state-changing POST (sign-in included): `Origin` must be the
  external origin. On loopback, cookies ignore ports and every `localhost:*` page is same-site, so this check, not
  `SameSite`, is the control that matters; the code says so where it checks. (A future desktop client sends no
  Origin: it gets a bearer handshake of its own, §10.)
- **Secrets**: compared in constant time, stored hashed. Failed attempts are slowed (a token bucket with a fixed
  delay), never locked out: a lockout lets anyone who can reach the address keep the person out. Never keyed by peer
  address: behind `tailscale serve` or a proxy every peer is 127.0.0.1. The waiting queue is capped, so a sustained
  flood makes new sign-ins answer "busy" for as long as it lasts (signed-in devices are untouched); accepted, since
  one global bucket cannot tell the person's attempt from the flood's.
- **Device cookie**: `HttpOnly`, `SameSite=Strict`, `Secure` unless the external origin is loopback http. Not rotated
  (a rotation races a device's parallel requests and its open WebSockets, which cannot receive `Set-Cookie`); the
  server keeps a sliding expiry instead (30 days of no use).
- **Visible on the desktop**: the top bar shows connected devices; one click lists them with Disconnect, Revoke and
  Revoke all. Revoking closes their sockets and kills their plugin-page tokens (§5.5) at once. Every new device
  raises a desktop notification.
- **Remote views cannot widen their own access**: the auth mode, bind, secrets, host list and device list are
  `no`-class channels (§2.3), changed only on the desktop.
- **Web shell CSP**: `default-src 'self'`, `connect-src 'self'`, `frame-src` the plugin paths only,
  `frame-ancestors 'none'`; `Cache-Control: no-store` on the shell.
- **Log**: sign-in, connect, disconnect, revoke, mode changes. Never terminal text or prompts.

### 4.2 Auth mode (the person's choice)

| Mode | How | Notes |
|---|---|---|
| **Access link** (default) | A 256-bit random token; the link is `<origin>/#t=<token>`. The desktop shows it behind a Show button (a screenshot or a screen share must not leak it), as text and a QR code. The page reads the fragment, posts it once, gets a device cookie and clears the URL. | The fragment never reaches the server, proxy logs or a `Referer`. Regenerate kills the token and every device that used it. "Add a device" can also show a one-time QR valid 10 minutes, which is safer to show on screen. |
| **Password** | Set on the desktop, stored as an scrypt hash (computed off the main thread, a few at a time); a sign-in page gives a device cookie. | Works with no one at the desktop. Brute force is slowed, not locked out (§4.1). |
| **Desktop confirm** | The browser shows a short code; the desktop shows a non-modal request ("A browser asks to control cc-cockpit") with no default button, and the person types the browser's code to allow it. | One pending request at a time, rate limited; the device name is the requester's own text and shown as such. Strongest for one person; needs someone at the desktop. |
| **None** | No sign-in: whoever reaches the address is in. Meant for a proxy that signs people in (Tailscale, Cloudflare Access, oauth2-proxy). | Host and Origin checks still apply. Revoke means nothing here (anyone can come back). On loopback: allowed with a plain explanation. On any other address: allowed after a confirm (§4.3). |

Every mode ends in the same device cookie, so the rest of the system (views, revoke, the indicator) does not care
which one signed the device in.

### 4.3 Dangerous choices need a confirm

Choosing **None on a non-loopback address**, or **any mode over plain http on a non-loopback address**, opens a
confirm that says what it means, in plain words. Draft text for None:

> **Anyone who can reach this address controls this computer.**
> With no sign-in, any device on this network (or the internet, if the port is reachable from it) can open
> cc-cockpit, read and type in your terminals, run Claude with your account, and read and change your files and
> plugin accounts (mail, Jira, chat), as if sitting at your desk.
> Use this only on a network you fully trust. If a proxy signs people in, keep cc-cockpit on 127.0.0.1 behind it:
> listening on the network lets people go around the proxy.
> [Cancel] [I understand, turn off sign-in]

For plain http: the token or password and everything you type travel unencrypted, so anyone on the same network
can read them and use them. While either choice is on, the desktop's top bar shows a warning badge.

### 4.4 Sharing

- **Your own new device**: scan the QR code on the desktop (the one-time "add a device" code, or the access link).
- **Another person** comes with multi-user (§10): an invite link that works once, expires and is tied to a person and
  a role. Not in v1.
- A long-lived shared link is the access link itself; regenerating it is how to take it back.

## 5. Live mirror

Every view of a project window shows the same tabs, terminals, panels and layout, and any view can act. Two things are
held by one view at a time, with "take over" on the others: an HTML overlay's page and a plugin settings page (§5.4).

### 5.1 State shared and state per view

| State | Shared or per view |
|---|---|
| Tabs, order, titles, flags, session status | shared (main) |
| Layout: which panels in which zones | shared (main, as today per project) |
| Zone sizes, collapsed zones | per view (a phone and a desktop differ); main keeps the desktop's as today |
| Selected tab | per view. The project's `activeTab` (plugins, Discuss) is the selection of the view that acted last. A plugin acting on a click (`ctx.sessions.focus` from the Sessions panel, `panels.show` from the usage meter) acts in the view the click came from (§5.3) |
| Terminal overlays, close asks, `ccc` CLI dialogs | shared: shown on every view, the first answer wins, and main tells the others it is settled. Close asks: `CloseAsks` takes the answer from any view of the window, then sends `sessions.closeSettled` to every view; a view that could not ask (a dialog, screen or overlay over it) answers `declined`, which counts only once every live view declined. An ask for a tab a view's strip does not show yet (a plugin's close right after its open) waits up to 2 s for the tab there, then is declined; one replayed before the view's tab list is declined at once when the list lacks the tab. Terminal overlays: main's stack, ended by the program's exit or the first ✕, and `overlays.updated` drops it everywhere. The link confirm becomes an in-page dialog for remote views (§6.1) and follows the same rule |
| HTML overlays, settings pages | held by one view (§5.4) |
| Scroll position in a terminal | per view |

The `ready` snapshot a joining view gets carries all of it: tabs, layout, the overlay stack, pending close asks and
CLI dialogs, panel headers and badges, slot frames. The browser bridge hands the pending close asks to the shell's
`sessions.closeAsk` listener when it subscribes (after `ready`), as if they had just arrived. A terminal overlay
joined mid-run shows only output from the join on (it redraws on the view's resize); its scrollback is not mirrored.
A view's `tabs.list` never waits for the desktop's first attach (which restores the window's tabs or opens its first
Claude tab); the tabs that attach brings are announced to the other views as `tabs.added`.

### 5.2 Terminals

- **Main holds the terminal.** A headless terminal per tab in main (`@xterm/headless` + the serialize addon,
  pinned), created while the gateway is on. It is fed **the same flushed chunks the views get** (`PtyService.flush`),
  each numbered. It is the pty's flow-control consumer: main acks the pty itself, so no view pauses Claude.
- **Snapshot without gaps or doubles.** A view joining a tab gets a `term.snapshot` taken inside the write callback
  of chunk N (xterm's `write` is asynchronous, so serializing earlier would miss parsed-later bytes), tagged `seq: N`;
  its live stream starts at N+1, chunks held for it meanwhile. A chunk boundary can fall inside an escape sequence,
  and a snapshot carries no parser state: the snapshot waits for the parser's ground state (or a short timeout). Only
  the visible tab is snapshotted; others when selected. A tab selected before it has a process (a restored command
  tab waiting for its first Restart) is joined when it starts, since a restart keeps the view's selection.
- **Every view, desktop included, drops and resyncs.** A view whose buffer passes a limit stops getting live data and
  is resynced with a snapshot. The desktop renderer follows the same rule instead of today's `tabs.ack` pausing the
  pty, so `cat bigfile` cannot flood it (the freeze `HIGH_WATER` exists to prevent); `TabManager.attach` →
  `resetFlow` becomes a snapshot.
- **Main answers terminal queries.** The headless terminal's own replies to DSR and DA go to the pty; OSC 10/11
  (colours) are answered from the theme. Query replies from every view are stripped in main. Mouse and focus reports
  pass from any view (a second view can click and scroll in a TUI). This also stops Claude's startup queries timing
  out when no view is awake.
- **Size.** Main remembers each view's size. The pty takes a view's size only when that view explicitly takes the
  terminal (typing after another view typed, after a short debounce, or a "fit to this screen" action), not on every
  resize, so phone and desktop typing in turn do not redraw Claude each time. The headless terminal resizes with it
  and views get a size event. When the sizing view leaves, the size falls back to a remaining visible view. Only the
  person's typing counts as input: a focus or mouse report, or a view's own reply to a query, takes nothing. A view's
  page also takes the size as "fit" does, at once, when the person presses the pointer in the pane, focuses the
  terminal, or brings the window (after it was left) or the page (visibility) back to the front while the terminal is
  the active tab, when the person selects the tab in that view (a tab bar click, the tab switcher, a tab shortcut, a tab
  made with +; a terminal not attached yet takes once it is, `TerminalSession.takeOnSelect`), and a browser page does so
  once when it loads (the first `ready` of the page, never a reconnect's; a tab without a terminal yet is skipped);
  programmatic focus and selection (start, restore, main's `tabs.select` from a plugin's focus or the Sessions panel,
  the neighbour of a closed tab) never take, and a view already sizing sends nothing (`TerminalSession.takeSize`). A view that follows draws the grid scaled down to its pane, but never below
  `MIN_DRAW_SCALE` (0.7, `terminal-draw.ts`); past that the pane scrolls, kept at the bottom and the cursor. A terminal
  overlay keeps a size per view too: the first view to measure it sizes it, typing in another view moves it there
  at once, and its flow control is the desktop page's acks alone. With no headless copy to answer for it, only the
  view that sizes an overlay (the desktop's until another takes it) answers its queries; the other views' replies are
  stripped from their input as for tabs. Hidden views follow the tab rule: a hidden view sizes (and so answers) an
  overlay only as its one measured view, and a hidden sizer hands both to the visible view active last, since a
  throttled renderer answers late and the late reply reads as typed keys.
- **Input from any view.** Input is the person's: it sets `typed` like desktop typing, and the send gate applies
  unchanged. Two views typing at once interleave, as two keyboards on one machine would; each view shows which
  device typed last in a tab. Turn-taking is a multi-user concern (§10).
- **Cost.** Parsing every tab's output now runs in main, which serves every IPC call. Phase 0 measures it with
  several busy Claude tabs; if it shows, the headless terminals move to a worker thread.
- **Keys.** A browser keeps Ctrl/Cmd+W, T, N, Tab and others; the web shell maps the cockpit's colliding chords to
  alternatives and documents them.

### 5.3 Panels and slots: ports per view

- **Panels.** `PanelPorts.attach` (`src/host/ctx/ui.ts:168`) keeps one port per panel and per view instead of one per
  panel; a reload in one view replaces only that view's port. `ctx.panels.post` goes to every view's page,
  `ctx.panels.onMessage` hears every page.
- **Slots** already are instances: `ctx.slots.onOpen(slot)` gives one object per frame and plugins keep a set
  (`plugins/sessions/dist/host.js:135`). Main's `openSlots`, `withinCap` (keyed by window today) and
  `connectSlot` (which closes the previous frame of the same id) are keyed by view, so each view's frame is its own
  slot instance.
- **Where an action came from.** The plugin host knows which view each message came from and carries it implicitly
  (an `AsyncLocalStorage` around listener dispatch, attached to the RPC calls the listener makes), so
  `ctx.sessions.focus` from a phone's click selects on the phone, with no plugin change. The same holds for every page a
  view shows: panels and slots (their port tag names the view), settings pages (the `settingsPageOpen` tag) and html
  overlays (main's `overlay.message` names the holder's view); and for the clicks main hands a plugin from a view: a
  palette command (`command.run`), a panel header action (`panel.action`), an overlay toolbar button
  (`overlay.buttonClick`) and a file given to the open-file plugin (`files.open`, from a `ctx.files.open` or
  `ctx.sessions.openFile` made in a view). Main adds the view the router bound to the call, never one from the payload.
- **Per-page replies.** Some answers belong to one page (file search results, the Sessions panel's `refused`
  message). The listener gets an optional second argument `{ view }` and `post` an optional `{ view }` target. Old
  plugins keep broadcasting, correct for state pushes; the bundled plugins that reply per page adopt it in phase 3.
- **Browser side.** The shell creates a `MessageChannel` per panel, hands one end to the iframe exactly as the desktop
  shell does (`panel-port-bus.ts`), and pipes the other end over the socket. The panel SDK does not change.
- **Main side.** For a remote view, the page end of the `MessageChannelMain` stays in main and is relayed to `port.*`
  frames; size cap, JSON only, and a per-panel queue limit.
- **As built** (plan Task 22): the shell asks with the desktop's own connect calls (`panels.connect`, `slots.connect`,
  `settingsPage.connect`, each with a nonce); a refused one answers false as on the desktop and no port follows, and
  an accepted one comes back as `port.open` with that nonce (`main/web/port-relay.ts`, `renderer/web/port-relay.ts`).
  The shell says `port.close` when a frame's page goes (a browser port has no close event to rely on); main closes
  every end a view held when it leaves, and a device may hold at most 8 views of one window (not None's anonymous
  caller, which is every browser at once; the gateway caps connections). The gateway pings every socket every 30 s and
  drops one that missed the last ping (a phone that slept or changed networks leaves a half-open socket), and a view
  whose socket holds more than 32 MiB unsent is closed to resync.

### 5.4 Overlays and settings pages

- **Terminal overlays** are shared, as tabs are (§5.2), and their answer is first-wins (§5.1).
- **HTML overlays are held by one view.** Main has one `pageReady` flag and one outbox per overlay
  (`overlay-manager.ts:345,721`), and plugins treat the page as one (the reviewer posts `init` once, `host.js:763`,
  and each page posts its whole draft, `:675`). So the overlay's page lives in one view, the one it opened on or the
  last to take it; other views show "Open on <device> — Take over". Taking over reloads the page in the new view, as
  a desktop reload does today.
- **Plugin settings pages** the same: `connectSettingsPage` already keeps one page per plugin (`panel-ports.ts`),
  shown in one view with take over.
- **As built** (plan Task 24): an html overlay's holder is the opener's origin view (a plugin's `ctx.overlay.open` from
  a listener handling a browser's message, checked to be a live view of the window), else the desktop's.
  `OverlayInfo.heldBy` names a browser holder and its device; absent means the desktop, so the shape without web
  access is unchanged. `overlays.take` moves it to the calling view; `overlays.ready`/`loaded`/`message`/`result` from
  any other view are dropped, and the opener's posts go to the holder's view only (`emitToView`). A view's own reload
  (`overlays.list`) resets only the pages it holds; a browser holder leaving hands the page back to the desktop (a
  reconnect is a new view, so it loses the hold). Settings pages: Take over is the taking view's own
  `settingsPage.connect`; `settingsPage.info` carries `heldBy`, and every change of holder is sent to the project's
  views as `settingsPage.held` (null when the page closed, and a view showing the note then loads it).

### 5.5 Plugin pages over HTTP

- **One origin, capability paths.** Plugin files are served under `/p/<token>/…`, one token **per (device, plugin)**,
  issued by main, valid while the device is signed in and killed on revoke. A page reading its own URL learns only
  its own plugin's token. A sandboxed page's requests are cross-site, so the `SameSite=Strict` cookie does not go
  with them: **the path token is the only credential** for plugin files, which is why it is per plugin and dies with
  the device.
- Responses carry the plugin CSP of `cc-plugin://` rewritten for the path (`connect-src` and `img-src` that path
  only), the CSP `sandbox allow-scripts` header (opaque origin, as today), `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, and `Access-Control-Allow-Origin: null` for the page's own fetches. No redirects ever
  (browsers ignore CSP path parts after a redirect).
- **The file resolver** in `plugin-protocol.ts` is Electron-free and reused: containment, realpath, verified reads,
  size cap.
- **Navigation.** The desktop blocks a frame navigating elsewhere (`create-window.ts:61`), and the shell cannot read a
  sandboxed cross-origin frame's URL. So in the web build, any load of a plugin frame that the shell did not start
  replaces the frame element with a new one on the canonical path, whose first load alone is served (`PluginFrame.onLoad`
  on the desktop hands a port on every load). Not `src` on the old element: its page is still alive and could start a
  navigation of its own after the shell's, which cancels the shell's, and its load would look like the expected one.
  A port from main is asked for when the shell starts the load and posted inside that load's event
  (`renderer/web/port-relay.ts` FrameLoads).
- **The shell's own plugin images** (`img-src … cc-plugin:` in `renderer/index.html`) map to the same paths.
- **Inline overlays** (`cc-overlay://`) are served from memory under a path valid while the overlay is open (reloads
  included): `/o/<token>/<overlayId>/`, one overlay token per device, and only for an overlay in a window the device
  has a view of.
- **Who learns the paths.** Main sends the web shell a prefix per installed plugin and the overlay prefix
  (`ready.paths`, and a `paths` frame when the installed plugins change); the shell maps the desktop's `cc-plugin://`
  and `cc-overlay://` URLs through them (`renderer/web/page-paths.ts`). A path is served only while its device has an
  open view bound to a project the plugin is enabled in (`main/web/plugin-pages.ts`).

### 5.6 Window lifetime

Closing the desktop window today closes the project and its tabs. With remote views attached it asks: "Close for
everyone" or "Keep running for <device>". Kept running, the window is hidden; a hidden renderer is throttled, so it is
never the sizing or input view. The person gets it back by opening the project again (the picker, `ccc open`, the
dock), which shows the hidden window. Quitting the app closes all views with a notice. When the host sleeps, views
show "host unreachable" and reconnect.

- **As built** (plan Task 26): `WindowManager.closeRequested` keeps the window open (Electron's `close` prevented)
  while `windows/close-dialog.ts` asks, as a sheet: Close for everyone, Keep running (the default, Enter)
  or Cancel (Esc); a box that fails closes for everyone. Nothing asks while quitting, for a reopen, or with no browser view. A hidden
  window's desktop view is marked hidden for the terminal sizes by main (its own `tabs.visibility` cannot undo it), so a
  browser sizes the tabs. `openView` (picker, `ccc open`), `activate` (the dock) and `focusAny` (a relaunch) show it;
  `focusProject` (plugins, chips, a plugin's tab close) leaves it hidden. Quit: `before-quit` closes every view with
  `CLOSE.appQuit` (4504), final in the bridge, before the windows close (each would otherwise send `windowClosed`).

## 6. Native features

### 6.1 Remote view behaviour (v1)

| Feature | Desktop view | Remote view |
|---|---|---|
| `ctx.notify` | OS notification and sound | unchanged: stays on the host (Web Notifications need a secure context and do not wake a sleeping phone; later) |
| `ctx.openExternal`, link clicks | the OS browser | a clickable notice in the view (a page cannot open a tab without a click): `app.linkNotice` to the asking view only, from `app.openExternal`, `updates.openRelease` and `ctx.openExternal`; the caller type is main's (`view.remote`, `originOf`), never the payload |
| Link-confirm dialog (`socket/handlers.ts:404`) | native dialog | an in-page dialog, shown while any browser view is attached on every view of the window (desktop included), first answer wins (`LinkAsks`, `links.ask` / `links.answer` / `links.settled`, pending ones in `ready.linkAsks`); with no browser attached the native dialog as before. A remote view may only Deny: main refuses its Allow (by `view.remote`, never the payload) and its dialog says "Approve on the desktop", so the ask waits for the desktop or runs out (5 min), as plugin linking stays off remote views (the row below) |
| `ctx.files.reveal`, `openWithSystem` | file manager, default app | refused with a message |
| `ctx.files.trash` | host trash | unchanged |
| Folder dialogs, plugin link | native | `no` (do it on the desktop); a `ccc plugin link` typed in a tab from a browser can be denied there but only approved on the desktop |
| OAuth sign-in | loopback redirect | "sign in on the desktop" |
| Browser panel, URL overlays (`WebContentsView`) | embedded browser | "available on the desktop" placeholder |
| Window controls, drag regions, full screen, update notice | native | not shown |

## 7. Phases

0. **Spike** (throwaway branch), proving the hard parts, not the easy bridge:
   - a browser view attaching to a **live Claude tab** next to the desktop: numbered chunks and a gap-free snapshot
     (no lost or doubled bytes under heavy output), the modes Claude sets (bracketed paste 2004, focus 1004,
     synchronized output 2026, alt screen) surviving serialization, main answering terminal queries, input from
     either view, the size policy;
   - **the cost of headless terminals in main** with several busy Claude tabs (event-loop delay, memory per tab);
   - **one real plugin panel** (`cockpit.sessions`) in a sandboxed iframe over HTTP on both screens: CSP path
     sources, the opaque-origin fetch, ports per view, a click on the phone selecting on the phone;
   - Host and Origin checks behind `tailscale serve`.
1. **Transport and identity**: `Caller` with views, `ViewRegistry` (and the rule against bypassing it), remote
   classes with their test, the gateway on loopback, the always-on checks (§4.1), the access link and None modes,
   devices, the top-bar indicator.
2. **Terminals**: headless terminal per tab as the flow consumer, numbered chunks, snapshots and resync for every
   view (desktop included), main answering queries, the size policy, keys.
3. **Panels and overlays**: ports and slots per view, the implicit origin view in the host, the optional `{ view }`
   API, plugin paths and tokens, shared asks with `settled`, HTML overlays and settings pages held by one view.
4. **Native mapping** (§6.1) and window lifetime (§5.6).
5. **Remote reach**: password and desktop-confirm modes, external origin and TLS settings, the confirms of §4.3,
   Tailscale and SSH docs.
6. Later: the desktop as a remote client, multi-user (§10), a phone layout, headless mode (§9).

## 7a. Spike results (2026-11-10, branch `spike/web-terminal-mirror`, not merged)

Proved in a browser on the LAN (`CC_COCKPIT_WEB_SPIKE=<port>`, `CC_COCKPIT_WEB_SPIKE_BIND=0.0.0.0`): a live Claude tab
mirrored with its full screen on join, live output on both screens, and input from the browser reaching Claude.
Unit tests: a randomized run (400 frames, random splits and joins, resizes) rebuilds every view identical to the
mirror; split CSI/OSC/surrogate cases; Host/Origin/token checks.

What changes in this design:
- **Resizes are numbered in the same stream as output** (a resize must land at the same point in every copy), so
  §3's `term.data` carries both data and size items.
- **Headless terminals go to a worker thread.** xterm parses in slices of up to 12 ms per terminal, so N flooding
  tabs stall main for about N×12 ms (8 tabs flooded: p50 97 ms); a full-scrollback snapshot blocks 30–70 ms. Paced
  output is cheap (p50 1.1 ms). Memory: about 9 MiB per tab at 5,000 lines.
- **Serialization gaps.** The serialize addon drops cursor visibility (25), synchronized output (2026), SGR mouse
  encoding (1006/1016), the scroll region and the cursor style; the spike re-emits them. Still lost: charsets, the
  saved cursor, the normal screen's state while the alt screen is on, tab stops, the title.
- **Ground state** needs xterm's private parser fields; if they move, the check degrades to "always ready".
- Over plain http on an IP nothing the page needs is missing (copy and paste go through xterm's own textarea).

**Spike 2** (branch `spike/web-plugin-panel`, on top of spike 1, not merged): the bundled Sessions panel, unchanged,
live in the browser and on the desktop at once; a card click in the browser switched the browser's terminal only.
Chromium (sandboxed iframe, opaque origin) enforced CSP path sources for `script-src`, `img-src` and
`connect-src` (another plugin's path, the server root and the WebSocket all blocked); the page fetched its own files
with `Access-Control-Allow-Origin: null`; storage, cookies and the parent's location stayed unreachable; a
`MessagePort` handed into the sandboxed frame worked both ways; a self-navigated page got no port.

What changes in this design:
- **Root-absolute URLs break under `/p/<token>/`.** Pages load `/__sdk/panel.js` and `/dist/…`; under a prefix they
  hit the server root and the CSP blocks them. The spike rewrites `src`/`href` in HTML; URLs built in JS or CSS still
  fail. To decide in the plan: rewriting, a relative-URLs rule with a lint (and the guide changed), or a host name
  per plugin (impossible on a bare IP or behind `tailscale serve`).
- **The origin view leaks** through timers and promises started inside a listener (`AsyncLocalStorage`), so main
  treats it as a hint and checks it against the asking host's project; the plan bounds it.
- Plugin pages need `frame-ancestors <shell origin>` and the shell `frame-src 'self'`, built from the external origin
  (https behind a proxy while main sees http).
- `port.open` is started by the page on every load it began; main answers a refused connect with `port.close`.

Not proved yet: overlays (the reviewer opens on the desktop only), slots (the sessions strip), settings pages,
per-page replies, main answering terminal queries, main as the flow consumer, cookies and devices, access through a
proxy.

## 8. Testing

- Router, gateway, view registry: unit tests with a fake socket (the router already takes a fake `ipcMain`).
- The remote-class drift test and the `webContents.send` / `getAllWindows()` rule.
- Mirror: two views of one window in tests (fake desktop view + fake socket view): panels on both, overlay answered
  once, query replies from one view only, a slow view resynced without pausing the pty.
- e2e: Playwright drives the web shell in a plain browser against the dev app with the gateway on loopback, next to
  the Electron window.
- Security: wrong Host, wrong Origin, no cookie, expired or revoked device, a used or regenerated access token,
  wrong passwords past the limit, a confirm code without desktop Allow, None on a network address without the confirm, a plugin token for another plugin, a navigated frame, a path outside the plugin folder, frames
  naming another window or project, `no`-class channels from a remote view, oversize frames.

## 9. Headless server mode (later)

The app with no desktop window (a home server, a VM). Electron runs without windows, but on Linux it still wants a
display unless started with Chromium's headless Ozone platform; plugin hosts and node-pty need none. Out of v1: the
window lifetime rules and the desktop-confirm mode assume a desktop (the link and password modes do not).

## 10. Toward pair development (after v1)

What v1 keeps open, and what multi-user adds:
- **Identity.** `Caller.who` is the person in v1; multi-user adds people (an invite per person, not a device code),
  shown as presence on tabs and panels.
- **A desktop as a client.** The desktop renderer uses the network bridge for a remote project (a "connect to…"
  entry next to open folder); the rest of the shell is the same code.
- **Input turn-taking** in a shared Claude tab: who holds the keyboard, "Bob is typing", a request to take over;
  `typed` and the send gate stay per tab.
- **Plugin data is the host owner's.** Gmail, Jira, Chat panels show the owner's accounts. A guest sees a plugin
  only if the owner shares it, per plugin, off by default; a guest never gets the owner's secrets, `ccc` socket or
  plugin settings.
- **Permissions**: view-only guests, and which channels a guest's class allows. A guest who can type or prompt Claude
  in a shared tab has the owner's shell; "never gets the owner's secrets" holds only for view-only guests, and they
  still see terminal text.
- **A desktop client** sends no `Origin`: it signs in with a bearer handshake of its own, never by relaxing the
  Origin check for browsers.

## 11. Open questions

1. ~~Zone sizes per view~~: v1 ships "the desktop keeps today's, a remote view keeps its own in the browser"
   (browser storage per project; main keeps the desktop's and ignores a remote view's sizes in `layout.set`).
   Main keeping sizes per device stays possible later.
2. Headless terminal always on (also fixes desktop reload) or only while the gateway is on? Memory per tab with
   ~5,000 lines needs measuring.
3. ~~The `{ view }` addition to `ctx.panels`~~: settled by review 2, it ships in phase 3 (bundled plugins need
   per-page replies).
4. Window close with remote views attached (§5.6): is hiding the desktop window the right default?
