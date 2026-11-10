'use strict'
// Files for cc-cockpit: a tree of the project folder in a panel, so the person can open any file of
// the project (changed or not) and discuss it with Claude. A click opens the file through the
// project's "Plugin used to open files" pick (ctx.files.open: the reviewer by default, the built-in
// viewer if that is the pick); Edit goes to the `editor` service (micro by default).
//
// The host owns the file system work: the page asks for a folder, the host reads it (full Node),
// asks git what is ignored and what changed, and watches every expanded folder so the tree follows
// what Claude writes. Design: docs/design.md.
//
// The right-click menu (0.2.0): the page draws it and sends one message per item. New file, New
// folder and Rename run here (lib/ops.js, confined to the project by real path); Reveal, Open with
// default app and Move to Trash go to main (ctx.files.reveal / openWithSystem / trash), which checks
// the path again, refuses runnable files and asks the person before the Trash; Ask Claude opens a
// Claude tab with a prompt naming the file (never its content); Open terminal here opens a shell tab
// in the folder (ctx.sessions.openShell: main checks the folder by real path, and the shell gets no
// command from here). Copy path is the page's own.
//
// "Open with" rules (0.3.0, app setting `openWith`, lib/open-with.js): a click on a file takes the
// first rule whose extensions match it: the system's default app, a terminal command (an overlay, or
// a command tab through ctx.sessions.openCommand), or the project's file opener. No rule: the opener,
// as before. The menu lists every matching rule and the opener, so a rule never locks the Reviewer
// out. The page only names a rule by its index; the host re-reads the setting and re-matches the path.

const fs = require('node:fs')
const path = require('node:path')
const tree = require('./lib/tree')
const ops = require('./lib/ops')
const openWith = require('./lib/open-with')

const PANEL = 'tree'
const EXPANDED_KEY = 'expanded' // ctx.storage (per project): the folders the person left open
const MAX_EXPANDED = 500
const MAX_WATCHERS = 200
const LIST_DEBOUNCE_MS = 250
const MARKS_DEBOUNCE_MS = 1000

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

/**
 * The prompt of "Ask Claude about this file": the path only. The file's content is never put in the
 * prompt (Claude reads it itself, with the person's permissions, and a prompt is an argv element
 * with a size limit); it starts with a letter, so it is never a slash command or a bash line.
 */
