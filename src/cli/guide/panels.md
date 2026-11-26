# Panels and the panel SDK

A panel contribution (`contributes.panels`) gives `id`, `title`, `entry` (the html page),
optional `icon` and `defaultZone` (`left`, `right` or `bottom`). The user can move it between
zones and reorder it inside one (menu items or dragging its icon); the order is saved per project.
With `"kind": "webview"` the panel is a web view instead and has no `entry`: see
`ccc guide webview`.

The `icon` (a path in the plugin folder) is an SVG or PNG used as a single-colour mask: only its
shape and alpha count, colours in the file are ignored, and the strip paints it in its own text
colour (so it follows the theme, hover and open states). Recommended: an SVG with
`viewBox="0 0 24 24"`, drawn at the strip's icon size (18px). Without an icon, or when it fails to
load, the strip shows the title's first letter.

## The page

- Served from the plugin's own folder as `cc-plugin://<pluginId>/<entry>` in a sandboxed frame.
- CSP (sent with the page): scripts, fonts and `fetch`/XHR only from the plugin's own files;
  images from its own files and `data:`; styles from its own files and **inline**, so a `<style>`
  block and `style="..."` attributes work; no inline script, no inline event handlers, no network,
  no frames, no form posts, no `<base>`. Put code in a separate `.js` file next to the html.
  Module scripts work: `<script type="module" src="main.js">` with static `import` and dynamic
  `import('./x.js')` of your own files (and top-level `await`), so split code into ES modules
  without a bundler; an import from another host or a bare package name (`import 'lodash'`)
  fails (no import maps: they would be inline script). The frame is sandboxed with scripts
  (an overlay's also with popups, which the app always denies as windows: open a link with
  `ctx.openExternal`): its origin is opaque, so no `localStorage` or cookies; keep state in the host.
- A panel or overlay page cannot submit a `<form>`: the frame is sandboxed without
  `allow-forms`, so its `submit` event never fires (Enter in a field included). Use buttons
  (`type="button"`) and act on their `click`.
- Include the SDK first: `<script src="../__sdk/panel.js"></script>` (from a page in a folder such as `panels/`; a page at
  the plugin's root says `./__sdk/panel.js`). It defines `ccPanel` and gives the page the app's component stylesheet
  (buttons, inputs, rows, cards, ...): see `ccc guide style`.
- Use URLs relative to the page for everything it loads (`../dist/lib/view.js`, `main.js`, `url(../icons/x.png)`), never
  root-absolute ones (`/dist/x.js`). The same page is also served over web access (the person's phone or another
  browser) under a path prefix, where `/x` is the server's root, not your plugin's: the server rewrites only
  `src` and `href` in HTML, and a URL in `srcset`, `poster`, `<form action>`, CSS or a script string breaks. `ccc plugin
  link` and the marketplace check warn about root-absolute URLs.

- With web access a panel can be open in a browser as well as the desktop, one page per view. What a browser view cannot
  do: `WebContentsView` features (`ctx.webview`, url overlays) show "available on the desktop" for a project open on a desktop, and `ctx.files.reveal` /
  `openWithSystem` are refused. In server mode `ctx.webview` panels are streamed to the browser (`ccc guide webview`);
  url overlays and `reveal` / `openWithSystem` are refused for every caller (see `ccc guide api`). A page knows it is in a browser view from `ccPanel.view.remote` (below) and can hide
  such items. See `ccc guide api` (`ctx.panels.post` `{ view }`).

## `ccPanel`

- `ccPanel.post(message)`: send JSON (at most 1 MiB) to the plugin host, where
  `ctx.panels.onMessage(panelId, fn)` hears it. Messages posted before the connection is up are
  queued. A top-level `$cc` key is the app's and throws.
- `ccPanel.onMessage(listener)`: hear what the host sends with `ctx.panels.post`. Returns an
  unsubscribe function.
- `ccPanel.onConnect(listener)`: runs each time the page gets a new connection to your host after it was added
  (add it at script start to hear the first one too). A panel, slot or overlay gets one per load; a page tab
  (`ccPanel.tab`) gets another after a host restart, a browser view's reconnect or a resync of a slow browser's
  link, without loading again. Messages on the old connection may be lost and your host starts over, so re-send
  what the page holds there. Posts queued before the first connection go out before it runs. Returns an
  unsubscribe function.
- Keys: on the desktop the app's own chords (Cmd/Ctrl/Alt chords of the key table, never Escape or the overlay
  keys) typed in a panel or slot page run the app's command and never reach the page, as in a webview panel; the
  command acts on the active tab and the shell takes the keyboard. Other keys, and chords the table lacks, are the
  page's. In a browser view or a remote window the shell lists the chords to the page and runs one the page forwards, only while that frame holds the keyboard and the person just gave input.
