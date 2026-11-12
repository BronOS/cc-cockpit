# Web access (remote cockpit) — design draft

Status: v1 implemented (2026-11-10, branch `feat/web-access`; plan `docs/plans/completed/20261110-web-access.md`, phases 1 to 5 of §7).
Revised after two architecture reviews. Server mode (§9, Linux, no display) is implemented and ships with web access
(2026-11-11, plan `docs/plans/completed/20261111-server-mode.md`); section 10 and the phone layout stay later. The code's own comments
carry the finer points (`src/main/web/`, `src/main/views/`, `src/renderer/web/`); this document keeps the reasons.

**What v1 implements:** the gateway (http + one WebSocket per view), the Host and Origin checks, the four sign-in modes
(access link, password, desktop confirm, None), devices with Disconnect and Revoke, the confirms of §4.3, the view
registry and the remote class of every IPC channel, a headless terminal per tab with numbered chunks and snapshots for
every view, ports and slots per view, plugin pages under path tokens, shared link asks, overlay and settings-page
take-over, window lifetime (§5.6), the native mapping of §6.1, and the settings page, top-bar chip and devices list.
How to use it: `docs/features.md` "Web access".

**Later, not in v1:** the desktop as a remote client (§10), more than one person (§10), a phone layout, Web
Notifications, and on the desktop: `ctx.notify` to a browser, a remote Allow of a plugin link and a plugin's OAuth
sign-in from a browser (server mode has all three, §9.6, §9.9); the browser panel and URL overlays in a browser.

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
- A server with no display in v1 itself; server mode is designed in §9 (Linux only) and ships with the same feature.
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
`getAllWindows()` broadcasts), `toEach` (one payload per view: the theme, §5.7), and `postPort` (today's
`webContents.postMessage`). A desktop view wraps its
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
  raises a desktop notification (server mode: a stdout line, §9.9).
- **Remote views cannot add or widen access**: the auth mode, bind, secrets, host list and device list are
  `no`-class channels (§2.3), changed only on the desktop (server mode: from a shell on the server, §9.4, where a
  browser may also revoke and disconnect devices, which only narrows, §9.6).
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
- **Seeded from the desktop.** A tab already running when web access starts, and every tab after a worker restart, has
  output main never saw (a full-screen program that switched to the alternate screen and mouse tracking before would
  otherwise be copied onto the normal screen, its redraws piling up as scrollback). Main asks the desktop page for its
  screen (`tabs.screenAsk`, desktop only, sent in order after the output that page got) and holds that tab's items for
  the worker until the answer (`tabs.screen`, `no` class: checked against the ask out for that tab of the sender's
  project, its size and `MAX_SCREEN_CHARS`) lands as the copy's start, then posts the items after it. A page parsing
  mid-sequence answers busy and is asked again; no answer within 3 s, a page that was behind, or none at all: the
  copy starts blank, as before (`mirror.ts` "Seeding").
- **Main answers terminal queries.** The headless terminal's own replies to DSR and DA go to the pty; OSC 10/11
  (colours) are answered from the theme of the view that typed in the tab last, else the view sizing it, else the
  desktop's (§5.7: views can differ, a program gets one answer). Query replies from every view are stripped in main. Mouse and focus reports
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
- Server mode (§9) never shows, hides or focuses its window (§9.8), and its stop closes views with a code the bridge
  retries (§9.1).

### 5.7 Theme per view

