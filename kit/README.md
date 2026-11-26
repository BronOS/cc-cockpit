# cc-cockpit overlay kit

Optional components for a plugin's own overlay page (shared/design.md §2): a sanitizing renderer, a selection menu,
notes, the note for Claude, an Ask chat, side tabs, an Original frame, a Discuss button and an error state, plus a host
helper that keeps one overlay's state and replays it to every view's copy. The kit is plugin code once it is in your
page: it has no privilege, and no check of the app rests on it. A page that does not load it builds on the same
`ccPanel` calls (`ccc guide panels`).

**Vendored, never served by the app.** Copy a pinned version into your plugin and keep the bytes as they are:

| File | What |
|---|---|
| `dist/cc-kit.js` | the page side, a classic script (IIFE) defining the global `ccKit` |
| `dist/cc-kit.css` | its styles, on the app theme's CSS variables |
| `host/shared-page.js` | the host side, CommonJS: `require('./kit/host/shared-page.js')` |
| `VERSION` | the kit's version |
| `SHA256SUMS` | `sha256sum -c` format over the three files above and `VERSION` |

Keep the layout (`kit/dist/`, `kit/host/`, `kit/VERSION`, `kit/SHA256SUMS` in your plugin), so
`cd kit && sha256sum -c SHA256SUMS` checks it. The demo, `test/fixtures/plugins/kit-demo`, uses every component.
A plugin's `test/kit-pin.test.js` hashes its copy against its `SHA256SUMS`. The master copy is cc-cockpit's `kit/`;
`npm run build:kit` rebuilds `dist/` and `SHA256SUMS`, and `test/unit/kit-build.test.ts` checks they match.

```html
<link rel="stylesheet" href="kit/dist/cc-kit.css" />
<script src="/__sdk/panel.js"></script>
<script src="kit/dist/cc-kit.js"></script>
<script src="page.js" defer></script>
```

## Rules every component keeps

- No `innerHTML` with document, answer or note text: text goes in with `createTextNode` or `textContent`, and a
  document's HTML goes through `sanitizeTree` and `render`.
- Nothing is sent, posted or opened without a person's click (or Enter in a field). That covers `ccPanel.post`,
  `ccPanel.ask.start`, `.say` and `.continue`, `ccPanel.overlay.discuss`, and `window.open`.
  Note writes are not sends. A note's Save is a click, and the note for Claude saves as it is typed, so Esc loses
  nothing.
- Links: the kit posts `{ type: 'cc-kit.link', url }` on a click. The host's `makePage` opens only an http(s) URL
  that is in what that copy was sent (its projected state, and the document when `set()` names one), with
  `{ view: from.view }`. A URL not found is not opened. Guests' clicks share a small budget (below). Links in an Ask
  answer are not clickable: they show their full URL as text.
- `ccPanel.notes` and `ccPanel.ask` are undefined on an older app, on an overlay without `notes`, and `ask` for
  a read guest. Each component that needs one draws nothing and returns `el: null` when it is missing.
- Every component takes `doc` (default `document`) and `panel` (default the global `ccPanel`), for tests.

## Types

```ts
type Access = 'owner' | 'write' | 'read'
/** What main pushes and `ccPanel.notes.list()` gives (sdk/types.ts NotesState, OverlayNote). */
interface NotesState { global: string; notes: OverlayNote[]; rev: number }
interface OverlayNote { id: string; quote: string; anchor: unknown; text: string; rev: number; author: NoteAuthor }
type NoteAuthor = { access: 'owner' | 'write'; person?: string } | { plugin: true }
/** A selection in a rendered document: offsets into its text, the quote and anchor for a note (`makeAnchor`). */
interface KitSelection { start: number; end: number; text: string; quote: string; anchor: KitAnchor }
interface KitAnchor { prefix: string; suffix: string; occurrence: number; length: number; at: number }
/** What `connect` tells the page about this copy. */
interface KitInit { access: Access; tab: string; features: KitFeatures }
interface KitFeatures { notes: boolean; ask: boolean; discuss: boolean }
interface Mounted { el: HTMLElement | null; destroy(): void }
```

## Page: `ccKit`

### Connection

