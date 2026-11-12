# Web views in a browser: rendered on the server, streamed — design

Status: implemented (2026-11-11), plan `docs/plans/20261111-streamed-webviews.md`; where the build differs from the first
draft the text below says what was built (wire names, input units, the key and text split, numbers). Extends
`docs/design-web.md` (web access, §9 server mode); read that first.
The owner's requirement: the Browser panel (and every `"kind": "webview"` panel) must work in server mode, from a
plain browser, with **one port** and nothing for a new user to set up or expose.

## 0. Goal and non-goals

**Goal.** In server mode, a webview panel shows its page in every browser view that has the panel open, and the
person can use it: click, type, scroll, select, copy, paste. `ccc browser open <url|file>`, `ccc browser url`,
`ccc browser reload` and `ctx.webview` behave as on the desktop (the same target rules, the same errors, the same
`onNavigate`), so the bundled browser plugin and third-party webview plugins work unchanged. Local files, dev servers
on the server's localhost, and external sites all load, since the page runs where the desktop's would.

**Non-goals (v1).** URL overlays (`ccc overlay --url`) stay refused in server mode (§9, later: the same machinery
fits). File uploads (`<input type=file>`), drag and drop into the page, downloads, audio and video sound, WebRTC,
the page's own JS dialogs shown to the person (they are disabled, §4.3), HiDPI-sharp rendering (§3.2), a phone touch
layout, and the desktop (with web access on) streaming its native views to browsers (the desktop keeps its
`WebContentsView`; a browser view of a desktop project keeps the placeholder).

## 1. Why streaming and not a proxy

Two shapes were weighed (2026-11-11, with the owner):

- **A. Proxy into an iframe.** The server serves the file or proxies the dev server; the person's browser renders it.
  A proxied page must not share cc-cockpit's origin (its script would act with the device's sign-in), and origins
  differ only by scheme, host and port. With one port and an IP address there is no second origin: the page either
  shares the gateway's origin (unsafe) or runs in an opaque-origin sandbox, where it loses cookies and storage and its
  root-absolute requests (`/assets/x.js`, `/@vite/client`, `/api/...`) land on the gateway's own paths, not the dev
  server's. Static mock-ups mostly survive; dev servers, the main case, break in ways rewriting cannot fix (absolute
  paths inside JS modules). A clean A needs a second host name (wildcard DNS, `.local`) or a port range: setup work the
  owner ruled out.
- **B. Render on the server, stream pixels and input.** The page runs in an off-screen Chromium view on the server,
  exactly as the desktop's `WebContentsView` would; frames go to the browser over the view's existing WebSocket, input
  comes back. One port, every page loads, and the page's code never runs in the person's browser, so the origin
  question disappears. Costs: latency, bandwidth while the page changes, server CPU while it animates, and input
  fidelity work (IME, clipboard, `<select>` popups).

B was chosen. A could return later as an optional fast path for static files only.

## 2. Spike results (2026-11-11, Electron 45.1.0, the server-mode switches `--ozone-platform=headless --disable-gpu`)

A throwaway script (not in the repo) made an off-screen `BrowserWindow` (`webPreferences.offscreen: true`, `show: false`):

- **Paint works headless.** `paint` events at the requested rate (`setFrameRate(30)`: 30 frames in 1 s with an
  animation), an 800x600 frame as JPEG q70 about 7 KB and about 1 ms to encode on this machine. A static page paints
  nothing (1 frame in 1 s after the animation stopped): an idle view costs no bandwidth.
- **The window starts 1x1** under the headless platform whatever `width`/`height` say; `setContentSize` after
  creation gives the real size, and a later `setContentSize` resizes the page (1200x700 painted at once). Every view
  must be sized explicitly.
