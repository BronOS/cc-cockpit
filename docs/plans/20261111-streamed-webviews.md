# Streamed web views in server mode

External review: sol / high

## Overview
- In server mode (headless Linux, browsers only, one port) the Browser panel and every `"kind": "webview"` panel are
  refused today (`design-web.md` §9.9): `ccc browser open` exits 1 and browsers show a placeholder. The owner ranks a
  working Browser panel among the most important features.
- This plan renders each webview off-screen on the server (Electron `offscreen: true`) and streams JPEG frames to the
  browser views over their existing WebSocket; pointer, wheel, keys, text, paste and copy come back. Design and the
  reasons for streaming over a proxy: `docs/design-web-browser.md` (spike results in its §2).
- `WebviewManager` keeps every decision (targets, tokens, navigation rules, `onNavigate`, errors); server mode only
  swaps the view factory, so `ccc browser open|url|reload` and `ctx.webview` behave as on the desktop.
- Revised after a fable plan review (2026-11-11): a crash-surface spike before any code, main's event loop protected
  from encoding, the toolbar for browsers, clipboard isolation, hidden-page reload, and task order.

## Context (from discovery)
- `src/main/webview/webview-manager.ts` (decisions, `WebviewView` / `WebviewViewFactory`, the server-mode refusal),
  `electron-webview.ts` (hardened `WebContentsView` adapter, `before-input-event` chords), `preview-protocol.ts`,
  `webview-target.ts`; `src/main/index.ts` (`webviewChord` ~1034, `did-navigate` → `webviews.resetWindow` ~1086).
- `src/renderer/zones/WebviewPanel.tsx` (placeholder + toolbar), the web shell in `src/renderer/web/` (`bridge.ts`,
  `main.tsx`), wire types in `src/shared/web-protocol.ts`, main's side in `src/main/web/protocol.ts` and
  `connection.ts` (`SOCKET_HIGH_WATER`, `MAX_FRAME_BYTES`, `bufferedAmount`, `send()` closing on an oversize frame).
- `src/main/views/view-registry.ts` (`toView`, view sinks), `view-sizes.ts` (terminal size owner), `src/shared/ipc.ts`
  (`REMOTE_CLASS`; `webviews.step/current/navigated` are `no`), `src/main/windows/permissions.ts`.
- Tests that encode today's refusal: `test/e2e/server-mode.spec.ts` (~955-995), `test/unit/browser-plugin.test.ts`
  (~183).
- Spike (2026-11-11): paint works headless at 30 fps, ~7 KB per 800x600 JPEG, idle page paints nothing; the window
  starts 1x1 until `setContentSize`; `sendInputEvent` and `cursor-changed` work; `<select>` popups are not painted;
  `alert()` aborts main unless `disableDialogs: true`.

## Development Approach
- **testing approach**: Regular (code first, then tests), as in the previous web access and server mode plans.
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- Electron stays behind adapter files (CLAUDE.md): `BrowserWindow` with `offscreen` only in the new adapter; logic in
  plain modules with fakes.
- Every new IPC channel gets its `REMOTE_CLASS` in the same change, named `webviews.*`; main decides by the view it
  bound and `server`, never a payload.
- Dense "why" comments (repo convention).

## Testing Strategy
- **unit tests** (vitest): every task, with fakes for Electron and sockets.
- **e2e** (Playwright, `npm run test:e2e`): server-mode specs with `launchServer` (`test/e2e/server-fixtures.ts`) and
  Electron's Chromium as the browser (`test/e2e/web-fixtures.ts`); UI tasks add their e2e in the same task.
- `node scripts/server-mode-smoke.mjs` from Task 2 on; `node --expose-gc scripts/web-terminal-bench.mjs` extended with
  an animated off-screen page in Task 5.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with actual work done

## Solution Overview
- **Crash surface first.** Every native UI a page can raise is spiked under the headless switches; each needing a
  cancel gets one in the shared hardening, each kept as a "main survives" test.
- **Off-screen factory.** `OffscreenWebviewFactory` implements `WebviewView` with an off-screen `BrowserWindow` per
  view, sharing one hardening function with the desktop adapter, plus `disableDialogs: true`, no chord dependency.
  `server` (decided once at start) picks the factory; the refusal goes; the hidden page's reload no longer resets views.
  Limits: 4 views per window, 12 per app; a navigate with no viewer is deferred until a browser shows the panel.
