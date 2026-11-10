# Web access (remote cockpit) v1

External review: sol / high

## Overview

The person opens cc-cockpit in a browser on another device and works with the cockpit running on their machine: the same
project window, Claude tabs, terminals, panels, overlays and plugins, live on the desktop and in the browser at once
(live mirror). Claude keeps running on the host. Design: `docs/design-web.md` (reviewed twice); proofs:
§7a (spike 1 terminal mirror, spike 2 plugin panel, both working in a real browser on the LAN).

v1 covers design phases 1–5: transport and identity, terminals, panels and overlays, desktop-only features and window
lifetime, and remote reach (all four auth modes, TLS, confirms). Out of v1: multi-user and invites, a desktop app as a
remote client, a phone layout, headless server mode (design §9, §10).

## Context (from discovery)

- Bridge: `src/preload/index.ts` (`invoke`/`on` only), channels and types in `src/shared/ipc.ts` (`INVOKE_CHANNELS`
  ~111, `EVENT_CHANNELS` 22, `IpcInvokeMap`, `IpcEventMap`, `CockpitApi`).
- Router: `src/main/ipc/router.ts` (`IpcRouter`, `authenticate` ~line 161, `IpcMainLike`), wired in `src/main/index.ts`
  (~1402). Events: `webContents.send`, `sendToProject`, `BrowserWindow.getAllWindows()` broadcasts
  (`index.ts:315,1193,1711`), `sessions.closeAsk` (`:553`), port posts (`:1062`).
- Terminals: `src/main/pty/pty-service.ts` (flush 8 ms / 64 KiB, `HIGH_WATER`), `src/main/tabs/tab-manager.ts`
  (`attach` → `resetFlow` ~289, `closeProject` ~608), `src/main/sessions/terminal-reports.ts`,
  `src/renderer/tabs/terminal-session.ts` (ack, resize observer).
- Panels: `src/host/ctx/ui.ts` (`PanelPorts.attach` ~168), `src/main/plugins/panel-ports.ts` (`PanelPortHub`, slots,
  settings pages), `src/renderer/plugins/panel-port-bus.ts`, `PluginFrame.tsx`, SDK `src/sdk/panel.ts` +
  `panel-core.ts` (unchanged by this plan), `src/main/plugins/plugin-protocol.ts` (Electron-free resolver, `pluginCsp`).
- Overlays and asks: `src/main/overlays/overlay-manager.ts`, `src/main/sessions/close-asks.ts`,
  `src/main/socket/handlers.ts` (`ccc overlay`, link confirm ~404).
- Spike code to port (not merge): branch `spike/web-plugin-panel` (on top of `spike/web-terminal-mirror`):
  `src/main/web-spike/{checks,server,term-mirror,panels,page}.ts`, `src/host/ctx/origin-view.ts`, `src/host/ctx/ui.ts`,
  `src/host/rpc.ts`, `src/shared/views.ts`, tests `test/unit/web-spike-*.test.ts`, `test/fakes/fake-main-port.ts`,
  `scripts/web-spike-bench.mjs`, `scripts/web-spike-panel-probe.mjs`. Pinned deps there: `ws@8.22.0`,
  `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`, `@types/ws@8.18.2`.
- Project rules (CLAUDE.md): main is the only authority; never trust ids from a caller; the send gate and `typed`;
  Electron-only modules behind adapter files; plugin settings schemas without regexes; dense "why" comments; a new
  `ccc` command or `ctx` member needs its guide text in the same change (drift tests).

## Development Approach

- **testing approach**: Regular (code first, then tests); every task ends with its tests
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** (`npm test`, `npm run typecheck`, `npm run lint`, and
  `npm run test:plugins` when a bundled plugin changes)
- **CRITICAL: update this plan file when scope changes during implementation**
- The gateway stays off by default: with web access off, the app behaves exactly as today (a test asserts no listener,
  and `ws`, the worker and the mirrors are loaded lazily)
- Network binds stay refused until Task 28 adds TLS and the danger confirms
- Port spike code where it was proven; do not merge the spike branches

## Testing Strategy

- **unit tests**: required for every task; the router and gateway take fakes (`IpcMainLike`, a fake socket), the plugin
  host ports use `test/fakes/fake-main-port.ts` (ported from spike 2)
- **mirror tests**: two views of one window (a fake desktop view and a fake socket view) for every shared behaviour
- **security tests** with each piece: wrong Host, wrong Origin, no cookie, expired or revoked device, used or
  regenerated tokens, another plugin's token, a navigated frame, a path outside the plugin folder, frames naming
  another window or project, `no`-class channels from a remote view, oversize frames
- **e2e** (Playwright, `npm run test:e2e`): the web shell in a plain Chromium against the dev app with the gateway on
  loopback, next to the Electron window (Tasks 29–30); existing e2e specs keep passing, and core tasks that touch
  always-on paths (3, 12, 17, 18, 21) run them in their exit gate

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

- **Views.** A project window can have several live views: the desktop window and remote browser views. Every caller
  resolves to the window's existing `SenderContext` plus a `viewId` (and a `who`, the person in v1). Events go through a
  `ViewRegistry`; nothing else may call `webContents.send` or `getAllWindows()`.
