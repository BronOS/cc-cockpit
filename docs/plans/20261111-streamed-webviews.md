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
- **Placement** (`webviews.place`, browser → main, `adapted`): `{ key, width, height, visible, hidden }`; CSS px
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

- [ ] spike under `--ozone-platform=headless --disable-gpu` with an off-screen window and *trusted* input
      (`sendInputEvent`): `window.print()`, `<input type=color>`, date/time pickers, `showOpenFilePicker()`, a click on
      a file input, HTTP basic auth (`login`), a bad certificate (`certificate-error`), `mailto:` in a sub-frame, drag
      start, a context menu, `beforeunload`; record each result (survives / aborts / needs a handler) in this plan and
      in `design-web-browser.md` §2
- [ ] move the session and webContents hardening of `electron-webview.ts` into `webview-hardening.ts`, adding a cancel
      for every case the spike shows can abort or hang (e.g. `login` → cancel, `certificate-error` → reject,
      `select-file`/pickers → cancel, print → refused); the desktop adapter calls it unchanged in behaviour
- [ ] add `OffscreenWebviewFactory` (`create` returns a `WebviewView`): off-screen `BrowserWindow` (`show: false`,
      `offscreen: true`, `disableDialogs: true`), explicit `setContentSize` at creation, never shown or focused, **no
      `before-input-event` chord forwarding**; load/back/forward/reload/current/load errors as the desktop adapter;
      `setBounds` → content size; `setVisible` → `startPainting`/`stopPainting`; `paint` and `cursor-changed` exposed
      through an event sink for later tasks; `destroy` closes the window
- [ ] write tests (Electron stubbed): hardening applied to both adapters, `disableDialogs` always set off-screen, the
      new cancels registered, no chord handler off-screen, size at creation and on `setBounds`, painting by visibility
- [ ] write tests for error cases: load failure text, aborted navigation, window gone, destroy idempotent
- [ ] run tests - must pass before next task

### Task 2: Server mode picks the off-screen factory; limits; hidden page [model: opus]

**Files:**
- Modify: `src/main/webview/webview-manager.ts`
- Modify: `src/main/index.ts`
- Modify: `scripts/server-mode-smoke.mjs`
- Modify: `test/unit/webview-manager.test.ts`
- Modify: `test/unit/browser-plugin.test.ts`
- Modify: `test/e2e/server-mode.spec.ts`

- [ ] replace the server-mode refusal with the factory choice in `index.ts` by `server` (never a payload); no `chord`
      dependency in server mode; skip `webviews.resetWindow` on the hidden page's `did-navigate` under `server`
- [ ] enforce 4 off-screen views per window and 12 per app (a navigate past it rejects with a clear reason); a navigate
      with no viewer records the target and loads it when a browser first shows the panel (the browser plugin's `home`
      at activation), except `ccc browser open`, which loads at once (the CLI needs the result)
- [ ] keep `onNavigate`, tokens, navigation rules and `window.open` (→ link notice in server mode) unchanged
- [ ] update the tests that encode today's refusal (`server-mode.spec.ts` ~955-995, `browser-plugin.test.ts` ~183) to
      the new behaviour; the smoke script opens a webview off-screen plus a page calling `alert()` and the spiked
      crash cases, and checks main survives
- [ ] write unit tests: off-screen factory chosen in server mode, desktop unchanged, limits, deferred load, hidden-page
      reload keeps views, no chord path
- [ ] run tests, the smoke script against `out/` and the server-mode e2e - must pass before next task

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

- [ ] add the binary webview frame (Technical Details) with an encoder in main and a decoder in the bridge; bump
      `PROTOCOL_VERSION`; a client binary frame still closes the socket
- [ ] `ViewSink.sendFrame` implemented only by browser view sinks, with a per-frame byte cap; `ViewRegistry` offers
      frame delivery to one view (no broadcast)
- [ ] the bridge hands decoded frames to a subscriber per panel key (no React yet)
- [ ] write tests: round trip, max key length, malformed header/short buffer rejected by the decoder; desktop and
      hidden-page sinks cannot send frames; an oversize frame is not sent and the view stays connected
- [ ] write tests: gateway still refuses client binary; version mismatch closes as before
- [ ] run tests - must pass before next task

### Task 4: Placement reports, viewers and the size owner [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Create: `src/main/webview/webview-viewers.ts`
- Modify: `src/main/webview/webview-manager.ts`
- Create: `test/unit/webview-viewers.test.ts`
- Modify: `test/unit/ipc-router.test.ts`

- [ ] add `webviews.place` (`adapted`, Technical Details), accepted only from remote views in server mode, the key
      resolved through the caller's window layout
- [ ] viewers per webview: browser views of its window that report it visible and not hidden; a view gone or a window
      closed removes it; no viewer → `setVisible(false)` (and the deferred load of Task 2 waits for the first viewer)
- [ ] size owner: changed by a button press, a key or text (Task 7 calls it) or "Fit to this screen", else the first
      reporter; owner gone → next viewer; resize throttled to one per 100 ms; sizes clamped
- [ ] write tests: viewer set, owner rules, throttle, clamping, desktop or hidden-page reports ignored
- [ ] write tests for edge cases: zero/NaN/huge sizes, a view of another window naming the key, view gone
- [ ] run tests - must pass before next task

### Task 5: Frame stream: encode budget, one frame in flight [model: opus]

**Files:**
- Create: `src/main/webview/frame-stream.ts`
- Modify: `src/main/index.ts`
- Modify: `scripts/web-terminal-bench.mjs`
- Create: `test/unit/frame-stream.test.ts`

- [ ] `FrameStream` takes `paint` images per webview, keeps the newest, encodes JPEG (q≈75) with the area capped near
      2 MP (downscaled, scale in the header) under one app-wide encode budget; keeps only the last JPEG per webview
- [ ] sends to each viewer (Task 4) through `sendFrame` with one frame in flight per viewer (the next only after the
      socket drained), latest wins; a new viewer, a reconnect or a resize gets the last JPEG at once or an `invalidate()`
- [ ] frames never go to another project's views, the desktop page or the hidden page, and are never logged
- [ ] extend `web-terminal-bench.mjs` with an animated off-screen page streamed to a fake viewer; it must still pass
      its p99 (frames must not slow terminals)
- [ ] write tests (fake sockets and images): latest-wins under a slow socket, one in flight, encode budget skips,
      area cap and scale, join frame, nothing to non-viewers
- [ ] write tests for edge cases: viewer gone mid-send, webview destroyed with a pending frame
- [ ] run tests and the bench - must pass before next task

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
