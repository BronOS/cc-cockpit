'use strict'
// Files for cc-cockpit: a tree of the project folder in a panel, so the person can open any file of
// the project (changed or not) and discuss it with Claude. A click opens the file through the
// project's "Plugin used to open files" pick (ctx.files.open: the reviewer by default, the built-in
// viewer if that is the pick); Edit goes to the `editor` service (micro by default).
//
// The host owns the file system work: the page asks for a folder, the host reads it (full Node),
// asks git what is ignored and what changed, and watches every expanded folder so the tree follows
// what Claude writes. Design: docs/design.md.

const fs = require('node:fs')
const path = require('node:path')
const tree = require('./lib/tree')

const PANEL = 'tree'
const EXPANDED_KEY = 'expanded' // ctx.storage (per project): the folders the person left open
const MAX_EXPANDED = 500
const MAX_WATCHERS = 200
const LIST_DEBOUNCE_MS = 250
const MARKS_DEBOUNCE_MS = 1000

let disposers = []

exports.activate = (ctx) => {
  const root = ctx.projectDir
  const exec = (argv, opts = {}) => ctx.exec(argv, { timeoutMs: 10000, ...opts })
  const editor = ctx.services.use('editor')
  const app = () => ctx.settings.app || {}
  const options = () => ({ exec, hideHidden: app().hideHidden === true, hideIgnored: app().hideIgnored === true })

  /** Expanded folders ('' is the root, always open). Kept in order of opening. */
  let expanded = new Set([''])
  const loaded = ctx.storage
    .get(EXPANDED_KEY)
    .then((v) => {
      if (Array.isArray(v)) {
        for (const p of v.slice(0, MAX_EXPANDED)) {
          try {
            expanded.add(tree.normalizeRelative(p))
          } catch {
            // a stale or bad entry: dropped
          }
        }
      }
    })
    .catch((e) => ctx.log.warn(`expanded: ${e.message}`))
  const saveExpanded = () =>
    ctx.storage.set(EXPANDED_KEY, [...expanded].filter(Boolean).slice(0, MAX_EXPANDED)).catch((e) => ctx.log.error(`expanded save: ${e.message}`))

  const post = (m) => {
    try {
      ctx.panels.post(PANEL, m)
    } catch (e) {
      ctx.log.warn(`post: ${e.message}`)
    }
  }

  // ---- reading ----

  async function sendDir(rel) {
    try {
      const listing = await tree.listDir(root, rel, options())
      post({ type: 'dir', ...listing })
      return true
    } catch (e) {
      // A folder that vanished (Claude deleted it) closes quietly; anything else is shown.
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        if (rel !== '') {
          expanded.delete(rel)
          unwatch(rel)
          saveExpanded()
        }
        post({ type: 'gone', path: rel })
      } else {
        post({ type: 'dir', path: rel, entries: [], more: 0, error: e.message })
      }
      return false
    }
  }

  let marksTimer = null
  async function sendMarks() {
    post({ type: 'marks', ...(await tree.gitMarks(exec)) })
  }
  const scheduleMarks = () => {
    clearTimeout(marksTimer)
    marksTimer = setTimeout(() => sendMarks().catch((e) => ctx.log.warn(`marks: ${e.message}`)), MARKS_DEBOUNCE_MS)
  }

  async function sendAll() {
    await loaded
    post({ type: 'reset', expanded: [...expanded], settings: { hideHidden: options().hideHidden, hideIgnored: options().hideIgnored } })
    // Parents before children, so the page always has the row it opens.
    const order = [...expanded].sort((a, b) => a.split('/').length - b.split('/').length)
    for (const rel of order) {
      if (await sendDir(rel)) watch(rel)
    }
    await sendMarks()
  }

  // ---- watching ----
  // fs.watch per expanded folder (not recursive: a recursive watch of a project with node_modules
  // would cost more than the whole tree). An event re-reads only that folder, debounced, and the git
  // marks after a longer pause. Watchers are capped: past the cap the refresh button still works.

  const watchers = new Map() // rel -> { w, timer }
  function watch(rel) {
    if (watchers.has(rel) || watchers.size >= MAX_WATCHERS) return
    try {
      const w = fs.watch(path.join(root, rel), { persistent: false }, () => {
        const entry = watchers.get(rel)
        if (!entry) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => sendDir(rel), LIST_DEBOUNCE_MS)
        scheduleMarks()
      })
      w.on('error', () => unwatch(rel))
      watchers.set(rel, { w, timer: null })
    } catch (e) {
      ctx.log.warn(`watch ${rel || '.'}: ${e.message}`)
    }
  }
  function unwatch(rel) {
    const entry = watchers.get(rel)
    if (!entry) return
    clearTimeout(entry.timer)
    try {
      entry.w.close()
    } catch {
      // already closed
    }
    watchers.delete(rel)
  }
  // A commit, a stage or a checkout changes git's marks without touching an expanded folder: watch
  // the git dir itself (not recursive) for its index and HEAD.
  exec(['git', 'rev-parse', '--absolute-git-dir'])
    .then((r) => {
      if (r.code !== 0) return
      const gitDir = String(r.stdout).trim()
      try {
        const w = fs.watch(gitDir, { persistent: false }, (_ev, name) => {
          if (name === 'index' || name === 'HEAD') scheduleMarks()
        })
        w.on('error', () => {})
        disposers.push(() => w.close())
      } catch (e) {
        ctx.log.warn(`watch git dir: ${e.message}`)
      }
    })
    .catch(() => {})
  disposers.push(() => {
    clearTimeout(marksTimer)
    for (const rel of [...watchers.keys()]) unwatch(rel)
  })

  // ---- the page ----

  let searchSeq = 0
  disposers.push(
    ctx.panels.onMessage(PANEL, async (m) => {
      if (!m || typeof m !== 'object') return
      try {
        if (m.type === 'hello' || m.type === 'refresh') {
          await sendAll()
        } else if (m.type === 'expand') {
          const rel = tree.normalizeRelative(m.path)
          expanded.add(rel)
          saveExpanded()
          if (await sendDir(rel)) watch(rel)
        } else if (m.type === 'collapse') {
          const rel = tree.normalizeRelative(m.path)
          if (rel === '') return
          // Its open subfolders close with it, as in any tree.
          for (const p of [...expanded]) {
            if (p === rel || p.startsWith(rel + '/')) {
              expanded.delete(p)
              unwatch(p)
            }
          }
          saveExpanded()
        } else if (m.type === 'open') {
          const rel = tree.normalizeRelative(m.path)
          await ctx.files.open(rel)
        } else if (m.type === 'edit') {
          const rel = tree.normalizeRelative(m.path)
          try {
            await editor.open(rel, {})
          } catch (e) {
            const missing = /no enabled plugin/.test(e.message) && /"editor"/.test(e.message)
            throw new Error(missing ? 'No editor: turn on "Editor (micro)" (or another editor plugin) in Settings > Plugins.' : e.message.replace(/^editor: /, ''), { cause: e })
          }
        } else if (m.type === 'search') {
          const seq = ++searchSeq
          const all = await tree.searchablePaths(exec, root)
          if (seq !== searchSeq) return // a newer query is on its way
          const { paths, total } = tree.rankMatches(all, m.query, { hideHidden: options().hideHidden })
          post({ type: 'results', query: m.query, paths, total })
        }
      } catch (e) {
        post({ type: 'error', message: e.message })
      }
    }),
  )

  disposers.push(ctx.onSettingsChange(() => sendAll().catch((e) => ctx.log.warn(`settings: ${e.message}`))))

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