- **Gateway** (`src/main/web/`): Node `http` + `ws` on the configured bind; Host and Origin checks on everything;
  four auth modes ending in one device cookie; the web build of the React shell talks over one WebSocket per view.
- **Terminals**: a headless terminal per tab in a worker thread, fed the same numbered stream (data and resize items) the
  views get; gap-free snapshots on join; main is the pty's flow consumer; every view, desktop included, drops and
  resyncs when behind; main answers terminal queries; per-view sizes with an explicit take.
- **Plugins**: ports and slots per view; the origin view carried implicitly in the host; an optional `{ view }` on
  `ctx.panels`; plugin pages over HTTP under per-(device, plugin) tokens with the plugin CSP rewritten for the path;
  root-absolute links rewritten in served HTML, new plugins steered to relative paths.
- **Shared asks** (close asks, CLI dialogs, terminal overlays) first-answer-wins with a `settled` event; HTML overlays
  and settings pages held by one view with "take over".

## Technical Details

- Wire frames (design §3): `hello`/`ready` (snapshot: tabs, layout, overlay stack, pending asks and CLI dialogs, panel
  headers and badges, slot frames), `invoke`/`result`, `event`, `port.open`/`port.msg`/`port.close`,
  `term.snapshot` (`tabId`, `seq`, parts), `term.data` (`tabId`, `seq`, data or size item). JSON, 4 MiB cap,
  `{ $bytes: base64 }` for `Uint8Array`.
- Remote class per channel: `yes` | `no` | `adapted`, declared next to each channel in `src/shared/ipc.ts`.
- Device record (app data dir, not `app.json`): `{ id, name, createdAt, lastSeenAt, secretHash, mode }`. Device cookie
  `HttpOnly; SameSite=Strict; Secure` (unless loopback http), sliding 30-day expiry, not rotated.
- Settings (app, desktop only): `webAccess: { enabled, bind, port, externalOrigin, hosts[], mode:
  'link'|'password'|'confirm'|'none', tls?: { certPath, keyPath } }`; secrets (access token, password hash) in the
  secret store.
- Plugin page paths: `/p/<token>/<pluginId>/<path>`; token per (device, plugin), killed on revoke.

## What Goes Where

- **Implementation Steps**: code, tests and docs in this repo
- **Post-Completion**: manual tests on the LAN and from the Mac, through `tailscale serve`, a phone browser; release

## Implementation Steps

### Task 1: Remote class on every IPC channel [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts`
- Create: `test/unit/ipc-remote-class.test.ts`

- [x] add a `remote: 'yes' | 'no' | 'adapted'` class next to every invoke and event channel (design §2.3: `no` for
      web-access settings and devices, `projects.openFolder`, `settings.pluginLink`, `window.reopen`, full screen,
      `webviews.*`, URL overlays; `adapted` for the §6.1 features; `yes` for project work); a wrong `yes` exposes the
      host, so classify conservatively
- [x] export `REMOTE_CLASS` and `remoteAllowed(channel)`; an unclassified or unknown channel is `no`
- [x] write a drift test: every channel in `INVOKE_CHANNELS` and `EVENT_CHANNELS` has a class, no extra keys
- [x] write tests for `remoteAllowed` (yes, no, adapted, unknown channel → no)
- [x] run tests - must pass before next task

### Task 2: Caller with views in IpcRouter [model: opus]

**Files:**
- Modify: `src/main/ipc/router.ts`
- Create: `src/shared/views.ts` (port from spike 2)
- Modify: `test/unit/ipc-router.test.ts`

- [x] replace `authenticate(channel, event)` with `authenticate(channel, caller)`; `ElectronCaller` keeps today's checks
      (top frame, app page, `sender.id`) and resolves to the window's `SenderContext` plus its desktop `viewId`
- [x] define `Caller` / `WebCaller` (bound context from the gateway; never from a payload) and pass `viewId` to
      handlers that need it; others unchanged
- [x] refuse a `no`-class channel from a `WebCaller` in the router, before the handler
- [x] write tests: Electron caller unchanged (all existing router tests pass), web caller resolves to its bound window,
      a payload naming another window or project has no effect, `no`-class refused for web, `yes` allowed
- [x] run tests - must pass before next task

### Task 3: ViewRegistry for every event and port post [model: opus]

**Files:**
- Create: `src/main/views/view-registry.ts`
- Modify: `src/main/index.ts` (sends at ~315, ~553 `sessions.closeAsk`, ~1062 panel port post, ~1193, ~1711),
  `src/main/windows/window-manager.ts`, the `options.emit` wiring of `src/main/tabs/tab-manager.ts`,
  `src/main/overlays/overlay-manager.ts` and `src/main/plugins/panel-ports.ts`
- Create: `test/unit/view-registry.test.ts`, `test/unit/no-direct-webcontents-send.test.ts`

- [x] `ViewRegistry` with `toProject`, `toWindow`, `toView`, `toAll`, `postPort`; a desktop view wraps `webContents`,
      a remote view wraps a sink the gateway provides
