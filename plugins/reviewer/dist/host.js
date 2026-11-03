'use strict'
// Reviewer for cc-cockpit: a diff of a changed file against the last commit, in a large overlay,
// where the person selects text to attach notes, writes one comment for the whole file, and hands
// the review to Claude (Discuss: the tab whose file was clicked; New session: a fresh tab).
//
// Entry points, all ending in showReview():
// - a click on a changed file in the Sessions panel (ctx.files.onOpen, `contributes.openFile`);
// - the `reviewer` service (v1): open(path, { tabId? }), for the file tree and other plugins, and
//   annotate({ title, text | html, assets?, url?, key?, tabId? }): the same overlay on a text or an
//   HTML document another plugin hands over (a Jira issue, a mail), with no diff, no file and no Edit;
// - `ccc review <path>`.
//
// Plain JavaScript host; only the overlay page (overlay/) is bundled, by `npm run build`.

const files = require('./lib/files')
const review = require('./lib/review')

const OVERLAY_FILE = 'overlay/review.html'
const LAST_PROMPT_MAX = 80
const LAYOUT_KEY = 'layout' // ctx.appStorage: the person's last diff layout, the same in every project
const LAYOUTS = ['split', 'unified']
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
// How much of a queued review's start must match the tab's next prompt to count as delivered.
const MATCH_CHARS = 120

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

/** A prompt's start with control characters and runs of whitespace made one space (the send gate strips controls). */
const promptStart = (s) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f\s]+/g, ' ')
    .trim()
    .slice(0, MATCH_CHARS)

/**
 * The tab the picker starts on: `tabId` when it is one of the window's live Claude tabs (the app's
 * own click names the clicked tab; a service caller's id is only a wish), else the tab the window
 * shows (SessionInfo.active, "the tab the person is looking at"), else null: the page then picks
 * the only tab, or asks. `tabs` is tabsInfo()'s list (ended tabs already left out). Exported for tests.
 */
function defaultTab(tabs, tabId) {
  if (typeof tabId === 'string' && tabs.some((t) => t.tabId === tabId)) return tabId
  const shown = tabs.find((t) => t.active)
  return shown ? shown.tabId : null
}
exports.defaultTab = defaultTab

let disposers = []
// Ended on deactivate: the watches of queued reviews (their drafts stay kept), and the draft
// writers of open reviews (flushed, best effort, so a reload loses no pending write).
const watches = new Set()
const flushers = new Set()

