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
//   the notes of a file in place (the editor's gutter, feature 'notes'): notes(path) the line notes of a
//   file's review, addNote(path, { from, to, text, quote? }) one more in the same store, removeNotes(path,
//   [{ id, text }]) the ones a caller handed to Claude itself (feature 'removeNotes'), and the
//   event `notesChange` { path } when a file's notes changed (the person's, the overlay's, addNote's or removeNotes');
//   annotate's `originals` [{ id, html }] and `view` (feature 'original'): the mail's own HTML and CSS
//   in sandboxed frames (the Original view), with an Original | Reader switch told as the event `view`;
// - `ccc review <path>`.
//
// Every view that shows an overlay loads its own copy of the page (manifest `overlays.perView`), a guest's
// included: the host keeps each overlay's state and sends each copy its own (makePage), a guest's without
// host paths, and acts on a page message by who sent it (docs/design-overlay-views.md §6).
//
// Plain JavaScript host; only the overlay page (overlay/) is bundled, by `npm run build`.

const fs = require('node:fs')
const path = require('node:path')
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
// 'notes' (notes(path), addNote(path, note) and the event `notesChange`: the line notes of a file's review,
// read and added from outside the overlay; the editor shows them in its gutter).
// 'removeNotes' (removeNotes(path, [{ id, text }]): the notes a caller sent to Claude itself go, as a sent
// review's do; the editor's Ask Claude).
const FEATURES = ['companion', 'prepare', 'type', 'mail', 'actions', 'update', 'original', 'fail', 'notes', 'removeNotes']
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
// The pages send their note ops on every change, so Esc (which closes without asking a page) loses
// no keystroke; storage writes are coalesced to one per this many ms, and flushed when it closes.
const DRAFT_SAVE_MS = 300
// How much of a queued review's start must be in the tab's next prompt to count as delivered.
const MATCH_CHARS = 120
// Discuss first asks every copy that edits to say it has sent all its ops (a page sends each change at
// once, but on its own port, which a toolbar click does not wait for, so the host's draft can be a
// keystroke behind); past this wait the host's draft goes as it is. Far under the app's 5 s bound on
// the onDiscuss answer.
const DRAFT_REQUEST_MS = 1500
// The page-local tags a copy's adds named, remembered per copy so a change or delete it sends before the
// id came back still finds its note; past this many the oldest are forgotten (a page's tag is answered
// within a round trip, so only a page that adds and deletes without end gets there).
const MAX_COPY_TAGS = 1000
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

// Who a page message or a copy came from, as the app fills it (ViewFrom: view, access, person, and the
// copy id main minted). Anything else is nobody: its message is dropped, its connect ignored.
const ACCESS = ['owner', 'write', 'read']
const viewerOf = (from) =>
  from && typeof from === 'object' && ACCESS.includes(from.access) && typeof from.copy === 'string' && from.copy !== '' && typeof from.view === 'string' ? from : null
const isOwner = (from) => from.access === 'owner'
// Who may change the notes (D-3): the owner and write guests; a read guest's copy shows them only.
const canNote = (from) => from.access === 'owner' || from.access === 'write'

/**
 * `sides` as a guest's copy gets them: no host path (design-guests D-33). A file review's and a preview's
 * `root` is the project folder; everything else in sides is project-relative (`path`), the caller's own
 * (an annotation's title and url) or the file's content. The page never reads `root`. Exported for tests.
 */