The theme pick is app-wide, but "follow the system" (no pick) is per view: the system is the screen the view is on.
The desktop page (and server mode's hidden page) follows Electron's `nativeTheme`; a browser view follows its own
`prefers-color-scheme`. Before, main pushed one theme to every view, so a server (no OS appearance, so light) painted
every dark browser light, and a phone took the desktop's appearance.

- The browser reports its scheme in `hello` (`dark`, optional; a non-boolean reads as not reported) and on every
  `matchMedia` change as `theme.scheme` (`adapted`: main takes it only from a view it bound as remote, never by the
  payload; a desktop call is ignored). `ThemeService` keeps it per view id and drops it with the view. Recorded at
  `hello` with no event (`ready` is the first frame), so the view's first `theme.get` already answers by its scheme.
- Resolution: a pick (a plugin theme included) for every view; else the built-in of the view's reported kind; else
  (desktop, a browser that did not report) the OS rule. The hint can only choose between the two built-ins for that one
  view: it cannot reach the desktop's theme or another view's.
- `theme.get` (`adapted`) answers by the calling view. `theme.changed` (`adapted`) goes per view through
  `ViewRegistry.toEach`, only to the views whose theme moved: a pick change, a plugin theme change, a `nativeTheme`
  change (the desktop and unreported browsers) or one view's scheme change (that view).
- Followers: plugin panels, slots and html overlays get the theme from the shell page they sit in, so they follow the
  view. Settings › Appearance's "Showing ..." names the calling view's theme. App-level readers stay on the OS rule:
  the `BrowserWindow`'s background before its page paints (a desktop window). `ctx.themes` only sets, never reads.
- Terminal colour queries (§5.2) have one answer per tab: the theme of the view that typed there last (`typedBy`,
  the same owner idea as the size), else the view sizing it, else the OS rule.
- Before the first theme: the web shell's stylesheet (render-blocking) paints the built-ins' background and text by
  `prefers-color-scheme`, and the page applies the built-in of the browser's scheme at once, so "Connecting...", the
  sign-in and the picker pages (which never get a theme from main) match the browser too.

## 6. Native features

### 6.1 Remote view behaviour (v1)

Server mode (§9) changes these rows: a browser may Allow a plugin link (§9.6), the trash confirm is in-page (§9.6),
`ctx.notify` is an in-page notice, OAuth signs in by pasting the failed redirect (§9.9), and there is no desktop to
defer to (§9.7, §9.9).

| Feature | Desktop view | Remote view |
|---|---|---|
| `ctx.notify` | OS notification and sound | unchanged: stays on the host (Web Notifications need a secure context and do not wake a sleeping phone; later) |
| `ctx.openExternal`, link clicks | the OS browser | a clickable notice in the view (a page cannot open a tab without a click): `app.linkNotice` to the asking view only, from `app.openExternal`, `updates.openRelease` and `ctx.openExternal`; the caller type is main's (`view.remote`, `originOf`), never the payload |
| Link-confirm dialog (`socket/handlers.ts:404`) | native dialog | an in-page dialog, shown while any browser view is attached on every view of the window (desktop included), first answer wins (`LinkAsks`, `links.ask` / `links.answer` / `links.settled`, pending ones in `ready.linkAsks`); with no browser attached the native dialog as before. A remote view may only Deny: main refuses its Allow (by `view.remote`, never the payload) and its dialog says "Approve on the desktop", so the ask waits for the desktop or runs out (5 min), as plugin linking stays off remote views (the row below) |
| `ctx.files.reveal`, `openWithSystem` | file manager, default app | refused with a message; a plugin page reads `ccPanel.view.remote` (the shell's `cc-plugin.port` message, from `isWebShell`, never the page or host) to hide such items, a UI hint only (cockpit.files leaves them out of its menu) |
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
6. **Server mode** (§9, Linux): the re-executed start, the hidden page's own state, the dialog and `openExternal`
   adapters, the key file, `ccc web` and the start link, owner approvals, opening projects from the browser, in-page
   notices and the OAuth paste box.
7. Later: the desktop as a remote client, multi-user (§10), a phone layout.

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
- Server mode: §9.13.

## 9. Server mode

Status: implemented 2026-11-11 (plan `docs/plans/completed/20261111-server-mode.md`), from a spike (Electron 45.1, Linux, no
keyring) and revised after review. Linux only in this phase. Run so far: the unpacked build, headless, by
`scripts/server-mode-smoke.mjs` (also with the network off), and the e2e suite with the harness's direct switches. Not
run: the AppImage on a stock Ubuntu Server, the deb and the systemd unit on a real server, Tailscale (§9.1 "Installs",
`docs/features.md` "Server mode"). Where the build differs from the text below, a "Built:" note says so.

**Goal.** Someone installs cc-cockpit on a server with no display (a home server, a VM) and uses it only through web
access, from browsers. The model is v1's: one person with several devices, every signed-in device is that person (§4).
What changes is that no desktop exists. v1 keeps three things on the desktop: who gets in (the auth settings), seeing
who is in, and approving what runs as code. Server mode moves the first to a shell on the server (§9.4), the second to
the log, the CLI and the browsers' card (§9.12), and the third to the browsers (§9.6).

**Mechanism.** Electron runs with `--ozone-platform=headless --disable-gpu`: Chromium's headless platform needs no X or
Wayland, and plugin hosts and node-pty never needed one. The project's `BrowserWindow` is kept and never seen: its page
stays the window's desktop view inside main, so the mirror's screen seed (`tabs.screenAsk`, §5.2), the restore of tabs
on attach, panels and the window's lifetime keep one code path, under rules of its own (§9.8). Idle cost: about 250 MB,
under 1 % of a core. Xvfb was dropped: a system package, and it turns each native-dialog crash below into an invisible
hang, so it needs the same work.

### 9.1 Start

- **When.** `cc-cockpit --server`, or on its own on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set (without
  the Ozone switch Electron exits at once, "The platform failed to initialize"). `ssh -X` sets `DISPLAY`, so a
  forwarded session gets the desktop; `--server` forces server mode. Not `--headless`: Chromium reads that switch itself
  (measured: `app.commandLine.hasSwitch('headless')` is true with it on argv).
- **Linux only.** On macOS and Windows `--server` prints "server mode runs on Linux only" and exits 1, and nothing is
  detected. macOS would need another mechanism (never-shown windows, throttling, the dock, a GUI login session, a
  keychain that prompts on screen) and has no spike.
- **Re-exec.** The Ozone switch must be on argv: `app.commandLine.appendSwitch` from main is too late and
  `ELECTRON_OZONE_PLATFORM_HINT=headless` is not read (spike). `app.relaunch` loses stdout: measured, the relaunched
  process has fd 1 and 2 on `/dev/null` and is detached, so a manual run would daemonize silently. A `spawnSync` child
  keeps stdout, but a SIGTERM sent to the first process alone leaves the child running, reparented; an async `spawn`
  cannot forward signals, because the first process leaves its top-level script, fails at platform init and exits 1
  within 3 s (both measured, minimal app). So when server mode applies and argv lacks `--ozone-platform=headless`,
  main, before `ready`:
  1. checks the single-instance lock: when another instance holds it, argv goes to that one as any second launch does
     and this process exits 0, with nothing re-executed. Else it releases the lock, which the re-executed image takes
     again (a launch that takes it in the gap becomes the primary, and this one hands its argv over after the re-exec);
  2. without `--server` (detected), prints one line: "no display: starting cc-cockpit in server mode, web access on;
     stop with Ctrl-C";
  3. checks that `process.execve` is a function and that `exe` is executable (`accessSync(exe, X_OK)`), then calls
     `process.execve(exe, [exe, ...argv after the executable, '--server', '--ozone-platform=headless', '--disable-gpu',
     '--password-store=basic'], process.env)`: the image is replaced, so there is one process with the same pid and
     the same stdin, stdout and stderr, and its exit status is its own. A failed `execve` aborts the process (Electron
     45.1.0: SIGABRT, no exception), hence the check first. `exe` is `process.execPath`, in an AppImage too: under
     `execve` the image's mount lives on with the pid, and executing `APPIMAGE` again would nest a second runtime and
     mount (the AppImage run is a manual check after the plan and may change this).

  **Fallback, chosen at run time by that check**, at each start and before the lock is released; never by catching,
  because a failed `execve` leaves nothing to catch. When `process.execve` is missing or `exe` fails the check, main
  runs `spawnSync(exe, [...the same args, '--server-parent=<its own pid>'], { stdio: 'inherit' })` and exits with the
  child's status (128 + n for a signal; 1 with a line when the spawn itself fails, which a non-executable `exe` does
  without aborting). The second process arms a parent watch only when that marker is on its argv: a timer compares it
  with `process.ppid` and quits as SIGTERM does when they differ, so a SIGTERM sent to the first process alone no
  longer leaves it running. A direct start with the switches (a unit that passes them, the e2e harness) carries no
  marker and never arms the watch; unit tests run the watch over an injected parent-pid reader and start no process.

  Measured in a minimal app, and repeated in the real app before anything is built on it (plan Task 1, which writes
  its numbers here): same pid, stdout kept, the lock taken again, SIGTERM and Ctrl-C quit with status 0; the first
  image's two zygote processes stay as zombies of that pid for the run (accepted: they are gone with it).
  Built, and measured in the real app (Electron 45.1.0, no display, no session bus, plan Task 1): `execve` stays the
  path. The pid is the same (`/proc/<pid>/cmdline` carries `--ozone-platform=headless` after the re-exec); fd 1 and 2
  point at the same target before and after (`pipe:[...]` with a pipe, `/dev/pts/N` under a pty); the re-executed image
  holds the lock (the CLI socket comes up), and a second no-display launch with a folder hands over and exits 0 in 0.17 s
  with nothing re-executed; SIGTERM exits 0 in 40 ms (pipe) or 51 ms (pty), SIGINT in 35 ms, Ctrl-C typed into the pty in
  32 ms; the exit status is the app's own (a start that fails exits 1, not a signal status); the detected-start line
  prints once; the first image leaves 2 `<defunct>` children of the pid during the run and nothing of the run's session
  is alive after it. A launch that loses the lock to a planned re-exec ends with `process.exit(0)`, not `app.quit()`:
  with no display a quit returns to Electron, which fails platform init with status 1. The decision
  is a pure function (`src/main/server-mode.ts`: platform, env, argv in; `{ server, exec: { exe, args } }` or a refusal
  out) at the top of `index.ts`; main keeps `server` for the run. `projectPathFromArgv` skips the flag, the switches
  and the fallback's marker. `--disable-gpu` only spares the GPU process failing EGL twice before Chromium's software
  fallback; `--password-store=basic` is §9.5's, and `choosePasswordStore` already leaves an explicit one alone.
- **A desktop launch meets a server.** `SecondInstanceData` carries whether the second launch has a display. A server
  primary ignores the argv of one that has (it opens nothing there, logs a line); the second launch asks the socket
  (`ccc web status`, 2 s deadline), and when the answer says server mode shows a native box, as it has a screen:
  "cc-cockpit runs in server mode on this machine (web access at <address>)", with Stop (`ccc web stop`) or Cancel.
  Without it, typing `cc-cockpit` on one's own desktop while a server run holds the data dir would seem to do nothing.
  `docs/features.md` says so.
  Built: the second launch asks only when `app.json` has web access on (every server run writes it on, §9.2); with it
  off the holder is a desktop and the launch quits at once, with no private profile and no wait, as before.
- **Start order.** In server mode main awaits the gateway and the CLI socket before any window opens or tab restores
  (today `void webAccess.apply()` is not awaited and a socket that cannot start only logs, `index.ts:2569-2572`). Either
  failing (the port is taken) logs the reason and exits 1, so systemd shows the failure and retries without Claude
  tabs resuming and being killed on each try. A stored setting the gateway refuses is not a failure (§9.2).
- **systemd.** The process re-executes itself in place, so the unit's main pid is the app: a `Type=simple` unit needs
  no switches, `systemctl stop` reaches it directly and the status is its own. Example user unit (in
  `docs/features.md`, not shipped):

  ```ini
  # ~/.config/systemd/user/cc-cockpit.service
  [Unit]
  Description=cc-cockpit (server mode)

  [Service]
  ExecStart=/usr/bin/cc-cockpit --server
  # Optional, mode 0600: CLAUDE_CODE_OAUTH_TOKEN=... (§9.10)
  EnvironmentFile=-%h/.config/cc-cockpit-server.env
  Restart=on-failure
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```

  `loginctl enable-linger <user>` starts the user manager at boot, `systemctl --user enable --now cc-cockpit` starts it.
  SIGTERM quits in under a second (spike): tabs are saved and Claude tabs resume on the next start. Views are closed
  with a new non-final code the bridge retries with backoff, not `CLOSE.appQuit` (final, "Reload this page",
  `renderer/web/bridge.ts:211`), so the open browser tabs come back after a restart, an update or a reboot. stdout goes
  to the user's journal. Never as root: Chromium's sandbox refuses it, and the app never passes `--no-sandbox`.
- **Installs.** The deb and AUR packages, which ship `chrome-sandbox`. The AppImage needs FUSE and has no setuid
  sandbox helper, so it aborts where unprivileged user namespaces are restricted (Ubuntu 23.10 and later, most
  containers; inferred): with no `--no-sandbox`, it does not start there. `docs/features.md` marks each install as
  run or not run; a stock Ubuntu Server is a manual check after the plan (it needs a second machine).

### 9.2 Web access is on

- **Server mode writes what it runs.** At start, a stored `enabled: false` is written `true` and a stored `confirm`
  mode is written `link`, and stdout says so once ("server mode: turned web access on in app.json"). `ccc web set` and
  `applyWebAccessPatch` then work on the stored record as on the desktop, with no overlay to reconcile. A desktop start
  on the same data dir finds web access on: the rare case, accepted. Turning it off is refused ("server mode: web
  access is the only way in").
- Modes: access link (the default), password, None. None is allowed on loopback with no confirm; the §4.3 confirms
  apply to network binds as on the desktop (given with `--confirm`, §9.4).
- **Desktop confirm is refused**: nobody can answer the request card, so every browser waits 2 min and fails (spike).
  `applyWebAccessPatch` (`main/web/settings.ts`) refuses it in server mode, with the reason.
- **A stored risky setting without its confirm** (a network bind with None or plain http) is refused as v1 does, never
  rewritten to something safer (`web/settings.ts:5-8`): nothing listens, start prints the reason and the exact line
  to apply it (`ccc web set --bind 0.0.0.0 --confirm plain-http`), and the app keeps running so `ccc web` can fix it.

### 9.3 The first link

- When stdout is a TTY and the mode is access link, start prints a one-time add-device link (`addDeviceLink`,
  `main/web/auth.ts`), as Jupyter prints its token:

  ```
  cc-cockpit server mode: web access on http://127.0.0.1:7330
  Add a device (works once, expires in 10 minutes): http://127.0.0.1:7330/#t=...
  ```

  Otherwise (systemd, a pipe) it prints the address and "add a device: `ccc web add-device`", so no live link reaches
  the journal, its readers or a log shipper. Password mode prints the address; None the address and the warning of
  §9.12. The origin is the external origin when one is set, else the listen address (an SSH tunnel or `tailscale
  serve` maps it, `docs/features.md` "Reaching it").
- Protected as the desktop's "Add a device": 256 random bits, only the hash in memory, used once, gone after 10 minutes
  or when the next one is made, never on disk. Not in `web-access.log` either (that log holds no secrets,
  `access-log.ts`); it records that a start link was issued and the sign-in that used it.

### 9.4 `ccc web`: settings from a server shell

v1 changes the auth mode, bind and secrets only on the desktop (`no`-class channels, §2.3). Server mode has no
desktop, so they move to the CLI socket, used from a shell on the server:

| Command | Does | Outside server mode |
|---|---|---|
| `ccc web status [--json]` | mode, listen address and external origin, listening or the error, the secret store and how many values it cannot read (§9.5), server mode or not, the devices (name, signed in with, last seen), core notices (§9.9) | answered |
| `ccc web revoke <device>\|--all` | revokes devices (a lost phone) | answered |
| `ccc web link [--regenerate]` | prints the access link, made on first use; `--regenerate` kills it and its devices (§4.2) | refused |
| `ccc web add-device` | prints a one-time link, 10 minutes | refused |
| `ccc web password` | sets the password from stdin (a no-echo prompt on a TTY), never argv: argv shows in `ps` | refused |
| `ccc web mode link\|password\|none` | switches the mode; `confirm` is refused | refused |
| `ccc web set [--bind <addr>] [--port <n>] [--origin <url>] [--host <name>]... [--tls-cert <pem> --tls-key <pem> \| --no-tls] [--confirm none-network\|plain-http] [--start-folder <path>]` | bind, port, origin, hosts, TLS, through the same `applyWebAccessPatch` as the settings page: a §4.3 risk is refused with its confirm text printed, and applies only with its `--confirm`; `--start-folder` is where the browser picker's folder browser starts (§9.8; `''` clears it) | refused |
| `ccc web stop` | quits as SIGTERM does (§9.1's box uses it) | refused |

- **Desktop: narrowing only.** Outside server mode `ccc web` answers `status` and `revoke` and refuses the rest with
  "use Settings › Web access". Otherwise any process of the user (a plugin with exec, a remote view's shell, Claude
  after a prompt injection) could print the link or turn on None on the network with nobody asked, where today that
  takes a click on the person's screen. CLAUDE.md's "changed only on the desktop" stays true for the desktop.
- **Host-only.** `web` is answered only for a tokenless caller (`socket-server.ts`: a process outside the app's tabs),
  through a new fixed list `HOST_ONLY_COMMANDS` in `shared/protocol.ts`, projectless and kept out of
  `WINDOW_TOKEN_COMMANDS`. A shell, command or Claude tab gets "run `ccc web` from a shell on the server, outside
  cc-cockpit". Not a boundary (a tab's process is the same OS user and can drop its token or edit `app.json`, §9.12):
  it stops a Claude session reconfiguring access as a side effect of a prompt, and keeps v1's "a view does not widen
  its own access" visible. Never through a remote view's IPC: the `settings.webAccess*` writes stay `no`.
- **CLI details.** `web` joins `CORE_CLI_COMMANDS` (`shared/manifest.ts:82`), so a plugin contributing a `web` command
  becomes invalid, and `build:marketplace-tools` runs if the tools import that list. With the app not running `ccc web`
  prints "cc-cockpit is not running" and exits 1, unlike a plugin command's silent 0 (`cli/client.ts:415`, kept for
  hooks), so a script sees it. The no-echo password prompt is read before the 40 s deadline starts (`cli/client.ts`).
  Its guide text lands in `src/cli/guide/cli.md` in the same change (`cli-guide.test.ts`) and says it is for a shell
  on the server, not for Claude.
- The socket is found as today (`<data>/app.sock`, `CC_COCKPIT_DATA_DIR` for another data dir). The ccc offer is skipped
  in server mode (§9.9), so start prints the wrapper's path (`<data>/bin/ccc`, `~/.config/cc-cockpit/bin/ccc` on Linux).
- **Settings card in browsers.** `settings.webAccess` (the read), `webAccess.state` and `webAccess.changed` become
  `adapted`, open to a remote view only in server mode, so the browser's card follows changes live: mode, address,
  devices with Revoke and Disconnect (§9.6), the secret store, Desktop confirm disabled with its reason, and "change
  these with `ccc web` on the server".

### 9.5 Secrets without a keyring

A server rarely has a Secret Service, so safeStorage falls back to `basic_text` (a key built into Chromium), which
`secret-store.ts` refuses. With no store, the access link, the password and every plugin secret (`ctx.secrets`, secret
settings fields, OAuth tokens) are off (spike).

- **The mode decides the store.** Server mode always uses the key file and runs Chromium with `--password-store=basic`
  (§9.1's re-exec), so the keyring is never asked and a locked Secret Service cannot leave a probe waiting on an unlock
  prompt nobody sees. The desktop always uses the keychain and keeps refusing `basic_text`: a desktop has a keychain to
  fix, and a silent key file would weaken it. No selection by keychain state, no mixed reads.
- **Key file.** `<data>/secret.key`: 256 random bits, made on first start with `O_CREAT | O_EXCL` and mode 0600 at open
  (never chmod after). Each value is AES-256-GCM with a random 96-bit IV, stored as `KEYFILE-V1:` + base64(iv, tag,
  ciphertext). Opened with `O_NOFOLLOW` and checked by `fstat` on that descriptor (no check-then-use gap): refused, with
  the reason, when it is not a regular file, not the user's, readable by group or others, or not 32 bytes. Never made
  again over an existing file: that would lose every secret silently. When a new key is made while `KEYFILE-V1:`
  values exist (a restored backup, a deleted key file), start logs it with the count, those values answer "the key
  file was replaced: enter it again", and `ccc web status` shows the count.
- **Same protection as `~/.claude/.credentials.json`**: whoever reads the data dir as the user, or root, reads the
  secrets, and a backup of the data dir carries its key. On a server the keychain protects little more (an unlocked
  Secret Service hands any process of the user every secret too); what it adds is a disk image or a backup without the
  key. Disk encryption is the server's job.
- **Behind the adapter.** `src/main/secrets/key-file-store.ts` (node `crypto` and `fs`, no Electron) is one more
  `SecretStore`; `selectSecretStore` gets `server` and returns it or the keychain store. `safeStorage` is still
  imported only by `index.ts` and reached only through `secret-store.ts`.
- **Desktop and server mode on one data dir.** Secrets do not move between the stores. Each refuses the other's values,
  as the fake store's are refused today, with "stored by server mode's key file: enter it again here" (or "by the
  desktop's keychain"):
  - a secret settings field shows "stored in the other mode: enter it again" instead of "set";
  - `ctx.secrets.get` rejects with that text, so the plugin shows its own sign-in again;
  - web access: devices stay signed in (cookies and the access token are checked by hash, `devices.ts`), but the link
    cannot be shown until regenerated and the password (stored only as ciphertext) must be set again; the card and
    `ccc web status` say both;
  - start logs how many stored values belong to the other store.

### 9.6 Approvals: any signed-in device is the owner

In server mode every signed-in browser view may give the answers v1 keeps on the desktop. On the desktop v1's rule
stays: a remote view may only Deny.
- **`ccc plugin link`.** `chooseAsk` (`asks/shared-asks.ts`) always takes the shared ask, and `LinkAsks.answer`
  accepts an Allow from a view main counts as owner (`!view.remote || server`, never from the payload). With no browser
  attached the ask waits (the hidden page takes it, so it is not "no view"); a browser that joins finds it in
  `ready.linkAsks`; 5 min, then Deny, as now. The dialog drops "Approve on the desktop".
- **Trash confirm** (`ctx.files.trash`). A shared ask like the link's: `TrashAsks` (`main/files/trash-asks.ts`,
  `trash.ask` / `trash.answer` / `trash.settled`, class `yes`, pending ones in `ready`), first answer wins, 5 min then
  "not moved". The shared-ask core moves out of `LinkAsks` into one class both use. The desktop takes it too while a
  browser is attached, by the same `chooseAsk`, so a trash started from a browser no longer waits on a native box
  nobody there can see; with no browser, its native confirm.
- **Devices.** A browser may Revoke and Disconnect devices: a signed-in device already has a shell, so neither adds
  power, and a lost phone is the case where no SSH is at hand. `settings.webDeviceRevoke`, `webDevicesRevokeAll` and
  `webDeviceDisconnect` become `adapted`, allowed for a remote view only in server mode (main's `server`, never the
  payload), behind an in-page confirm; `web-access.log` names the acting device. Minting (link, add-device, password,
  mode, bind) stays on the server shell. §4.1 reads "cannot add or widen", and CLAUDE.md's web access rule gets the
  same wording in the implementation. `docs/features.md` says a revoke does not undo what an unlocked lost device
  already did from its shell.
- **Close project and error notices**: in-page, in the asking view (§9.7, §9.8).
- An in-page approval never has Allow as the default, Enter does nothing, the dialog never takes keyboard focus from a
  terminal by itself, and Allow is enabled only after the dialog has been visible for about a second: neither keys typed
  for Claude nor a click already on its way when an ask appears can approve. Visible means on top too: of two dialogs up
  at once (a link ask and a trash ask) only the upper one arms, and the one under it starts its second when it is bared.
  The desktop's own confirms (the link confirm, the web access risk confirm) are in the same stack: ready at once when
  they first show, as the native dialog, but one under them stops arming, and covered and bared again they too wait a
  second. A browser's pending OAuth sign-in keeps its paste box: past the notice cap only ended sign-ins go.

### 9.7 Native dialogs

Under Ozone headless `dialog.showMessageBox` (with a parent or without) and `dialog.showErrorBox` abort main with SIGTRAP,
a Chromium CHECK (reproduced in a 10-line app). `showOpenDialog` answers `canceled` with no portal. Test runs hid it:
their queued fakes replace the close, link and trash dialogs (index.ts:450-490, 1516-1528).

- **One adapter.** `src/main/dialogs/electron-dialog.ts` is the only importer of Electron's `dialog` (the rule in
  `main/index.ts` and CLAUDE.md, and a grep test like `no-direct-webcontents-send.test.ts`); the logic is in
  `src/main/dialogs/dialogs.ts`. In server mode it never calls `dialog`: a message box rejects (`ServerDialogError`), an
  open dialog answers canceled, an error box becomes a log line. A call site missed below then fails closed instead of
  killing main. `link-dialog.ts`, `close-dialog.ts` and `trash-dialog.ts` get it instead of `dialog.showMessageBox`.
- **Each call site in server mode** (grep of `dialog.` in `src/main`):

| Call | Server mode |
|---|---|
| plugin link confirm: `link-asks.ts:130` → index.ts:1525 → `link-dialog.ts:58` | the shared ask, Allow from any view (§9.6) |
| window close: `window-manager.ts:497` → `close-dialog.ts:68` | no ask (`askClose` absent): nobody can press the window's close button; a close comes from a browser's Close project (§9.8), which is for everyone |
| trash confirm: index.ts:455 → `trash-dialog.ts:55` | `TrashAsks` (§9.6) |
| `showErrorBox` after open folder (index.ts:1608) and relink (index.ts:1663) | the browser's open by path (§9.8) answers the asking view with the error; relink is not reached |
| `showOpenDialog`: open folder (index.ts:1600), relink (1655), `pickFolder` (1686: Settings relink, Settings link a plugin folder) | not reached: these are `no`-class for browsers and nobody drives the hidden page. Projects open by path (§9.8); plugins link with `ccc plugin link` (§9.6) |

### 9.8 Projects and the hidden page

- **Opening.** In server mode the browser picker (`renderer/web/picker.tsx`) lists the recent projects and has "Open
  folder…" with a server path field. The picker's GET adds recent and missing projects only in server mode
  (`projects.recent` stays `no`). `POST /api/projects` (server mode only, else 404; device cookie and Origin as every
  state-changing POST, the cookie checked again once the body is read and once more right before the open, after the
  folder's `stat`, so a device revoked mid-request opens nothing; body capped as the sign-in routes'): `{ open: path }` (absolute, resolved, an existing
  directory; no create, `mkdir` in a terminal) or `{ reopen: id }`. Main runs `windows.openPath` as the desktop does and
  answers the project id or the error text; the picker goes on to `/?project=<id>`. Any folder the server user can
  read can be opened: no more than the shell a device already has. `ccc open <path>` and `cc-cockpit <path>` from a
  server shell open one too. A project whose folder is gone shows as missing; relink and forget from the browser wait
  for a later version (open the folder by its new path instead).
  Built: the GET's recent list leaves out projects that have a window open (they are under the open ones), so a recent
  row always means reopen; an open or reopen main refuses answers 400 with main's text (not a folder, not an absolute
  path, not a recent project, folder missing), a throw inside main's open 500 with no text.
  Built (picker v2, 2026-11-11): the page is drawn from the desktop picker's parts (`renderer/picker/parts.tsx`: header,
  panels, project rows with colour dot and missing badge, empty states; the CSS is styles.css's `.picker-*`), so both
  pickers change together; the recent rows show when each was last opened. With nothing open and nothing recent (a new
  server) the page is a welcome naming the server and its user (the GET's `host`: host name, OS user, home) with one
  Open folder button. The path field became a **folder browser** (`renderer/web/folder-browser.tsx`), an in-page
  dialog over `POST /api/folders` (`main/web/list-folders.ts`; server mode only, else 404; device cookie and Origin as
  every POST, the cookie checked again once the body is in; body capped): `{ path?, hidden? }`, a path absolute, no NUL,
  normalized by `resolve`, absent for the start folder (`webAccess.startFolder` in `app.json`, set by `ccc web set
  --start-folder`, §9.4; default the server user's home; one that is not a folder now falls back to home with a note).
  A POST though it changes nothing, so it gets the Origin check, and the path is in no URL. It answers the folder's
  subfolders only (never files), sorted, dot folders left out unless asked (counted), at most 1000 with `truncated`,
  and stops reading after 20,000 directory entries; each folder marked `git` (an `lstat` of its `.git`, file or folder)
  and `project` (its real path is a record's). The entry type is readdir's (lstat's view): a symbolic link to a folder
  is listed as a link and can be entered, and is never marked (resolving it would mean a `realpath` and a stat on a
  target that may be a slow mount, for a hint; entered, the folder shows its own marks). A folder it cannot read is an
  answer with the reason (permission denied, gone, not a folder; another code generic with the detail in the log), the
  path and its parent, so the dialog shows it in place and Up still works. A click goes into a folder, the bottom
  button takes the folder shown, a double click or Enter on a row takes a folder at once (the double click's second
  click takes the folder the first one entered: the list under the pointer has changed by then); "Go to path" takes a
  pasted path (`~` expanded in the page) and completes with Tab from listings of the typed folder's parent. Same
  reach as the old path field: no new access. **Relink and forget** a missing project are in the browser too, through
  the same `POST /api/projects` with all its checks: `{ relink: id, path }` (the new folder checked as an open's path,
  picked in the folder browser) and `{ forget: id }` (confirmed inline in the row, never a `confirm()`); main runs the
  desktop picker's own code (`restore.ts` `relinkMissing` then `windows.openPath`, `forgetMissing`: only a recent
  project whose folder really is missing), refuses one with a window open, and answers the id; their refusals are
  `ProjectRefusal`s, so their text reaches the device. The log line names the device and what it did.
- **Closing.** Close project in the browser shell: an in-page confirm in that view ("Close <name> for every device? Its
  tabs end."), then `projects.close` (`adapted`: a remote view only in server mode). Main closes the window as "Close
  for everyone" does; its views go back to the picker.
  Built: an icon button in the browser's top bar before the gear (`renderer/web/CloseProject.tsx`), drawn only in a
  server's view; the confirm is an `ApprovalDialog` (§9.6), and a view whose socket closes with the window-closed code
  goes to the picker with `location.replace('/')`.
- **No desktop picker, no quit.** In server mode `WindowManager` never makes the picker window (it would be invisible,
  and on Linux its close quits the app); with no project open the app keeps running with the gateway up until SIGTERM.
- **The hidden page is a state of its own**, not Keep running's (§5.6), whose mark is undone by `remoteViewGone`,
  `openView`, `focusAny` and `activate` (`window-manager.ts:276,306,320-327,424`), and whose hidden view still sizes a
  tab it is the only view of (`views/view-sizes.ts:183-185`):
  - it is never a measured view in `ViewSizes` (tabs and terminal overlays), so it never sizes a pty nor answers their
    queries; browsers own the size (§5.2). A pty keeps the size the last browser gave it; a tab no browser has sized
    (new, or restarted overnight with none attached) gets 120x40. Built: only tabs get 120x40; a terminal overlay no
    browser has sized keeps its 80x24 spawn size;
  - `WindowManager` never calls `focus`, `show`, `hide` or `showPicker` in server mode;
  - a crash (`render-process-gone`) or a failed load reloads the page with a log line and never closes the window
    (today a failed load closes it, `electron-window-factory.ts` `finish`, which would end the project's tabs);
  - the window is clamped to 480x320 by the 1x1 screen (`window-bounds.ts:14`), which never matters; the page reports
    itself visible under Ozone, so it is not throttled and answers `tabs.screenAsk`. Server mode writes neither the
    window's bounds nor the page's zone sizes to the project record, so a later desktop start finds the person's own.
- **Overlays are held by browsers only.** Today an HTML overlay with no origin view (`ccc overlay` from a Claude tab, the
  reviewer from a plugin command or timer) is held by the desktop view (`overlays/overlay-manager.ts:20-25`, `:697-702`),
  which in server mode would show "Open on Desktop — Take over" in every browser. In server mode the holder is the
  window's last-acting browser view, else the first browser to list the overlay, never the hidden page; a holder that
  leaves passes it to another browser, and with none attached it waits for the first.
  Built: "last-acting" is `ViewSelections`' order (selected or typed into a tab, §5.1) over the window's live browser
  views; with none acted, the first attached live browser holds it (browsers already attached do not list again), and
  only with no browser attached does it wait for the first `overlays.list`. `overlays.take` from the desktop view (the
  hidden page) is refused in server mode.

### 9.9 Other desktop-only pieces

- **ccc offer** (`ccc.offer`, index.ts:1982): skipped. It opened a modal on the hidden page and left its root inert.
- **Notifications.** `ctx.notify` and `ccc notify` go to an in-page notice: a `NoticeBackend` in
  `notifications/notifier.ts`, so `Notifier.wait` and the click action keep working, in server mode only (the desktop
  keeps §6.1). It reaches every browser view of the plugin's window; the text is plain text, its length and the queue
  capped; a click goes through main with the view the router bound; the chime reaches browser views (`notify.chime`
  becomes `adapted`) and never the hidden page; the browser tab's title shows a mark, else a notice in a background
  tab is missed. New channels get their `REMOTE_CLASS`; `api.md` says what `ctx.notify` does in server mode, and
  `docs/features.md` that it does not reach a phone in a pocket. Plugin notification text is never logged (it carries
  mail subjects).
  Built: `ccc notify` naming no project reaches every window's browsers; one naming a project with no open window, or a
  folder with no project record, is dropped (never app-wide).
- **Core notices** (a new device, the marketplace revocation notice, `index.ts:381`, the update notice) carry no plugin
  text: a stdout line each, listed in `ccc web status`, and the new device beside its `web-access.log` entry.
  Built as `notifications/core-notices.ts`: the desktop keeps its OS notification, server mode prints
  `cc-cockpit: <line>` and keeps the run's last 50 for `status` (`notices`, also in `--json`; a new device carries its
  id, which names its `sign-in` entry in the log). A line is plain text with no link and no index or plugin text: the
  revocation line names the plugin id only (the index's reason stays on the Plugins page), the update line the new and
  running versions, announced once per version.
- **`shell.openExternal`.** One adapter, as for `dialog`, with the same grep test, for every call: `ctx.openExternal`,
  `app.openExternal`, the update notice, plugin OAuth (`index.ts:239`), the webview manager (`index.ts:831`) and the
  window-open handler (`windows/create-window.ts:75`). In server mode never on the server: a link notice (§6.1) to the
  asking view, or to every browser view of the window when no view asked; with no browser attached, refused with a log
  line.
- **`ctx.files.reveal`, `openWithSystem`**: refused by `server` in main, whatever the origin. `desktopOnly`
  (`plugins/host-api.ts:1543`) refuses only a call with a remote origin view, a hint that lapses after 10 s, so a timer
  or a plugin command would reach `shell.showItemInFolder` or `shell.openPath` on the server.
- **Browser panel, URL overlays**: `ctx.webview` and URL overlays are refused at the open call in server mode ("not
  available in server mode"), so main never makes a `WebContentsView` for the hidden page's layout (inferred: the
  layout is shared, §5.1, so it otherwise would); browsers show the placeholder ("not available in server mode").
  Built: the webview refusal sits in `WebviewManager` (`navigate` and where a view is made), so every asker is
  covered, the bundled browser plugin's home navigate at activation included (logged, the plugin stays active); the
  URL overlay refusal in `OverlayManager.start`. Both by main's `server`, never a payload.
- **Plugin OAuth** (`ctx.oauth`): main's `startLoopback` (`oauth/oauth.ts:150`) owns `127.0.0.1:<random>/callback`,
  one pending sign-in per plugin, on the server, so the redirect fails in the browser. The auth URL goes out as a link
  notice; the notice has a box where the person pastes the failed URL, and main settles the pending sign-in in-process
  with the callback handler's own checks (origin equals the pending one, path `/callback`, one `state` compared in
  constant time, the code's length, the error code's pattern). No request is made, so there is nothing to forge
  toward. Main picks the pending sign-in from the caller's window, never from the pasted host or port; PKCE keeps a URL
  read on the wire useless; attempts are limited, and errors never echo the URL.
  Built: `ctx.oauth.authorize` from a browser origin is allowed by main's `server` (`host-api.ts`); `PluginOAuth` mints a
  sign-in id per pending sign-in and the openExternal adapter puts it in `app.linkNotice` (`signIn`, server mode only),
  which the shell draws with the paste box; `oauth.paste` (`adapted`, `server && view.remote`) names that id and main looks
  it up among the bound window's sign-ins only. `checkCallback` (`oauth.ts`) is the one set of checks for the HTTP
  handler and `Loopback.paste`. The pasted text is capped at 8 KiB, the fifth paste the checks refuse ends the sign-in (an
  unknown id, a non-string or an over-long text is refused unread and not counted), and every refusal is the one
  `OAUTH_PASTE_REFUSED` (`shared/oauth-paste.ts`); the log counts refusals and never names the address. However a sign-in
  ends, `oauth.signInEnded` goes to the window's browsers: with a code the notice goes (in every view), otherwise (timeout,
  the attempt limit, replaced, the provider's refusal) it says the sign-in is over in place of the box. The window's
  pending sign-ins are in `ready` (`signIns`) and the bridge hands them to the remounted shell after a reconnect, shown
  but never opened at once, so the box is not lost while main still waits for the address.

### 9.10 Claude login

Claude Code with no display prints the sign-in URL and waits for a pasted code, so `claude` in a browser terminal tab
signs in (tested); the credentials go to `~/.claude/.credentials.json` and survive restarts. For a box run from boot
that should never need an interactive login: `claude setup-token` makes a long-lived token, set as
`CLAUDE_CODE_OAUTH_TOKEN` in the unit's environment file (§9.1). `buildPtyEnv` drops every `CLAUDE_CODE_*` variable
(`env/pty-env.ts:38-40`, `isStrippedVar`, also applied to the login-shell capture), so that one name becomes an
exact-name exception there, with a comment and a unit test; Claude tabs then get it from main's environment.

### 9.11 Spike breakages and their fixes

| Spike result | Fix | Files |
|---|---|---|
| No display: the app exits; `appendSwitch` is too late | re-exec in place with the switches, same pid and stdio (§9.1) | `main/server-mode.ts`, `main/index.ts` |
| The GPU process fails EGL twice | `--disable-gpu` | same |
| 1x1 screen, 480x320 window; with no browser the desktop view sizes tabs | the hidden page's own state, never measured; 120x40 default; bounds and zone sizes not saved (§9.8) | `index.ts`, `windows/window-manager.ts`, `views/view-sizes.ts`, `tabs/tab-manager.ts` |
| DBus and libnotify errors per notification | in-page notice backend (§9.9) | `notifications/notifier.ts` |
| ccc offer modal on the hidden page | skipped | `hooks/ccc-offer.ts`, `index.ts` |
| No keyring: no access link, no password, no plugin secrets | key file, `--password-store=basic` (§9.5) | `secrets/key-file-store.ts`, `secrets/secret-store.ts` |
| A link can be made only on the desktop | start link (§9.3), `ccc web` (§9.4) | `web/auth.ts`, `web/access-service.ts`, `web/settings.ts`, `shared/protocol.ts`, `shared/manifest.ts`, `socket/handlers.ts`, `cli/index.ts`, `cli/client.ts`, `cli/guide/cli.md` |
| `showMessageBox` / `showErrorBox` kill main (link, close, trash, error boxes) | dialog adapter, a server-mode path per call (§9.7) | `dialogs/`, `plugins/link-asks.ts`, `files/trash-asks.ts`, `windows/close-dialog.ts`, `files/trash-dialog.ts`, `index.ts` |
| A browser can only Deny a link, so it times out | owner Allow (§9.6) | `plugins/link-asks.ts`, the shell's link dialog |
| Closing with no browser leaves an invisible picker; a browser cannot open a project; Keep running unreachable | no desktop picker or quit; open, reopen and close from the browser; no close ask (§9.8) | `windows/window-manager.ts`, `web/gateway.ts`, `shared/web-protocol.ts`, `shared/ipc.ts`, `renderer/web/picker.tsx` |
| Desktop confirm lapses after 2 min | refused (§9.2) | `web/settings.ts`, the settings card |
| SIGTERM | already clean; a non-final close for views; systemd unit (§9.1) | `web/gateway.ts`, `renderer/web/bridge.ts`, `docs/features.md` |

### 9.12 Security

The rule of §4 holds: a signed-in device is the person at the keyboard, with a shell on the host. In server mode a
browser may also Allow a plugin link (code that runs as the user), list and open any folder, relink or forget a missing
project, close a project, answer trash,
revoke and disconnect devices, settle a plugin's OAuth sign-in, and read the web access card. None of it is more than
that shell already gives, so the boundary does not move: it is sign-in. What keeps it:
- §4.1 unchanged: Host check, Origin check on every state-changing POST (`/api/projects` included, and the folder
  listing `/api/folders`, a POST for that reason), the device cookie,
  `frame-ancestors 'none'` (no other page can frame the shell and steer a click onto Allow).
- Plugin pages cannot answer: sandboxed opaque-origin frames with only their own port (§5.5); `links.answer`,
  `trash.answer`, `projects.close`, the device calls and the OAuth paste are shell channels.
- Allow is never the default, never reached by typing, and not live until the dialog has been seen (§9.6).
- Sign-in material is made only by a server shell (`ccc web`) or once at start on a TTY; a remote view still cannot add
  or widen access (mode, bind, secrets, new devices), only narrow it.
- On the desktop `ccc web` only reads and revokes (§9.4), so v1's desktop boundary does not move either.

What server mode gives up, and what stands in:
- **Seeing a new device**: no desktop notification. Instead a stdout line, `web-access.log`, `ccc web status`, and the
  device list on every browser's card, live. A start link used by someone else first shows as an unknown device, and
  the person's own copy answers "already used"; Revoke on the card or `ccc web revoke` ends it.
- **The keychain**: the key file (§9.5); the same user and root read the secrets, as they read `~/.claude`.
- **Loopback is no longer one person.** On a desktop loopback is the person's machine; on a shared server every local
  user reaches 127.0.0.1, so None on loopback (or the local end of an SSH tunnel on a shared client) hands the account
  to all of them. `ccc web mode none` and the card say so; no confirm, by the owner's rule.
- **The start link** goes only to a terminal (§9.3): whoever reads that terminal within 10 minutes can use it; the
  journal gets none.
- `ccc web` refused from tabs is no boundary (§9.4): any process of the user can rewrite `app.json` or read the key
  file. On the server the boundary is the OS account; never root, never `--no-sandbox`.

### 9.13 Testing

- Unit, `server-mode.ts` table: platform, `DISPLAY` / `WAYLAND_DISPLAY`, `--server`, switches already present: server
  or not, the exec args (`--password-store=basic` included), `process.execPath` as the executable with `APPIMAGE` set
  or not, the refusal off Linux, no re-exec when the switches are there; the start path (`execve` missing or the
  executable failing its check gives the watch, and `execve` is never called); the watch armed only by its marker;
  argv parsing skips the flag, the switches and the marker.
- Key file store, in plain Node in a temp dir: made 0600 with `O_EXCL`; opened `O_NOFOLLOW` and refused as a symlink,
  with a wider mode, another owner (an injected `fstat`) or the wrong length; round trip; one changed byte fails the GCM
  tag; a new key with tagged values on disk logs the count and answers "replaced"; each store refuses the other's with
  the "other mode" text; server mode always picks the key file, the desktop never does.
- Dialog adapter with a recorder `dialog`: server mode never calls it (the box rejects, the open dialog is canceled, the
  error box is logged); the grep tests that only `electron-dialog.ts` imports `dialog` and only its adapter calls
  `shell.openExternal`.
- Hidden page, with the fake window factory: in server mode none of `focus`, `show`, `hide`, `showPicker` happens across
  `remoteViewGone`, `openView`, `focusAny`, `activate` and a second launch; `ViewSizes` never measures the desktop view;
  a tab nobody sized gets 120x40; a page crash or failed load reloads and the window stays. Overlay holder: no origin
  view goes to the last-acting browser, a leaving holder passes it on, never to the desktop view.
- `LinkAsks`: a remote Allow taken only in server mode, Allow disabled for the first second. `TrashAsks`: first answer
  wins, the timeout denies, a joining view gets the pending ask, the desktop takes it with a browser attached.
  `applyWebAccessPatch` in server mode: `confirm` and turning off refused; start writes `enabled: true` and `link` and
  says so once; a stored unconfirmed risk refused with the exact `ccc web set` line and not rewritten.
- The socket: `web` refused for a session or window token, answered tokenless; outside server mode only `status` and
  `revoke`; not running exits non-zero; `web` reserved in `CORE_CLI_COMMANDS`; guide drift. Start order: a gateway or
  socket that cannot start exits 1 before any window opens.
- The gateway: `POST /api/projects` (open, reopen, relink, forget) and `POST /api/folders` 404 off server mode, no
  Origin, no cookie, a path that is no directory, an oversize
  body; the GET lists recent projects only in server mode. The folder listing (`web-list-folders.test.ts`): folders
  only, the start folder and its fallback, hidden ones, the marks never through a link, both caps, an unreadable folder
  as text. Device Revoke and Disconnect from a remote view only in
  server mode, the acting device logged. SIGTERM closes views with the non-final code, and the bridge retries.
- In-page notice backend: plain text, caps, `Notifier.wait` and the click through the bound view, the chime to browser
  views and not the hidden page. OAuth paste: wrong origin, path or `state`, an oversize code, the attempt limit, no
  request made, the pending sign-in taken from the caller's window, no URL in errors. `buildPtyEnv`:
  `CLAUDE_CODE_OAUTH_TOKEN` passes, every other `CLAUDE_CODE_*` is still stripped.
- Smoke script, like `scripts/web-terminal-bench.mjs` (the re-exec replaces the image Playwright launched and drops its
  inspector connection, so the e2e cannot cover it): no display, no switches, wait for the socket, the pid unchanged,
  `ccc web status --json`, SIGTERM, check the exit status and that no live process of the run is left; one run with
  the fallback forced.
- e2e: the harness starts the app with the switches directly (`--server --ozone-platform=headless --disable-gpu
  --password-store=basic`, no `DISPLAY`, Linux; what the re-exec starts), signs in through `ccc web add-device` with the
  web browser fixture (`test/e2e/web-fixtures.ts`), opens a project through the folder browser (relinks and forgets a
  missing one), runs `ccc plugin link` and Allows it in the
  browser, opens an HTML overlay with `ccc overlay` from a Claude tab and answers it in the browser, trashes a file from
  Files with the real `shell`, closes the project, and checks main is alive. One spec runs with no session bus and no
  fake secret store: `ccc web password`, sign in, restart, sign in again. Server-mode specs do not use the queued test
  dialogs for these paths: those fakes hid the crash.

### 9.14 Out of scope

macOS and Windows; relink and forget from the browser; `ccc web` writes on the desktop; a Files "Download" item (a
later idea); more than one person (§10).

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
5. ~~Notifications in server mode~~: an in-page notice backend (§9.9).
6. ~~Plugin OAuth in server mode~~: a paste box settled in-process by main, no request made (§9.9).
7. ~~Device management from a browser in server mode~~: Revoke and Disconnect allowed, minting stays on the server
   shell (§9.6).
8. ~~stdout over `app.relaunch`~~: lost and detached (measured in review), so §9.1 re-executes in place
   (`process.execve`), same stdio. macOS is not in this phase.