- [x] route every `webContents.send`, `getAllWindows()` broadcast, `sessions.closeAsk` and panel-port post through it
- [x] a grep test that fails on `webContents.send` / `getAllWindows()` / `webContents.postMessage` outside the registry
      and the Electron adapter files (`electron-window-factory.ts`, `create-window.ts`, `electron-url-view.ts`,
      `electron-webview.ts`)
- [x] write tests: fan-out to two views of one window, project scoping, a closed view is skipped, port posts reach the
      right view
- [x] run tests and `npm run test:e2e` (the desktop must behave as today) - must pass before next task (214 passed; 4 fail identically on the base commit a50e4cd: window-bounds x2 under the tiling WM, reviewer-annotate:282, top-strip:191)

### Task 4: Gateway skeleton, loopback only, always-on checks [model: opus]

**Files:**
- Create: `src/main/web/gateway.ts`, `src/main/web/checks.ts` (port `web-spike/checks.ts`), `src/main/web/settings.ts`
- Modify: `src/shared/types.ts` (`AppSettings.webAccess`), `src/main/settings/settings-service.ts`,
  `src/main/index.ts`, `package.json` (pin `ws@8.22.0`, `@types/ws@8.18.2`)
- Create: `test/unit/web-gateway.test.ts`, `test/unit/web-checks.test.ts`

- [x] `webAccess` app settings (off by default; port, external origin, host list) parsed without regexes; **any
      non-loopback bind is refused until Task 28 lifts it together with TLS and the §4.3 confirms**
- [x] Node `http` server + `ws` upgrade, `ws` imported lazily so off costs nothing; Host allow-list on every request and
      the upgrade; Origin equal to the external origin on the upgrade and every state-changing POST; the web shell CSP
      and `Cache-Control: no-store` (§4.1)
- [x] start and stop with the setting; nothing listens while off
- [x] write tests: off means no listener and no `ws` import; a non-loopback bind refused; wrong Host (DNS rebinding
      case), wrong or missing Origin; external origin behind a proxy (`https` origin while the peer is 127.0.0.1)
- [x] run tests - must pass before next task

### Task 5: Devices, the access link, None on loopback, the access log [model: opus]

**Files:**
- Create: `src/main/web/devices.ts`, `src/main/web/auth.ts`
- Modify: `src/main/web/gateway.ts`, secret store wiring
- Create: `test/unit/web-devices.test.ts`, `test/unit/web-auth.test.ts`
- ➕ Also created `src/main/web/access-log.ts` (the access log); `src/main/paths.ts` gained `webAccessJson`

- [x] device store in the app data dir (hashed secrets, sliding 30-day expiry, no rotation), revoke and revoke all;
      a new device raises a desktop notification (through the existing notifier adapter)
- [x] access link mode: a 256-bit token in the secret store, `<origin>/#t=<token>`; a POST (Origin-checked) exchanges it
      for the device cookie; regenerate kills token and its devices; a one-time "add a device" token valid 10 minutes
- [x] None mode on loopback (no sign-in; Host and Origin still apply)
- [x] failed attempts slowed by a token bucket with a fixed delay, never a lockout, never keyed by peer address;
      constant-time compares
- [x] access log: sign-in, connect, disconnect, revoke, mode change; never terminal text, prompts or secrets
- [x] write tests: sign-in success, used one-time token, regenerated token, expired/revoked device, cookie flags per
      origin, the bucket under a burst, a request without a valid cookie refused, the log never carries a token or text
- [x] run tests - must pass before next task

### Task 6: Wire protocol and WebCaller binding [model: opus]

**Files:**
- Create: `src/main/web/protocol.ts`, `src/main/web/connection.ts`
- Modify: `src/main/web/gateway.ts`, `src/main/views/view-registry.ts`, `src/main/ipc/router.ts`
- Create: `test/unit/web-protocol.test.ts`

- [x] frames per Technical Details: `hello`/`ready`, `invoke`/`result`, `event`; 4 MiB cap, `$bytes` encoding; the
      allow-lists and remote class checked on every frame
- [x] an upgrade with a valid device cookie (Task 5) binds to one open project window as a remote view (`WebCaller`,
      fresh `viewId`); the `ready` snapshot starts with tabs, layout and the overlay stack (Tasks 17, 23 and 24 extend
      it, each with its own snapshot test)
- [x] the router dispatches web frames through the same handlers; errors return the message only, as IPC does
- [x] write tests: invoke round trip, unknown channel, `no` class, oversize frame closes the socket, `$bytes`, events
      reach only views of their project, a view cannot switch project mid-connection, no cookie no upgrade
- [x] run tests - must pass before next task

### Task 7: Web shell part 1: web build, bridge, reconnect [model: opus]

**Files:**
- Create: `src/renderer/web/bridge.ts`, a web renderer entry (`src/renderer/web/index.html` / `main.tsx`)
- Modify: `electron.vite.config.ts` (a web renderer build)
- Create: `test/unit/web-bridge.test.ts`