function guestSides(sides) {
  const { root, ...rest } = sides
  return rest
}
exports.guestSides = guestSides
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
  /**
   * The service caller chain of this call, outermost first ([] outside a call, once it settled, or on an app
   * without ctx.services.callers). Read at the top of a service method, while the call is live: the content
   * it brings is attributed to these plugins (handle.addSources) before it leaves, also when it leaves later
   * (a copy that connects after the call returned), so a guest who may not see one of them never gets it (D-4).
   */
  const callersOf = () => {
    try {
      const chain = typeof ctx.services.callers === 'function' ? ctx.services.callers() : []
      return Array.isArray(chain) ? chain.filter((id) => typeof id === 'string' && id !== '') : []
    } catch {
      return []
    }
  }
  const exec = (argv) => ctx.exec(argv, { timeoutMs: 15000 })

  /**
   * One overlay's page in every view that shows it (manifest `overlays.perView`): each view loads its own
   * copy, which the app announces (onConnect, `from` filled by main: view, access, person, copy) and takes
   * back (onDisconnect). The overlay's state lives here, never only in a page: its phase (prepare's loader,
   * fail's error page, a filled review) and, once filled, the review's hooks (`review`), which keep the
   * content, the updates, the layout and the draft. So a copy that connects late, reloads or reconnects is
   * rebuilt from its connect, a prepared overlay's included (design-overlay-views §6).
   *
   * Every post goes to one copy (`post(m, { copy })`), never a broadcast: what a guest's copy gets is
   * projected (no host path) and its flags differ, and a copy that connected while the loader showed has had
   * no addressed post, which is what joins a copy to broadcasts. Messages are heard only from a copy this
   * page greeted and are acted on by the access main filled in `from` (the access table, §6), never by
   * anything the page says about itself.
   */
  function makePage(handle) {
    const page = {
      handle,
      copies: new Map(), // copy id -> { id, from, content (its content handshake answered), errorPage }
      phase: 'loading', // 'loading' | 'failed' | 'ready'
      failure: null, // { message, retry } while 'failed'
      onRetry: null, // the error page's Try again (prepare's caller is told)
      review: null, // { greet(copy), message(m, from, copy) } once filled
      sources: new Set(), // the plugins this overlay's content was opened or filled for (D-4)
    }
    page.postTo = (c, msg) => {
      try {
        page.handle.post(msg, { copy: c.id })
        return true
      } catch (e) {
        ctx.log.warn(`post to a review page: ${e.message}`) // never break the save chain
        return false
      }
    }
    /** `msg` (or `msg(copy)`) to every copy `which` takes. */
    page.each = (msg, which = () => true) => {
      for (const c of [...page.copies.values()]) if (which(c)) page.postTo(c, typeof msg === 'function' ? msg(c) : msg)
    }
    /**
     * Records the plugins `ids` and tells main the whole set again, before any post of what they brought. It
     * runs again before each late copy is sent anything: those posts are made outside the service call, so
     * the host adds no caller chain to them (main's set only grows, so repeating it costs nothing).
     */
    page.attribute = (ids = []) => {
      for (const id of ids) if (typeof id === 'string' && id !== '') page.sources.add(id)
      if (page.sources.size) page.handle.addSources([...page.sources])
    }
    // The error page's Try again is the owner's alone (§6: `retry` re-asks the consumer, a service event).
    const failedFor = (c) => ({ type: 'failed', message: page.failure.message, retry: page.failure.retry && isOwner(c.from) })
    /** A copy's starting state: nothing while loading (the page starts on its loader), else the phase's. */
    page.greet = (c) => {
      if (page.phase === 'loading') return
      try {
        page.attribute()
      } catch (e) {
        ctx.log.warn(`overlay sources: ${e.message}; nothing sent to a new copy`) // fail closed
        return
      }
      if (page.phase === 'failed') page.postTo(c, failedFor(c))
      else page.review.greet(c)
    }
    page.loading = () => {
      page.phase = 'loading'
      page.failure = null
      page.each({ type: 'loading' })
    }
    page.fail = (message, retry) => {
      page.phase = 'failed'
      page.failure = { message, retry }
      page.each(failedFor)
    }
    /** Filled: every copy already up gets the review now, later ones on their connect. */
    page.fill = (review) => {
      page.review = review
      page.phase = 'ready'
      for (const c of [...page.copies.values()]) page.greet(c)
    }
    handle.onConnect((from) => {
      const v = viewerOf(from)
      if (!v || page.copies.has(v.copy)) return
      // `inited`: its init went out, so it holds the draft and takes the notes' live changes (a file
      // review's page never asks for content, so `content` cannot say that).
      const c = { id: v.copy, from: v, content: false, errorPage: false, inited: false, tags: new Map(), refused: false }
      page.copies.set(c.id, c)
      page.greet(c)
    })
    handle.onDisconnect((from) => {
      if (from && typeof from.copy === 'string') page.copies.delete(from.copy)
    })
    handle.onMessage((m, from) => {
      if (!m || typeof m !== 'object') return
      const v = viewerOf(from)
      const c = v && page.copies.get(v.copy)
      if (!c) return
      // The error page's buttons: the overlay's (fail), or one copy's whose init could not be sent
      // (`errorPage`). Once filled, a stale Close or Try again from fail's page means nothing.
      if (page.phase === 'failed' || c.errorPage) {
        if (m.type === 'close') {
          // D-2: the owner's and a write guest's Close end the overlay for everyone; a read guest's hides
          // only its own copy (and main keeps it hidden from that guest).
          if (v.access === 'read') page.handle.hide({ copy: c.id })
          else page.handle.close()
        } else if (m.type === 'retry' && page.phase === 'failed' && isOwner(v) && page.failure.retry && page.onRetry) {
          page.onRetry()
        }
      } else if (page.phase === 'ready') {
        page.review.message(m, v, c)
      }
    })
    return page
  }

  /**
   * The event `notesChange` { path } (feature 'notes'): a file's draft was written, deleted or added to.
   * Told to every consumer; a path-less subject (an annotated text, a preview) has no notes of its own
   * to tell. Never throws: an emit that fails must not break the draft's save chain.
   */
  function notesChanged(path) {
    if (typeof path !== 'string') return
    try {
      ctx.services.emit('reviewer', 'notesChange', { path })
    } catch (e) {
      ctx.log.warn(`notesChange ${path}: ${e.message}`)
    }
  }

  /**
   * One file's draft, read-modify-write at a time: addNote's own calls and a queued Discuss's delete of
   * the sent notes never interleave on the stored value. An open review's draft (the host's, written from
   * its copies' note ops) is kept apart another way:
   * addNote is refused while a review is open or being opened (`isReviewing`), and showReview waits for
   * the notes in flight before it reads the draft.
   */
  const noteQueue = new Map() // draft key -> the tail of its chain
  function serialNotes(key, fn) {
    const prev = noteQueue.get(key) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    noteQueue.set(key, tail)
    tail.then(() => {
      if (noteQueue.get(key) === tail) noteQueue.delete(key)
    })
    return run
  }
  let noteSeq = 0
  /** openKey -> count of showReview calls that have not put their overlay in `open` yet (they read the draft first). */
  const openingCount = new Map()
  const isReviewing = (openKey) => open.has(openKey) || openingCount.has(openKey)

  /** A project-relative path for the notes calls: the same checks as a review's (inside the folder, by name and by symlink). */
  function notesPath(rel) {
    const p = files.normalizeRelative(rel)
    if (!files.insideRoot(ctx.projectDir, path.join(ctx.projectDir, p))) {
      throw new files.ReviewError(`path leaves the project folder through a symlink: ${p}`)
    }
    return p
  }

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
  async function prepareAnnotation(options, caller, chain = []) {
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
      failed.page.attribute(chain)
      failed.page.loading()
      failed.handle.focus()
      holdPrepared(openKey, key, failed)
      return
    }
    const handle = ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: overlayTitle('Notes: ', title), size: 'large', ...overlayExtras(type, tabId) })
    // The overlay's life across loader, error page (fail) and loader again; `page.phase` says which.
    const page = makePage(handle)
    const view = { handle, page, key, caller }
    try {
      // Kept with the page: the annotate that fills it later, and every copy that connects after this
      // call returned, re-assert it before its content leaves.
      page.attribute(chain)
    } catch (e) {
      handle.close()
      throw e
    }
    // The error page's Try again (the owner's: makePage drops a guest's). The same event as a document's
    // buttons (`action`), with an id no caller's string can collide with in meaning: only the plugin that
    // failed the key acts on it.
    page.onRetry = () => {
      try {
        ctx.services.emit('reviewer', 'action', { key, id: 'retry', caller: view.caller })
      } catch (e) {
        ctx.log.warn(`action retry: ${e.message}`)
      }
    }
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
  function failPrepared(options, caller, chain = []) {
    const { key, message, retry } = review.failInput(options)
    const openKey = `text:${key}`
    const e = prepared.get(openKey)
    if (!e || !caller || e.view.caller !== caller) return false
    e.settled = true
    clearTimeout(e.timer)
    prepared.delete(openKey)
    dismissed.delete(openKey)
    const view = e.view
    failedViews.set(openKey, view)
    // The message is the caller's words: attributed like any content it brings.
    view.page.attribute(chain)
    view.page.fail(message, retry)
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

  /** The page of `openKey`'s loading overlay for its annotate to fill, DISMISSED when the person closed it, else null. */
  function takePrepared(openKey) {
    const e = prepared.get(openKey)
    if (e) {
      e.settled = true
      clearTimeout(e.timer)
      prepared.delete(openKey)
      return e.view.page
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
  function watchQueued({ what, draftKey, path, tabId, texts, sentDraft, prevPrompt, kept }) {
    // Each Discuss ask's text (two screens may each have asked): the delivered one is one of them.
    const wants = texts.map(promptStart)
    let over = false
    const end = () => {
      over = true
      stop()
      watches.delete(stop)
    }
    const check = async (list) => {
      if (over) return
      const s = list.find((x) => x.tabId === tabId)
      if (s && s.lastPrompt !== prevPrompt && wants.some((want) => promptText(s.lastPrompt).includes(want))) {
        end()
        // Only what was sent goes (by note id and text, the global note when unchanged): a note added since
        // (the editor's addNote works while the overlay is closed) or an edit from a reopened review stays.
        const gone = await serialNotes(draftKey, async () => {
          const now = review.cleanDraft(await ctx.storage.get(draftKey))
          const left = review.subtractSent(now, sentDraft)
          if (left.notes.length === now.notes.length && left.global === now.global) return false
          if (review.isEmpty(left)) await ctx.storage.delete(draftKey)
          else await ctx.storage.set(draftKey, left)
          return true
        })
        if (gone) notesChanged(path)
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
  async function openReview(rel, { tabId, sources } = {}) {
    const r = await root()
    const kind = files.viewKindOf(typeof rel === 'string' ? rel : '')
    if (kind === 'image' || kind === 'pdf') return openPreview(r, rel, { tabId, sources })
    const sides = await files.readSides(exec, r, rel)
    // A markdown or HTML file: the page opens it rendered (no diff) or on the diff with a Rendered
    // switch. An HTML file's Rendered view is the page's sanitizer over its markup, as for a mail.
    if (kind === 'markdown' || kind === 'html') sides.format = kind
    return showReview(
      {
        openKey: `file:${sides.path}`,
        draftKey: review.draftKey(sides.path),
        // The notes service's file: told as the event `notesChange` when the draft is written or sent.
        path: sides.path,
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
      { tabId, sources },
    )
  }

  /**
   * An image or a PDF of the project, shown by the page (an <img>, pdf.js) with no diff. Its bytes
   * do not fit the init message, so the init says `mode: 'preview'` and the bytes come as `after`
   * (review.previewChunks): posted only once the page asks with { type: 'content' }, because until
   * it has loaded main queues at most 100 messages or 8 MiB for it, and a 25 MiB PDF is 33 MiB of
   * base64. Same open key as a review of the path, so a second click focuses the overlay.
   */
  async function openPreview(r, rel, { tabId, sources } = {}) {
    const p = files.readPreview(r, rel)
    // Only for the head line: an untracked PDF reads like an untracked text file ("a new file").
    const g = await files.previewGit(exec, p.path).catch(() => ({ head: null, added: false }))
    const sides = { path: p.path, root: r, git: false, head: g.head, added: g.added, old: '', new: '', oldMissing: true, newMissing: false, mode: 'preview', kind: p.kind, mime: p.mime, size: p.bytes.length, note: null }
    return showReview(
      {
        openKey: `file:${p.path}`,
        draftKey: review.draftKey(p.path),
        what: p.path,
        overlayTitle: overlayTitle(p.kind === 'pdf' ? 'PDF: ' : 'Image: ', p.path),
        sides,
        // Chunked again on each copy's content request: the raw bytes (at most 25 MiB) are what the overlay
        // keeps, not their base64 messages (about 33 MiB), so three open PDFs do not hold 100 MB of strings.
        after: () => review.previewChunks(p.kind, p.mime, p.bytes),
        type: { name: 'file', data: { path: p.path } },
        build: (d) => review.buildReview(d, sides, review.MAX_CONTEXT, { named: false }),
        tooLarge: `${p.path} is too large to show (with its saved draft)`,
      },
      { tabId, sources },
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
  async function openAnnotation(options, caller = null, chain = []) {
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
      { tabId: a.tabId, sources: chain },
    )
  }

  /**
   * Opens the review overlay for one subject (a file's sides, or an annotated text). Resolves once
   * the overlay is up, with `done` (the promise of its end), so the openFile listener can keep
   * running (a listener still running after 1 s counts as handled) while a service caller does
   * not wait for the person. `subject`: openKey (one overlay per key), draftKey, what (named in
   * notices), overlayTitle, sides, after (messages posted when the page asks for them with
   * { type: 'content' }, each within the page message limit, or a function that makes them for each
   * request; may be absent), type (the overlay's
   * type, or null for none), openUrl (the caller's url for the header's "Open in browser" button;
   * absent or null: none), companionUrl (the same for the companion's icon), companion (true: the
   * page shows a companion and gets the person's divider position), links (review.linkSet of the
   * caller's html and aside: the only links an `open-link` opens; absent or null: none, as in a file
   * review), build(draft) -> { text, cut } (the text Discuss hands the app), and tooLarge (the
   * refusal when the init message would not fit). `tabId` is Discuss's preselected tab.
   */
  async function showReview(subject, { tabId, sources } = {}) {
    const { openKey, draftKey } = subject
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    // From here until the overlay is in `open` the review is on its way: addNote refuses meanwhile (a note
    // written after the draft is read below would be written over by the page), and the notes already in
    // flight finish first, so the read sees them.
    openingCount.set(openKey, (openingCount.get(openKey) || 0) + 1)
    try {
      await (noteQueue.get(draftKey) || Promise.resolve())
      return await showReviewNow(subject, { tabId, sources })
    } finally {
      const left = openingCount.get(openKey) - 1
      if (left > 0) openingCount.set(openKey, left)
      else openingCount.delete(openKey)
    }
  }

  async function showReviewNow(subject, { tabId, sources = [] } = {}) {
    const { openKey, draftKey, what, sides } = subject
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    let draft = review.cleanDraft(await ctx.storage.get(draftKey))
    const savedLayout = await ctx.appStorage.get(LAYOUT_KEY).catch(() => null)
    // The owner's layout and divider (app-wide prefs): what a copy that connects later starts with.
    let layout = LAYOUTS.includes(savedLayout) ? savedLayout : 'split'
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
    /**
     * The init one copy starts with: the newest draft, layout and divider, and for a guest's copy no host
     * path (guestSides) and `canAct: false`, so its page draws no `data-action` button (the host drops a
     * guest's action anyway, §6). The owner's is the init as it always was.
     */
    const initFor = (c) => {
      const out = { ...init, draft, layout }
      if (subject.companion) out.split = split
      if (subject.originals) out.sides = { ...sides, view: docView }
      if (!isOwner(c.from)) {
        out.sides = guestSides(out.sides)
        out.canAct = false
      }
      // A read guest's copy draws no note editing (no Add note, read-only texts, no delete); the host drops
      // its ops anyway. Absent for the owner and a write guest, so the owner's init is as it was.
      if (!canNote(c.from)) out.canNote = false
      return out
    }
    // A prepared overlay (its loader showing) is filled instead of a new one started; its title, type
    // and Discuss tab stay the ones prepare gave (they are set when an overlay starts).
    const pre = takePrepared(openKey)
    if (pre === DISMISSED) return { done: Promise.resolve(), dismissed: true }
    const page = pre || makePage(ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: subject.overlayTitle, size: 'large', ...overlayExtras(subject.type || null, tabId) }))
    const { handle } = page
    try {
      // Before anything of this content leaves (a copy may already be up, prepare's loader): the plugins
      // it was opened or filled for. Kept with the page, so a later copy re-asserts it.
      page.attribute(sources)
    } catch (e) {
      handle.close()
      throw new files.ReviewError(`the review overlay did not open: ${e.message}`)
    }
    // The content each copy asks for once it has its init ({ type: 'content' }), kept for the overlay's
    // life: a copy that connects later, reloads or reconnects asks again. An annotation's is its parts
    // and assets (2 MiB of html, 8 MiB of images, the originals and the details); a preview's is a
    // function that chunks its kept bytes again for each request (openPreview). Then update()'s state
    // so far, folded into one `update` and its assets (`replay`): a late copy has the same images,
    // hidden parts and status, and a caller that sets a status every few seconds does not grow the list.
    const afterOf = () => (typeof subject.after === 'function' ? subject.after() : subject.after && subject.after.length ? subject.after : [])
    const hasAfter = typeof subject.after === 'function' || (subject.after && subject.after.length > 0)
    const replay = { declared: [], assets: [], hide: new Set(), status: null }
    const replayed = () => {
      if (!replay.declared.length && !replay.hide.size && replay.status === null) return []
      return [{ type: 'update', assets: replay.declared, hide: [...replay.hide], ...(replay.status !== null ? { status: replay.status } : {}) }, ...replay.assets]
    }
    // The owner's Original | Reader choice (feature 'original'), kept like layout and split, so a reload or
    // the owner's other screen starts on it (a guest's copy starts on it too); a guest's switch stays in its
    // own copy. The caller's `view` until the owner switches.
    let docView = subject.originals ? sides.view : null
    let settle
    const opening = new Promise((resolve, reject) => (settle = { resolve, reject }))
    opening.catch(() => {}) // observed by focusExisting only when a second open comes in the wait
    const entry = { handle, page, opening, caller: subject.caller || null, html: !!subject.assets, draft: () => draft }
    // update(): more images for the open document (they join its asset budget), parts of it hidden,
    // a status line. Posted to the page as is: the page adds the images to the ones it has and leaves
    // the rendered document alone, so a note's anchor does not move. Live only to the copies whose
    // content went out; the others get it after their content.
    let budget = subject.assets ? review.assetBudget([subject.assets]) : null
    entry.update = (u, chain = []) => {
      // Checked on a copy: a refused update spends nothing of the budget.
      const next = { count: budget.count, total: budget.total, seen: new Set(budget.seen) }
      const assets = review.checkAssets(u.assets, 'update.assets', next)
      page.attribute(chain)
      budget = next
      const msgs = [
        { type: 'update', assets: assets.map(({ id, name, mime }) => ({ id, name, mime })), hide: u.hide, ...(u.status !== null ? { status: u.status } : {}) },
        ...assets.map(({ id, dataUrl }) => ({ type: 'asset', id, dataUrl })),
      ]
      // Live copies get each update as it comes; the replay keeps their sum (assets are bounded by the budget,
      // hide is a set, the status the last one; '' clears it, so it is kept too).
      replay.declared.push(...msgs[0].assets)
      replay.assets.push(...msgs.slice(1))
      for (const name of u.hide) replay.hide.add(name)
      if (u.status !== null) replay.status = u.status
      for (const msg of msgs) page.each(msg, (c) => c.content)
    }
    open.set(openKey, entry)
    // The draft is the host's (design-overlay-views §6, D-3): every copy that may edit sends note ops on
    // each change (applyOp), and Esc closes the overlay without asking a page, so the draft as the last op
    // left it is what Close keeps. Writes are coalesced: `pending` is the newest draft not
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
    let failed = null // the draft whose write failed (retried once at close)
    // Discuss's waits for the editing copies to say all their ops are out (`draft-sync`).
    const draftWaiters = new Set()
    // What the newest Discuss ask of each view handed the app: view -> { draft, text, cut, prompts }
    // (prompts: each tab's lastPrompt then, so a queued review's delivery is told from the prompt before
    // it), the newest ask last. An ask whose send never happened (a refused send) is replaced by that
    // view's next one; two screens that both asked leave two, and since the app's answer does not say
    // which was sent, a delivery clears only what both sent.
    const asks = new Map()
    // The copies that hold the draft (their init went out) and may change it: they get its save errors
    // and Discuss's sync asks. A read guest's copy sees the notes and nothing about saving them.
    const editors = (c) => c.inited && canNote(c.from)
    const toEditors = (msg) => page.each(msg, editors)
    // A note change to every other copy that holds the draft (never back to its sender: a late echo of an
    // older keystroke would overwrite what the person typed since).
    const toOthers = (msg, origin) => page.each(msg, (c) => c.inited && c !== origin)
    const draftErrorText = () => `Draft not saved: ${saveError}. The last saved draft is kept.`
    const showSaveError = (why) => {
      saveError = why
      toEditors({ type: 'draft-error', message: draftErrorText() })
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
              if (saveError) toEditors({ type: 'draft-saved' })
              saveError = null
              notesChanged(subject.path)
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

    /**
     * Resolves once every editing copy up now said its ops are all out (`draft-sync`: it answers after the
     * ops it sent before, on the same port), or after DRAFT_REQUEST_MS; at once with none up. Rejects when
     * an owner's copy holds text it could not send (`draft-unsaved`: over its size cap), as Discuss did
     * before notes were shared; a guest's unsent text is its own and does not stop the owner's Discuss.
     */
    function syncCopies() {
      return new Promise((resolve, reject) => {
        const waiting = new Set([...page.copies.values()].filter(editors).map((c) => c.id))
        const w = {
          waiting,
          resolve: () => (clearTimeout(w.timer), draftWaiters.delete(w), resolve()),
          reject: (e) => (clearTimeout(w.timer), draftWaiters.delete(w), reject(e)),
          timer: setTimeout(() => w.resolve(), DRAFT_REQUEST_MS),
        }
        if (!waiting.size) return w.resolve()
        draftWaiters.add(w)
        page.each({ type: 'draft-request' }, (c) => waiting.has(c.id))
      })
    }

    const mintId = () => {
      const ids = new Set(draft.notes.map((n) => n.id))
      let id
      do id = `n${Date.now().toString(36)}${noteSeq++}`
      while (ids.has(id))
      return id
    }
    /**
     * A note op of copy `c` (design-overlay-views §6): applied to the one draft by review.applyNoteOp,
     * saved, and told to every other copy that holds the draft; the adding copy gets its tag's id. Read
     * guests' ops are dropped (their copy draws no editing either). The author is main's `from.person` for a
     * guest and none for the owner, never anything the page says. An op whose result would lose text is
     * refused and only its sender told (an add, with its tag, so that page drops the note).
     */
    function applyOp(m, from, c) {
      if (!canNote(from) || !c.inited) return
      try {
        applyOpNow(m, from, c)
      } finally {
        // Each text op of a copy is acked to it, applied or not, in order with what the host sends it: while
        // the copy has one unacked, another copy's text for the same note (or the comment) is older than its
        // own and is not shown there, so the copy shows what the host ends up with (last writer wins).
        // By the id, also for a change the page named by its tag: the page has the id by then (note-added
        // went out before this ack).
        if (m.type === 'note-change') page.postTo(c, { type: 'ack', id: typeof m.id === 'string' ? m.id : typeof m.tag === 'string' ? c.tags.get(m.tag) || null : null })
        else if (m.type === 'global') page.postTo(c, { type: 'ack', global: true })
      }
    }
    function applyOpNow(m, from, c) {
      let op = m
      if ((m.type === 'note-change' || m.type === 'note-delete') && typeof m.id !== 'string') {
        // A note this copy added before its id came back: named by its own tag, only within this copy.
        op = { ...m, id: typeof m.tag === 'string' ? c.tags.get(m.tag) : undefined }
      }
      const r = review.applyNoteOp(draft, op, { author: isOwner(from) ? null : review.authorName(from.person) || 'Guest', mintId })
      if (r.ignored) return
      if (r.problem) {
        c.refused = true
        const what = m.type === 'note-add' ? 'Note not added' : 'Not saved'
        page.postTo(c, { type: 'draft-error', message: `${what}: ${r.problem}.`, ...(m.type === 'note-add' ? { tag: m.tag } : {}) })
        return
      }
      draft = r.draft
      if (m.type === 'note-add') {
        c.tags.set(m.tag, r.note.id)
        if (c.tags.size > MAX_COPY_TAGS) c.tags.delete(c.tags.keys().next().value)
        page.postTo(c, { type: 'note-added', tag: m.tag, note: r.note })
        toOthers({ type: 'note', note: r.note }, c)
      } else if (m.type === 'note-change') {
        toOthers({ type: 'note', note: r.note }, c)
      } else if (m.type === 'note-delete') {
        toOthers({ type: 'note-deleted', id: op.id }, c)
      } else {
        toOthers({ type: 'global', text: draft.global }, c)
      }
      // The copy's earlier refusal is over (unless a save is failing: that message stays).
      if (c.refused) {
        c.refused = false
        if (!saveError) page.postTo(c, { type: 'draft-saved' })
      }
      markDiscuss(draft)
      pending = draft
      clearTimeout(saveTimer)
      saveTimer = setTimeout(flush, DRAFT_SAVE_MS)
    }

    /** Opens `url` on the device of the view that asked (§6: a guest's click opens on the guest's own screen). */
    const openOn = (url, from, c) =>
      ctx.openExternal(url, { view: from.view }).catch((e) => page.postTo(c, { type: 'error', message: `Not opened in the browser: ${e.message.replace(/^openExternal: /, '')}` }))

    // What each page message does, by the access main filled in `from` (design-overlay-views §6's table).
    const onPageMessage = (m, from, c) => {
      const owner = isOwner(from)
      if (m.type === 'note-add' || m.type === 'note-change' || m.type === 'note-delete' || m.type === 'global') {
        applyOp(m, from, c)
      } else if (m.type === 'draft-sync' || m.type === 'draft-unsaved') {
        // A copy's answer to Discuss's sync ask. Only an owner's unsent text stops the Discuss.
        for (const w of [...draftWaiters]) {
          if (!w.waiting.has(c.id)) continue
          if (m.type === 'draft-unsaved' && owner) {
            w.reject(new Error('the draft is too large to send: shorten or delete a note first'))
            continue
          }
          w.waiting.delete(c.id)
          if (!w.waiting.size) w.resolve()
        }
      } else if (m.type === 'layout' && LAYOUTS.includes(m.layout)) {
        // The owner's app-wide pref; a guest's switch stays in its own copy (the page already switched).
        if (!owner) return
        layout = m.layout
        ctx.appStorage.set(LAYOUT_KEY, m.layout).catch((e) => ctx.log.error(`layout save: ${e.message}`))
      } else if (m.type === 'split' && subject.companion && splitOk(m.split)) {
        if (!owner) return
        split = m.split
        ctx.appStorage.set(SPLIT_KEY, m.split).catch((e) => ctx.log.error(`divider save: ${e.message}`))
      } else if (m.type === 'open-url') {
        // The page names no URL (it shows the caller's content in a sandboxed frame), only which
        // document's icon was clicked: the host opens the one it was given for it. The app refuses
        // some (user:pass@, 3 per 10 s): the page says why.
        const url = m.doc === 'companion' ? companionUrl : openUrl
        if (url !== null) openOn(url, from, c)
      } else if (m.type === 'open-link' && links !== null) {
        // A link clicked in the document or the details column. The href comes from the page, so it
        // opens only when the caller's own html or aside has that link (review.linkVerdict), and only
        // http(s): ctx.openExternal takes nothing else, so a mailto link is named, not opened.
        const v = review.linkVerdict(links, m.href)
        if (v.refuse) page.postTo(c, { type: 'error', message: v.refuse })
        else openOn(v.open, from, c)
      } else if (m.type === 'action' && owner && subject.actions && typeof m.id === 'string' && subject.actions.has(m.id)) {
        // A button of the caller's document (`data-action`), the owner's alone (a guest's copy draws
        // none): told to every consumer of the service (events have no single addressee), with the key
        // and the caller, so the one that annotated acts and the others ignore it. An id the caller's
        // strings never had is dropped above.
        try {
          ctx.services.emit('reviewer', 'action', { key: subject.key, id: m.id, caller: subject.caller })
        } catch (e) {
          ctx.log.warn(`action ${m.id}: ${e.message}`)
        }
      } else if (m.type === 'view' && owner && subject.originals && review.VIEWS.includes(m.view)) {
        // The owner switched between the Original and the Reader view (feature 'original'): kept as the
        // overlay's (docView: what a reload or a later copy starts on), and told to every consumer like an
        // action, with the key and the caller, so the caller can remember it (the Gmail plugin keeps it per
        // sender). The page has already switched; a guest's switch stays in its own copy.
        docView = m.view
        try {
          ctx.services.emit('reviewer', 'view', { key: subject.key, view: m.view, caller: subject.caller })
        } catch (e) {
          ctx.log.warn(`view ${m.view}: ${e.message}`)
        }
      } else if (m.type === 'content' && !c.content) {
        // Once per copy, to that copy (the same for every viewer: the caller's content and the file's
        // bytes carry no host path). A post that fails is logged and the page lives without it (an
        // image shows its alt text after assets-done).
        c.content = true
        const late = replayed()
        if (!hasAfter && !late.length) return
        try {
          page.attribute()
        } catch (e) {
          ctx.log.warn(`overlay sources: ${e.message}; no content sent`) // fail closed
          return
        }
        for (const msg of afterOf()) page.postTo(c, msg)
        for (const msg of late) page.postTo(c, msg)
      }
    }

    // The app's Discuss with Claude asks for the context (5 s): the review text built from the shared
    // draft, once the editing copies' ops in flight are in (syncCopies). Empty is fine (real-work
    // feedback 9): build() then asks Claude to discuss the file or the text. An owner's copy holding text
    // it could not send throws: the popover shows why and nothing is sent. The app adds `About:`, the
    // type line and the note.
    handle.onDiscuss(async (from) => {
      await syncCopies()
      // The shared draft as it is now (applyOp never changes a draft in place, so this snapshot stays
      // what was sent, whatever comes after).
      const sent = draft
      const { text, cut } = subject.build(sent)
      const prompts = new Map()
      try {
        for (const s of await ctx.sessions.list()) prompts.set(s.tabId, s.lastPrompt)
      } catch (e) {
        ctx.log.warn(`sessions.list: ${e.message}`)
      }
      // An older app gives no `from`: its asks count as one view's.
      const view = from && typeof from.view === 'string' ? from.view : ''
      asks.delete(view)
      asks.set(view, { draft: sent, text, cut, prompts })
      return { text }
    })

    // Every copy up now (prepare's loader, its error page) gets its init, later ones on their connect.
    // The page posts drafts as soon as it has its init: the listener above is in place first.
    page.fill({
      greet: (c) => {
        // Marked before the post: a page may answer its init at once (an op in the same turn).
        c.inited = true
        if (!page.postTo(c, initFor(c))) {
          c.inited = false
          // Only a draft grown since the open's size check gets here: this copy says so, the others live.
          // Its Close follows the error page's rule (makePage).
          c.errorPage = true
          page.postTo(c, { type: 'failed', message: `${what} is too large to show here (with its draft).`, retry: false })
          return
        }
        if (saveError && canNote(c.from)) page.postTo(c, { type: 'draft-error', message: draftErrorText() })
      },
      message: onPageMessage,
    })

    // start() gives no "shown" signal, but a refused overlay (3 open, 10 a minute, a closed window)
    // rejects `result` at once, while one that opened settles only when the person closes it. Wait
    // briefly for a rejection and throw it: a click then goes to the built-in viewer, and the service
    // and `ccc review` report the failure. The page's hooks are in place first, so a copy's
    // first drafts are handled during the wait. A person closing it within the wait is a
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
        await write(value)
        return kept
      } catch (e) {
        ctx.log.error(`draft save: ${e.message}`)
        return `The draft could not be saved: ${e.message}.`
      }
    }

    /**
     * The app sent the review ({ kind: 'discussed', tabId, queued }): what it sent goes from the draft once
     * all of it reached Claude, and only that (review.subtractSent: the notes unchanged since the snapshot,
     * the comment if unchanged), so a note added or edited on another screen while the popover was up
     * stays. A review cut to fit keeps the whole draft (deleting it lost the unsent part), and the person
     * is told; a queued one keeps it until the tab takes it (watchQueued). What is kept is the draft as it
     * is now, never the snapshot (which would write over the notes added since).
     */
    async function sentToClaude(res) {
      const asked = [...asks.values()]
      if (!asked.length) return // no context was asked for, so this is not the reviewer's text: keep the draft
      const sent = review.commonSent(asked.map((a) => a.draft))
      if (asked.some((a) => a.cut)) {
        ctx.notify(`Review of ${what} was too long and was cut at ${review.MAX_CONTEXT} characters. ${await keep(draft, 'The full draft is kept.')}`)
        return
      }
      if (res.queued) {
        const KEPT = 'The draft is kept until Claude gets it.'
        const kept = await keep(draft, KEPT)
        watchQueued({ what, draftKey, path: subject.path, tabId: res.tabId, texts: asked.map((a) => a.text), sentDraft: sent, prevPrompt: asked.at(-1).prompts.get(res.tabId), kept: kept === KEPT })
        return
      }
      // All of it reached Claude: only now does what it sent go. A failed write only leaves it.
      const left = review.subtractSent(draft, sent)
      draft = left
      await serialNotes(draftKey, () => write(left)).catch((e) => ctx.log.warn(`draft delete: ${e.message}`))
      notesChanged(subject.path)
    }

    const done = handle.result
      .then(async (res) => {
        await flush()
        for (const w of [...draftWaiters]) w.resolve()
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
    ctx.files.onOpen(async ({ path, tabId, requestedBy }) => {
      // Throwing before the overlay is up hands the click to the built-in viewer (binary, too
      // big, unreadable); after that, awaiting the overlay keeps the click ours. `requestedBy` (set by
      // main: the plugin whose ctx.files.open this is, outside any service call) is attributed before
      // the file's content leaves, so a guest who may not see that plugin never gets it (D-4).
      const sources = typeof requestedBy === 'string' && requestedBy !== '' ? [requestedBy] : []
      const { done } = await openReview(path, { tabId, sources })
      await done
    }),
  )

  ctx.services.provide('reviewer', {
    async open(path, options) {
      // The caller chain, read before the first await (start() adds it to the overlay too; kept with the
      // page so a copy that connects later re-asserts it).
      const sources = callersOf()
      try {
        const tabId = options && typeof options === 'object' && typeof options.tabId === 'string' ? options.tabId : undefined
        await openReview(path, { tabId, sources })
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
      // Its chain too (A -> B -> reviewer: both), kept with the content (makePage's attribute).
      const chain = callersOf()
      try {
        const r = await openAnnotation(options, caller, chain)
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
      const chain = callersOf()
      try {
        await prepareAnnotation(options, caller, chain)
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
      const chain = callersOf()
      try {
        return { failed: failPrepared(options, caller, chain) }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 too (app 0.9.3): the optional annotate features this reviewer has. An older one
    // rejects with "has no method", which a caller reads as none.
    async features() {
      return [...FEATURES]
    },
    // Additive in v1 (feature 'notes'): the line notes of a file's review, from the same draft the overlay
    // keeps (the open overlay's own copy while it is open, else the stored one). [{ id, from, to, text,
    // quote }] in line order: the working-tree side, the person's words, never the old side's or a PDF's.
    async notes(rel) {
      try {
        const p = notesPath(rel)
        const openEntry = open.get(`file:${p}`)
        const draft = openEntry && openEntry.draft ? openEntry.draft() : await ctx.storage.get(review.draftKey(p))
        return review.fileNotes(draft)
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 (feature 'notes'): one more line note on a file's working-tree side, in the same
    // stored draft the overlay reads when it opens, so the note is there at the next review and in what
    // Discuss sends. Refused while that file's review is open (its draft is the open review's and would write
    // over the note: the person adds it there), when the draft is full or too large, and for any input
    // the page's own note box would not take. Resolves { id }.
    async addNote(rel, note) {
      try {
        const p = notesPath(rel)
        const n = review.noteInput(note)
        const openKey = `file:${p}`
        if (isReviewing(openKey)) throw new files.ReviewError(`the review of ${p} is open: add the note there`)
        // Only a real file of the working tree gets a draft: a made-up path would fill the storage with
        // records the person never sees (no review opens them).
        let st = null
        try {
          st = fs.statSync(path.join(ctx.projectDir, p))
        } catch {}
        if (!st || !st.isFile()) throw new files.ReviewError(`${p} is not a file of this project`)
        const key = review.draftKey(p)
        const id = `e${Date.now().toString(36)}${noteSeq++}`
        await serialNotes(key, async () => {
          // Checked again: a review may have started to open while this waited its turn.
          if (isReviewing(openKey)) throw new files.ReviewError(`the review of ${p} is open: add the note there`)
          const draft = review.cleanDraft(await ctx.storage.get(key))
          draft.notes.push({ id, side: 'new', from: n.from, to: n.to, quote: n.quote, text: n.text })
          const problem = review.draftProblem(draft)
          if (problem) throw new files.ReviewError(`the note was not added: ${problem}`)
          await ctx.storage.set(key, draft)
        })
        notesChanged(p)
        return { id }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 (feature 'removeNotes'): the notes a caller sent to Claude on its own (the editor's
    // Ask Claude) go, as the notes of a review Discuss delivered do (watchQueued): only those
    // whose id and text still match what the caller read, so a note edited or added since stays; the
    // global comment is never touched (notes() does not give it, so no caller sent it). A draft left with
    // nothing in it is deleted. Refused while that file's review is open (its draft is the open review's and
    // would write the notes back), as addNote is. Resolves { removed } (0: nothing matched).
    async removeNotes(rel, list) {
      try {
        const p = notesPath(rel)
        const gone = review.noteRefs(list)
        const openKey = `file:${p}`
        if (isReviewing(openKey)) throw new files.ReviewError(`the review of ${p} is open: the notes stay there`)
        const key = review.draftKey(p)
        const removed = await serialNotes(key, async () => {
          if (isReviewing(openKey)) throw new files.ReviewError(`the review of ${p} is open: the notes stay there`)
          const raw = await ctx.storage.get(key)
          if (raw === null || raw === undefined) return 0
          const now = review.cleanDraft(raw)
          const left = { global: now.global, notes: now.notes.filter((n) => !gone.has(`${n.id}\0${n.text}`)) }
          const count = now.notes.length - left.notes.length
          if (count === 0) return 0
          if (review.isEmpty(left)) await ctx.storage.delete(key)
          else await ctx.storage.set(key, left)
          return count
        })
        if (removed > 0) notesChanged(p)
        return { removed }
      } catch (e) {
        throw new Error(`reviewer: ${e.message}`)
      }
    },
    // Additive in v1 (feature 'update', app 0.13.0): more images, hidden parts or a status line for an
    // open annotation of the same caller. The same answer for a key that is not open and one another
    // plugin annotated, so a caller learns nothing of the others' keys.
    async update(options) {
      const caller = callerOf()
      const chain = callersOf()
      try {
        const u = review.updateInput(options)
        const entry = open.get(`text:${u.key}`)
        if (!entry || !entry.html || !caller || entry.caller !== caller) throw new files.ReviewError(`no open HTML annotation with the key ${u.key}`)
        await entry.opening
        entry.update(u, chain)
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