- `ccPanel.theme.current`: the theme the page's screen shows `{ kind, vars }` (with no theme picked,
  a browser's own light or dark, not the desktop's); the CSS variables are
  already set on `:root` (and `color-scheme` is `kind`), so style with `var(--...)`.
  `ccPanel.theme.onChange(listener)` fires on every change. The shell sends the theme in a
  message after the page loads, so the first paint can come before it.
- `ccPanel.slot`: only when the page is drawn as a slot (`contributes.slots`): `{ type,
  setHeight(px), setWidth(px) }`. `setHeight` asks the app for a frame height (rounded, 24-600 px,
  then within the slot's `[minHeight, placement height]`); without it the frame has the placement's
  height. `setWidth` is for a slot in the app's top bar (`sessions-strip`, `usage-meter`) and ignored elsewhere:
  the frame takes that width (rounded, 0-4096 px, then capped by the app so part of the bar is
  always left to drag the window on macOS); without it the frame takes the whole cap, so report
  the width of what you draw (0 when it is empty) from a `ResizeObserver` on an element sized to
  its content (`width: max-content`), never on the page's body, which only echoes the frame.
  `undefined` in a panel or an overlay. It appears once the app has said what the page is, so
  read it after load, not at script start.
- `ccPanel.tab`: only when the page is drawn as a page tab (`contributes.tabs`, `ccc guide plugins`):
  `{ type, setDirty(dirty), discuss() }`; its backend is `ctx.tabs.onOpen` (`ccc guide api`).
  `undefined` anywhere else; like `ccPanel.slot`, read it after load. A page tab's frame is mounted on the tab's
  first select, a few recently used ones are kept alive, and it is never reloaded to reconnect, so it keeps
  unsaved text: when your host restarts, a browser view reconnects or the link to a slow browser falls behind, the
  app hands the page a new connection instead (`ccPanel.onConnect`). A frame that left the kept set, or a tab not
  selected since the start, loads afresh when it is selected.
- `ccPanel.tab.setDirty(dirty)`: say whether the page holds unsaved changes (a boolean; sent on a change only).
  The app keeps it per view (the desktop and each browser have their own page): the tab shows a dirty dot while
  any view says so, a dirty frame is never dropped from the kept set, and closing the tab, its window or the app
  asks the person first. It is only a report: the page cannot stop or delay a close.
- `ccPanel.tab.discuss()`: Ask Claude from this tab (bind it to a key your manifest `keys` declare, such as
  Ctrl+L, or a context menu item). The app draws its own question box over the tab, then asks your host's
  `tab.onDiscuss` for the context of this view (`ccc guide api`, `ctx.tabs`) and sends it with the question to
  the Claude tab the person picks. Taken only while the tab is on screen and its page has the keyboard. The box
  sends only on the person's deliberate act: Send and Ctrl/Cmd+Enter work after it has been up for about a
  second, and a cancelled box does not reopen for the tab for two seconds.
- `ccPanel.view.remote`: `true` when the page is drawn in a web access browser view (the person's
  phone or another browser), `false` on the desktop. The app's shell that mounts the page says so with
  the page's connection, so it is `false` until then: read it once the host's first message has come,
  or on a click, not at script start. Neither the page nor your host can set it. Use it to hide
  what cannot work there, such as a "Reveal in Finder" or "Open with default app" item. It is a UI
  hint only, never a security check: main refuses `ctx.files.reveal` / `openWithSystem` from a
  browser view whatever the page shows.
- `ccPanel.view.access`: who is behind this view, `'owner'` or a guest the owner invited, `'read'` or `'write'`
  (`'owner'` until the page is connected and on the desktop). Use it to leave out what a read-only guest may
  not use (Rename, Delete, Save). Like `view.remote` it is a UI hint only: your host gets the access from the
  app (`from.access`, `ccc guide plugins` "Guests") and must refuse there, whatever the page shows.
- `ccPanel.upload`: put files from the person's device into the project. Only in a web access browser view
  (`ccPanel.view.remote`) that is not a read guest's, and only once the page is connected: `undefined` on the
  desktop, for a read guest and before then, so test for it when you draw the item or on the click
  (`typeof ccPanel.upload?.pick === 'function'`). Only a panel page's request is taken; the app ignores one from
  an html overlay, a slot or a page tab. Both members return nothing: the app shows the outcome itself (its
  clash dialog with Replace / Keep both / Cancel, a progress notice with Cancel, the result), and the files
  show up in the folder once they are written. The app checks the folder, every name and the viewer's access
  itself; a page cannot widen any of it.
  - `ccPanel.upload.pick({ folder })`: opens the device's file chooser (several files) and uploads what the
    person picks into `folder` (project-relative, `''` the project folder). Call it inside a click or key
    handler: a browser opens a chooser only on the person's gesture.
  - `ccPanel.upload.files(source, { folder })`: uploads a drop's `DataTransfer` or a `FileList` / `File[]`
    into `folder`. Pass `event.dataTransfer` inside the `drop` handler: after the event its items are gone,
    and only during it can a dropped folder be told from a file. Folders are not uploaded; the app names
    the ones it skipped. Take a drag only when `event.dataTransfer.types` includes `Files` (call
    `preventDefault` on its `dragover` and `drop`). The SDK cancels every other `Files` drag over the page, so
    a drop that misses your target does nothing (a plain browser would open the file in place of the app). The cancel
    skips a file input, a text field and a contenteditable (they take a drop themselves). It runs before your own
    window-level listeners, so in a web access browser view (`ccPanel.view.remote`) a handler on `window` must also
    set `event.dataTransfer.dropEffect = 'copy'`.
    `ccPanel.upload` exists in a panel only, not in a slot or a page tab.
- `ccPanel.ready()`: in an html overlay opened with `ready: 'manual'`, says the page has drawn
  its content, so the app's loader over it goes (without `ready: 'manual'` the loader goes when the
  page has loaded). Harmless in a panel or a slot.