- [x] a web build of the React shell next to the Electron one
- [x] `bridge.ts` provides `window.cockpit` (`invoke`/`on`) over the socket with the same allow-lists as the preload
- [x] reconnect after a drop with a fresh `ready` snapshot; a "host unreachable" state while away
- [x] write tests for the bridge (allow-lists, invoke/result matching, events, reconnect and re-snapshot)
- [x] run tests - must pass before next task

### Task 8: Web shell part 2: serving, sign-in page, picker, chrome, zone sizes [model: opus]

**Files:**
- Create: `src/renderer/web/sign-in.ts`, `src/renderer/web/picker.tsx`
- Modify: `src/main/web/gateway.ts` (serve the web build), renderer platform checks where Electron-only UI is drawn,
  the zone layout code (per-view sizes)
- Create: tests next to them

- [x] the gateway serves the web build and the sign-in page (reads `#t=`, posts it, clears the URL); a project picker
      lists open project windows
- [x] hide window chrome, drag regions and full screen in the web build
- [x] zone sizes and collapsed zones are per view: a remote view keeps its own in the browser; the desktop's stay in
      main as today (design open question 1)
- [x] write tests: sign-in page flow, picker lists only open windows, chrome hidden in the web build, per-view zone sizes
      never reach main's layout
- [x] run tests - must pass before next task
- ➕ `layout.set` from one view is published (`layout.updated`) to the window's other views (`LayoutService.set`): a
  stale view would otherwise write its old placement back on its next edit (fixed in the Task 8 review).

### Task 9: Web access settings and the desktop indicator [model: sonnet]

**Files:**
- Create: `src/renderer/settings/WebAccessSection.tsx` (in `src/renderer/settings/GeneralPage.tsx`), an indicator in
  `src/renderer/status/TopStrip.tsx`
- Modify: `src/shared/ipc.ts` (new `no`-class channels), `package.json` (a pinned QR library)
- Create: tests next to the components

- [x] Settings > General > Web access: enable, port, external origin, host list, mode; modes built later (password,
      desktop confirm, None or TLS on a network address) shown disabled until Tasks 27–28
- [x] the access link behind a Show button (text and QR) and the one-time "add a device" QR; devices list with
      Disconnect, Revoke, Revoke all
- [x] top-bar indicator of connected devices; a warning badge while a §4.3 risky choice is on
- [x] every channel added here is `no` class (remote views cannot change access)
- [x] write tests: settings validation, Show hides the token by default, revoke from the list, `no` class drift
- [x] run tests - must pass before next task
- ➕ Also created `src/main/web/access-service.ts` (stores, validates, applies), `src/shared/web-access.ts`, `src/renderer/settings/web-access-model.ts` and `qr.ts`, `src/renderer/status/WebAccessChip.tsx`; QR library `qrcode-generator@2.0.4` (no dependencies, drawn as SVG path by React); e2e `test/e2e/web-access-settings.spec.ts`.

### Task 10: Headless terminals in a worker, packaged [model: opus]

**Files:**
- Create: `src/main/terminals/mirror-worker.ts`, `src/main/terminals/mirror.ts` (port `web-spike/term-mirror.ts`),
  `scripts/web-terminal-bench.mjs` (port `scripts/web-spike-bench.mjs`)
- Modify: `src/main/tabs/tab-manager.ts` (marked tap points), `electron.vite.config.ts` (the worker entry),
  `electron-builder.yml` (worker, `ws` and xterm packages in the package), `package.json` (pin `@xterm/headless@6.0.0`,
  `@xterm/addon-serialize@0.14.0`)
- Create: `test/unit/terminal-mirror.test.ts` (port spike tests), extend `test/unit/packaging-config.test.ts`
- ➕ Also created `src/main/terminals/mirror-protocol.ts` (the message types and the worker mark, so neither bundle pulls
  in the other); `PtyService.resize` returns whether the pty took the size; `WebAccessService` starts and stops the mirror

- [x] a worker thread holding one headless terminal per tab (5,000 lines), loaded only while web access is on
- [x] feed it the same flushed chunks as the views, numbered, with resize, spawn size, restart and close as numbered
      items in the same stream
- [x] the bench: main event-loop delay stays low with 8 flooded tabs (the reason for the worker) (8 tabs flooded: p50 0.9 ms,
      p99 1.9 ms; the spike parsing in main had p50 97 ms)
- [x] write tests: numbering, resize items in order, close frees the terminal, worker restart recovers, the packaging
      config includes the worker and its packages
- [x] run tests and `npm run package:dir` (smoke: the packaged app starts with web access on) - must pass before next task
      (packaged: gateway answers 200, the worker loads xterm from app.asar and reports ready; off: no worker)

### Task 11: Gap-free snapshots and joins [model: opus]

**Files:**
- Modify: `src/main/terminals/mirror.ts`, `mirror-worker.ts`, `src/main/web/protocol.ts`
- Modify: `test/unit/terminal-mirror.test.ts`
- ➕ Also created `src/main/web/view-terminals.ts` (`ViewTerminals`: the tabs one view follows and the `term.*` frames
  it gets; Task 12 wires it into the connection); frame types in `src/shared/web-protocol.ts`

