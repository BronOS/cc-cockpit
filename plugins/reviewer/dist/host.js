'use strict'
// Reviewer for cc-cockpit: a diff of a changed file against the last commit, in a large overlay,
// where the person selects text to attach notes, writes one comment for the whole file, and hands
// the review to Claude with the app's Discuss with Claude (the overlay toolbar's button: the tab
// whose file was clicked is preselected, or a new session). The reviewer answers the button's
// onDiscuss with the review text; other plugins add their buttons by the overlay's type (a file
// review is `file { path }`, so the editor's "Edit" shows there).
//
// Entry points, all ending in showReview():
// - a click on a changed file in the Sessions panel (ctx.files.onOpen, `contributes.openFile`);
// - the `reviewer` service (v1): open(path, { tabId? }), for the file tree and other plugins, and
//   annotate({ title, text | html, aside?, assets?, url?, key?, tabId?, companion?, type? }): the same
//   overlay on a text or an HTML document another plugin hands over (a Jira issue, a mail), with no
//   diff and no file; `type` is the caller's overlay type, passed through (a mail thread as
//   `inbox-item`, so the caller's buttons show); with `companion`, a second HTML document beside the
//   main one (the Jira issue a mail is about); features() lists the optional annotate features
//   (FEATURES), so a caller can tell;
//   prepare({ key, title, type?, tabId? }) opens that overlay at once with a loader, for a caller that still fetches
//   what it shows (the annotate with the same key fills it), and cancel({ key }) closes one never filled;
//   fail({ key, message, retry? }) turns one never filled into an error page (Close, Try again);
//   for a mail (app 0.13.0): annotate's `kind: 'mail'` (the reading layout), `data-action` buttons in
//   the document whose clicks are the service event `action` { key, id, caller }, and update({ key,
//   assets?, hide?, status? }), which adds images to an open document without rendering it again;
//   annotate's `originals` [{ id, html }] and `view` (feature 'original'): the mail's own HTML and CSS
//   in sandboxed frames (the Original view), with an Original | Reader switch told as the event `view`;
// - `ccc review <path>`.
//
// Plain JavaScript host; only the overlay page (overlay/) is bundled, by `npm run build`.

const files = require('./lib/files')
const review = require('./lib/review')

const OVERLAY_FILE = 'overlay/review.html'
const LAYOUT_KEY = 'layout' // ctx.appStorage: the person's last diff layout, the same in every project
const LAYOUTS = ['split', 'unified']
// ctx.appStorage: the share of the width the main document takes beside a companion, the person's last
// drag of the divider (the page's src/page/split.mjs has the same bounds; a test compares them).
const SPLIT_KEY = 'companionSplit'
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8
const SPLIT_DEFAULT = 0.5
const splitOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX
// What features() answers: the optional parts of annotate this reviewer has, beyond its first
// version's { title, text | html, assets?, url?, key?, tabId? }. A caller asks before it relies on
// one, since an older reviewer ignores an option it does not know (a companion would just not be
// shown); an older reviewer has no features() at all, and the call rejects with "has no method".
// 'type': annotate and prepare take an overlay type (and the toolbar's Discuss replaced the page's).
// App 0.13.0, for a mail: 'mail' (annotate's `kind: 'mail'`, the mail reading layout), 'actions'
// (`<span data-action>` buttons in the document, a click emitted as the service event `action`) and
// 'update' (update({ key, assets?, hide?, status? }) on an open annotation: a mail's remote pictures
// once the person asked for them).
// 'original' (annotate's `originals` and `view`: the main document's parts as their sender made them,
// each in a sandboxed frame, with an Original | Reader switch on the page told as the event `view`).
// 'fail' (fail({ key, message, retry? }): a prepared loader whose fetch failed shows the error, with a
// Try again told as the event `action`, instead of closing; app 0.13.2).
const FEATURES = ['companion', 'prepare', 'type', 'mail', 'actions', 'update', 'original', 'fail']
// prepare: a loading overlay no annotate filled (and no cancel closed) in this long is closed, so a
// caller that died mid-fetch leaves no spinner behind. Its fetches are bounded far under this.
const PREPARE_MS = 60000
// A loading overlay the person closed: the annotate that comes for it within this long opens
// nothing (they no longer want it); a later one opens as usual.
const DISMISSED_MS = 120000
// Returned by takePrepared for a key whose loading overlay the person closed.
const DISMISSED = Symbol('dismissed')
// OverlayHandle.post refuses a message over 1,040,384 chars of JSON (`ccc guide api`); a little
// under it leaves room for the transport's own wrapping.
const MAX_INIT_CHARS = 1000000
// main refuses an overlay title over 200 chars (overlay.start); a long path keeps its tail, the file name.
const MAX_TITLE_CHARS = 200
// How long openReview waits for the overlay to be refused before it counts it as shown. A refusal
// comes back in one host-to-main round trip, far under this (the editor waits the same).
const OPEN_SETTLE_MS = 500
// The page posts its draft on every change, so Esc (which closes without asking the page) loses
// no keystroke; storage writes are coalesced to one per this many ms, and flushed when it closes.
const DRAFT_SAVE_MS = 300
// How much of a queued review's start must be in the tab's next prompt to count as delivered.
const MATCH_CHARS = 120
// Discuss asks the page for its newest draft (it posts one on every change, so the host's copy is
// at most a keystroke behind); past this wait the host's copy goes. Far under the app's 5 s bound
// on the onDiscuss answer.
const DRAFT_REQUEST_MS = 1500
// main refuses a Discuss tab id over this many chars (src/shared/overlay-buttons.ts): a longer
// caller's wish is dropped, not a refused overlay.
const MAX_TAB_ID = 100