- **Input works** through `webContents.sendInputEvent`: mouse move, down, up (a button's click handler ran), `char`
  events (non-ASCII `é` arrived), key down/up (`Backspace`, `Down`, `Return`), wheel. `cursor-changed` fires
  (`pointer`, `hand`).
- **`<select>` popups are not painted** into the frame (the popup is a separate widget the off-screen view does not
  composite); the select still works by keyboard (Down then Return changed its value). Needs its own handling (§4.4).
- **A JS dialog kills main.** `alert()` in the page aborted the process (core dump, SIGTRAP), the same failure as a
  message box under Ozone headless (CLAUDE.md, server mode dialogs). `webPreferences.disableDialogs: true` fixes it:
  `alert` returns at once, `confirm` returns false, `prompt` throws in the page, and main lives. A click on
  `<input type=file>` did nothing and main lived.
- **External sites load** (`https://example.com/` painted with its title).
- **The rest of the crash surface** (plan Task 1, 2026-11-11, trusted input through `sendInputEvent`, one case per
  run). Nothing else aborts main. Where each case lands, and what the shared hardening (`webview-hardening.ts`) does:

  | Case | Plain server (no session bus) | With a desktop portal on the session bus | Handling |
  |---|---|---|---|
  | `window.print()` | returns at once | the portal's Print dialog on the host's desktop; the page's renderer blocked until answered (only destroy frees it) | off-screen: `print` locked to a no-op in every new document (DevTools protocol) |
  | `<input type=file>` click, `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` | nothing / AbortError | the portal's file chooser on the host's desktop; the promise pending | off-screen: `Page.setInterceptFileChooserDialog {cancel}` (AbortError) |
  | `<input type=color>`, date, datetime-local, time, month | survives, nothing painted | same | none |
  | HTTP basic auth (page or sub-resource) | cancelled by Electron's default, 401 body shown | same | `login` → cancel, explicit (both adapters) |
  | Self-signed certificate | load fails, ERR_CERT_AUTHORITY_INVALID | same | `certificate-error` → reject, explicit (both adapters) |
  | `mailto:` in a sub-frame (and the top frame) | `will-frame-navigate` refused; `openExternal` asked | same | existing: the manager's rule and the session lock-down |
  | Drag (element, text, image, onto a drop zone) | survives | same | none |
  | Right-click | `context-menu` fires, no menu | same | none |
  | `beforeunload`, then a navigate or reload | silently cancelled (ERR_ABORTED) without the handler | same | existing: `will-prevent-unload` → proceed |

  The desktop keeps its file choosers, print and page dialogs; only the `login` and `certificate-error` pins are
  shared, and they match what Electron did before. A cross-site sub-frame's `print()` runs in a process the
  protocol session is not attached to and is not covered (the worst it does is that frame blocked and the portal
  dialog). Killing a blocked renderer on `unresponsive` did not free it in the spike, so there is no watchdog.

## 3. Architecture

### 3.1 One more view factory, the same manager

`WebviewManager` (`src/main/webview/webview-manager.ts`) already holds every decision: which target a navigate may
load (http(s) as is, a file through a `cc-preview://<token>/` per view and folder), which in-page navigation goes
ahead, where `window.open` goes, load errors, `onNavigate` coalescing, tokens, ownership by panel. The Electron
adapter (`electron-webview.ts`) only makes the hardened view. Server mode gets a second adapter,
`main/webview/electron-offscreen-webview.ts` (`OffscreenWebviewFactory`), implementing the same `WebviewView`:

- an off-screen `BrowserWindow` per view (`show: false`, `offscreen: true`), never shown, focused or positioned on any
  screen, sized only by `setContentSize` (the 1x1 start, §2);
- the same hardening as `electron-webview.ts`, factored into `webview-hardening.ts`, which both adapters call: no preload, no
  Node, sandboxed, context-isolated, the in-memory partition per project and plugin, permissions denied, downloads
  cancelled, WebRTC off non-proxied UDP, `cc-preview://` on that session only, `beforeunload` never holding the view,
  plus **`disableDialogs: true`** in server mode (§2; required, not optional: one `alert` would end the server) and
  the off-screen cancels of file choosers, pickers and `print()` (§2, the table);
- `paint` events go to the frame stream (§3.3); `cursor-changed` to the browsers (§4.1).

The server-mode refusal in `WebviewManager` (§9.9) is replaced by the factory choice: `server` picks the off-screen
factory when main starts (decided once, by `decideServerMode`, never by a payload). The hidden page still never makes
a native view: the factory paints off-screen whoever asks, and the hidden page's placement reports (it has the panel
open in the shared layout) are ignored for sizing (§3.2), as `ViewSizes` already ignores it for terminals. Two desktop
paths must not run in server mode (plan review): the hidden page reloading (`did-navigate` → `webviews.resetWindow`
would hide every view, and browsers never re-report), and the adapter's `before-input-event` chord forwarding
(`webviewChord` would focus the hidden page and trigger a command only it runs); the off-screen factory gets no chord
dependency, since shell chords never reach the page from a browser (§4.1).