- [x] `term.snapshot` taken inside the write callback of item N at parser ground state (300 ms fallback), tagged `seq`;
      live `term.data` from N+1 with items held meanwhile; split into parts above the frame cap
- [x] re-emit what the serialize addon drops: cursor visibility (25), 2026, SGR mouse encoding (1006/1016), scroll
      region, cursor style
- [x] snapshot only the visible tab; others when selected
- [x] write tests: the randomized no-loss/no-double test from the spike, split CSI/OSC/surrogate, mode survival, a
      multi-part snapshot reassembled
- [x] run tests - must pass before next task

### Task 12: Main as the flow consumer; every view resyncs [model: opus]

**Files:**
- Modify: `src/main/pty/pty-service.ts`, `src/main/tabs/tab-manager.ts`, `src/renderer/tabs/terminal-session.ts`,
  `src/main/web/connection.ts`
- Modify: their tests
- ➕ Also created `src/main/terminals/desktop-flow.ts` (the desktop view's per-tab flow: live, behind, joining) and
  `test/unit/terminal-flow.test.ts`, `test/fakes/fake-mirror-worker.ts` (moved out of terminal-mirror.test.ts); modified
  `src/main/terminals/mirror.ts` (flow binding, held pruning, backlog backstop), `src/main/web/view-terminals.ts` (a
  remote view's own flow), `src/main/ipc/router.ts` + `src/shared/ipc.ts` (`tabs.list`/`ack`/`selected`/`data`
  `adapted`), `src/renderer/web/bridge.ts` (term frames to `tabs.data`), `src/renderer/tabs/TabsPane.tsx`

- [x] while web access is on, the pty is acked by main's mirror consumer, never paused by a view
- [x] every view (desktop included) gets output from main's stream; a view over its buffer limit stops getting live data
      and is resynced with a snapshot; `TabManager.attach` → snapshot instead of `resetFlow`
- [x] web access off: today's ack flow, unchanged
- [x] write tests: a slow view does not pause the pty, a resynced view matches the mirror, off behaves as today,
      `cat`-sized floods do not grow main's buffers unbounded
- [x] run tests and `npm run test:e2e` - must pass before next task

### Task 13: Turning web access on and off at runtime [model: opus]

**Files:**
- Modify: `src/main/web/gateway.ts`, `src/main/terminals/mirror.ts`, `src/main/pty/pty-service.ts`,
  `src/main/tabs/tab-manager.ts`
- Create: `test/unit/web-access-toggle.test.ts`
- ➕ Also modified `src/main/terminals/desktop-flow.ts` (`take` with the desktop's debt, `release` returns it,
  `settled`), `src/main/web/access-service.ts` (off: gateway first, then `drain`), `src/shared/web-protocol.ts` +
  `src/renderer/web/bridge.ts` (`CLOSE.turnedOff`, a final close), `docs/features.md` (known limitation: blank baseline)

- [x] on: create mirrors for running tabs from a baseline (the desktop's current screen via a snapshot of what the pty
      sends next, documented), start numbering there, then hand flow control to main
- [x] off: close remote views with a notice, hand flow control back to the desktop ack path, tear the mirrors and the
      worker down
- [x] write tests: toggling on and off while a tab floods (no stuck pty, no lost desktop output), on with several tabs,
      off with a remote view attached
- [x] run tests - must pass before next task

### Task 14: Main answers terminal queries [model: opus]

**Files:**
- Modify: `src/main/sessions/terminal-reports.ts`, `src/main/terminals/mirror.ts`, the input path in `tab-manager.ts`
- Modify: their tests
- ➕ Also modified `src/main/terminals/mirror-worker.ts` + `mirror-protocol.ts` (`reply`, `color` messages),
  `src/main/index.ts` (input through `TabManager.viewInput`, theme colours), `docs/features.md`; created
  `test/unit/terminal-queries.test.ts`

- [x] with web access on, the mirror's DSR/DA replies go to the pty; OSC 10/11 answered from the theme
- [x] strip query replies from every view's input (mixed chunks too); mouse and focus reports pass from any view
- [x] web access off: the desktop answers as today
- [x] write tests: Claude-style startup queries answered with no view awake, replies from two views never reach the pty,
      a report glued to a key keeps the key, mouse reports from the second view pass
- [x] run tests - must pass before next task

### Task 15: Terminal size per view [model: opus]

**Files:**
- Modify: `src/main/tabs/tab-manager.ts`, `src/renderer/tabs/terminal-session.ts`, the web shell terminal view
- Modify: their tests

- [ ] main remembers each view's size; the pty takes a view's size on an explicit take (typing after another view typed,
      debounced, or "Fit to this screen"), not on every resize observer call
- [ ] size items go into the numbered stream; views draw at the pty size (scaled or letterboxed); the desktop handles
      the size event
- [ ] when the sizing view leaves or is hidden, fall back to a remaining visible view
- [ ] write tests: alternating typing does not resize per keystroke, fallback on disconnect, a hidden window never sizes
- [ ] run tests - must pass before next task

### Task 16: Input from any view, typing indicator, keys [model: opus]

**Files:**
- Modify: the input path (`tabs.input`), the session registry (last-typed view per tab), web shell key handling
- Modify: their tests; a note on remapped chords in the guide or features doc

- [ ] input from a remote view goes through the desktop's typing path: `typed` and the send gate apply unchanged
- [ ] each view shows which device typed last in a tab
- [ ] the web shell maps chords the browser keeps (Ctrl/Cmd+W, T, N, Tab) to alternatives, documented
- [ ] write tests: remote input sets `typed`, a plugin send to that tab is then refused and its queue dropped, last-typed
      device per tab
- [ ] run tests - must pass before next task

### Task 17: Ports per view for panels; slots and settings pages by view [model: opus]

**Files:**
- Modify: `src/host/ctx/ui.ts` (port from spike 2), `src/main/plugins/panel-ports.ts`, port wiring in `src/main/index.ts`,
  `src/main/web/protocol.ts` (`ready` gains panel headers/badges and slot frames)
- Create: `test/fakes/fake-main-port.ts` (port); Modify: `test/unit/panel-ports.test.ts`

- [ ] the host keeps one port per (panel, view); `post` fans out; `onMessage` hears every page; a reload in one view
      replaces only its port
- [ ] slots: `openSlots`, `withinCap`, `connectSlot` keyed by view, so each view's frame is its own slot instance
- [ ] settings pages keyed by view (held by one view, Task 24)
- [ ] write tests: two views get a post, a reload replaces only its own port, two slot frames of one id in two views do
      not close each other, caps per view, the `ready` snapshot carries headers, badges and slot frames
- [ ] run tests, `npm run test:plugins` and `npm run test:e2e` - must pass before next task

### Task 18: Origin view in the plugin host [model: opus]

**Files:**
- Create: `src/host/ctx/origin-view.ts` (port, bounded); Modify: `src/host/rpc.ts`, `src/host/index.ts`,
  `src/main/plugins/host-api.ts`, `src/main/ipc/router.ts` (`tabs.selected`, `activeTab`)
- Modify: `test/unit/host-api.test.ts`; Create: `test/unit/origin-view.test.ts`

- [ ] listener dispatch runs with its view (`AsyncLocalStorage`); RPC calls carry it; bounded so timers started inside a
      listener get no view
- [ ] main treats the view as a hint: checked against the asking host's project, else ignored
- [ ] per-view tab selection; the project's `activeTab` is the selection of the view that acted last;
      `sessions.focus` and `panels.show` act in the origin view
- [ ] write tests: a click in one view selects there only, a forged view id is ignored, a timer started in a listener
      has no view, `activeTab` follows the last-acting view
- [ ] run tests, `npm run test:plugins` and `npm run test:e2e` - must pass before next task

### Task 19: `{ view }` on ctx.panels, and the bundled plugins that need it [model: sonnet]

**Files:**
- Modify: `src/host/ctx/ui.ts`, `src/sdk/types.ts`, `src/cli/guide/*.md` (api), `examples/plugin/sdk/types.ts`
  (`cp src/sdk/types.ts examples/plugin/sdk/types.ts`)
- Modify: `plugins/files` (search results), `plugins/sessions` (`refused` message) to reply per page
- Modify: guide drift tests, plugin tests

- [ ] `ctx.panels.onMessage(fn(msg, { view }))` and `ctx.panels.post(msg, { view })`; no second argument keeps
      broadcasting
- [ ] guide text for the new argument (drift tests); types copied to the example
- [ ] the files and sessions plugins answer per-page requests to the asking view
- [ ] write tests: a targeted post reaches one view, broadcast reaches all, plugin tests for the two plugins
- [ ] run tests (`npm test`, `npm run test:plugins`) - must pass before next task

### Task 20: Plugin pages and inline overlays over HTTP [model: opus]

**Files:**
- Create: `src/main/web/plugin-pages.ts` (port `web-spike/panels.ts`)
- Modify: `src/main/plugins/plugin-protocol.ts` (export what the HTTP path reuses), `src/main/overlays/overlay-protocol.ts`
  (inline overlay content), `src/main/web/gateway.ts`, `src/main/web/devices.ts` (tokens die on revoke)
- Create: `test/unit/web-plugin-pages.test.ts` (port spike tests)

- [ ] serve `/p/<token>/<pluginId>/<path>`; one token per (device, plugin), only plugins enabled in the view's project;
      reuse the resolver (containment, realpath, verified reads, cap)
- [ ] the SDK at `/p/<token>/<pluginId>/__sdk/panel.js`, so both `/__sdk/panel.js` (rewritten) and the relative
      `./__sdk/panel.js` resolve there; `cc-plugin://<id>/__sdk/panel.js` keeps working on the desktop
- [ ] headers: the plugin CSP rewritten for the path, CSP `sandbox allow-scripts`, `frame-ancestors <external origin>`,
      `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: null`; never redirect
- [ ] rewrite root-absolute `src`/`href` in served HTML to the prefixed path; map the shell's plugin images
- [ ] inline overlays (`cc-overlay://` content) served from memory under a path valid while the overlay is open, reloads
      included
- [ ] write tests: another plugin's path under a token, traversal, unknown and revoked tokens, headers, HTML rewriting,
      the SDK at both URLs (`cc-plugin://` and HTTP), a disabled plugin refused, an inline overlay path dies on close
- [ ] run tests - must pass before next task

### Task 21: Relative plugin URLs: guide, check, bundled plugins [model: sonnet]

**Files:**
- Modify: `src/cli/guide/plugins.md` and the topics that show `/__sdk/panel.js`; `examples/plugin`
- Modify: the plugin check behind `ccc plugin` (`src/cli/` plugin commands) and `marketplace/tools/src` (then
  `npm run build:marketplace-tools`; its committed dist is byte-compared)
- Modify: bundled plugin pages that use root-absolute URLs (then `npm run build:browser`, `build:reviewer`, `build:hello`)
- Modify: drift tests; Create: a test for the check

- [ ] the guide tells plugin pages to use relative URLs (`./__sdk/panel.js`) and why (web access)
- [ ] a warning (not an error) from the plugin check and the marketplace tools when a page's HTML, JS or CSS uses a
      root-absolute URL
- [ ] the example plugin and the bundled plugins switched to relative URLs where simple; rebuilt dists committed
- [ ] write tests: the check flags `/dist/x.js` in HTML and in a JS string, passes relative ones
- [ ] run tests, `npm run test:plugins`, and the e2e specs for bundled plugins, panels and overlays - must pass before
      next task

### Task 22: Browser-side port relay and navigation guard [model: opus]

**Files:**
- Create: `src/renderer/web/port-relay.ts`; Modify: `src/renderer/plugins/PluginFrame.tsx` (web branch),
  `src/main/web/connection.ts` (`port.*` frames)
- Create: `test/unit/web-port-relay.test.ts`

- [ ] main keeps the page end of the `MessageChannelMain` for a remote view and relays `port.open`/`port.msg`/
      `port.close`; refused connects answered with `port.close`; per-panel queue limit
- [ ] the browser shell creates a `MessageChannel` per panel load it started and hands one end in with the SDK's
      `cc-plugin.port` message; the panel SDK is unchanged
- [ ] any frame load the shell did not start resets `src` to the canonical path before a port (cap: 5 resets in 10 s)
- [ ] write tests: relay round trip, refused connect, a navigated frame gets no port, the reset cap, theme delivery
- [ ] run tests - must pass before next task

### Task 23: Shared asks first-answer-wins [model: opus]

**Files:**
- Modify: `src/main/sessions/close-asks.ts`, `src/main/socket/handlers.ts` (`ccc` dialogs), terminal overlays in
  `src/main/overlays/overlay-manager.ts`, `src/shared/ipc.ts` (`settled` event), `src/main/web/protocol.ts` (`ready`)
- Modify: their tests

- [ ] close asks, CLI dialogs and terminal overlays are shown on every view of the window; the first answer wins
- [ ] a `settled` event closes them on the other views; a view joining mid-ask gets them in `ready`
- [ ] answers accepted from any view of the window, never from another window
- [ ] write tests: two views, one answers, the other gets `settled`; a late join sees the pending ask; another window's
      answer refused
- [ ] run tests - must pass before next task

### Task 24: HTML overlays and settings pages held by one view [model: opus]

**Files:**
- Modify: `src/main/overlays/overlay-manager.ts`, `src/renderer/overlays/HtmlOverlay.tsx`, settings page wiring,
  `src/main/plugins/panel-ports.ts`, `src/main/web/protocol.ts` (`ready`)
- Modify: their tests

- [ ] an HTML overlay's page lives in one view (the opener's, or the last to take it); other views show
      "Open on <device> — Take over"; taking over reloads the page there (pageReady and outbox reset as on a reload)