- The SDK also gives the page edges-only scrolling, as the app has: no scrollbar at rest, the
  content of a scroll container fading out over its top 24px while content is hidden above and over
  its bottom 24px while content is hidden below, and the bar (thin, `--cc-fg` tinted, its strip
  always reserved so rows never move) while the element scrolls and for about a second after, or
  while the pointer is within 24px of its right edge. The SDK marks scroll containers (computed
  `overflow` `auto` or `scroll`) with `data-cc-scroller` and drives the fade with two scroll-driven
  animations (`cc-edge-top`, `cc-edge-bottom`) and a `mask-image` on the element, set only while
  an edge is hidden; a page that listens for `animationstart` / `animationend` on a scroller or its
  ancestors should check `event.animationName`. A mask clips everything inside the element to its
  box, `position: fixed` children too, so a scroller holding an open `.cc-menu`, `role="menu"` or
  non-modal `<dialog open>` drops its fade while that is open; any other fixed popup belongs on
  `body` or in the top layer (`popover`), not inside a scroller. It also clips a scroller's own drop shadow and fades its border at a hidden edge, so a
  scroller that is itself a popup or a bordered box should set `mask-image: none` (`.cc-menu` does). When the page's own document scrolls, a veil in the page's background colour (or
  `--cc-bg` when the page has none) covers the edges instead. Every rule is in the layer
  `cc.scroll` at zero specificity, so your own `mask-image` (`none` drops the fade), `animation` or
  `scrollbar-*` rule on an element wins. On macOS the bar rule applies only while the page measures
  classic bars (a mouse connected and "Show scroll bars" on Automatic, or Always); overlay bars stay
  the system's.

## Theme variables

Every variable below is set on a panel's `:root`, in light and dark and in any theme, since a
theme a plugin contributes is laid over the built-in one of its `kind` and so never lacks a name.
A theme may also bring names of its own, which panels get too.

- Surfaces: `--cc-bg` (window), `--cc-bg-bar`, `--cc-bg-menu`, `--cc-bg-banner`, `--cc-bg-error`
  (a tinted error background), `--cc-surface-1`, `--cc-surface-2`, `--cc-surface-3` (raised
  steps), `--cc-terminal-bg`.
- Text: `--cc-fg`, `--cc-fg-muted`, `--cc-fg-subtle` (the two weaker steps).
- Lines: `--cc-border`, `--cc-border-strong`.
- Accent: `--cc-accent`, `--cc-accent-hover`, `--cc-accent-fg` (text on an accent fill),
  `--cc-accent-soft` (a translucent tint), `--cc-focus` (focus ring).