/** `prefix` + `p`, cut from the left with a leading … so it fits main's title limit. Exported for tests. */
function overlayTitle(prefix, p) {
  const full = prefix + p
  if (full.length <= MAX_TITLE_CHARS) return full
  return prefix + '…' + p.slice(p.length - (MAX_TITLE_CHARS - prefix.length - 1))
}
exports.overlayTitle = overlayTitle

/**
 * Races an overlay's `result` against OPEN_SETTLE_MS: null when it is still open after the wait,
 * else `{ error }` (refused) or `{ result }` (ended). Call it after all wiring is done, so the wait
 * delays nothing.
 */
async function earlyEnd(result) {
  let timer
  const wait = new Promise((resolve) => (timer = setTimeout(resolve, OPEN_SETTLE_MS, null)))
  try {
    return await Promise.race([result.then((r) => ({ result: r }), (error) => ({ error })), wait])
  } finally {
    clearTimeout(timer)
  }
}

/** A prompt with control characters and runs of whitespace made one space (the send gate strips controls). */
const promptText = (s) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f\s]+/g, ' ')
    .trim()
const promptStart = (s) => promptText(s).slice(0, MATCH_CHARS)

/**
 * The extras of the review overlay's spec: its type, and Discuss's preselected tab. `tabId` is the
 * clicked tab (or a service caller's wish): main preselects it only when it is a Claude tab of this
 * window, else the active one. Exported for tests.
 */
function overlayExtras(type, tabId) {
  const out = {}
  if (type) out.type = type
  if (typeof tabId === 'string' && tabId && tabId.length <= MAX_TAB_ID) out.discuss = { tabId }
  return out
}
exports.overlayExtras = overlayExtras
exports.SPLIT_MIN = SPLIT_MIN
exports.SPLIT_MAX = SPLIT_MAX
exports.FEATURES = FEATURES

let disposers = []
// Ended on deactivate: the watches of queued reviews (their drafts stay kept), and the draft
// writers of open reviews (flushed, best effort, so a reload loses no pending write).
const watches = new Set()
const flushers = new Set()