- [ ] `post({ result })` settles the opener once; the overlay closes on every view
- [ ] plugin settings pages the same
- [ ] write tests: take over moves the page, the old view's port closes, the result settles once, a joining view sees
      "open on <device>"
- [ ] run tests - must pass before next task

### Task 25: Desktop-only features for remote views [model: sonnet]

**Files:**
- Modify: handlers of the `adapted` channels (`ctx.openExternal`, link clicks, the link confirm in
  `src/main/socket/handlers.ts`, `ctx.files.reveal`/`openWithSystem`), web shell UI for notices and placeholders
- Modify: their tests

- [ ] `openExternal` and link clicks from a remote view: a clickable notice in that view
- [ ] the link confirm as an in-page dialog for remote views; `reveal`/`openWithSystem` refused with a message; `trash`
      unchanged; OAuth sign-in says "sign in on the desktop"; notifications stay on the host
- [ ] Browser panel and URL overlays: an "available on the desktop" placeholder in remote views
- [ ] write tests per adapted channel (remote vs desktop caller), and that every adapted handler decides by the caller
      type main bound, never by anything in the payload
- [ ] run tests - must pass before next task

### Task 26: Window lifetime with remote views [model: opus]

**Files:**
- Modify: `src/main/windows/` (close handling), `src/main/tabs/tab-manager.ts` (`closeProject`), the app quit path
- Modify: their tests