const askPrompt = (rel) => `Have a look at ${rel} in this project and tell me briefly what it does. Then wait for my questions.`

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

  const post = (m, view) => {
    try {
      ctx.panels.post(PANEL, m, view ? { view } : undefined)
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
    post({
      type: 'reset',
      expanded: [...expanded],
      settings: { hideHidden: options().hideHidden, hideIgnored: options().hideIgnored },
      // What the menu needs up front: Copy path writes the clipboard inside the click (the page's
      // user activation), so it cannot wait for an answer; the reveal label is per system; an older
      // app without ctx.files.reveal (and its siblings) gets a menu without those items, and one
      // without ctx.sessions.openShell no Open terminal here.
      env: {
        root,
        sep: path.sep,
        platform: process.platform,
        system: typeof ctx.files.reveal === 'function',
        shell: typeof ctx.sessions.openShell === 'function',
      },
      // The rules as the menu needs them (labels, extensions to match, why one cannot run); the
      // commands stay here.
      openWith: openWith.rulesOf(app().openWith).map((r, index) => ({ index, extensions: r.extensions || [], label: r.label || 'Rule', ...(r.error ? { error: r.error } : {}) })),
    })
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

  // ---- the menu's writes ----

  /** Forget expanded folders (and their watchers) at or under `rel`: it was renamed or trashed. */
  function forget(rel) {
    const gone = []
    for (const p of [...expanded]) {
      if (p !== '' && (p === rel || p.startsWith(rel + '/'))) {
        expanded.delete(p)
        unwatch(p)
        gone.push(p)
      }
    }
    return gone
  }

  /** After a write: re-read the folder that changed now (the watcher would, a little later) and the marks. */
  async function refreshAfter(dir, select) {
    if (expanded.has(dir) && (await sendDir(dir))) watch(dir)
    if (select !== undefined) post({ type: 'select', path: select })
    scheduleMarks()
  }

  async function create(m) {
    const dir = tree.normalizeRelative(m.dir)
    const rel = m.kind === 'dir' ? await ops.createFolder(root, dir, m.name) : await ops.createFile(root, dir, m.name)
    // The page expanded the folder before asking, so the new entry shows; the host follows.
    if (!expanded.has(dir)) {
      expanded.add(dir)
      saveExpanded()
    }
    await refreshAfter(dir, rel)
  }

  async function rename(m) {
    const from = tree.normalizeRelative(m.path)
    const to = await ops.renameEntry(root, from, m.name)
    if (to === from) return
    // An open folder stays open under its new name, with its open subfolders.
    const moved = forget(from).map((p) => to + p.slice(from.length))
    for (const p of moved) expanded.add(p)
    saveExpanded()
    if (moved.length === 0) return refreshAfter(parentOf(to), to)
    // Open folders moved: the page's expanded set and every listing below change, so all of it again.
    await sendAll()
    post({ type: 'select', path: to })
  }

  async function trash(rel) {
    try {
      await ctx.files.trash(rel)
    } catch (e) {
      // The person said no in the app's dialog: nothing happened, nothing to report.
      if (e && e.name === 'AbortError') return
      throw e
    }
    if (forget(rel).length > 0) saveExpanded()
    post({ type: 'gone', path: rel })
    await refreshAfter(parentOf(rel))
  }

  // ---- the page ----

  let searchSeq = 0
  disposers.push(
    ctx.panels.onMessage(PANEL, async (m, from) => {
      if (!m || typeof m !== 'object') return
      // A search answer and a failure belong to the page that asked (another view shows its own
      // query); the tree state everywhere else is shared, so it still goes to every view.
      const reply = (r) => post(r, from && from.view)
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
          await openFile(rel, m.rule)
        } else if (m.type === 'edit') {
          const rel = tree.normalizeRelative(m.path)
          try {
            await editor.open(rel, {})
          } catch (e) {
            const missing = /no enabled plugin/.test(e.message) && /"editor"/.test(e.message)
            throw new Error(missing ? 'No editor: turn on "Editor (micro)" (or another editor plugin) in Settings > Plugins.' : e.message.replace(/^editor: /, ''), { cause: e })
          }
        } else if (m.type === 'reveal') {
          await ctx.files.reveal(tree.normalizeRelative(m.path))
        } else if (m.type === 'open-system') {
          await ctx.files.openWithSystem(tree.normalizeRelative(m.path))
        } else if (m.type === 'trash') {
          await trash(tree.normalizeRelative(m.path))
        } else if (m.type === 'ask') {
          const rel = tree.normalizeRelative(m.path)
          if (rel === '') return
          await ctx.sessions.open({ prompt: askPrompt(rel), focus: true })
        } else if (m.type === 'terminal') {
          // A folder of the tree ('' the project folder); focused, because the person clicked.
          const rel = tree.normalizeRelative(m.path)
          await ctx.sessions.openShell({ cwd: rel === '' ? undefined : rel, focus: true })
        } else if (m.type === 'create') {
          await create(m)
        } else if (m.type === 'rename') {
          await rename(m)
        } else if (m.type === 'search') {
          const seq = ++searchSeq
          const all = await tree.searchablePaths(exec, root)
          if (seq !== searchSeq) return // a newer query is on its way
          const { paths, total } = tree.rankMatches(all, m.query, { hideHidden: options().hideHidden })
          reply({ type: 'results', query: m.query, paths, total })
        }
      } catch (e) {
        reply({ type: 'error', message: e.message })
      }
    }),
  )

  // ---- Open with ----

  /**
   * Opens a file: `rule` undefined (a click) takes the first matching rule, an index (the menu) that
   * rule if it still matches the path, -1 (the menu's "Open in file viewer") the project's opener.
   * A rule that cannot run throws, so the person sees why instead of something else opening.
   */
  async function openFile(rel, rule) {
    const matches = openWith.matchRules(rel, openWith.rulesOf(app().openWith))
    let r
    if (rule === undefined) r = matches[0]
    else if (rule !== -1) {
      r = matches.find((x) => x.index === rule)
      if (!r) throw new Error('That rule does not match this file any more (the settings changed): reopen the menu.')
    }
    if (!r || r.action === 'default') return ctx.files.open(rel)
    const name = `Open with rule ${r.index + 1} (${r.extensions.join(', ')})`
    if (r.error) throw new Error(`${name}: ${r.error}. Change it in Settings > Plugins > Files.`)
    if (r.action === 'system') return ctx.files.openWithSystem(rel)
    const argv = openWith.buildArgv(r, rel)
    const base = rel.split('/').pop()
    if (r.where === 'tab' && typeof ctx.sessions.openCommand === 'function') {
      // A tab title is 1-60 chars on one line: the program and the file name, cut at the end.
      const title = `${r.words[0].split('/').pop()}: ${base}`.replace(/\s+/g, ' ')
      return ctx.sessions.openCommand({ argv, title: title.length > 60 ? `${title.slice(0, 59)}…` : title, focus: true })
    }
    // An overlay (also for a tab rule on an app without openCommand). Not awaited to its end: it
    // settles when the person closes it. A refusal (too many overlays) rejects at once: shown.
    const full = `${r.words[0].split('/').pop()}: ${rel}`
    const handle = ctx.overlay.start({ kind: 'terminal', argv, title: full.length > 200 ? `${full.slice(0, 199)}…` : full, size: 'large' })
    handle.result.then(
      (res) => {
        if (res && res.kind === 'exit' && res.code === 127) post({ type: 'error', message: `${name}: ${r.words[0]} was not found (exit 127).` })
      },
      (e) => post({ type: 'error', message: `${name}: ${e.message}` }),
    )
  }

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