```ts
ccKit.VERSION: string
ccKit.features(panel?: CcPanel): KitFeatures
ccKit.connect(handlers: {
  init?(info: KitInit): void          // once per connection, before the first state
  state?(state: unknown): void        // the plugin's state for this copy, as makePage's project() made it (chunks joined)
  loading?(): void                    // page.loading() on the host
  failed?(failure: { message: string; retry: boolean }): void
  message?(m: unknown): void          // every other message of the plugin's host (not cc-kit.*)
}, opts?: { panel?: CcPanel }): () => void   // returns the unsubscribe
ccKit.retry(panel?: CcPanel): void          // posts { type: 'cc-kit.retry' }; call it from a click only
ccKit.postLink(url: string, panel?: CcPanel): boolean  // posts { type: 'cc-kit.link', url } for an http(s) URL; false otherwise
```

### Renderer (copied from the Reviewer's sanitize.mjs)

```ts
ccKit.renderDocument(target: HTMLElement, input: { html: string } | { text: string }, opts?: {
  classes?: 'allow-list' | 'none'     // default 'allow-list': the Reviewer's classes (card, lozenge-*, facts, person, mail-*, ...)
  start?: 'top' | 'end'               // 'end' scrolls to the bottom once drawn (Chat: the newest message)
  assets?: Record<string, string> | ((id: string) => string | null)   // data: URLs of pictures named by data-asset / asset:<id>
  onLink?(url: string): void          // default ccKit.postLink; runs on a click of a link
  parse?(html: string): Node          // default a DOMParser 'text/html' parse (inert)
  doc?: Document; panel?: CcPanel
}): RenderedDocument

interface RenderedDocument {
  root: HTMLElement                   // the element the document is in (class cc-kit-doc; add "mail" for the mail layout)
  text(): string                      // the concatenated text of its text nodes (what anchors count in)
  selection(sel?: Selection): KitSelection | null   // the current selection, if it lies inside root
  rangeOf(start: number, end: number): Range | null
  setAsset(id: string, dataUrl: string): boolean   // a picture arrived (image data: URLs only)
  destroy(): void
}

ccKit.sanitizeTree(parent: Node, depth?: number): SanitizedNode[]
ccKit.render(tree: SanitizedNode[], doc: Document): DocumentFragment
ccKit.safeHref(raw: unknown): string | null     // http(s) or mailto, normalized; null for anything else
ccKit.assetRef(src: unknown, dataAsset: unknown): string | null
ccKit.isImageDataUrl(s: unknown): boolean
ccKit.ALLOWED_TAGS, ccKit.ALLOWED_CLASSES, ccKit.TAG_CLASSES, ccKit.MAIL_CLASSES   // Sets / Map, read-only use
```

### Anchors and notes in the document (anchor.mjs, note-ops.mjs)

```ts
ccKit.QUOTE_MAX: number; ccKit.CONTEXT: number; ccKit.TAIL_MAX: number
ccKit.makeAnchor(full: string, start: number, end: number): { quote: string; anchor: KitAnchor }
ccKit.locate(full: string, note: { quote: string; anchor: unknown }): { start: number; end: number } | null
ccKit.tailOf(text: string, kept: number): string
ccKit.upsertNote(notes: OverlayNote[], note: OverlayNote): 'added' | 'changed' | null
ccKit.removeNote(notes: OverlayNote[], id: string): boolean
ccKit.markNotes(doc: RenderedDocument, notes: OverlayNote[]): Map<string, { start: number; end: number } | null>
  // wraps each located note in mark.cc-kit-note[data-note=id] (old marks removed first; text nodes keep their text)
ccKit.focusNote(doc: RenderedDocument, id: string): boolean   // scrolls the note's mark into view and flashes it
```

### Components