- [ ] closing the desktop window with remote views attached asks "Close for everyone" or "Keep running for <device>";
      with no remote view it closes as today (no ask); kept running hides the window (never the sizing or input view)
- [ ] opening the project again (picker, `ccc open`, dock) shows the hidden window
- [ ] quitting closes remote views with a notice
- [ ] write tests: no remote view → no ask; both choices; reopen shows it; quit notice sent
- [ ] run tests - must pass before next task

### Task 27: Password and desktop-confirm modes [model: opus]

**Files:**
- Modify: `src/main/web/auth.ts`, the settings UI from Task 9 (enable the modes)
- Modify: `test/unit/web-auth.test.ts`

- [ ] password: scrypt hash in the secret store, computed off the main thread with a concurrency cap; sign-in page; the
      token bucket from Task 5
- [ ] desktop confirm: the browser shows a short code; the desktop shows a non-modal request with no default button;
      the person types the browser's code to allow; one pending request, rate limited; the device name shown as the
      requester's own text
- [ ] write tests: password success/failure/slowdown, scrypt off-thread, confirm with the right code, wrong code, a
      second request while one is pending, Enter never accepts
- [ ] run tests - must pass before next task

### Task 28: Network binds: TLS, None and plain-http confirms [model: opus]

**Files:**
- Modify: `src/main/web/settings.ts`, `src/main/web/gateway.ts`, the settings UI, a confirm dialog in the renderer
- Modify: their tests