- `--cc-shadow`: a shadow colour.
- Status, the colours the Claude tabs use: `--cc-status-starting`, `--cc-status-idle` (greys),
  `--cc-status-working` (blue), `--cc-status-needs-permission` (orange, a warning),
  `--cc-status-waiting` (green, ok), `--cc-status-ended` (red, an error).
- Project colours: `--cc-project-red`, `-orange`, `-yellow`, `-green`, `-teal`, `-blue`,
  `-purple`, `-grey` (each prefixed `--cc-project-`).
- Tab flag colours (`SessionInfo.flag.color`): `--cc-flag-red`, `-orange`, `-yellow`, `-green`,
  `-blue`, `-purple` (each prefixed `--cc-flag-`).

A page tab (`ccPanel.tab`) also gets the terminal font the person picked (Settings › Appearance ›
Terminal), to draw code in: `--cc-terminal-font-size` (px) and `--cc-terminal-font-family`. The family
is left out when it is a font bundled with the app (a page cannot load those) or only generic names,
so use `var(--cc-terminal-font-family, var(--cc-font-mono))`.

There is no separate error or success token: use `--cc-status-ended` / `--cc-status-waiting` for
red and green text or dots, and `--cc-bg-error` behind an error message.

A panel has no API of its own: everything goes through its plugin host, which decides what the
page may do. Fetch data in the host (`ctx.exec`, network) and post the result.

## Overlay pages

An html overlay (`ctx.overlay.open({ kind: 'html', file })`) is a plugin page loaded the same way.
It answers with `ccPanel.post({ result: value })`, which closes the overlay and resolves `open`
with `{ kind: 'value', value }`.

Opened with `ctx.overlay.start(spec)` instead, the page and the plugin also talk while it is open:
`ccPanel.post(message)` without a `result` key leaves the overlay open and reaches the handle's
`onMessage`; `ccPanel.onMessage(fn)` hears the handle's `post` (sent once the page has loaded). A
message is at most 1,040,384 chars of JSON (1 MiB less 8 KiB); a larger page message is dropped
with a console warning. Only the plugin that opened the overlay hears its page. Esc (or ✕,
Cmd+Shift+W) closes the overlay as `{ kind: 'dismissed' }` without asking the page: a page with a
draft should post it as it changes, so nothing is lost when the user presses Esc.

An overlay opened with `notes: { key }` (a `perView` plugin, `api` topic) gives its page more, on each view's copy;
each is undefined on an older app, in a panel, slot or page tab, and on an overlay without `notes`, so check first.
Check in `ccPanel.onConnect(fn)`, not at script start: the app tells a copy what it has just before the page connects,
so when your script runs they are still undefined on every app:

- `ccPanel.notes`: `{ list(), add({ quote, anchor?, text }), change(id, { text }), remove(id), setGlobal(text),
  onChange(fn) }`, the same notes as the host's `ctx.notes(key)`. `list()` resolves `{ global, notes, rev }`;
  `onChange(fn)` gets that state after every write in any view. `anchor` is yours (where the note sits, at most
  2,048 characters of JSON). A read guest's writes reject. The note for Claude is `global`.
- `ccPanel.ask`: `{ start({ question, quote? }), say({ question, quote? }), close(), pick({ model?, effort? }),
  continue(), on(type, fn) }`, a chat with Claude about the document your host's `handle.onAsk` gives.
  `on(type, fn)` hears one kind of push, `type` one of `history` (the stored turns, on connect), `state` (`{ phase,
  notice? }`: `notice` is a line to show while the chat runs, such as the owner's Ask in a folder Claude Code has not
  trusted answering from the document only), `delta`
  (answer text as it comes, `{ text }`), `tool`, `answer` (`{ text }`) and `end`; another type throws. `pick` with nothing reads the model and effort lists and the pick; per field, a name sets it, `null` goes back to the default and a field left out keeps its value; the owner's pick is remembered.
  `continue()` (the owner's; a guest's `ccPanel.ask` has none) opens the same session in a Claude tab. Undefined for a read guest. Render answers
  as text or sanitized Markdown, never as raw HTML, and never post or send an answer without the person's click.
- `ccPanel.overlay.discuss()`: open the toolbar's Discuss with Claude popover from your own button (New session, or
  a Claude tab); the person sends from there. Nothing is sent by the call itself. There for any view that may write,
  also before your host's `handle.onDiscuss` (it may come after an await): until then the call rejects.

Each call rejects after 30 s without an answer and past 50 outstanding.