A navigate with no browser showing the panel (the browser plugin's `home` page at activation, in every open project)
records the target and loads it when a browser first shows the panel, so idle projects hold no Chromium page and
cannot exhaust the app-wide view limit (§5). `ccc browser open` loads at once whether or not a browser shows the
panel (the CLI needs the load result): main knows a `ccc` command of the plugin is running (its own count of the
plugin's running commands, nothing from the payload) and a navigate made meanwhile is not deferred. The deferral is a
resource rule, not a boundary. The first browser to show the panel (`WebviewManager.setViewed`) loads the deferred
target; past the limits (§5) that is logged and the toolbar says why.

`setBounds`/`setVisible` keep their meaning for the manager: `setVisible(false)` means no browser shows the panel, and
the adapter then stops painting (`webContents.stopPainting()`), so a hidden view costs no CPU or bandwidth; `true`
starts it again and sends a full frame.

### 3.2 Size: one owner, like a terminal

Every browser view that shows the panel reports its placeholder's size with `webviews.place` (`{ panelKey, width,
height, visible, hidden }`, `adapted`, accepted only from a remote view in server mode, the panel resolved through the
caller's window layout; CSS pixels from the canvas area the web shell draws, sent on mount, on every resize and on
`visibilitychange`, `visible: false` on unmount; clamped to [64, 4096] by main). A view is a **viewer** of the panel
while it is visible, not hidden (`document.hidden`) and has an area (`webview-viewers.ts`). The page has one size: the size of
the view that last gave it input or asked "Fit to this screen" (`webviews.fit`; the terminal's rule, design-web.md
§5.2), else the first view that reported. Other views show the frame scaled to fit, letterboxed ("contain", for every
view: the owner's frame lands 1:1), and map their input back through the same scale. The browser is not told who owns
the size: "Fit to this screen" shows in the toolbar while the frame's page size differs from the area by more than 1 px.
A panel losing its last viewer forgets its state. A size change from the owner resizes the off-screen window (`setContentSize`), at most every 100 ms (a dragged
splitter must not reflow the page per pixel).

Pixels are CSS pixels at device scale 1 in v1: on a HiDPI screen the frame is upscaled and looks soft. Rendering at
the owner's `devicePixelRatio` (zoom or a larger frame) is a later step; the frame header carries the scale so the
browser can draw either.

### 3.3 Frames: latest wins, never queued

A frame is the whole visible page, JPEG (quality about 75; PNG never: 10x the size). v1 sends full frames.

- **Main's event loop and memory** (plan review). `toJPEG` is synchronous on main, and a page decides how often it
  paints. So: the encoded area is capped at 1920x1080 (a full-HD page goes as is; a larger one is downscaled by the
  largest whole hundredth, so the header's scale x 100 is exact); JPEG quality 75, re-encoded at 50 and then 30 when
  a frame is over the 1 MiB per-frame cap, else skipped (logged once per view, size only); one app-wide encode budget
  (`ENCODE_BUDGET_SHARE` 0.2: a leaky bucket of at most 200 ms of encode debt, draining 200 ms per second, every
  encode charged, retries included) holds paints once spent, newest kept; encoding is lazy, only when some viewer's
  socket drained and lacks the newest frame; per view only the last **JPEG** is kept, never the `NativeImage`. The terminal bench
  (`scripts/web-terminal-bench.mjs`) gets an animated off-screen page so this is measured, not assumed.
- **Rate.** `setFrameRate` 30 while a browser shows the view; the encoder takes the newest image only (a slow encode
  never builds a backlog); an empty (0x0) first paint after `startPainting` is skipped. A view with no viewer (no browser shows the panel, or its only browsers are hidden tabs)
  stops painting.
- **One frame in flight per browser view.** A browser view gets the next frame only after the previous one left the
  socket (`bufferedAmount` at most 64 KiB, `FRAME_DRAINED_BYTES`); `ws` has no drain event, so main polls it with one
  app-wide 16 ms timer, armed only while a viewer waits for its socket or a paint for the budget; meanwhile a newer frame replaces the pending one. With the per-frame size
  cap this bounds what a frame can put in front of terminal output to one frame, which is the only priority that can
  be had: a frame already on the socket cannot be pre-empted, and terminal chunks are written straight to it.
- **Join and resync.** A view that opens the panel, reconnects, or resizes gets the last JPEG at once, or the page is
  asked to repaint (`invalidate()`) when there is none.
- **Wire.** Frames are the protocol's first **binary** frames, server to browser only: a fixed header (`u8` kind 1,
  `u8` key length, the panel key (UTF-8, at most 200 bytes), `u32` seq, `u16` width, `u16` height, `u16` scale x 100)
  and the JPEG bytes, at most 1 MiB with the header (`MAX_WEBVIEW_FRAME_BYTES`; over it the frame is not sent and the
  view stays connected). `scale` is the encoded size over the page's size (the painted image's, CSS px at device scale
  1), so a frame's page size is `width / scale` x `height / scale`; `seq` only names a frame (it starts again for a new
  view of the panel), frames of one socket arrive in order. Only browser view sinks can send them (a
  `sendFrame` the desktop and hidden-page sinks do not have), so the hidden page is left out by construction. The
  browser never sends binary (the gateway keeps closing on a binary frame from a client). `PROTOCOL_VERSION` is
  bumped to 2 (an older page would drop every frame, so it is closed with `CLOSE.version` and reloads). Base64 inside JSON was rejected: a third more bytes on the hottest path.

### 3.5 The toolbar in a browser

The desktop panel's toolbar (back, forward, reload, the URL and title, a load error) uses `webviews.step`,
`webviews.current` and the `webviews.navigated` event, all `no` today. In server mode they become `adapted`, allowed
when `server && view.remote` (`webviews.navigated` reaches remote views only in server mode) and resolved through the
caller's own window, so a browser gets the same toolbar, the
load-error text (a failed load is otherwise a blank frame) and the "view gone" state. New channels of this design are
named `webviews.*` too (`webview.*` is host-api's namespace).

### 3.4 Who receives what

Frames and the cursor of a view go only to the browser views of the view's own project
window that are its viewers (`ViewRegistry.toView`, never `toAll`); the selection text (§4.2) and a `<select>` popup
(§4.4) only to the one view that acted, and only while it is still a viewer. The page's URL and title (`webviews.navigated`) go to the window's views as on the desktop. A browser view of another project, the
desktop page and the hidden page get nothing. Nothing of a frame is logged or kept past the view's life.

## 4. Input

### 4.1 Pointer, wheel, keys, cursor

The web shell draws the panel as a `<canvas>` (the frames) with a transparent input layer over it
(`.webview-canvas-area`, `data-webview` = the panel key). Pointer events (move, down, up, with the held buttons, click
count and modifiers), wheel and keys (`keydown`/`keyup`) go to main as `webviews.input` invokes (`{ panelKey, events }`,
at most 64 events per call, `adapted`) on the view's socket, **in the page's CSS px**: the browser undoes the letterbox
and the frame's scale (`boxToPage`), so main checks each point against the page's current size (`view.size()`) and does
no scaling of its own. A point off the page is dropped on its own (a stale frame after a resize must not lose a
release); anything malformed refuses the whole call. The browser's outbox sends once per animation frame, moves
coalesced and wheels summed; click counts are its own (`ClickCounter`: a PointerEvent's `detail` is 0); a blur releases
held keys, a pointercancel held buttons. Modifiers are Electron's lower-case names (`shift`, `control`, `alt`, `meta`,
`leftbuttondown`, ..., `isautorepeat`); held buttons travel on moves (without them a page's `buttons` reads 0); wheel
deltas are negated for Chromium. Main maps the events to `sendInputEvent` (`mouseMove`, `mouseDown`, `mouseUp`,
`mouseWheel`, `keyDown`, `keyUp`, `char`), accepts them only from a current viewer (`server && view.remote`, the panel
resolved through the caller's layout), allows 600 events per second per view (a token bucket; over-rate input is
dropped silently) and key names only from the fixed allow-list in `src/shared/webview-keys.ts`. A press, a key or text
makes the sender the size owner. The page's cursor (`cursor-changed`) goes to the viewers as `webviews.cursor` (a name
from a fixed map) and is the input layer's CSS `cursor`.

Shell shortcuts keep working: a key that is one of the window's command chords (`commandForEvent`), or an event the
window's capture handler already prevented, goes to the shell, not the page. Everything else goes to the page while
the input layer has focus.

### 4.2 Text input, IME, clipboard

- **Text** is split between two paths (Task 8's decision, so a page gets the events a real keyboard gives). A plain
  printable ASCII key or Space with no Ctrl, Meta or Alt goes as a key down plus its `char` (and is prevented in the
  browser, so the textarea never sees it): keydown, keypress, input and keyup reach the page, letter shortcuts and
  games work, and a page that prevents a keydown (a `/` shortcut focusing a search box) still suppresses the
  character, which a separate insertText could not. A hidden `<textarea>` in the input layer takes the rest, which the
  browser's IME and dead keys already understand: committed text (`input` insertText/insertReplacementText when not
  composing, and `compositionend`) of IME and dead-key compositions, non-ASCII characters and AltGr text goes to main
  as one `webviews.insertText` (`{ panelKey, text }`, at most 64 KiB of UTF-8, the same gate and rate bucket as input;
  control characters other than tab and newline stripped), delivered with `webContents.insertText`. No character goes
  both ways. Enter is a key with `'\r'` as its char; Tab, Backspace, Delete, arrows, Escape, F-keys and chords are keys
  with no char. v1 shows no composition preview inside the page (the browser's own IME window shows it, where the
  textarea sits under the pointer).
- **Paste.** A `paste` event on the textarea (Ctrl/Cmd+V while the panel has focus) gives the text without any
  clipboard permission; it is prevented and goes to the page as `insertText`, cut into chunks of 16 Ki units (never
  inside a surrogate pair, at most 64 calls). Images and files are not pasted (v1).
- **Copy.** The browser's `copy` event needs the text synchronously, and the page's selection lives on the server. So
  main pushes the page's selection text (`webviews.selection`, to the acting view only) after any input that can
  change it (a mouse up or key down that went to the page, or inserted text), debounced 100 ms, latest wins,
  deduplicated, read from an isolated world (`executeJavaScriptInIsolatedWorld`, world id **1717**, `WEBVIEW_WORLD_ID`:
  not 0, the main world, nor 999, Electron's own contextIsolation world; one read in flight per view and panel):
  `getSelection()`, or for a focused text `<input>`/`<textarea>` its selected value slice (never a password field).
  The script slices before returning, main caps the text near 256 KB of encoded bytes and strips control characters (a
  selection of control characters, JSON-escaped, could otherwise exceed the socket's frame limit and close the browser
  view, terminals included). The browser keeps the latest and sets it in its `copy` event, only when it is non-empty
  (else the person's clipboard is untouched). Cut is that copy plus a Delete key. `navigator.clipboard` is not used: it
  needs a secure context, and plain-http server mode on a LAN address is not one.
- **Clipboard chords are never forwarded** (Ctrl/Cmd+C, X, V, Ctrl+Insert, Shift+Insert, Shift+Delete): the headless
  clipboard is presumably one per process (not verified), so a forwarded copy in project A's page could be pasted into
  project B's, and a forwarded paste would double the browser's own `paste`. They are not prevented either, so the
  browser's own `copy`/`cut`/`paste` still fire on the textarea.

### 4.3 What the page cannot reach

The page runs on the server with the server user's network reach, as the desktop's view runs with the desktop user's:
nothing new (a signed-in device already has a terminal on the server). It has no bridge to main, as today. It never
runs in the person's browser and gets nothing from it but input events, pasted text and its own size. Its JS dialogs
are disabled (`disableDialogs`, §2): `alert` is silent, `confirm` is false, `prompt` throws. `window.open` keeps the
manager's rule and in server mode becomes a link notice in the browser (design-web.md §6.1, §9.9), as today for every
link main opens. A file chooser opens nothing (§2); a later version may relay a file from the browser.

### 4.4 `<select>` popups

The off-screen view does not paint a `<select>`'s popup (§2). v1 (plan review): before forwarding a `mouseDown`, main
hit-tests the point in an isolated world (`executeJavaScriptInIsolatedWorld`, invisible to the page's scripts). When
it is a `<select>`, main does not forward the click; it reads the select's options (labels capped, at most 500) and
rectangle from that same call's result and sends them to the browser view that clicked, which draws its own dropdown
over the canvas; the choice comes back and the isolated world sets the value and fires `input` and `change`. No
channel from the page to main is needed, so there is nothing to forge. Should hit-testing prove unreliable, v1 ships
keyboard-only selects (focus, arrows, Enter) with a note in the docs.

Implemented (Task 9, `main/webview/select-hit.ts`): hit-testing held up in the e2e, so no keyboard-only fallback. The
script runs in the same isolated world 1717 as the selection read (§4.2). A left press held for the hit-test, and
everything after it (later `webviews.input` calls and `webviews.insertText`, so an 'é' typed right after a click is not
inserted before the click focused the field) queues behind it in order; the answer, a rejection or a 50 ms timer
decides, whichever is first, and a late answer is ignored. A slow or failed hit-test lets the press go as a plain
click. On a select the press and its release are dropped, moves meanwhile lose `leftbuttondown`, and `webviews.select`
(`{ panelKey, id, options, selected, rect }`, options at most 500 with labels capped at 200, rect in page CSS px) goes
to the clicking view only; the id is main's (one per view and panel, taken once) and the answer is
`webviews.selectChoose` (`{ panelKey, id, index | null }`; a stale, forged or another view's id is ignored). The
element is found again through a `WeakRef` kept under the id in the isolated world's globals. The browser draws a
`role="listbox"` dropdown (arrows, Home/End, type-ahead, Enter or Space, Escape). The page sees the select take the
focus and an untrusted `input` and `change`, not the mouse events of that click. Right and middle presses are never
held. Keyboard-only still: a select inside an iframe (`elementFromPoint` stops at the frame element; a cross-origin
frame's document is not ours to walk) or a closed shadow root, and listboxes (`multiple`, `size` > 1), which the page
paints and takes clicks on itself. Not tested: a real phone (touch on the dropdown), a page zoomed by its own CSS
`zoom`.

## 5. Limits

- Off-screen views: at most 4 per project window and 12 per app at once; a navigate past that is refused with a
  reason (`ccc browser open` prints it).
- Frame size: the owner's size clamped to 4096x4096 for layout, the encoded image capped at 1920x1080 (§3.3), a frame
  at most 1 MiB; frame rate 30 at most; an app-wide encode budget (20% of main's time).
- Input: at most 600 events per second per browser view (pointer moves are already coalesced; over-rate input is
  dropped silently), at most 64 events per call; `insertText` at most 64 KB per call. Input is accepted only from a browser view of the webview's
  own window that currently shows the panel, the key resolved through main's layout (never trusted from the payload).
  The size owner changes on a button press, a key or text, not on a pointer move.
- Selection text pushed: near 256 KB encoded, debounced, deduplicated (§4.2).

## 6. Docs, guide, skill

Done in plan Task 10 (2026-11-11):

- `design-web.md` §9.9: the Browser panel bullet points here; §0's "later" list drops the browser panel.
- `docs/features.md` "Server mode": the Browser panel works, how it feels (latency, letterboxing, selects, copy and
  paste), what does not work (uploads, downloads, sound, the page's dialogs).
- The browser skill and `ccc guide` drop "In server mode there is no panel"; the guide's `ctx.webview` text says a
  webview panel works in server mode, streamed, with the v1 limits.
- CLAUDE.md implementation patterns: the off-screen factory, `disableDialogs` required in server mode, binary frames
  server to browser only.

## 7. Testing

- Unit: the off-screen factory with Electron stubbed (hardening, `disableDialogs`, explicit size, stop/start
  painting); the frame scheduler (latest wins per view, the per-view budget, terminal priority, join gets a frame at
  once); the size owner; input validation and mapping; the binary frame codec both ends; the selection push caps.
- e2e (server mode, `launchServer`, Electron's Chromium as the browser): `ccc browser open` a local file shows
  painted pixels in the browser's canvas; a click in the canvas changes the page; typing and paste reach an input;
  wheel scrolls; a page calling `alert()` leaves main alive; a second browser sees the same page letterboxed; a closed
  panel stops frames.
- `scripts/server-mode-smoke.mjs` gets a step that opens the Browser panel off-screen and checks main survives.

## 8. Open questions

1. `<select>` popups: hit-testing reliability (§4.4) — settled: it held up (4 of 4 repeated e2e runs).
2. HiDPI: render at the owner's device pixel ratio (larger frames, more bandwidth) or keep scale 1 (§3.2).
3. Tiles from the dirty rectangle instead of full frames: measure first; full frames may be good enough on a LAN.
4. Should a URL overlay (`ccc overlay --url`) reuse this in server mode (v2), and the desktop with web access stream
   its native views to browsers (today a placeholder)?
