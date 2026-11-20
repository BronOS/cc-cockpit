# Web views in a browser: rendered on the server, streamed — design

Status: implemented (2026-11-11), plan `docs/plans/completed/20261111-streamed-webviews.md`; where the build differs from the first
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
  | `window.print()` | returns at once | the portal's Print dialog on the host's desktop; the page's renderer blocked until answered (only destroy frees it) | off-screen: `print` locked to a no-op and `execCommand('print')` refused in every new document, cross-site frames included (DevTools protocol, a session per frame) |
  | `<input type=file>` click, `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` | nothing / AbortError | the portal's file chooser on the host's desktop; the promise pending | off-screen: `Page.setInterceptFileChooserDialog {cancel}` (AbortError), on every cross-site frame's session too |
  | `<input type=color>`, date, datetime-local, time, month | survives, nothing painted | same | none |
  | HTTP basic auth (page or sub-resource) | cancelled by Electron's default, 401 body shown | same | `login` → cancel, explicit (both adapters) |
  | Self-signed certificate | load fails, ERR_CERT_AUTHORITY_INVALID | same | `certificate-error` → reject, explicit (both adapters) |
  | A server asking for a TLS client certificate | Electron's default: the first certificate in the person's store, no prompt | same | `select-client-certificate` → none, on the page (both adapters) and app-wide (`security/client-certificates.ts`) |
  | `mailto:` in a sub-frame (and the top frame) | `will-frame-navigate` refused; `openExternal` asked | same | existing: the manager's rule and the session lock-down |
  | Drag (element, text, image, onto a drop zone) | survives | same | none |
  | Right-click | `context-menu` fires, no menu | same | none |
  | `beforeunload`, then a navigate or reload | silently cancelled (ERR_ABORTED) without the handler | same | existing: `will-prevent-unload` → proceed |

  The desktop keeps its file choosers, print and page dialogs; only the `login` and `certificate-error` pins are
  shared, and they match what Electron did before. A cross-site (out-of-process) sub-frame is not reached by the
  page's own protocol session: before the fix (security review, 2026-11-19, `scripts/offscreen-frames-check.mjs` on a
  Mac) its `print()` was the native one and the frame stopped answering at it, a cross-site frame's file chooser
  stayed pending, and the top frame stopped answering at `execCommand('print')`, which never reads `window.print`. Now
  `Target.setAutoAttach {waitForDebuggerOnStart, flatten}` pauses each new frame target at any depth, its own session
  gets the same cancels (and the auto-attach for its children), then `Runtime.runIfWaitingForDebugger`, sent whatever
  the rest did; worker targets (dedicated and service workers, also auto-attached paused) are only resumed. The File
  System Access pickers are refused in a cross-origin sub-frame by Chromium itself (SecurityError). Not yet run
  against a real desktop portal on Linux. Killing a blocked renderer on `unresponsive` did not free it in the spike,
  so there is no watchdog.

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
- **Frame budget** (`frame-budget.ts`, backlog item `offscreen-frame-area-cap`, closed). The encode budget above caps
  encoding, but a page's paints cost main before that (the compositor's readback), so many big animating pages still
  starved it. Main sums width x height x 30 fps over the pages that have a viewer and painted at least 3 times in the
  last second; past `BUDGET_AREA_RATE` (250 Mpx/s) it sets one shared `setFrameRate` on those pages
  (`budget / summed area`, never under 5 fps, evaluated every 250 ms) and puts a page back to 30 when it stops
  animating, loses its viewer or closes. Decided in main only; the adapter just makes the call. Measured 2026-11-20 on the
  Debian VM (16 cores, Electron 45.1.0, `node scripts/web-terminal-bench.mjs 8 4 20 sweep`, the 8-tab flood beside N
  animated pages with a viewer each), main's p99 without the budget, at 1280x800 / 1920x1080: N=1 5.7 / 8.4 ms,
  N=4 6.2 / 9.9, N=8 6.7 / 12.4, N=12 7.5 / 36.5 (max 95 ms). The knee is between 500 and 750 Mpx/s; 250 Mpx/s is
  4 pages of 1920x1080 at 30 fps. With it, 12 pages at 1920x1080 run at 12 fps and the bench's phase 8 measured p99 13.7 ms
  (limit 20; a 400 Mpx/s trial gave 17.2 ms, too little margin). A real browser and a busier host may differ: the
  constant is one line.
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
deltas are negated for Chromium. Main maps the events to Electron's input events (`mouseMove`, `mouseDown`, `mouseUp`,
`mouseWheel`, `keyDown`, `keyUp`, `char`), except the key down of an edit chord (Ctrl or Cmd alone with A, Z, Shift+Z,
or Ctrl+Y) or a Mac line key (Cmd alone with Left/Right, Up/Down, each with Shift too, and Cmd+Backspace;
`editCommandOf`), which carries its command (`selectAll`, `undo`, `redo`, `moveToLeftEndOfLine`, ...,
`deleteToBeginningOfLine`: AppKit's names for those keys): a key event alone runs none of them on a macOS server; the
page still sees the key down and can prevent it (plan 20261119-server-mode-mac, decision 7). The off-screen view sends
them all on the page's DevTools protocol through one router per page (`page-input.ts`), with `sendInputEvent` only as
the fallback when the protocol detached:

- **Keys, text and commands** go on the page's own session (`Input.dispatchKeyEvent` one for one with the key down,
  `char` and key up, `code` and Windows key code from the allow-list's table; `Input.insertText`): they follow focus into
  a cross-site iframe, which `sendInputEvent` keys never reach.
- **Pointer events** go to the session of the deepest cross-site (out-of-process) frame under the point, the point in
  that frame's own CSS px: neither `sendInputEvent` nor the page's session reaches such a frame of an off-screen page
  (the top document gets the event, its target the IFRAME element). The child sessions are the ones the hardening
  auto-attaches (§2); a frame takes input once resumed. Per level main asks the renderer what is under the point
  (`DOM.getNodeForLocation`, document px: the level's scroll added), whether it owns a child target
  (`DOM.describeNode`'s `frameId`), and its content box (`DOM.getBoxModel`, a viewport quad: transforms included), and
  maps the point through the quad and the frame's untransformed size. Clipping, overlays and `pointer-events` are the
  renderer's own hit test; a point on the owner's border or padding stays with the parent; a box that does not hold the
  point (a scroll read gone stale) is read once more, then the parent takes it. No cache: one hit test per event, none
  on a page without cross-site frames. After a press the frame that got it captures the moves and the release (a drag
  leaving the frame keeps selecting in it; one from the top document stays there over a frame), the owners' boxes read
  again on each event, until no button is held. Press records are the router's only press state: every road that
  delivers a key's or a button's down (the protocol to the page or a frame, or a detached road) makes one of where it
  went, one per key code and per button (a key down on a held code is a repeat that keeps it; a button down on a held
  button first sends the old press's release), every ending deletes it (its up, a refused down, its frame going, a new
  attachment), and the up goes there
  and nowhere else, exactly once: an up with no record (its down went nowhere: a new attachment, a full queue) is
  dropped, so no session gets a release it was not pressed for, and one whose frame went is dropped with it. A press
  a detached road took whose up comes once the protocol is back goes to the page's session. A move without a button still
  pressed, or a press of a button still pressed, means the viewer's release went missing: that release is sent then,
  to its press's session. When the pointer changes frame, the frame it left gets one move (over the owner, or outside
  its viewport) so its hover ends.
- **Order.** One queue per page, one step at a time, and at most one input command on its way per page across all
  its sessions: every `Input.*` (keys, texts, edit commands, pointer events, the hover moves and the lost releases)
  goes through one sender, which holds the rest of this contract too, and the step that sent it waits until it is answered or its 500 ms deadline passed before anything else
  goes (a key sent while a press into a frame was on its way landed in the old focus 15 times in 30; a press
  hit-tested while a move was on its way could pick a frame that move's hover covered). A pointer event does every
  wait first and its hit test last, right before its send; after hover moves it is hit-tested again, at most twice,
  then the page's session takes it at the top point. Keys go one at a time too: the page answers one in about
  0.15 ms. While a step waits, moves behind it coalesce to the latest and wheel deltas sum; presses, releases, keys
  and texts keep their order. A full queue (512) drops moves first, then lets in only an up that matches a live press
  record (matched by the physical key's `code`, so Shift+A down and `a` up match, or by the button), one per record:
  repeated ups for one held key never grow the queue. A refused key down drops its `char` too.
- **Stalled sessions.** A session whose command missed its deadline gets nothing more until every such command of it
  answered (a later command's answer never stands in for an earlier one's), so
  a renderer that answers nothing holds one unanswered command, never a pile; that command no longer counts toward
  the page's one on its way (a stalled frame holds itself, not the page). A move for a stalled frame is dropped, its
  press or wheel goes to the page's session at the top point. A release always goes where its press went: a frame
  that got a press and then stalled still gets the release, at once and in order (one per press, on its way like any
  command), never parked behind later input (a parked release let a later key go first); an edit command's key down is
  a press like any key. While the page's own session is stalled nothing at all goes, page-wide: keys, texts, commands,
  presses, releases and wheels wait in the queue in order (bounded by the cap; no hit test runs), moves
  are dropped, so a page busy for a second loses no key and no press lands in a frame before a key to the page was
  answered; its answer or a reset starts the queue again. A hit-test query that missed its 200 ms deadline stalls its
  session exactly as a late command does, and a stalled session is asked no query (one command or query outstanding
  per session). The detached road is a session too: a text, edit
  command or blocking call there that missed its deadline holds everything after it on that road, in order, until it
  settles or the renderer goes (`render-process-gone`, `destroyed`); the stall is the renderer's, so a reset drops what
  waits but keeps it, and at most one is outstanding across attachments; a deadline or answer the renderer that went
  owed changes nothing. The renderer going (`render-process-gone`, `destroyed`, or the main frame's `did-navigate`
  into another process) is a full reset as well: after a crash and a reload the old renderer's commands never answer
  and the debugger stays attached (Electron, 2026-11-19), so only that lets input reach the new page. A page that spins
  forever commits no reload and no same-site navigation (Chromium's own: the old renderer must run its unload first;
  a cross-site one commits into another process by itself), so the
  adapter watches main's own reload, load, back and forward (`hung-navigation.ts`): one not ended after 3 s while the
  page answers no probe within 2 s (main's isolated-world script, on the call road below) gets the renderer SIGKILLed
  (`renderer-kill.ts`: the pid read when the navigation started, only if still the page's) and goes again once it is
  gone, one kill per navigation, with an in-page notice to the window's browsers; that `render-process-gone` is not the
  manager's `gone`, so the view, its viewers and its history stay. SIGKILL, never `forcefullyCrashRenderer`: on a Linux
  host that pipes cores to systemd-coredump a crash sits in `do_exit` 40 s and more before `render-process-gone`, and a
  navigation sent meanwhile never commits (a SIGKILL ends even a dump in progress). A crash with no navigation after it
  still holds its input that long (backlog). The protocol's sends never wait on it. A call (a script run in the page, a select's hit test, a
  selection read; every isolated-world script main runs for the page goes this way) is one at a time too, attached or not: the next call waits for the one on its way, and past its
  deadline holds what follows it until it settles or the renderer goes (that stall is the renderer's too). A key down refused late still drops its `char`. Each attachment of the protocol has an epoch, bumped
  only by the reset its detach brings (which drops the queue and every press record), each step the epoch it was taken
  in, and each session its own lifetime. The one sender checks both synchronously right before it sends, so no wait
  inside a step can carry it across: a step of an older attachment sends nothing by any road, and a pointer event
  whose frame went goes to the page's session at the top point (never dropped, never to another frame; a hover move
  or a release for it goes nowhere). Every continuation (an answer, a refusal, a deadline, a hit test) of an older
  attachment or of a session that went changes nothing, requeues nothing and replays nothing, and the router keeps
  nothing of a session that went; a live frame refusing a hover move is logged and the event routed again. A live frame's session refusing (the frame went) sends the event to the
  page's session at the top point, never to another frame (a release is dropped instead; a press sent there owes its
  release there); a refusal from a frame that already went sends nothing anywhere. Whatever the page's own session
  refuses (a pointer event, key, text or edit command) is dropped and logged once (a text or command's caller hears the
  rejection), never run by another road, which could land in a later attachment or after the input behind it; a
  refused press records nothing (its release is dropped too) and a refused release clears its press. The
  detached roads go through the same sender and serve only a protocol detached when the step runs, in order (what follows a text, an edit command or
  a blocking call such as a select's choice waits for it, `STEP_TIMEOUT_MS` at most). A seeded randomized test
  (`page-input.fuzz.test.ts`, `FUZZ_SEEDS` for a long run) checks these rules on every send and at quiescence, with
  sessions that answer late, never or refuse, frames that detach, hover effects, the protocol lost (also between two
  microtasks of the router's continuations) and detached roads that answer late, each delivery checked against the
  attachment it lands in.

`scripts/offscreen-input-check.mjs` proves it under Electron (macOS, 2026-11-19): click, double click, typing, edit
chords, drag, a drag leaving the frame, wheel, hover cursor and hover leaving, in a cross-site iframe, one nested in it,
one at `scale(0.5)`, with the top page and the frame scrolled; a same-site frame, and a cross-site one inside a scrolled
same-site frame; a link dragged; Tab into the frame; the allow-listed keys the same as `sendInputEvent`'s; 50 rounds of
clicks and typing across four documents in order. A pointer event costs about one frame (16 ms) to be answered, the
same in the top document and in frames. One change from `sendInputEvent`: the protocol's wheel scrolls a small scroller
by the whole delta (a 120 px wheel moved a 60 px tall box by 120, `sendInputEvent`'s by 60, its height), as a trackpad
does; the page itself scrolls the same distance either way. A frame under a perspective transform (its box no
parallelogram within half a px of the frame's own, measured in the frame's px, not the screen's) is not routed into:
its parent takes the event. Not checked: Linux, a frame's scroll chaining to its parent, drag and drop between frames, a page zoomed
by its own CSS `zoom`.

It accepts them only from a current viewer (`server && view.remote`, the panel
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
  control characters other than tab and newline stripped), delivered as the page protocol's `Input.insertText` (an IME
  commit on the widget's input pipe; `webContents.insertText` only when the protocol detached). No character goes
  both ways.
- **Order.** Everything one browser view sends for one panel (pointer, wheel, keys, inserted text, select choices)
  reaches the page in the order the person produced it. The browser has one outbox per panel (`InputQueue`: events
  batched per animation frame, a move coalesced only with the move right before it; a text or a choice flushes the
  events before it), and main one lane per view and panel shared by `webviews.input`, `.insertText` and
  `.selectChoose` (the lane that also holds a press for its select hit-test, §4.4). A text or a choice is a call of
  its own into the page, so the lane holds what comes after it until its promise settles (at most 500 ms, so a hung
  page costs order, not input). `webContents.insertText` was not enough: it is an IPC to the renderer that a key sent
  just before or after it overtook (the e2e typed "héllo ü" as "hlélo ü" or "éhllo ü" about one run in ten, with
  main's calls in order), while `Input.insertText` is queued behind the keys already sent. Enter is a key with `'\r'` as its char; Tab, Backspace, Delete, arrows, Escape, F-keys and chords are keys
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
  browser's own `copy`/`cut`/`paste` still fire on the textarea. Main drops one that comes anyway (`WebviewInput.accept`,
  the same `isClipboardChord` in `shared/webview-keys.ts`): the browser's filter is a client's, not a check.

### 4.3 What the page cannot reach

The page runs on the server with the server user's network reach, as the desktop's view runs with the desktop user's:
nothing new (a signed-in device already has a terminal on the server). It has no bridge to main, as today. It never
runs in the person's browser and gets nothing from it but input events, pasted text and its own size. Its JS dialogs
are disabled (`disableDialogs`, §2): `alert` is silent, `confirm` is false, `prompt` throws. `window.open` keeps the
manager's rule and in server mode becomes a link notice in the browser (design-web.md §6.1, §9.9), as today for every
link main opens; marked as the page's own (`page: true`), it is only shown to click, never opened at once. A file chooser opens nothing (§2); a later version may relay a file from the browser.

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
held. Keyboard-only still: a select inside an iframe (`elementFromPoint` stops at the frame element; a cross-site
frame's document would need an isolated world per child session, `Page.createIsolatedWorld`, not done; the click
reaches the frame, whose popup then opens unpainted; whether the keyboard works it there was not checked) or a closed shadow root, and listboxes (`multiple`, `size` > 1), which the page
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
