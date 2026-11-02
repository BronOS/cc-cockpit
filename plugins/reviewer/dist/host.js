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

let disposers = []

exports.activate = (ctx) => {
  const root = async () => ctx.projectDir
  const exec = (argv) => ctx.exec(argv, { timeoutMs: 15000 })
  // The editor is whichever plugin the project uses for the "editor" service (cockpit.editor,
  // micro, by default). Resolved on every call, so it may come and go.
  const editor = ctx.services.use('editor')

  // One overlay per file: a second open of the same file brings the first to the front.
  const open = new Map() // path -> OverlayHandle

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
    if (open.has(sides.path)) {
      open.get(sides.path).focus()
      return { done: Promise.resolve() }
    }
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
    if (open.has(sides.path)) {
      open.get(sides.path).focus()
      return { done: Promise.resolve() }
    }
    const handle = ctx.overlay.start({ kind: 'html', file: OVERLAY_FILE, title: `Review: ${sides.path}`, size: 'large' })
    open.set(sides.path, handle)
    handle.post({ type: 'init', sides, draft, tabs, tabId: target, layout, canEdit: ctx.services.available('editor') })

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

    const done = handle.result
      .then(async (res) => {
        await saving
        // Close, Esc, ✕: nothing is sent and the draft stays.
        if (!res || res.kind !== 'value' || !res.value || typeof res.value !== 'object') return
        const v = res.value
        const finalDraft = review.cleanDraft(v.draft || draft)
        if (review.isEmpty(finalDraft)) return
        const text = review.formatReview(finalDraft, sides)
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
        await ctx.storage.delete(draftKey)
      })
      .catch((e) => {
        ctx.log.error(`review of ${sides.path}: ${e.message}`)
        ctx.notify(`Review not sent: ${e.message}. The draft is kept.`)
      })
      .finally(() => open.delete(sides.path))
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
