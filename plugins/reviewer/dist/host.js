'use strict'
// Reviewer for cc-cockpit: a diff of a changed file against the last commit, in a large overlay,
// where the person selects text to attach notes, writes one comment for the whole file, and hands
// the review to Claude (Discuss: the tab whose file was clicked; New session: a fresh tab).
//
// Entry points, all ending in openReview():
// - a click on a changed file in the Sessions panel (ctx.files.onOpen, `contributes.openFile`);
// - the `reviewer` service (v1): open(path, { tabId? }), for the file tree and other plugins;
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

let disposers = []

exports.activate = (ctx) => {
  const root = async () => ctx.projectDir
  const exec = (argv) => ctx.exec(argv, { timeoutMs: 15000 })
  // The editor is whichever plugin the project uses for the "editor" service (cockpit.editor,
  // micro, by default). Resolved on every call, so it may come and go.
  const editor = ctx.services.use('editor')

  // One overlay per file: a second open of the same file brings the first to the front. `opening`
  // settles when the first open has its outcome (shown, or refused within OPEN_SETTLE_MS): a second
  // caller during that wait reported `{ opened: true }` for an overlay main then refused, so it
  // waits for the same outcome instead.
  const open = new Map() // path -> { handle, opening: Promise<void> }

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
      }))
  }

  /**
   * Opens the review overlay for a project-relative path. Resolves once the overlay is up, with
   * `done` (the promise of its end), so the openFile listener can keep running (a listener still
   * running after 1 s counts as handled) while a service caller does not wait for the person.
   * Throws before anything is shown when the file cannot be reviewed; for a click, that sends it
   * to the built-in viewer.
   */
  async function openReview(rel, { tabId } = {}) {
    const r = await root()
    const sides = await files.readSides(exec, r, rel)
    if (open.has(sides.path)) return focusExisting(open.get(sides.path))
    const draftKey = review.draftKey(sides.path)
    let draft = review.cleanDraft(await ctx.storage.get(draftKey))
    const tabs = await tabsInfo()
    const savedLayout = await ctx.appStorage.get(LAYOUT_KEY).catch(() => null)
    const layout = LAYOUTS.includes(savedLayout) ? savedLayout : 'split'
    // A tab id from a service caller is checked against this window's tabs (the app's own click
    // gives one it knows). An unknown id is dropped, and the page asks which tab.
    const target = tabs.some((t) => t.tabId === tabId) ? tabId : null

    // Checked again after the awaits above: two quick clicks (or `ccc review` calls) on the same
    // file both pass the first check, and the second must focus the first overlay, not open
    // another. Nothing between here and open.set awaits, so the pair is atomic.
    if (open.has(sides.path)) return focusExisting(open.get(sides.path))
    // Measured before the overlay starts: MAX_SIDE_BYTES bounds the raw bytes, but JSON escaping (a
    // newline or a quote is two chars) and a saved draft can push the message past what post takes.
    // Throwing here hands a click to the built-in viewer; a post that threw after start would leave
    // a blank overlay cached in `open`, so that file never reopened.
    const init = { type: 'init', sides, draft, tabs, tabId: target, layout, canEdit: ctx.services.available('editor') }
    if (JSON.stringify(init).length > MAX_INIT_CHARS) {
      throw new files.ReviewError(`${sides.path} is too large to review (with escaping and its saved draft)`, { fallback: true })
    }
    const handle = ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: overlayTitle('Review: ', sides.path), size: 'large' })
    let settle
    const opening = new Promise((resolve, reject) => (settle = { resolve, reject }))
    opening.catch(() => {}) // observed by focusExisting only when a second open comes in the wait
    const entry = { handle, opening }
    open.set(sides.path, entry)
    // Registered before init is posted: the page posts drafts and Edit as soon as it has loaded.
    // Drafts arrive on every change (debounced in the page): Esc closes the overlay without
    // asking the page, so the last posted draft is what Close keeps.
    let saving = Promise.resolve()
    handle.onMessage((m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'draft') {
        draft = review.cleanDraft(m.draft)
        const value = review.isEmpty(draft) ? null : draft
        saving = saving
          .then(() => (value ? ctx.storage.set(draftKey, value) : ctx.storage.delete(draftKey)))
          .catch((e) => ctx.log.error(`draft save: ${e.message}`))
      } else if (m.type === 'layout' && LAYOUTS.includes(m.layout)) {
        ctx.appStorage.set(LAYOUT_KEY, m.layout).catch((e) => ctx.log.error(`layout save: ${e.message}`))
      } else if (m.type === 'edit') {
        // Open the editor first and close the review only when that worked, so a missing editor
        // leaves the person where they were, with the reason. The draft is already saved.
        const line = Number.isInteger(m.line) && m.line >= 1 ? m.line : undefined
        editor
          .open(sides.path, { line })
          .then(() => handle.close())
          .catch((e) => handle.post({ type: 'error', message: e.message.replace(/^editor: /, '') }))
      } else if (m.type === 'tabs') {
        tabsInfo().then((t) => handle.post({ type: 'tabs', tabs: t }))
      }
    })

    try {
      handle.post(init)
    } catch (e) {
      open.delete(sides.path)
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
      if (open.get(sides.path) === entry) open.delete(sides.path)
      const err = new files.ReviewError(`the review overlay did not open: ${ended.error.message}`, { fallback: true })
      settle.reject(err)
      throw err
    }
    settle.resolve()

    const done = handle.result
      .then(async (res) => {
        await saving
        // Close, Esc, ✕: nothing is sent and the draft stays.
        if (!res || res.kind !== 'value' || !res.value || typeof res.value !== 'object') return
        const v = res.value
        const finalDraft = review.cleanDraft(v.draft || draft)
        if (review.isEmpty(finalDraft)) return
        // A review past MAX_MESSAGE even without quotes goes out with its tail cut; the draft is
        // kept whole then (deleting it lost the unsent part), and the person is told.
        const { text, cut } = review.buildReview(finalDraft, sides)
        if (v.action === 'discuss') {
          const tabsNow = await tabsInfo()
          if (!tabsNow.some((t) => t.tabId === v.tabId)) {
            await ctx.storage.set(draftKey, finalDraft)
            ctx.notify('Review not sent: that Claude tab is gone. The draft is kept.')
            return
          }
          const sent = await ctx.sessions.send(v.tabId, text)
          if (sent && sent.queued) ctx.notify(`Review of ${sides.path} queued: it is sent when Claude is waiting for input.`)
        } else if (v.action === 'new') {
          await ctx.sessions.open({ prompt: text })
        } else {
          return
        }
        if (cut) {
          await ctx.storage.set(draftKey, finalDraft)
          ctx.notify(`Review of ${sides.path} was too long and was cut at ${review.MAX_MESSAGE} characters. The full draft is kept.`)
          return
        }
        await ctx.storage.delete(draftKey)
      })
      .catch((e) => {
        ctx.log.error(`review of ${sides.path}: ${e.message}`)
        ctx.notify(`Review not sent: ${e.message}. The draft is kept.`)
      })
      .finally(() => {
        if (open.get(sides.path) === entry) open.delete(sides.path)
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
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      // nothing left to clean up in a reloading host
    }
  }
  disposers = []
}