exports.activate = (ctx) => {
  const root = async () => ctx.projectDir
  const exec = (argv) => ctx.exec(argv, { timeoutMs: 15000 })
  // The editor is whichever plugin the project uses for the "editor" service (cockpit.editor,
  // micro, by default). Resolved on every call, so it may come and go.
  const editor = ctx.services.use('editor')

  // One overlay per file (`file:<path>`) and per annotated text (`text:<key>`): a second open of
  // the same one brings the first to the front. `opening` settles when the first open has its
  // outcome (shown, or refused within OPEN_SETTLE_MS): a second caller during that wait reported
  // `{ opened: true }` for an overlay main then refused, so it waits for the same outcome instead.
  const open = new Map() // openKey -> { handle, opening: Promise<void> }

  /** Brings an open (or opening) review to the front once it is up; throws the first open's refusal. */
  async function focusExisting(entry) {
    await entry.opening
    entry.handle.focus()
    return { done: Promise.resolve() }
  }

  async function tabsInfo() {
    let list = []
    try {
      list = await ctx.sessions.list()
    } catch (e) {
      ctx.log.warn(`sessions.list: ${e.message}`)
    }
    return list
      .filter((s) => s.status !== 'ended')
      .map((s) => ({
        tabId: s.tabId,
        status: s.status,
        lastPrompt: (s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, LAST_PROMPT_MAX),
        active: s.active === true,
      }))
  }

  /**
   * A review queued in a busy tab is not delivered yet: main drops the queue when the tab ends
   * (logged only), so deleting the draft at send time lost the whole review then. The draft stays
   * stored until the tab's next prompt starts like the review (it reached Claude: the draft is
   * deleted, unless it changed since), or the tab ends first (the person is told; the draft stays).
   * `prevPrompt` is the tab's prompt before the send: the same review sent twice is not mistaken
   * for this one's delivery. No plugin API reports a queued item's fate, hence the prompt match.
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
      if (s && s.lastPrompt !== prevPrompt && promptStart(s.lastPrompt) === want) {
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
    const sides = await files.readSides(exec, r, rel)
    return showReview(
      {
        openKey: `file:${sides.path}`,
        draftKey: review.draftKey(sides.path),
        what: sides.path,
        overlayTitle: overlayTitle('Review: ', sides.path),
        sides,
        editPath: sides.path,
        build: (d) => review.buildReview(d, sides),
        tooLarge: `${sides.path} is too large to review (with escaping and its saved draft)`,
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
  async function openAnnotation(options) {
    const a = review.annotateInput(options)
    const base = { path: a.title, url: a.url, old: '', oldMissing: true, newMissing: false, note: null }
    let sides
    let after = []
    if (a.html !== null) {
      const parts = review.splitParts(a.html)
      sides = { ...base, mode: 'html', new: '', htmlParts: parts.length, assets: a.assets.map(({ id, name, mime }) => ({ id, name, mime })) }
      after = [
        ...parts.map((part, index) => ({ type: 'html', index, part })),
        ...a.assets.map(({ id, dataUrl }) => ({ type: 'asset', id, dataUrl })),
        { type: 'assets-done' },
      ]
    } else {
      sides = { ...base, mode: 'text', new: a.text }
    }
    return showReview(
      {
        openKey: `text:${a.key}`,
        draftKey: review.annotationKey(a.key),
        what: a.title,
        overlayTitle: overlayTitle('Notes: ', a.title),
        sides,
        after,
        editPath: null,
        build: (d) => review.buildAnnotation(d, a),
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
   * { type: 'content' }, each within the page message limit; may be absent), editPath (null: no Edit), build(draft) -> { text, cut }, and
   * tooLarge (the refusal when the init message would not fit).
   */
  async function showReview(subject, { tabId } = {}) {
    const { openKey, draftKey, what, sides } = subject
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    let draft = review.cleanDraft(await ctx.storage.get(draftKey))
    const tabs = await tabsInfo()
    const savedLayout = await ctx.appStorage.get(LAYOUT_KEY).catch(() => null)
    const layout = LAYOUTS.includes(savedLayout) ? savedLayout : 'split'
    const target = defaultTab(tabs, tabId)

    // Checked again after the awaits above: two quick clicks (or `ccc review` calls) on the same
    // file both pass the first check, and the second must focus the first overlay, not open
    // another. Nothing between here and open.set awaits, so the pair is atomic.
    if (open.has(openKey)) return focusExisting(open.get(openKey))
    // Measured before the overlay starts: MAX_SIDE_BYTES bounds the raw bytes, but JSON escaping (a
    // newline or a quote is two chars) and a saved draft can push the message past what post takes.
    // Throwing here hands a click to the built-in viewer; a post that threw after start would leave
    // a blank overlay cached in `open`, so that file never reopened.
    const init = { type: 'init', sides, draft, tabs, tabId: target, layout, canEdit: subject.editPath !== null && ctx.services.available('editor') }
    if (JSON.stringify(init).length > MAX_INIT_CHARS) {
      throw new files.ReviewError(subject.tooLarge, { fallback: true })
    }
    const handle = ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: subject.overlayTitle, size: 'large' })
    let after = subject.after && subject.after.length ? subject.after : null
    let settle
    const opening = new Promise((resolve, reject) => (settle = { resolve, reject }))
    opening.catch(() => {}) // observed by focusExisting only when a second open comes in the wait
    const entry = { handle, opening }
    open.set(openKey, entry)
    // Drafts arrive on every change: Esc closes the overlay without asking the page, so the last
    // posted draft is what Close keeps. Writes are coalesced: `pending` is the newest draft not
    // written yet, and flush() queues it behind the writes before it. A failed write is shown in
    // the page while it is open (draft-error, cleared by draft-saved once a later write works) and
    // in a notice when the overlay closes with it unresolved: the failure used to be only logged,
    // so Esc or Edit threw the unsaved text away without a word. Storage keeps the last good draft.
    let pending = null
    let saveTimer = null
    let saving = Promise.resolve()
    let saveError = null // why the newest text is not stored; null while it is
    let failed = null // the draft whose write failed (retried once at close); null for a draftProblem
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

    // Registered before init is posted: the page posts drafts and Edit as soon as it has loaded.
    handle.onMessage((m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'draft') {
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
        pending = draft
        clearTimeout(saveTimer)
        saveTimer = setTimeout(flush, DRAFT_SAVE_MS)
      } else if (m.type === 'layout' && LAYOUTS.includes(m.layout)) {
        ctx.appStorage.set(LAYOUT_KEY, m.layout).catch((e) => ctx.log.error(`layout save: ${e.message}`))
      } else if (m.type === 'edit' && subject.editPath !== null) {
        // Open the editor first and close the review only when that worked, so a missing editor
        // leaves the person where they were, with the reason. Not while the newest draft is
        // unsaved: closing then would lose it, so the review stays open and says so.
        const line = Number.isInteger(m.line) && m.line >= 1 ? m.line : undefined
        flush()
          .then(() => {
            if (saveError) return post({ type: 'error', message: `The editor is not opened while the draft is not saved (${saveError}).` })
            return editor.open(subject.editPath, { line }).then(() => handle.close())
          })
          .catch((e) => post({ type: 'error', message: e.message.replace(/^editor: /, '') }))
      } else if (m.type === 'tabs') {
        tabsInfo().then((t) => handle.post({ type: 'tabs', tabs: t }))
      } else if (m.type === 'content' && after) {
        // Once: the content is let go after it went out (it can be 10 MiB). A post that fails is
        // logged and the page lives without it (an image shows its alt text after assets-done).
        const list = after
        after = null
        for (const msg of list) post(msg)
      }
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
    // page's first drafts and an early Edit are handled during the wait. A person closing it within
    // the wait is a shown overlay; `done` below handles that result. A second open of the same file
    // during the wait finds the entry in `open` and waits on `opening`: it focuses the overlay once
    // shown, or throws the same refusal.
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

    const done = handle.result
      .then(async (res) => {
        await flush()
        const v = res && res.kind === 'value' && res.value && typeof res.value === 'object' ? res.value : null
        // Close, Esc, ✕: nothing is sent and the draft stays.
        if (!v || (v.action !== 'discuss' && v.action !== 'new')) return closedUnsaved()
        const raw = v.draft || draft
        const problem = review.draftProblem(raw)
        if (problem) {
          ctx.notify(`Review of ${what} not sent: ${problem}. The last saved draft is kept.`)
          return
        }
        const finalDraft = review.cleanDraft(raw)
        if (review.isEmpty(finalDraft)) return closedUnsaved()
        // A review past MAX_MESSAGE even without quotes goes out with its tail cut; the draft is
        // kept whole then (deleting it lost the unsent part), and the person is told.
        const { text, cut } = subject.build(finalDraft)
        // Stores the full draft whenever Claude may not get all of it; says whether that worked
        // (the send failing and the write failing too must not read "the draft is kept").
        const keep = async (kept) => {
          try {
            await ctx.storage.set(draftKey, finalDraft)
            return kept
          } catch (e) {
            ctx.log.error(`draft save: ${e.message}`)
            return `The draft could not be saved: ${e.message}.`
          }
        }
        let queued = false
        try {
          if (v.action === 'discuss') {
            const list = await ctx.sessions.list()
            const tab = list.find((s) => s.tabId === v.tabId && s.status !== 'ended')
            if (!tab) {
              ctx.notify(`Review not sent: that Claude tab is gone. ${await keep('The draft is kept.')}`)
              return
            }
            const sent = await ctx.sessions.send(v.tabId, text)
            if (sent && sent.queued) {
              queued = true
              const KEPT = 'The draft is kept until Claude gets it.'
              const kept = await keep(KEPT)
              watchQueued({ what, draftKey, tabId: v.tabId, text, sentDraft: finalDraft, prevPrompt: tab.lastPrompt, kept: kept === KEPT })
              const cutNote = cut ? ` It was too long and was cut at ${review.MAX_MESSAGE} characters.` : ''
              ctx.notify(`Review of ${what} queued: it is sent when Claude is waiting for input.${cutNote} ${kept}`)
            }
          } else {
            await ctx.sessions.open({ prompt: text })
          }
        } catch (e) {
          ctx.log.error(`review of ${what}: ${e.message}`)
          ctx.notify(`Review of ${what} not sent: ${e.message}. ${await keep('The draft is kept.')}`)
          return
        }
        if (queued) return
        if (cut) {
          ctx.notify(`Review of ${what} was too long and was cut at ${review.MAX_MESSAGE} characters. ${await keep('The full draft is kept.')}`)
          return
        }
        // All of it reached Claude: only now does the draft go. A failed delete only leaves it.
        await ctx.storage.delete(draftKey).catch((e) => ctx.log.warn(`draft delete: ${e.message}`))
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
      try {
        await openAnnotation(options)
        return { opened: true }
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