exports.activate = (ctx) => {
  const root = async () => ctx.projectDir
  /** The plugin whose service call this is (null on an app without ctx.services.caller). */
  const callerOf = () => {
    try {
      return typeof ctx.services.caller === 'function' ? ctx.services.caller() || null : null
    } catch {
      return null
    }
  }
  const exec = (argv) => ctx.exec(argv, { timeoutMs: 15000 })

  // One overlay per file (`file:<path>`) and per annotated text (`text:<key>`): a second open of
  // the same one brings the first to the front. `opening` settles when the first open has its
  // outcome (shown, or refused within OPEN_SETTLE_MS): a second caller during that wait reported
  // `{ opened: true }` for an overlay main then refused, so it waits for the same outcome instead.
  const open = new Map() // openKey -> { handle, opening: Promise<void> }
  // prepare(): loading overlays waiting for their annotate (`text:<key>`), and the keys whose
  // loading overlay the person closed (the time they did). Real-work feedback 8: a source fetched a
  // mail or an issue for seconds before annotate, with nothing on screen meanwhile.
  const prepared = new Map() // openKey -> { handle, settled, timer, view }
  const dismissed = new Map() // openKey -> ms
  // fail(): loading overlays turned into an error page (`text:<key>` -> its view). The key is released
  // there: the error page is no review of that key, so an annotate of it opens as for a key not open,
  // and only the same caller's next prepare takes the page back (to the loader, then its annotate).
  // A source used to cancel its loader when the fetch failed: a network outage made the overlay flash
  // open and shut with no reason on screen (the error went only to the source's own panel).
  const failedViews = new Map()
  disposers.push(() => {
    for (const e of prepared.values()) clearTimeout(e.timer)
    prepared.clear()
    failedViews.clear()
  })

  /**
   * The overlay of a coming annotate, opened now with the page's loader (it shows until the init).
   * Resolves once the overlay is up and throws main's refusal (3 open, 10 a minute): it used to
   * resolve at once, so prepare answered `{ opened: true }` for a refused overlay and a source
   * counted its open as shown (round-4 review). start() gives no "shown" signal, so this waits
   * OPEN_SETTLE_MS for `result` to reject, as showReview does. A key already open (or loading) is
   * brought to the front; the same caller's error page of the key (fail) goes back to the loader,
   * so a Try again opens no second overlay. `caller` is the plugin of the call (null: none known).
   */
  async function prepareAnnotation(options, caller) {
    const { key, title, type, tabId } = review.prepareInput(options)
    const openKey = `text:${key}`
    dismissed.delete(openKey)
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    const had = prepared.get(openKey)
    if (had) return had.handle.focus()
    const failed = failedViews.get(openKey)
    if (failed && caller && failed.caller === caller) {
      // Its title, type and Discuss tab stay the first prepare's (set when an overlay starts): the
      // same key is the same item.
      failedViews.delete(openKey)
      failed.state = 'loading'
      failed.handle.post({ type: 'loading' })
      failed.handle.focus()
      holdPrepared(openKey, key, failed)
      return
    }
    const handle = ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: overlayTitle('Notes: ', title), size: 'large', ...overlayExtras(type, tabId) })
    // The overlay's life across loader, error page (fail) and loader again; `state` says which.
    const view = { handle, key, caller, state: 'loading' }
    // The error page's buttons. Heard only while it is one: once an annotate filled the overlay its
    // messages are the review's (showReview's own listener).
    handle.onMessage((m) => {
      if (view.state !== 'failed' || !m || typeof m !== 'object') return
      if (m.type === 'close') handle.close()
      else if (m.type === 'retry' && view.retry) {
        // The same event as a document's buttons (`action`), with an id no caller's string can
        // collide with in meaning: only the plugin that failed the key acts on it.
        try {
          ctx.services.emit('reviewer', 'action', { key, id: 'retry', caller: view.caller })
        } catch (e) {
          ctx.log.warn(`action retry: ${e.message}`)
        }
      }
    })
    handle.result.then(
      () => {
        if (failedViews.get(openKey) === view) failedViews.delete(openKey)
      },
      () => {
        if (failedViews.get(openKey) === view) failedViews.delete(openKey)
      },
    )
    holdPrepared(openKey, key, view)
    // Wired first, so an annotate taking the entry during the wait finds it. A person closing the
    // loader within the wait is a shown overlay (its annotate then answers { opened: false }).
    const ended = await earlyEnd(handle.result)
    if (ended && ended.error) throw new Error(`the loading overlay did not open: ${ended.error.message}`)
  }

  /**
   * `view` as `openKey`'s loader, waiting for its annotate: closed after PREPARE_MS, and a loader the
   * person closes marks the key dismissed. Returns the entry (settled once taken, cancelled, failed
   * or timed out: its result is not ours to read then).
   */
  function holdPrepared(openKey, key, view) {
    const { handle } = view
    const entry = { handle, settled: false, timer: null, view }
    prepared.set(openKey, entry)
    const drop = () => {
      entry.settled = true
      clearTimeout(entry.timer)
      if (prepared.get(openKey) === entry) prepared.delete(openKey)
    }
    entry.timer = setTimeout(() => {
      if (entry.settled) return
      drop()
      ctx.log.warn(`a loading overlay waited ${PREPARE_MS / 1000} s for its content (${key}); closed`)
      handle.close()
    }, PREPARE_MS)
    handle.result.then(
      () => {
        if (entry.settled) return
        drop()
        dismissed.set(openKey, Date.now())
      },
      (e) => {
        if (entry.settled) return
        drop()
        ctx.log.warn(`the loading overlay did not open (${key}): ${e.message}`)
      },
    )
    return entry
  }

  /**
   * The caller's loader of `key` (prepared, never filled) turned into an error page: the message and
   * Close, with `retry` a Try again whose click is the event `action` { key, id: 'retry', caller }.
   * The key is released (failedViews). False, as cancel answers, for a key with no such loader:
   * filled, never prepared, or prepared by another plugin (a caller learns nothing of the others').
   */
  function failPrepared(options, caller) {
    const { key, message, retry } = review.failInput(options)
    const openKey = `text:${key}`
    const e = prepared.get(openKey)
    if (!e || !caller || e.view.caller !== caller) return false
    e.settled = true
    clearTimeout(e.timer)
    prepared.delete(openKey)
    dismissed.delete(openKey)
    const view = e.view
    view.state = 'failed'
    view.retry = retry
    failedViews.set(openKey, view)
    view.handle.post({ type: 'failed', message, retry })
    return true
  }

  /** Closes a loading overlay no annotate filled; false when there is none (filled, or never prepared). */
  function cancelPrepared(options) {
    const { key } = review.prepareInput(options, { title: false })
    const openKey = `text:${key}`
    dismissed.delete(openKey)
    const e = prepared.get(openKey)
    if (!e) return false
    e.settled = true
    clearTimeout(e.timer)
    prepared.delete(openKey)
    e.handle.close()
    return true
  }

  /** The loading overlay of `openKey` for its annotate to fill, DISMISSED when the person closed it, else null. */
  function takePrepared(openKey) {
    const e = prepared.get(openKey)
    if (e) {
      e.settled = true
      clearTimeout(e.timer)
      prepared.delete(openKey)
      return e.handle
    }
    const at = dismissed.get(openKey)
    if (at === undefined) return null
    dismissed.delete(openKey)
    return Date.now() - at < DISMISSED_MS ? DISMISSED : null
  }

  /** Brings an open (or opening) review to the front once it is up; throws the first open's refusal. */
  async function focusExisting(entry) {
    await entry.opening
    entry.handle.focus()
    return { done: Promise.resolve() }
  }

  /**
   * A review queued in a busy tab is not delivered yet: main drops the queue when the tab ends
   * (logged only), so deleting the draft at send time lost the whole review then. The draft stays
   * stored until the tab's next prompt has the review's start in it (it reached Claude: the draft is
   * deleted, unless it changed since; the app's Discuss puts its `About:` and type lines before the
   * review), or the tab ends first (the person is told; the draft stays). `prevPrompt` is the tab's
   * prompt before the send: the same review sent twice is not mistaken for this one's delivery. No
   * plugin API reports a queued item's fate, hence the prompt match.
   */
  function watchQueued({ what, draftKey, tabId, text, sentDraft, prevPrompt, kept }) {
    const want = promptStart(text)
    let over = false
    const end = () => {
      over = true
      stop()
      watches.delete(stop)
    }
    const check = async (list) => {
      if (over) return
      const s = list.find((x) => x.tabId === tabId)
      if (s && s.lastPrompt !== prevPrompt && promptText(s.lastPrompt).includes(want)) {
        end()
        // A review reopened since may have changed the draft: only the one that was sent goes.
        const now = await ctx.storage.get(draftKey)
        if (JSON.stringify(now) === JSON.stringify(sentDraft)) await ctx.storage.delete(draftKey)
      } else if (!s || s.status === 'ended') {
        end()
        ctx.notify(`Review of ${what} may not have reached Claude: its tab ended while the review was queued. ${kept ? 'The draft is kept.' : 'Its draft could not be saved.'}`)
      }
    }
    const run = (list) => check(list).catch((e) => ctx.log.warn(`queued review of ${what}: ${e.message}`))
    const stop = ctx.sessions.onChange(run)
    watches.add(stop)
    // Delivery may have happened before the watch started (the tab stopped right after the send).
    ctx.sessions.list().then(run, () => {})
  }

  /**
   * The review of a project-relative path (a diff against the last commit). Throws before anything
   * is shown when the file cannot be reviewed; for a click, that sends it to the built-in viewer.
   */
  async function openReview(rel, { tabId } = {}) {
    const r = await root()
    const kind = files.viewKindOf(typeof rel === 'string' ? rel : '')
    if (kind === 'image' || kind === 'pdf') return openPreview(r, rel, { tabId })
    const sides = await files.readSides(exec, r, rel)
    // A markdown or HTML file: the page opens it rendered (no diff) or on the diff with a Rendered
    // switch. An HTML file's Rendered view is the page's sanitizer over its markup, as for a mail.
    if (kind === 'markdown' || kind === 'html') sides.format = kind
    return showReview(
      {
        openKey: `file:${sides.path}`,
        draftKey: review.draftKey(sides.path),
        what: sides.path,
        overlayTitle: overlayTitle('Review: ', sides.path),
        sides,
        // The well-known `file` type: the editor's "Edit" (and any other plugin's file buttons) show
        // on the review, and Discuss names the file.
        type: { name: 'file', data: { path: sides.path } },
        // A markdown file's Rendered view has links: only the http(s) URLs written in it open.
        ...(kind === 'markdown' || kind === 'html' ? { links: review.textLinks(sides.new, sides.old) } : {}),
        build: (d) => review.buildReview(d, sides, review.MAX_CONTEXT, { named: false }),
        tooLarge: `${sides.path} is too large to review (with escaping and its saved draft)`,
      },
      { tabId },
    )
  }

  /**
   * An image or a PDF of the project, shown by the page (an <img>, pdf.js) with no diff. Its bytes
   * do not fit the init message, so the init says `mode: 'preview'` and the bytes come as `after`
   * (review.previewChunks): posted only once the page asks with { type: 'content' }, because until
   * it has loaded main queues at most 100 messages or 8 MiB for it, and a 25 MiB PDF is 33 MiB of
   * base64. Same open key as a review of the path, so a second click focuses the overlay.
   */
  async function openPreview(r, rel, { tabId } = {}) {
    const p = files.readPreview(r, rel)
    const sides = { path: p.path, root: r, git: false, head: null, old: '', new: '', oldMissing: true, newMissing: false, mode: 'preview', kind: p.kind, mime: p.mime, size: p.bytes.length, note: null }
    return showReview(
      {
        openKey: `file:${p.path}`,
        draftKey: review.draftKey(p.path),
        what: p.path,
        overlayTitle: overlayTitle(p.kind === 'pdf' ? 'PDF: ' : 'Image: ', p.path),
        sides,
        after: review.previewChunks(p.kind, p.mime, p.bytes),
        type: { name: 'file', data: { path: p.path } },
        build: (d) => review.buildReview(d, sides, review.MAX_CONTEXT, { named: false }),
        tooLarge: `${p.path} is too large to show (with its saved draft)`,
      },
      { tabId },
    )
  }

  /**
   * annotate: the review overlay on a text another plugin handed over. `sides` in mode 'text' is
   * one read-only pane (the page shows no diff, no layout toggle and no Edit); in mode 'html' the
   * page renders the caller's HTML through its allow-list sanitizer (src/page/sanitize.mjs) instead.
   * The draft has its own key namespace (review.annotationKey), so a caller's key never reaches a
   * file's draft.
   *
   * HTML mode: 2 MiB of HTML and 8 MiB of images do not fit the one init message (a page message
   * takes 1,040,384 chars of JSON), so the init names how many `html` parts follow and which assets
   * (id, name, mime). The page asks for them ({ type: 'content' }) once it has the init, and the
   * host then posts the parts, each asset in a message of its own, and `assets-done`: the page shows
   * a placeholder for an image until its asset comes, and its alt text once `assets-done` came
   * without it. Not posted with the init: until the page has loaded, main queues at most 100
   * messages or 8 MiB for it and drops (logs) the rest, which 10 MiB of content would overflow;
   * once the page asks, it has loaded and each post goes straight out, in order.
   */
  async function openAnnotation(options, caller = null) {
    const a = review.annotateInput(options)
    const base = { path: a.title, url: a.url, old: '', oldMissing: true, newMissing: false, note: null }
    const c = a.companion
    let sides
    let after = []
    if (a.html !== null) {
      const parts = review.splitParts(a.html)
      // One asset namespace for both documents (annotateInput checked the ids and the shared budget).
      const assets = c ? [...a.assets, ...c.assets] : a.assets
      sides = { ...base, mode: 'html', new: '', htmlParts: parts.length, assets: assets.map(({ id, name, mime }) => ({ id, name, mime })), start: a.start }
      if (a.kind) sides.kind = a.kind
      // The originals (feature 'original'): named in the init with their part counts, their html
      // after the documents' parts (the Reader rendering comes first, so a slow original never holds
      // up the text) and before the pictures, which a frame is built with.
      const oParts = a.originals ? a.originals.map((o) => ({ id: o.id, parts: review.splitParts(o.html) })) : []
      if (a.originals) {
        sides.originals = oParts.map((o) => ({ id: o.id, parts: o.parts.length }))
        sides.view = a.view
      }
      // The companion's html comes in parts of its own ({ doc: 'companion' }), after the main
      // document's, so the one the person reads first renders first.
      const cParts = c ? review.splitParts(c.html) : []
      if (c) {
        sides.companion = { title: c.title, url: c.url, htmlParts: cParts.length, facts: c.facts !== null, label: c.label, urlLabel: c.urlLabel }
        // The main column's header bar (shown beside a companion only).
        sides.label = a.label
        sides.urlLabel = a.urlLabel
      }
      after = [
        ...parts.map((part, index) => ({ type: 'html', index, part })),
        ...cParts.map((part, index) => ({ type: 'html', doc: 'companion', index, part })),
        ...oParts.flatMap((o) => o.parts.map((part, index) => ({ type: 'original', id: o.id, index, part }))),
        ...assets.map(({ id, dataUrl }) => ({ type: 'asset', id, dataUrl })),
        { type: 'assets-done' },
      ]
    } else {
      sides = { ...base, mode: 'text', new: a.text }
    }
    // The details blocks (`aside` and the companion's `facts`, at most 100,000 chars each): a message
    // each, first, so a 400 KiB text and a draft in the init leave them room; `sides.aside` (and
    // `sides.companion.facts`) tell the page to ask for the content.
    if (c && c.facts !== null) after = [{ type: 'aside', doc: 'companion', html: c.facts }, ...after]
    if (a.aside !== null) {
      sides.aside = true
      after = [{ type: 'aside', html: a.aside }, ...after]
    }
    return showReview(
      {
        openKey: `text:${a.key}`,
        draftKey: review.annotationKey(a.key),
        what: a.title,
        overlayTitle: overlayTitle('Notes: ', a.title),
        sides,
        after,
        type: a.type,
        // The URL the caller gave, checked by annotateInput: the only one the header's "Open in
        // browser" button ever opens (the page says "open", never which URL); the companion's own
        // icon opens the companion's url the same way.
        openUrl: a.url,
        companionUrl: c ? c.url : null,
        // The links of the caller's own html and aside (and the companion's html and facts), read
        // from the strings it passed (built once, here): a link click opens one of these or nothing.
        links: review.linkSet(a.html, a.aside, c && c.html, c && c.facts, ...(a.originals || []).map((o) => o.html)),
        // The buttons the caller's own strings offer (`data-action`): a click on any other id is dropped.
        actions: a.html !== null ? review.actionSet(a.html, a.aside, c && c.html, c && c.facts) : null,
        // update() checks its assets against what the document has: one budget and one id namespace.
        assets: a.html !== null ? (c ? [...a.assets, ...c.assets] : a.assets) : null,
        // Who annotated (ctx.services.caller() at the call): the `action` event names it, so a consumer
        // acts only on its own documents, and only that plugin may update this one.
        caller,
        key: a.key,
        companion: c !== null,
        // The page's Original | Reader switch is passed on (event `view`) only for a document with originals.
        originals: Boolean(a.originals),
        build: (d) => review.buildAnnotation(d, a, review.MAX_CONTEXT),
        tooLarge: 'the text is too large to show (with escaping and its saved draft)',
      },
      { tabId: a.tabId },
    )
  }

  /**
   * Opens the review overlay for one subject (a file's sides, or an annotated text). Resolves once
   * the overlay is up, with `done` (the promise of its end), so the openFile listener can keep
   * running (a listener still running after 1 s counts as handled) while a service caller does
   * not wait for the person. `subject`: openKey (one overlay per key), draftKey, what (named in
   * notices), overlayTitle, sides, after (messages posted when the page asks for them with
   * { type: 'content' }, each within the page message limit; may be absent), type (the overlay's
   * type, or null for none), openUrl (the caller's url for the header's "Open in browser" button;
   * absent or null: none), companionUrl (the same for the companion's icon), companion (true: the
   * page shows a companion and gets the person's divider position), links (review.linkSet of the
   * caller's html and aside: the only links an `open-link` opens; absent or null: none, as in a file
   * review), build(draft) -> { text, cut } (the text Discuss hands the app), and tooLarge (the
   * refusal when the init message would not fit). `tabId` is Discuss's preselected tab.
   */
  async function showReview(subject, { tabId } = {}) {
    const { openKey, draftKey, what, sides } = subject
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    let draft = review.cleanDraft(await ctx.storage.get(draftKey))
    const savedLayout = await ctx.appStorage.get(LAYOUT_KEY).catch(() => null)
    const layout = LAYOUTS.includes(savedLayout) ? savedLayout : 'split'
    let split = SPLIT_DEFAULT
    if (subject.companion) {
      const saved = await ctx.appStorage.get(SPLIT_KEY).catch(() => null)
      if (splitOk(saved)) split = saved
    }

    // Checked again after the awaits above: two quick clicks (or `ccc review` calls) on the same
    // file both pass the first check, and the second must focus the first overlay, not open
    // another. Nothing between here and open.set awaits, so the pair is atomic.
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    // Measured before the overlay starts: MAX_SIDE_BYTES bounds the raw bytes, but JSON escaping (a
    // newline or a quote is two chars) and a saved draft can push the message past what post takes.
    // Throwing here hands a click to the built-in viewer; a post that threw after start would leave
    // a blank overlay cached in `open`, so that file never reopened.
    // ctx.openExternal is in every app that bundles this plugin; checked anyway, so a copy run on an
    // older app hides the button instead of showing one that throws.
    const openUrl = subject.openUrl && typeof ctx.openExternal === 'function' ? subject.openUrl : null
    const companionUrl = subject.companionUrl && typeof ctx.openExternal === 'function' ? subject.companionUrl : null
    const links = subject.links && typeof ctx.openExternal === 'function' ? subject.links : null
    const init = {
      type: 'init',
      sides,
      draft,
      layout,
      canOpenUrl: openUrl !== null,
      canOpenLinks: links !== null,
    }
    if (subject.companion) {
      init.split = split
      init.canOpenCompanionUrl = companionUrl !== null
    }
    if (JSON.stringify(init).length > MAX_INIT_CHARS) {
      throw new files.ReviewError(subject.tooLarge, { fallback: true })
    }
    // A prepared overlay (its loader showing) is filled instead of a new one started; its title, type
    // and Discuss tab stay the ones prepare gave (they are set when an overlay starts).
    const pre = takePrepared(openKey)
    if (pre === DISMISSED) return { done: Promise.resolve(), dismissed: true }
    const handle =
      pre || ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: subject.overlayTitle, size: 'large', ...overlayExtras(subject.type || null, tabId) })
    let after = subject.after && subject.after.length ? subject.after : null
    let settle
    const opening = new Promise((resolve, reject) => (settle = { resolve, reject }))
    opening.catch(() => {}) // observed by focusExisting only when a second open comes in the wait
    const entry = { handle, opening, caller: subject.caller || null, html: !!subject.assets }
    // update(): more images for the open document (they join its asset budget), parts of it hidden,
    // a status line. Posted to the page as is: the page adds the images to the ones it has and leaves
    // the rendered document alone, so a note's anchor does not move.
    let budget = subject.assets ? review.assetBudget([subject.assets]) : null
    entry.update = (u) => {
      // Checked on a copy: a refused update spends nothing of the budget.
      const next = { count: budget.count, total: budget.total, seen: new Set(budget.seen) }
      const assets = review.checkAssets(u.assets, 'update.assets', next)
      budget = next
      post({ type: 'update', assets: assets.map(({ id, name, mime }) => ({ id, name, mime })), hide: u.hide, ...(u.status !== null ? { status: u.status } : {}) })
      for (const { id, dataUrl } of assets) post({ type: 'asset', id, dataUrl })
    }
    open.set(openKey, entry)
    // Drafts arrive on every change: Esc closes the overlay without asking the page, so the last
    // posted draft is what Close keeps. Writes are coalesced: `pending` is the newest draft not
    // written yet, and flush() queues it behind the writes before it. A failed write is shown in
    // the page while it is open (draft-error, cleared by draft-saved once a later write works) and
    // in a notice when the overlay closes with it unresolved: the failure used to be only logged,
    // so Esc threw the unsaved text away without a word. Storage keeps the last good draft.
    let pending = null
    let saveTimer = null
    let saving = Promise.resolve()
    // Discuss is the toolbar's primary button once there is a note to send, plain while there is
    // none (an older app has no setDiscussPrimary: the button just stays plain).
    let primary = null
    const markDiscuss = (d) => {
      const on = !!(d && Array.isArray(d.notes) && d.notes.length > 0)
      if (on === primary || typeof handle.setDiscussPrimary !== 'function') return
      primary = on
      handle.setDiscussPrimary(on)
    }
    markDiscuss(draft)
    let saveError = null // why the newest text is not stored; null while it is
    let failed = null // the draft whose write failed (retried once at close); null for a draftProblem
    // Discuss's asks for the page's newest draft, answered by its next `draft` (or `draft-unsaved`).
    const draftWaiters = new Set()
    // What the last Discuss ask handed the app: { draft, text, cut, prompts } (prompts: each tab's
    // lastPrompt then, so a queued review's delivery is told from the prompt before it).
    let discussed = null
    const post = (msg) => {
      try {
        handle.post(msg)
      } catch (e) {
        ctx.log.warn(`post to the review page: ${e.message}`) // never break the save chain
      }
    }
    const showSaveError = (why) => {
      saveError = why
      post({ type: 'draft-error', message: `Draft not saved: ${why}. The last saved draft is kept.` })
    }
    const write = (value) => (review.isEmpty(value) ? ctx.storage.delete(draftKey) : ctx.storage.set(draftKey, value))
    function flush() {
      clearTimeout(saveTimer)
      saveTimer = null
      if (pending) {
        const value = pending
        pending = null
        saving = saving.then(() =>
          write(value).then(
            () => {
              failed = null
              if (saveError) post({ type: 'draft-saved' })
              saveError = null
            },
            (e) => {
              ctx.log.error(`draft save: ${e.message}`)
              failed = value
              showSaveError(e.message)
            },
          ),
        )
      }
      return saving
    }
    flushers.add(flush)

    /** The page's newest draft (raw, as posted), or the host's copy when the page does not answer in time. */
    function requestDraft() {
      return new Promise((resolve, reject) => {
        const w = {
          resolve: (d) => (clearTimeout(w.timer), draftWaiters.delete(w), resolve(d)),
          reject: (e) => (clearTimeout(w.timer), draftWaiters.delete(w), reject(e)),
          timer: setTimeout(() => w.resolve(draft), DRAFT_REQUEST_MS),
        }
        draftWaiters.add(w)
        post({ type: 'draft-request' })
      })
    }

    // Registered before init is posted: the page posts drafts as soon as it has loaded.
    handle.onMessage((m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'draft') {
        for (const w of [...draftWaiters]) w.resolve(m.draft)
        // A draft cleanDraft would cut is not stored (storing it, or sending it and deleting the
        // draft, dropped the rest): the last good one stays, and the page says why.
        const problem = review.draftProblem(m.draft)
        if (problem) {
          flush()
          saving = saving.then(() => {
            failed = null
            showSaveError(problem)
          })
          return
        }
        draft = review.cleanDraft(m.draft)
        markDiscuss(draft)
        pending = draft
        clearTimeout(saveTimer)
        saveTimer = setTimeout(flush, DRAFT_SAVE_MS)
      } else if (m.type === 'draft-unsaved') {
        // The page's own size check refused the draft: Discuss would send an older one.
        for (const w of [...draftWaiters]) w.reject(new Error('the draft is too large to send: shorten or delete a note first'))
      } else if (m.type === 'layout' && LAYOUTS.includes(m.layout)) {
        ctx.appStorage.set(LAYOUT_KEY, m.layout).catch((e) => ctx.log.error(`layout save: ${e.message}`))
      } else if (m.type === 'split' && subject.companion && splitOk(m.split)) {
        ctx.appStorage.set(SPLIT_KEY, m.split).catch((e) => ctx.log.error(`divider save: ${e.message}`))
      } else if (m.type === 'open-url') {
        // The page names no URL (it shows the caller's content in a sandboxed frame), only which
        // document's icon was clicked: the host opens the one it was given for it. The app refuses
        // some (user:pass@, 3 per 10 s): the page says why.
        const url = m.doc === 'companion' ? companionUrl : openUrl
        if (url !== null) ctx.openExternal(url).catch((e) => post({ type: 'error', message: `Not opened in the browser: ${e.message.replace(/^openExternal: /, '')}` }))
      } else if (m.type === 'open-link' && links !== null) {
        // A link clicked in the document or the details column. The href comes from the page, so it
        // opens only when the caller's own html or aside has that link (review.linkVerdict), and only
        // http(s): ctx.openExternal takes nothing else, so a mailto link is named, not opened.
        const v = review.linkVerdict(links, m.href)
        if (v.refuse) post({ type: 'error', message: v.refuse })
        else ctx.openExternal(v.open).catch((e) => post({ type: 'error', message: `Not opened in the browser: ${e.message.replace(/^openExternal: /, '')}` }))
      } else if (m.type === 'action' && subject.actions && typeof m.id === 'string' && subject.actions.has(m.id)) {
        // A button of the caller's document (`data-action`): told to every consumer of the service
        // (events have no single addressee), with the key and the caller, so the one that annotated
        // acts and the others ignore it. An id the caller's strings never had is dropped above.
        try {
          ctx.services.emit('reviewer', 'action', { key: subject.key, id: m.id, caller: subject.caller })
        } catch (e) {
          ctx.log.warn(`action ${m.id}: ${e.message}`)
        }
      } else if (m.type === 'view' && subject.originals && review.VIEWS.includes(m.view)) {
        // The person switched between the Original and the Reader view (feature 'original'): told to
        // every consumer like an action, with the key and the caller, so the caller can remember it
        // (the Gmail plugin keeps it per sender). The page has already switched.
        try {
          ctx.services.emit('reviewer', 'view', { key: subject.key, view: m.view, caller: subject.caller })
        } catch (e) {
          ctx.log.warn(`view ${m.view}: ${e.message}`)
        }
      } else if (m.type === 'content' && after) {
        // Once: the content is let go after it went out (it can be 10 MiB). A post that fails is
        // logged and the page lives without it (an image shows its alt text after assets-done).
        const list = after
        after = null
        for (const msg of list) post(msg)
      }
    })

    // The app's Discuss with Claude asks for the context (5 s): the review text built from the
    // page's newest draft. Empty is fine (real-work feedback 9): build() then asks Claude to discuss
    // the file or the text. A draft the host would cut, or one the page could not post, throws: the
    // popover shows why and nothing is sent. The app adds `About:`, the type line and the note.
    handle.onDiscuss(async () => {
      const raw = await requestDraft()
      const problem = review.draftProblem(raw)
      if (problem) throw new Error(`not sent: ${problem}`)
      const sent = review.cleanDraft(raw)
      const { text, cut } = subject.build(sent)
      const prompts = new Map()
      try {
        for (const s of await ctx.sessions.list()) prompts.set(s.tabId, s.lastPrompt)
      } catch (e) {
        ctx.log.warn(`sessions.list: ${e.message}`)
      }
      discussed = { draft: sent, text, cut, prompts }
      return { text }
    })

    try {
      handle.post(init)
    } catch (e) {
      open.delete(openKey)
      flushers.delete(flush)
      settle.reject(e)
      handle.close()
      throw e
    }
    // start() gives no "shown" signal, but a refused overlay (3 open, 10 a minute, a closed window)
    // rejects `result` at once, while one that opened settles only when the person closes it. Wait
    // briefly for a rejection and throw it: a click then goes to the built-in viewer, and the service
    // and `ccc review` report the failure. The listener above and the post are wired first, so the
    // page's first drafts are handled during the wait. A person closing it within the wait is a
    // shown overlay; `done` below handles that result. A second open of the same file during the
    // wait finds the entry in `open` and waits on `opening`: it focuses the overlay once shown, or
    // throws the same refusal.
    const ended = await earlyEnd(handle.result)
    if (ended && ended.error) {
      if (open.get(openKey) === entry) open.delete(openKey)
      flushers.delete(flush) // a refused overlay never loaded its page, so no draft is pending
      const err = new files.ReviewError(`the review overlay did not open: ${ended.error.message}`, { fallback: true })
      settle.reject(err)
      throw err
    }
    settle.resolve()

    /** Closed without sending: tell the person when the newest draft never reached storage. */
    async function closedUnsaved() {
      if (!saveError) return
      // One more try for a write that failed (a full store may have room again).
      if (failed) {
        try {
          await ctx.storage.set(draftKey, failed)
          return
        } catch (e) {
          saveError = e.message
        }
      }
      ctx.notify(`The review draft of ${what} was not saved: ${saveError}. The last saved draft is kept.`)
    }

    /** Stores the full draft whenever Claude may not have all of it; says whether that worked. */
    async function keep(value, kept) {
      try {
        await ctx.storage.set(draftKey, value)
        return kept
      } catch (e) {
        ctx.log.error(`draft save: ${e.message}`)
        return `The draft could not be saved: ${e.message}.`
      }
    }

    /**
     * The app sent the review ({ kind: 'discussed', tabId, queued }): the draft goes once all of it
     * reached Claude. A review cut to fit keeps the whole draft (deleting it lost the unsent part),
     * and the person is told; a queued one keeps it until the tab takes it (watchQueued).
     */
    async function sentToClaude(res) {
      const sent = discussed
      if (!sent) return // no context was asked for, so this is not the reviewer's text: keep the draft
      if (sent.cut) {
        ctx.notify(`Review of ${what} was too long and was cut at ${review.MAX_CONTEXT} characters. ${await keep(sent.draft, 'The full draft is kept.')}`)
        return
      }
      if (res.queued) {
        const KEPT = 'The draft is kept until Claude gets it.'
        const kept = await keep(sent.draft, KEPT)
        watchQueued({ what, draftKey, tabId: res.tabId, text: sent.text, sentDraft: sent.draft, prevPrompt: sent.prompts.get(res.tabId), kept: kept === KEPT })
        return
      }
      // All of it reached Claude: only now does the draft go. A failed delete only leaves it.
      await ctx.storage.delete(draftKey).catch((e) => ctx.log.warn(`draft delete: ${e.message}`))
    }

    const done = handle.result
      .then(async (res) => {
        await flush()
        for (const w of [...draftWaiters]) w.resolve(draft)
        if (res && res.kind === 'discussed' && typeof res.tabId === 'string') return sentToClaude(res)
        // Close, Esc, ✕: nothing is sent and the draft stays.
        return closedUnsaved()
      })
      .catch((e) => {
        ctx.log.error(`review of ${what}: ${e.message}`)
        ctx.notify(`Review of ${what}: ${e.message}. The last saved draft is kept.`)
      })
      .finally(() => {
        flushers.delete(flush)
        if (open.get(openKey) === entry) open.delete(openKey)
      })
    return { done }
  }

  // ---- entry points ----

  disposers.push(
    ctx.files.onOpen(async ({ path, tabId }) => {
      // Throwing before the overlay is up hands the click to the built-in viewer (binary, too
      // big, unreadable); after that, awaiting the overlay keeps the click ours.
      const { done } = await openReview(path, { tabId })
      await done
    }),
  )

  ctx.services.provide('reviewer', {
    async open(path, options) {
      try {
        const tabId = options && typeof options === 'object' && typeof options.tabId === 'string' ? options.tabId : undefined
        await openReview(path, { tabId })
        return { opened: true }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1: a provider without it answers a call with "has no method", so a caller can
    // tell an older reviewer apart and fall back.
    async annotate(options) {
      // Read before the first await: the caller of this call (the `action` event names it, and only
      // it may update the document). An app without ctx.services.caller: null, and update refuses.
      const caller = callerOf()
      try {
        const r = await openAnnotation(options, caller)
        // The person closed its loading overlay while the caller fetched: nothing opens.
        return { opened: !(r && r.dismissed) }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 (features() lists 'prepare'): the overlay of an annotate still to come, shown at
    // once with a loader; the annotate with the same key fills it. An older reviewer rejects with
    // "has no method", which a caller reads as "annotate when ready", as before.
    async prepare(options) {
      // Read before the first await, as annotate does: fail() and a later prepare check it.
      const caller = callerOf()
      try {
        await prepareAnnotation(options, caller)
        return { opened: true }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Closes a prepared overlay that no annotate filled (the fetch failed, or the caller shows its
    // own page instead); a no-op once filled, so a caller may call it whatever happened.
    async cancel(options) {
      try {
        return { closed: cancelPrepared(options) }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 (feature 'fail'): the caller's loader of a key whose fetch failed turns into an
    // error page (the message, Close, and with `retry` a Try again told as the event `action`
    // { key, id: 'retry', caller }) instead of closing. `{ failed: false }` where cancel would close
    // nothing (filled, never prepared) and for another plugin's loader; the caller then cancels.
    async fail(options) {
      const caller = callerOf()
      try {
        return { failed: failPrepared(options, caller) }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 too (app 0.9.3): the optional annotate features this reviewer has. An older one
    // rejects with "has no method", which a caller reads as none.
    async features() {
      return [...FEATURES]
    },
    // Additive in v1 (feature 'update', app 0.13.0): more images, hidden parts or a status line for an
    // open annotation of the same caller. The same answer for a key that is not open and one another
    // plugin annotated, so a caller learns nothing of the others' keys.
    async update(options) {
      const caller = callerOf()
      try {
        const u = review.updateInput(options)
        const entry = open.get(`text:${u.key}`)
        if (!entry || !entry.html || !caller || entry.caller !== caller) throw new files.ReviewError(`no open HTML annotation with the key ${u.key}`)
        await entry.opening
        entry.update(u)
        return { updated: true }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
  })

  ctx.cli.register('review', async (argv, { cwd }) => {
    if (!argv.length || argv[0] === 'help' || argv.includes('--help')) {
      return { stdout: 'usage: ccc review <file>   review a file of this project (diff against the last commit)\n' }
    }
    try {
      const r = await root()
      const rel = files.relativeFromCwd(r, cwd, argv[0])
      await openReview(rel)
      return { stdout: `reviewing ${rel}\n` }
    } catch (e) {
      return { stderr: `review: ${e.message}\n`, code: 1 }
    }
  })

  ctx.log.info('activated')
}

exports.deactivate = () => {
  // Pending draft writes go out now (best effort: the store may already refuse), and the queued
  // review watches stop; their drafts stay stored.
  for (const fn of [...flushers, ...watches]) {
    try {
      fn()
    } catch {
      // a host that is going away
    }
  }
  flushers.clear()
  watches.clear()
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      // nothing left to clean up in a reloading host
    }
  }
  disposers = []
}