```ts
ccKit.mountSelectionMenu(doc: RenderedDocument, opts: {
  actions: Array<{ id: string; label: string; run(sel: KitSelection): void }>   // e.g. Note, Ask about this
  doc?: Document
}): Mounted
  // A small menu above the selection inside doc.root (mouse and touch: follows selectionchange). An action runs on its click only.

ccKit.mountNotes(container: HTMLElement, opts: {
  canWrite: boolean                   // owner and write guests; a read guest's list has no edit, add or remove controls
  rendered?: RenderedDocument         // marks the notes in it and focuses one on a click of its quote
  onFocus?(note: OverlayNote): void
  doc?: Document; panel?: CcPanel     // uses panel.notes
}): Mounted & {
  compose(sel: KitSelection): void    // opens a new note for the selection; its Save click calls notes.add
  state(): NotesState | null
}
  // "Notes N", each "1. «quote» text — by guest Ann" with Edit / ✕; listens to notes.onChange; a refused write shows its error.

ccKit.authorLabel(author: NoteAuthor): string   // 'by the owner', 'by guest Ann', 'by a guest', 'added by the plugin'

ccKit.mountGlobalNote(container: HTMLElement, opts: {
  canWrite: boolean
  saveMs?: number                     // default 500: notes.setGlobal this long after the last keystroke (and on blur)
  doc?: Document; panel?: CcPanel
}): Mounted
  // "+ Note for Claude (optional)": folded while empty; a read guest sees the text only.

ccKit.mountAsk(container: HTMLElement, opts: {
  about?: string                      // the header line, e.g. 'About: whole ticket'
  canContinue: boolean                // shows "Continue in a tab" (pass init.access === 'owner' and the intro's ask)
  doc?: Document; panel?: CcPanel     // uses panel.ask
}): Mounted & {
  setQuote(text: string | null): void // "About this:" the selection, sent with the next question as `quote`
  focus(): void
}
  // Shows the pushed history, the answer as it streams (Markdown, no raw HTML), tool lines and errors; the model and
  // effort picks (ask.pick on change, both fields, null for a select on default: back to default needs an app with
  // the null pick, kit 0.1.4); Ask (click or Enter): ask.start when no chat runs, else ask.say, and off while a turn
  // runs (the question typed meanwhile waits in the box); Close (ask.close).

ccKit.renderMarkdown(text: string, doc?: Document): DocumentFragment   // an answer: allow-listed tags, text nodes only
ccKit.markdownTree(text: string): MarkdownNode                         // the editor's chat-markdown.mjs

ccKit.mountSideTabs(container: HTMLElement, opts: {
  tabs: Array<{ id: string; label: string; panel: HTMLElement }>   // ids /^[a-z][a-z0-9-]{0,39}$/, e.g. 'details', 'ask', 'reply'
  selected?: string                   // default the first tab; pass init.tab (D7) or 'reply' when a draft waits
  onSelect?(id: string, byUser: boolean): void
  doc?: Document; panel?: CcPanel
}): Mounted & { select(id: string): void; selected(): string }
  // A person's click posts { type: 'cc-kit.tab', tab } (makePage keeps the owner's last used tab). Under 700 px:
  // a bottom bar, a tab opens full height with "← Back".

ccKit.mountOriginal(container: HTMLElement, opts: {
  html: string                        // the document's own HTML and CSS (a designed mail)
  assets?: Record<string, string> | ((id: string) => string | null)
  title?: string                      // the frame's accessible title
  parse?(html: string): Node; doc?: Document
}): Mounted & {
  ok: boolean                         // false: over a limit, nothing drawn (show the renderer instead)
  frame: HTMLIFrameElement | null     // sandbox="allow-popups", srcdoc with ORIGINAL_CSP first
  links: Array<{ href: string; text: string }>
  setAsset(id: string, dataUrl: string): void   // rebuilds the frame when one of its pictures arrives
}
ccKit.originalDocument(root: Node, opts?: { asset?(id: string): string | null }):
  { html: string; links: Array<{ href: string; text: string }>; assets: Set<string> } | null
ccKit.FRAME_SANDBOX: string; ccKit.ORIGINAL_CSP: string; ccKit.MAX_FRAME_DOC: number

ccKit.mountDiscussButton(container: HTMLElement, opts?: { label?: string; doc?: Document; panel?: CcPanel }): Mounted
  // Calls panel.overlay.discuss() on its click (core's popover sends; the button sends nothing). el null when the
  // app or the overlay has no page-started Discuss.

ccKit.mountError(container: HTMLElement, opts: {
  message: string
  retry?: boolean                     // shows Try again, which posts { type: 'cc-kit.retry' } (or calls onRetry)
  onRetry?(): void
  doc?: Document; panel?: CcPanel
}): Mounted
```

## Host: `host/shared-page.js`