```js
// page: set up once connected (each member undefined where the app or the overlay lacks it)
ccPanel.onConnect(() => {
  if (ccPanel.notes) ccPanel.notes.onChange(drawNotes)
  if (ccPanel.ask) ccPanel.ask.on('delta', (d) => (answer.textContent += d.text))
  if (ccPanel.overlay && ccPanel.overlay.discuss) discussButton.hidden = false
})
```

```js
// host
const chat = ctx.overlay.start({ kind: 'html', file: 'chat.html', title: 'Chat' })
chat.post({ history })                       // queued until the page has loaded
chat.onMessage((m) => saveDraft(m.draft))    // the page posts { draft } on every change
const result = await chat.result             // { kind: 'value', value } or { kind: 'dismissed' }
// page
ccPanel.onMessage((m) => render(m.history))
input.addEventListener('input', () => ccPanel.post({ draft: input.value }))
send.addEventListener('click', () => ccPanel.post({ result: input.value }))
```

## Badges

`ctx.badge(panelId, n | 'dot' | null)` shows a count or a dot on the panel's icon.

## Header

`ctx.panels.header(panelId, { meta?, actions? } | null)` fills the title bar of one of your own
panels (html or webview). `meta` is muted plain text after the title, at most 120 characters, cut
with an ellipsis when the panel is narrow (the whole text is its tooltip): "3 open", "synced 2 min
ago". `actions` is up to 3 icon buttons before the panel's "…" menu, each
`{ id, icon, title, busy?, disabled? }`: `id` is 1 to 40 of `A-Z a-z 0-9 . _ -`, unique; `title`
(at most 80) is the tooltip and the accessible name; `icon` is one of the app's own icons
(`refresh`, `add`, `search`, `filter`, `settings`, `open-external`, `check`, `sort`) or a path to
an `.svg` in your plugin folder, drawn in the header's colour like a panel icon. Every call
replaces the whole header; `null` clears it. Over a limit or for an undeclared panel it throws a
TypeError; all text is shown as text, never HTML. The header is cleared when the plugin stops or
reloads, so set it again in `activate`.

Do not add a `settings` action for your settings: the app draws a gear in the header of every panel
whose plugin has settings (a schema or a settings page), after your actions and before "…". It opens
Settings > This Project at your plugin when it has project settings, else its global page under
Plugins. A panel does not draw settings forms of its own either: every setting lives in Settings.

`ctx.panels.onAction(panelId, (actionId) => …)` hears the clicks and returns a disposer. A `busy`
action spins and takes no clicks, a `disabled` one is greyed out; neither reaches `onAction`.

```js
const header = (busy) =>
  ctx.panels.header('board', {
    meta: `${items.length} open`,
    actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh', busy }]
  })
ctx.panels.onAction('board', async (id) => {
  if (id !== 'refresh') return
  header(true)
  try { await load() } finally { header(false) }
})
```

## Slots

A slot is a place where another plugin draws its page. Two roles, both in the manifest.

Host (your panel places it): list the types in the panel, `"slots": ["agenda"]` (at most 4), then
`ctx.panels.slots('main', [{ type: 'agenda', position: 'top', height: 90, params: { day: 'mon' } }])`.
The shell draws the provider's frame above (`top`) or below (`bottom`) your own page, in your
panel's column, and no frame at all when no plugin of the project provides the type or the user
picked "None". You never get a handle on the frame; `params` (plain JSON, 4 KiB) go to the provider
only. `ctx.slots.available('agenda')` says whether a placement would draw now. A hidden panel
unmounts its frames.

Provider (you draw it): `"contributes": { "slots": [{ "type": "agenda", "entry": "slots/agenda.html",
"title": "Agenda", "minHeight": 48, "maxHeight": 320 }] }` (the manifest needs `main`). Hear a frame
in the host with `ctx.slots.onOpen('agenda', (slot) => …)`: `slot.params`, `slot.host`,
`slot.post(message)`, `slot.onMessage(fn)`, `slot.onClose(fn)`. The page is a normal panel page
(SDK, theme, `ccPanel.post` / `onMessage`) talking only to your host; `ccPanel.slot.setHeight(px)`
sizes it within `[minHeight, placement height]`, and in the top bar `ccPanel.slot.setWidth(px)` sets its width. A slot page is untrusted by your host as any
panel page is, and `params` are untrusted by the provider.

```js
// provider host
ctx.slots.onOpen('agenda', (slot) => {
  slot.onMessage((m) => { if (m === 'ready') slot.post({ events: todaysEvents(slot.params) }) })
})
```