- [ ] lift Task 4's loopback-only rule: a non-loopback bind is allowed with TLS (cert and key paths) or after the
      plain-http confirm; external origin for a proxy in front
- [ ] the §4.3 confirms with the design's text: None on a non-loopback address, any mode over plain http on a
      non-loopback address; the warning badge while on
- [ ] None mode says in the UI that revoke has no effect; Host and Origin still apply
- [ ] write tests: each risky choice requires the confirm, a refused confirm leaves loopback, the TLS server serves
      https, None on the LAN after the confirm
- [ ] run tests - must pass before next task

### Task 29: e2e part 1: sign-in and terminal mirror [model: opus]

**Files:**
- Create: `test/e2e/web-access-terminal.spec.ts`, helpers to launch the app with web access on loopback

- [ ] sign in with the access link in a plain Chromium next to the Electron window
- [ ] a terminal tab's output on both screens; input from the browser reaches the tab; reload of the web page
      re-snapshots cleanly
- [ ] existing e2e specs still pass
- [ ] run `npm run test:e2e` - must pass before next task

### Task 30: e2e part 2: panels, take-over, security [model: opus]

**Files:**
- Create: `test/e2e/web-access-plugins.spec.ts` (launched with `env: { CC_COCKPIT_NO_BUNDLED: '' }` for the Sessions panel)

- [ ] the Sessions panel in the browser and on the desktop; a click in the browser acts there only
- [ ] an HTML overlay taken over by the browser; a close ask answered in the browser settles on the desktop
- [ ] security end to end: wrong Origin, no cookie, revoked device closes the socket
- [ ] run `npm run test:e2e` - must pass before next task

### Task 31: Verify acceptance criteria (final regression pass) [model: sonnet]

- [ ] verify every Overview item is implemented (live mirror, four modes, confirms, TLS, plugins unchanged)
- [ ] with web access off, nothing listens and the desktop behaves as before (terminal ack path, panels, overlays)
- [ ] run the full suite: `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`
- [ ] run `npm run test:coverage` and check the new `src/main/web`, `views` and `terminals` code is covered

### Task 32: [Final] Documentation [model: sonnet]

**Files:**
- Modify: `docs/design.md` (a section pointing at design-web.md and what v1 implements), `docs/design-web.md` (mark v1
  implemented, what is later), `docs/features.md`, `README.md`, `src/cli/guide/*.md`, `CLAUDE.md`

- [ ] how to turn it on; LAN, Tailscale (`tailscale serve`) and SSH tunnel recipes; the modes and their risks
- [ ] plugin author notes (views, `{ view }`, relative URLs, what remote views cannot do)
- [ ] CLAUDE.md implementation patterns: the ViewRegistry rule, remote classes, gateway checks, loopback by default
- [ ] run tests (guide drift) - must pass
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- the dev app on the VM with web access on the LAN, opened from the Mac: sign in by QR/link, mirror a busy Claude tab,
  panels and an overlay take-over, close the desktop window with a remote view attached
- through `tailscale serve` (https, every peer 127.0.0.1): Host/Origin, cookies, plugin pages
- a phone browser (usability notes for the later phone layout)
- the None-on-LAN and plain-http confirms read clearly
- performance: 8 busy Claude tabs with a remote view, main stays responsive

**External system updates:**
- `BronOS/cc-cockpit-plugin-example` gets the relative-URL change and the types (`examples/plugin`)
- marketplace plugins (bronos.*) switch to relative URLs over time; the check warns until then
- release notes for the app version that ships it