- **Viewers and size.** Browser views report the panel's placeholder size and visibility; a webview's viewers are the
  browser views of its own window that show it and are not hidden; one size owner (last press/key/text or "Fit to this
  screen", else the first reporter), throttled `setContentSize`; others letterbox.
- **Frames.** `paint` → JPEG (area capped near 2 MP, app-wide encode budget, last JPEG kept per view) → binary frame
  to each viewer through a browser-only `sendFrame`, one frame in flight per viewer, latest wins; no viewer →
  `stopPainting`.
- **Toolbar.** `webviews.step/current/navigated` become `adapted` for `server && view.remote`.
- **Input.** A `<canvas>` with a focusable input layer and hidden `<textarea>`; `webviews.input` /
  `webviews.insertText`, validated, viewer-only and rate-capped in main, mapped to `sendInputEvent` / `insertText`;
  cursor mirrored; selection pushed (capped, control characters stripped) for a synchronous `copy`; clipboard chords
  never forwarded; shell chords stay with the shell.
- **Selects.** Main hit-tests a `mouseDown` in an isolated world; a `<select>` becomes a browser-drawn dropdown.

## Technical Details
- **Binary frame** (server → browser only; `PROTOCOL_VERSION` bumped): `u8 kind (1 = webview frame)`,
  `u8 keyLength`, `key` (UTF-8 panel key, ≤ 200 bytes), `u32 seq`, `u16 width`, `u16 height`, `u16 scale×100`,
  then JPEG bytes. Sent only through `ViewSink.sendFrame`, which only browser view sinks implement. The gateway keeps
  closing a client that sends binary. A frame larger than the per-frame cap is not sent (the next paint is smaller or
  the view gets a lower quality).
- **Placement** (`webviews.place`, browser → main, `adapted`): `{ panelKey, width, height, visible, hidden }`; CSS px
  clamped to [64, 4096]; `hidden` = `document.hidden`. Accepted only from remote views in server mode; the key is
  resolved through the caller's window layout.
- **Input** (`webviews.input`, `adapted`): `{ key, events: [...] }`, ≤ 64 events per call; pointer
  (`move|down|up`, x, y in frame px, button, clicks, modifiers), wheel (x, y, dx, dy clamped), key (`down|up`, key
  name from a fixed allow-list, modifiers); 600 events/s per view, over-rate dropped silently; accepted only from a
  current viewer. `webviews.insertText`: `{ key, text }` ≤ 64 KB.
- **Events to the browser** (per view, `toView`): `webviews.cursor` (name from a fixed map), `webviews.selection`
  (≤ ~256 KB encoded, control characters stripped, debounced, deduplicated), `webviews.select` (options ≤ 500, labels
  capped, rect) — all `adapted`.
- **Encoding**: area cap ~2 MP (downscale, header scale), JPEG q≈75, app-wide encode budget (share of each second),
  newest paint wins; per view only the last JPEG kept; join/resync → last JPEG or `invalidate()`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: manual checks on a real server and phone.

## Implementation Steps

### Task 1: Crash-surface spike, shared hardening and the off-screen adapter [model: opus]

**Files:**
- Create: `src/main/webview/webview-hardening.ts`
- Create: `src/main/webview/electron-offscreen-webview.ts`
- Modify: `src/main/webview/electron-webview.ts`
- Create: `test/unit/electron-offscreen-webview.test.ts`
- Modify: `test/unit/electron-webview.test.ts`

- [x] spike under `--ozone-platform=headless --disable-gpu` with an off-screen window and *trusted* input
      (`sendInputEvent`): `window.print()`, `<input type=color>`, date/time pickers, `showOpenFilePicker()`, a click on
      a file input, HTTP basic auth (`login`), a bad certificate (`certificate-error`), `mailto:` in a sub-frame, drag
      start, a context menu, `beforeunload`; record each result (survives / aborts / needs a handler) in this plan and
      in `design-web-browser.md` §2
- [x] move the session and webContents hardening of `electron-webview.ts` into `webview-hardening.ts`, adding a cancel
      for every case the spike shows can abort or hang (e.g. `login` → cancel, `certificate-error` → reject,
      `select-file`/pickers → cancel, print → refused); the desktop adapter calls it unchanged in behaviour
- [x] add `OffscreenWebviewFactory` (`create` returns a `WebviewView`): off-screen `BrowserWindow` (`show: false`,
      `offscreen: true`, `disableDialogs: true`), explicit `setContentSize` at creation, never shown or focused, **no
      `before-input-event` chord forwarding**; load/back/forward/reload/current/load errors as the desktop adapter;
      `setBounds` → content size; `setVisible` → `startPainting`/`stopPainting`; `paint` and `cursor-changed` exposed
      through an event sink for later tasks; `destroy` closes the window
- [x] write tests (Electron stubbed): hardening applied to both adapters, `disableDialogs` always set off-screen, the
      new cancels registered, no chord handler off-screen, size at creation and on `setBounds`, painting by visibility
- [x] write tests for error cases: load failure text, aborted navigation, window gone, destroy idempotent
- [x] run tests - must pass before next task
- ➕ spike results (2026-11-11, Electron 45.1.0, `--ozone-platform=headless --disable-gpu --password-store=basic`,
      off-screen window, `disableDialogs`, trusted input; one case per run, exit code checked). **Nothing aborts main**
      except a JS dialog without `disableDialogs` (exit 133, the known case). With no session bus (a plain server):
      `print()` returns at once; color, date, datetime-local, time, month pickers survive (nothing painted, Escape
      closes); `showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker` reject with AbortError; a file input click
      does nothing. **With a session bus and a desktop portal** (server mode started inside a desktop session):
      `print()` opens xdg-desktop-portal's Print dialog on the host's desktop and blocks the page's renderer until it is
      answered (`unresponsive` after ~16 s; same-site loads no longer go; killing the renderer on `unresponsive` did
      not free it; only destroy does), and the pickers open the portal's file chooser there → cancelled off-screen
      through the page's DevTools protocol (`Page.enable` + `Page.setInterceptFileChooserDialog {cancel}`: pickers
      reject with AbortError, needs `Page.enable`; `print` locked to a no-op by `Page.addScriptToEvaluateOnNewDocument`;
      both survive a cross-site navigation; a cross-site sub-frame's `print()` is not covered, unproven either way).
      HTTP basic auth: Electron already cancels with no `login` listener (the 401 body shows); a bad certificate
      already fails with ERR_CERT_AUTHORITY_INVALID with no `certificate-error` listener → both pinned explicitly in
      the shared hardening (`login` → cancel, `certificate-error` → `callback(false)`), desktop included (same
      behaviour). `mailto:` in a sub-frame: `will-frame-navigate` fires (the manager refuses it) and `openExternal` is
      asked (the lock-down denies it) → no new handler. Drag (an element, a text selection, an image, a drop target),
      the right-click context menu (`context-menu` fires, Electron shows no menu): survive, no handler. `beforeunload`
      without the existing `will-prevent-unload` handler cancels the navigation silently (ERR_ABORTED) and the reload,
      with or without `disableDialogs` → the existing handler fixes it (kept, shared).
- ➕ for Task 2: `app.on('browser-window-created')` and `'web-contents-created'` in `index.ts` also see every
      off-screen window (the overlay chord listener returns early, `did-navigate` → `webviews.resetWindow(<off-screen
      id>)` is a no-op, the lock-down is harmless), and anything that walks `BrowserWindow.getAllWindows()` or counts
      windows now finds them; the adapter destroys its window when the project window closes. The first `paint`
      after `startPainting` can carry an empty (0x0) image: Task 5 skips empty images.

### Task 2: Server mode picks the off-screen factory; limits; hidden page [model: opus]

**Files:**
- Modify: `src/main/webview/webview-manager.ts`
- Modify: `src/main/webview/electron-offscreen-webview.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/plugins/host-api.ts`
- Modify: `src/main/plugins/host-manager.ts`
- Modify: `scripts/server-mode-smoke.mjs`
- Modify: `test/unit/webview-manager.test.ts`
- Modify: `test/unit/browser-plugin.test.ts`
- Modify: `test/e2e/server-mode.spec.ts`
- Modify: `test/e2e/webview-panel.spec.ts`
- Modify: `test/unit/electron-offscreen-webview.test.ts`

- [x] replace the server-mode refusal with the factory choice in `index.ts` by `server` (never a payload); no `chord`
      dependency in server mode; skip `webviews.resetWindow` on the hidden page's `did-navigate` under `server`
- [x] enforce 4 off-screen views per window and 12 per app (a navigate past it rejects with a clear reason); a navigate
      with no viewer records the target and loads it when a browser first shows the panel (the browser plugin's `home`
      at activation), except `ccc browser open`, which loads at once (the CLI needs the result)
- [x] keep `onNavigate`, tokens, navigation rules and `window.open` (→ link notice in server mode) unchanged
- [x] update the tests that encode today's refusal (`server-mode.spec.ts` ~955-995, `browser-plugin.test.ts` ~183) to
      the new behaviour; the smoke script opens a webview off-screen plus a page calling `alert()` and the spiked
      crash cases, and checks main survives
- [x] write unit tests: off-screen factory chosen in server mode, desktop unchanged, limits, deferred load, hidden-page
      reload keeps views, no chord path
- [x] run tests, the smoke script against `out/` and the server-mode e2e - must pass before next task
- ➕ "a `ccc` command waits on it" (`now`, `NavigateOptions`): main's own count of the plugin's running `ccc` calls
      (`HostScope.cliRunning`, from HostManager's `cliInFlight`), read by host-api.ts at the navigate; no SDK or host
      change, nothing from the payload. A navigate made while one runs loads at once (`ccc browser open`); any other
      navigate for a panel with no view and no viewer (`home` at activation) is recorded (`hasDeferred`) and resolves.
      The deferral is a resource rule, not a boundary: a plugin keeping a command open only gets what the limits allow.
- ➕ the viewer hook for Task 4: `WebviewManager.setViewed(windowId, pluginId, panelId, viewed)`. Nothing calls it yet,
      so every panel counts as unseen and only `now` navigates (and navigates of a panel that already has a view) load.
      The first `viewed: true` of a panel loads its deferred target (outcome to `current()`, `onNavigate`, the toolbar;
      past the limits: logged, the toolbar told the reason, the target kept for the next viewer); `false` only forgets
      the viewer (hiding, `setVisible(false)`, is Task 4's). Viewers and deferred targets go with destroyPlugin and
      closeWindow. In server mode `setPlacement` is ignored (only the hidden page sends it) and `handBack` never runs,
      so an off-screen view stays `setVisible(false)` (not painting) until Task 4 drives visibility itself.
- ➕ limits are counted from the manager's records, which a view leaves however it goes (destroyPlugin, closeWindow, its
      page `gone`, which the adapter's destroy on the project window's `closed` fires); refused with
      `WEBVIEW_LIMIT_REFUSAL` (a plain error: host-api refunds the navigate charge). Desktop: no limits, no deferral.
- ➕ off-screen windows in main's window code: `isOffscreenWindow(win)` (the adapter; `webContents.isOffscreen()`,
      since `browser-window-created` fires inside the constructor) skips them in `browser-window-created` (no overlay
      chord listener, no `did-navigate` reset) and `browser-window-focus`/`-blur`. Nothing else walks windows in main
      (WindowManager, ViewRegistry and the quit path use their own tables; `getAllWindows` is banned outside adapters);
      the `web-contents-created` lock-down still applies (as for desktop views). `before-quit` calls
      `OffscreenWebviewFactory.destroyAll()` (a blocked page never answers the close Electron's quit asks). Test hooks:
      `nativeViewsMade` gained `offscreenWebviews` (`webviews` = views placed on a screen, 0 in server mode) and
      `offscreenWebviews()` lists the live pages with `visible`, `focused`, `painting`, `projectWindow`, `sender`.
- ➕ the smoke script's trusted-input file chooser cases (a click on a file input, the pickers with a gesture) are run
      without a gesture (the CLI has no input path); the e2e of Task 7 can drive them with input. The guide
      (`cli.md`, `api.md`) and the browser skill still say "not available in server mode": Task 10.

### Task 3: Binary frames on the wire [model: sonnet]

**Files:**
- Modify: `src/shared/web-protocol.ts`
- Modify: `src/main/web/protocol.ts`
- Modify: `src/main/views/view-registry.ts`
- Modify: `src/main/web/connection.ts`
- Modify: `src/renderer/web/bridge.ts`
- Modify: `test/unit/web-protocol.test.ts`
- Modify: `test/unit/web-bridge.test.ts`
- Modify: `test/unit/view-registry.test.ts`

- [x] add the binary webview frame (Technical Details) with an encoder in main and a decoder in the bridge; bump
      `PROTOCOL_VERSION`; a client binary frame still closes the socket
- [x] `ViewSink.sendFrame` implemented only by browser view sinks, with a per-frame byte cap; `ViewRegistry` offers
      frame delivery to one view (no broadcast)
- [x] the bridge hands decoded frames to a subscriber per panel key (no React yet)
- [x] write tests: round trip, max key length, malformed header/short buffer rejected by the decoder; desktop and
      hidden-page sinks cannot send frames; an oversize frame is not sent and the view stays connected
- [x] write tests: gateway still refuses client binary; version mismatch closes as before
- [x] run tests - must pass before next task

### Task 4: Placement reports, viewers and the size owner [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Create: `src/main/webview/webview-viewers.ts`
- Modify: `src/main/webview/webview-manager.ts`
- Modify: `src/main/index.ts`
- Create: `test/unit/webview-viewers.test.ts`
- Modify: `test/unit/ipc-router.test.ts`
- Modify: `test/unit/ipc-remote-class.test.ts`
- Modify: `test/unit/webview-manager.test.ts`

- [x] add `webviews.place` (`adapted`, Technical Details), accepted only from remote views in server mode, the key
      resolved through the caller's window layout
- [x] viewers per webview: browser views of its window that report it visible and not hidden; a view gone or a window
      closed removes it; no viewer → `setVisible(false)` (and the deferred load of Task 2 waits for the first viewer)
- [x] size owner: changed by a button press, a key or text (Task 7 calls it) or "Fit to this screen", else the first
      reporter; owner gone → next viewer; resize throttled to one per 100 ms; sizes clamped
- [x] write tests: viewer set, owner rules, throttle, clamping, desktop or hidden-page reports ignored
- [x] write tests for edge cases: zero/NaN/huge sizes, a view of another window naming the key, view gone
- [x] run tests - must pass before next task
- ➕ wire: `webviews.place` `{ panelKey, width, height, visible, hidden }` (`panelKey`, not `key`, as
      `webviews.step/current`) and a separate `webviews.fit` `{ panelKey }` ("Fit to this screen"), both `adapted`:
      refused unless `server && view.remote` (the desktop page, the hidden page and a browser outside server mode
      throw), the key resolved by `layouts.webviewPanel(ctx.projectId, …)`, the window and view the router's. Width and
      height must be finite numbers (else refused); clamping to [64, 4096] is `webview-viewers.ts` (`clampSide`). A
      viewer is visible, not hidden and with an area (a raw side < 1 is not, like the desktop's zero bounds). **For Task
      6**: report on mount, on every ResizeObserver change and `visibilitychange`, and `visible: false` on unmount;
      `visible` means mounted and on screen, not "no shell layer over it" (an overlay in a browser is a page layer
      over the canvas, so the manager has no cover rule in server mode). A report whose key no longer resolves (the
      plugin was just turned off) is refused but still takes that view's own entry in its own window off the panel
      (`WebviewViewers.leave`), so the unmount report works.
- ➕ API (`src/main/webview/webview-viewers.ts`, one `WebviewViewers` in index.ts as `webviewViewers`, fed only in server
      mode): `report`, `claimOwner(panel, viewId)` (**Task 7** calls it on a press, a key or text; ignored from a
      non-viewer; `webviews.fit` uses it too), `leave`, `viewGone` (wired in webConnections' `viewGone`),
      `closeWindow` (wired in `onWindowClosed`, no `setViewed`: the manager drops the views); reads for **Task 5**:
      `viewers(panel)` (join order), `isViewer`, `ownerOf`, `sizeOf` (the applied size), `onChange(listener)` → unsubscribe,
      with `{ kind: 'added' | 'removed', panel, viewId }`, `{ kind: 'size', panel, size }` (after the throttle) and
      `{ kind: 'owner', panel, viewId | undefined }`. `panel` is `{ windowId, pluginId, panelId }`. A panel losing its
      last viewer forgets its state (the next first viewer is owner and sized at once). Owner gone → the viewer active
      last (a report or a claim), the terminal rule. Task 7 must only call `claimOwner` for a view that `isViewer`.
- ➕ manager (server mode): `setViewed` now drives the view's visibility (`true` → `setVisible(true)`, so painting;
      `false` → hidden) and is ignored on the desktop; new `setViewSize` (clamped again, kept without a view, so a view
      made for a deferred load starts at the owner's size); `setWindowCovered` and `resetWindow` change nothing in
      server mode; `destroyPlugin` keeps the viewers and their placements (they are the browsers', a reloaded plugin's
      `home` loads at once for a browser that still shows the panel) — Task 2's test changed to that.

### Task 5: Frame stream: encode budget, one frame in flight [model: opus]

**Files:**
- Create: `src/main/webview/frame-stream.ts`
- Modify: `src/main/index.ts`
- Modify: `scripts/web-terminal-bench.mjs`
- Create: `test/unit/frame-stream.test.ts`

- [x] `FrameStream` takes `paint` images per webview, keeps the newest, encodes JPEG (q≈75) with the area capped near
      2 MP (downscaled, scale in the header) under one app-wide encode budget; keeps only the last JPEG per webview
- [x] sends to each viewer (Task 4) through `sendFrame` with one frame in flight per viewer (the next only after the
      socket drained), latest wins; a new viewer, a reconnect or a resize gets the last JPEG at once or an `invalidate()`
- [x] frames never go to another project's views, the desktop page or the hidden page, and are never logged
- [x] extend `web-terminal-bench.mjs` with an animated off-screen page streamed to a fake viewer; it must still pass
      its p99 (frames must not slow terminals)
- [x] write tests (fake sockets and images): latest-wins under a slow socket, one in flight, encode budget skips,
      area cap and scale, join frame, nothing to non-viewers
- [x] write tests for edge cases: viewer gone mid-send, webview destroyed with a pending frame
- [x] run tests and the bench - must pass before next task
- ➕ done as `src/main/webview/frame-stream.ts` (`FrameStream`, `streamView`, `encodedSize`), wired in index.ts in
      server mode only: the manager's factory wrapper wraps each off-screen view with `streamView(frameStream, owner,
      view)` (its paints to the stream, its destroy detaches it), so `WebviewViewFactory.create` got a 4th argument,
      `owner` (the panel; the manager passes it, the adapters ignore it). `sendFrame` = `views.frameToView`, `drained` =
      `views.frameDrained`, clock `performance.now()`; `before-quit` disposes it after `destroyAll`. Numbers:
      `MAX_ENCODE_AREA` 1920x1080 (a full-HD page as is; larger ones scaled by the largest whole hundredth, so the
      header's scale x 100 is exact), `JPEG_QUALITY` 75, over 1 MiB re-encoded at 50 then 30, else skipped (logged once
      per view, size only), `ENCODE_BUDGET_SHARE` 0.2 (a leaky bucket of at most 200 ms of encode debt, draining 200 ms
      per second; every encode, retries included, is charged), `DRAIN_POLL_MS` 16. Encoding is lazy: a paint is held
      (newest only) and encoded only when some viewer's socket drained and lacks the newest frame. Drain is polled: one
      app-wide timer, armed only while a viewer waits for its socket or a paint for the budget (`ws` has no drain event;
      net.Socket's `drain` only follows a full write). `bufferedAmount` does not see the kernel's socket buffer.
- ➕ the header's `scale` keeps Task 3's definition: encoded size over the page's size, the page's size being the
      painted image's (CSS px at device scale 1 in v1, design-web-browser.md §3.2). **For Task 6**: the page's CSS size
      of a frame is `width / scale` x `height / scale` (letterbox and input mapping by the frame's own size: right after a
      resize the browser may still get one frame of the old size). `seq` starts at 1 per page and starts again for a
      new view of the panel (a plugin reload, a crash): it only names a frame; frames of one socket arrive in order, so
      never drop a frame for a lower seq. A new viewer gets the last frame at once, or the page is `invalidate()`d (no
      frame yet); a size change invalidates the page. Nothing to do on the browser for the one-in-flight rule (main
      paces by the socket).
- ➕ **for Task 7**: `streamView`'s 4th argument `cursor` takes the page's `cursor-changed` type; index.ts passes none
      yet (the cursor is dropped until then).
- ➕ the bench now runs as Electron's main (started with node, it starts itself again under the repo's Electron, on
      Linux with `--ozone-platform=headless --disable-gpu` and no display), so it needs no `npm run build`. Phase 5
      streams an animated canvas page (1280x800, then 1920x1080) through the real FrameStream and WebviewViewers to a fake
      viewer draining at 8 MiB/s during phase 1's flood; exits 1 when phase 1's or phase 5's p99 is over the limit. Event
      loop utilization is no longer printed (Electron's main loop is Chromium's; Node's figure reads 0). Measured
      (2026-11-11, this machine): flooded p99 2.0 ms; with a 1280x800 stream p99 6.2 ms (30 frames/s, 128 KiB each,
      encode 4.3 ms avg, 8.7 max, 13% of main); 1920x1080 p99 8.4 ms (30 frames/s, 174 KiB, encode 7.1 ms avg, 13.4 max,
      21% of main, at the budget). CLAUDE.md's line on the bench ("exits 1 when parsing lands back on main") is Task 13's.

### Task 6: The web shell draws the stream and the toolbar [model: opus]

**Files:**
- Modify: `src/renderer/zones/WebviewPanel.tsx`
- Create: `src/renderer/web/webview-canvas.tsx`
- Modify: `src/renderer/web/web.css`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Create: `test/unit/webview-canvas.test.ts`
- Create: `test/e2e/server-webview.spec.ts`

- [ ] `webviews.step`, `webviews.current` and `webviews.navigated` become `adapted`: allowed when
      `server && view.remote`, resolved through the caller's own window; desktop rules unchanged
- [ ] when the view is a server view (`isServerView()`), a webview panel renders `webview-canvas` instead of the
      placeholder: frames (`createImageBitmap`) on a canvas, letterboxed when not the size owner, placement reports
      (ResizeObserver, `document.hidden`), "Fit to this screen", and the same toolbar as the desktop (back, forward,
      reload, URL and title, the load-error text, the "view gone" state)
- [ ] the desktop's `WebviewPanel` path and a browser view of a desktop project (placeholder) are unchanged
- [ ] write unit tests for letterbox math, placement reporting and the toolbar's channel classes
- [ ] e2e: server mode, `ccc browser open` of a local HTML file from a Claude tab paints non-blank pixels of the
      expected colour in the browser's canvas; the toolbar shows the URL; a refused port shows the load error; closing
      the panel stops frames
- [ ] run tests - must pass before next task

### Task 7: Pointer, wheel and keys [model: opus]

**Files:**
- Create: `src/main/webview/webview-input.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Modify: `src/renderer/web/webview-canvas.tsx`
- Create: `test/unit/webview-input.test.ts`
- Modify: `test/e2e/server-webview.spec.ts`

- [ ] `webviews.input` (`adapted`) validated in main (allow-listed key names, finite in-frame coordinates, 64 events
      per call, 600/s per view dropped silently, only from a current viewer, key resolved through the layout) and
      mapped to `sendInputEvent` through the header scale; a press, key or text makes the sender the size owner
- [ ] the canvas captures pointer (moves coalesced per animation frame), wheel and keys with the letterbox scale
      undone; shell command chords stay with the shell; **clipboard chords (Ctrl/Cmd+C, X, V, Shift+Insert) are never
      forwarded**
- [ ] `webviews.cursor` mirrored as the input layer's CSS cursor from a fixed map
- [ ] write unit tests: validation (bad types, out of frame, unknown keys, rate cap, non-viewer, another window's
      view), mapping and scale, chord split, clipboard chords dropped
- [ ] e2e: a click in the canvas runs the page's click handler; wheel scrolls; Enter/Backspace reach an input; a page
      calling `alert()` leaves main alive
- [ ] run tests - must pass before next task

### Task 8: Text, IME, paste and copy [model: opus]

**Files:**
- Modify: `src/main/webview/webview-input.ts`
- Modify: `src/main/webview/electron-offscreen-webview.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/renderer/web/webview-canvas.tsx`
- Modify: `test/unit/webview-input.test.ts`
- Modify: `test/e2e/server-webview.spec.ts`

- [ ] hidden `<textarea>` in the input layer: committed text (`input`, `compositionend`) → `webviews.insertText`
      (≤ 64 KB) → `webContents.insertText`; the `paste` event's text → the same
- [ ] after selecting input (mouse up, shift-arrows, select-all, double click), debounced and latest-wins, main reads
      the selection in an isolated world: `getSelection()`, or a focused text input/textarea's selected slice (never a
      password field), sliced in the script; main strips control characters, caps near 256 KB encoded, deduplicates,
      and pushes `webviews.selection` to the acting view; the browser sets it in its `copy` event; cut = copy + Delete
- [ ] write unit tests: insertText caps, selection caps by encoded bytes, control characters stripped, password fields
      skipped, dedupe/debounce, push only to the acting view, a hostile selection never closes the view
- [ ] e2e: typed and pasted text (including non-ASCII) reaches an input; a selection copied in the canvas lands in the
      browser's copy event data
- [ ] run tests - must pass before next task

### Task 9: `<select>` popups by hit-testing [model: opus]

**Files:**
- Create: `src/main/webview/select-hit.ts`
- Modify: `src/main/webview/webview-input.ts`
- Modify: `src/renderer/web/webview-canvas.tsx`
- Create: `test/unit/select-hit.test.ts`
- Modify: `test/e2e/server-webview.spec.ts`

- [ ] before forwarding a `mouseDown`, main hit-tests the point in an isolated world; on a `<select>` it does not
      forward the click, reads options (≤ 500, labels capped) and rect from that result, and sends `webviews.select` to
      the clicking view; the browser draws a dropdown over the canvas; the choice sets the value and fires
      `input`/`change` in the isolated world
- [ ] if hit-testing proves unreliable: keyboard-only selects, documented in `design-web-browser.md` §4.4 and
      features.md, with a keyboard test
- [ ] write unit tests: result parsing and caps, non-select clicks forwarded unchanged, a stale choice ignored
- [ ] e2e: a select's value changes through the browser
- [ ] run tests - must pass before next task

### Task 10: Docs, guide and skill [model: sonnet]

**Files:**
- Modify: `docs/design-web.md`
- Modify: `docs/design-web-browser.md`
- Modify: `docs/features.md`
- Modify: `plugins/browser/skills/browser/SKILL.md`
- Modify: `src/cli/guide/api.md`
- Modify: `CLAUDE.md`

- [ ] design-web.md §9.9 and §0 point at `design-web-browser.md`; mark the design implemented with any deviations
- [ ] features.md "Server mode": the Browser panel works, how it feels, what does not (uploads, downloads, sound,
      page dialogs, selects if keyboard-only)
- [ ] the browser skill and the `ctx.webview` guide text drop "no panel in server mode"
- [ ] CLAUDE.md implementation patterns: the off-screen factory, `disableDialogs` and the hardening cancels required,
      binary frames server to browser only through `sendFrame`, no clipboard chords forwarded
- [ ] run the guide drift tests (`cli-guide.test.ts`, `claude-plugins.test.ts`) and `npm run test:plugins`
- [ ] run tests - must pass before next task

### Task 11: Second browser and reconnect e2e [model: sonnet]

**Files:**
- Modify: `test/e2e/server-webview.spec.ts`

- [ ] e2e: a second browser on the same project sees the page letterboxed; a press from it makes it the size owner
- [ ] e2e: a browser that reconnects gets a frame at once; a hidden browser tab stops being a viewer
- [ ] run the e2e - must pass before next task

### Task 12: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview are implemented (Browser panel and a third-party webview panel)
- [ ] verify edge cases: limits, deferred load, hidden tabs, reconnect, slow socket, the spiked crash cases
- [ ] run full test suite: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] run `node scripts/server-mode-smoke.mjs` and `node --expose-gc scripts/web-terminal-bench.mjs`

### Task 13: [Final] Update documentation [model: sonnet]
- [ ] update README.md if it mentions the server-mode browser limitation
- [ ] update CLAUDE.md "State" with the streamed web views line
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- on the real server: a Vite dev server with live reload, an external site, a long scrolling page, a phone browser
- feel: latency and bandwidth on Wi-Fi; CPU on the server with an animated page; HiDPI softness (design open question 2)