```ts
const { makePage, urlsIn, CHUNK_CHARS } = require('./kit/host/shared-page.js')

makePage(handle: OverlayHandle, opts: {
  ctx: PluginContext                  // ctx.openExternal for links, ctx.appStorage for the last used tab, ctx.log
  log?(text: string): void            // default ctx.log.warn
  project?(state: unknown, from: ViewFrom & { copy: string }): unknown   // what one copy gets; default the state as is.
                                      // Called per copy on every set() and connect: drop what a guest may not see.
  guestError?: string                 // a guest's text for a failure (default 'This could not be loaded.'); the owner gets the message
  tabs?: { ids: string[]; first?: string }   // the page's side tabs (default ['details', 'ask'], first 'ask')
  holderAccess?: 'owner' | 'write' | 'read'  // holder mode only (below): the one page's access (default 'read')
  now?(): number                      // the clock of the guests' link budget (default Date.now), for tests
}): SharedPage

interface SharedPage {
  set(state: unknown, opts?: { document?: string }): void
    // The overlay's state. Every live copy gets project(state, from) now, a later copy on its connect. A copy may open
    // the URLs in the strings of what it was sent; `document` (the text or HTML shown, which must be in the state too)
    // narrows that to the URLs it has. Absent: every URL in the strings of the copy's projected state.
  loading(): void
  fail(message: string, opts?: { retry?: () => void }): void   // Try again is the owner's; retry runs on its click
  post(copy: string, message: unknown): boolean   // one copy, never a broadcast; false when gone or refused
  each(message: unknown | ((copy: { copy: string; from: ViewFrom }) => unknown)): void
  copies(): Array<{ copy: string; from: ViewFrom & { copy: string } }>
  onMessage(fn: (m: unknown, from: ViewFrom & { copy: string }) => void): () => void   // the page's own messages (not cc-kit.*)
  dispose(): void
}

urlsIn(document: string): Set<string>   // the normalized http(s) URLs in a text or HTML string (&amp; decoded)
urlsOf(value: unknown): Set<string>     // urlsIn over every string of a value (a projected state), keys left out
GUEST_LINKS: number, LINK_WINDOW_MS: number   // guests' link budget: 1 per 10 s per plugin (below)
CHUNK_CHARS: number                     // a state message longer than this is sent in chunks (under the 1 MiB page cap)
```

Messages on the copy's port (the kit handles them, never yours):
- host → page: `{ type: 'cc-kit.init', access, tab }`, `{ type: 'cc-kit.state', state }`,
  `{ type: 'cc-kit.chunk', id, i, n, text }` (a state over `CHUNK_CHARS`, joined by `connect`), `{ type: 'cc-kit.loading' }`,
  `{ type: 'cc-kit.failed', message, retry }`.
- page → host: `{ type: 'cc-kit.link', url }`, `{ type: 'cc-kit.tab', tab }`, `{ type: 'cc-kit.retry' }`,
  `{ type: 'cc-kit.hello' }` (sent by `connect` on every load; only holder mode answers it).

`makePage` hears copies only through `onConnect` / `onDisconnect` (`from` filled by main) and acts by
`from.access`: it opens a link for any access (the link is in that copy's own document), writes the last used tab
only for the owner, and runs `retry` only for the owner. Guests' link opens are counted together, every guest copy
of every page of the plugin (one `ctx`): at most `GUEST_LINKS` (1) per `LINK_WINDOW_MS` (10 s). main allows a plugin
3 opens per 10 s in a window, whoever clicks, so a guest clicking in a loop would otherwise make the owner's clicks
fail; the owner keeps two of the three. The owner's clicks are not counted by the kit. In holder mode the holder's
access is what counts (default `'read'`, so an older app's one page has the guests' budget). Your `onAsk`, `onDiscuss` and writes stay yours.

Holder mode (kit 0.1.1): on an app before `overlays.perView` the handle has no `onConnect`, and `makePage` does not
throw: the overlay has one page (its holder) and one state. The copy is `'holder'` (`copies()`, `post('holder', m)`),
greeted when its page says hello (so a reload is greeted again), and its posts carry no copy. Its access is
`opts.holderAccess`, default `'read'` (such an app does not say who is looking, so fail closed: `project()` gets a
read `from`, no Try again, no tab written); a message whose `from` carries an access main filled counts as that
access. A plugin that knows its older app shows the overlay only to the owner may pass `holderAccess: 'owner'`.

Last used tab (D7): the owner starts on the tab last chosen on any owner view (`ctx.appStorage` key `cc-kit.tab`),
else `tabs.first`. A write guest starts on `ask`, a read guest on `details` (when those are in `tabs.ids`).
