'use strict'
// Editor for cc-cockpit (design-editor.md): open files are tabs in the main tab bar (`contributes.tabs`
// type `file`), edited with CodeMirror 6 in the page dist/pages/file.html (built from src/page by
// `npm run build:editor`); this host reads and saves them (lib/files.js: compare-and-swap, a watch
// per folder). micro (https://micro-editor.github.io), the terminal editor this plugin used to be,
// stays as "Open in micro" on a file tab, and is what an app without page tabs gets.
//
// It provides the "editor" plugin service (v1):
//
//   const editor = ctx.services.use('editor')
//   await editor.open(path, { line?, col? })   // path relative to the project folder: its file tab
//
// Files' Edit uses it. Any plugin that provides "editor" v1 can replace this one (Settings > This
// Project, "Plugin used for editor"). `ccc edit <file>[:line[:col]]` opens the file's tab at
// that position without selecting it (the unseen dot); micro on an app without page tabs.
//
// It also adds "Edit" to every overlay of the well-known type `file` { path } (a review, a file
// shown by another plugin) for a text file of the project: the file's tab, and the overlay closes.

const fs = require('node:fs')
const path = require('node:path')
const files = require('./lib/files.js')
const search = require('./lib/search.js')
const git = require('./lib/git.js')
const { LspManager } = require('./lib/lsp/manager.js')
const { serveLsp } = require('./lib/lsp/serve.js')

const INSTALL_HINT =
  'micro is not installed (or not on your login-shell PATH). Install it with `brew install micro` (macOS), ' +
  '`sudo pacman -S micro` (Arch) or `sudo apt install micro` (Debian, Ubuntu), or see https://micro-editor.github.io. ' +
  'If it is installed elsewhere, set its path in Settings > Plugins > Editor, setting "microPath".'

// How long open() waits for the overlay to be refused before it counts it as shown. A refusal comes
// back in one host-to-main round trip, far under this.
const OPEN_SETTLE_MS = 500
// main refuses an overlay title over 200 chars (overlay.start); a long path keeps its tail, the file name.
const MAX_TITLE_CHARS = 200

/** `prefix` + `p`, cut from the left with a leading … so it fits main's title limit. */
function overlayTitle(prefix, p) {
  const full = prefix + p
  if (full.length <= MAX_TITLE_CHARS) return full
  return prefix + '…' + p.slice(p.length - (MAX_TITLE_CHARS - prefix.length - 1))
}

const EDIT_USAGE = 'usage: ccc edit <file>[:line[:col]]   open a file of this project in the editor at a position (the tab is marked, never selected)'

/**
 * `path[:line[:col]]` (also the old `path line` form). Trailing all-digit segments are the
 * position, at most two, 1-based; a path with colons of its own still works because only digit-only
 * tails count (`a:b.txt:3` is file `a:b.txt`, line 3). A name that itself ends in `:<digits>` is
 * reached only with a full position after it (`a:12:1:1` is file `a:12`, line 1, column 1): at most
 * two tails are taken. No ranges or `#L` forms: `a.ts:12-20` is a file of that name (and refused by
 * `ccc edit` when it does not exist). Throws a usage line or a message on a bad position. Exported for tests.
 */
function parseTarget(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 2 || typeof argv[0] !== 'string') throw new Error(EDIT_USAGE)
  let file = argv[0]
  const nums = []
  while (nums.length < 2) {
    const i = file.lastIndexOf(':')
    const tail = i > 0 ? file.slice(i + 1) : ''
    if (tail.length === 0 || tail.length > 9 || [...tail].some((c) => c < '0' || c > '9')) break
    nums.unshift(Number(tail))
    file = file.slice(0, i)
  }
  if (argv.length === 2) {
    const n = argv[1]
    if (nums.length || typeof n !== 'string' || n.length === 0 || n.length > 9 || [...n].some((c) => c < '0' || c > '9')) throw new Error(EDIT_USAGE)
    nums.push(Number(n))
  }
  if (nums.some((n) => n < 1)) throw new Error('line and column count from 1')
  return { file, line: nums[0], col: nums[1] }
}

/**
 * A project-relative path, or a thrown Error: no absolute path, no `..`, no NUL. A backslash is a
 * separator only where the OS says so (Windows): on macOS and Linux `a\b.js` is one valid file name,
 * and turning it into `a/b.js` opened a different file.
 */
function relativePath(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('path must be a non-empty string')
  if (path.isAbsolute(p)) throw new Error(`path must be relative to the project folder: ${p}`)
  const norm = path.posix.normalize(path.sep === '\\' ? p.replace(/\\/g, '/') : p)
  if (norm === '..' || norm.startsWith('../') || norm === '.') throw new Error(`path leaves the project folder: ${p}`)
  return norm.replace(/^\.\//, '')
}

// The Edit button's file check: what the button provider may read (it has 500 ms), and what counts
// as a text file micro can open: a regular file, no NUL byte in its first BINARY_SNIFF_BYTES.
const BINARY_SNIFF_BYTES = 8000
const MAX_EDIT_BYTES = 64 * 1024 * 1024

/**
 * The project-relative path of a `file` overlay's data when it names a text file of the project
 * micro can open, else null. The data came from the overlay's opener (any plugin), so it is
 * checked as `editor.open` checks a path (relativePath), and after following symlinks the file must
 * still lie inside the project folder: a link to ~/.ssh/config gets no Edit. Exported for tests.
 */
function editableFile(root, data) {
  if (!data || typeof data !== 'object' || typeof data.path !== 'string') return null
  let rel
  try {
    rel = relativePath(data.path)
  } catch {
    return null
  }
  let fd
  try {
    const realRoot = fs.realpathSync(root)
    const real = fs.realpathSync(path.join(realRoot, rel))
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
    const st = fs.statSync(real)
    // A FIFO or a device would block the read (and the whole plugin host): regular files only.
    if (!st.isFile() || st.size > MAX_EDIT_BYTES) return null
    fd = fs.openSync(real, 'r')
    const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    if (buf.subarray(0, n).includes(0)) return null
  } catch {
    return null // missing, unreadable: nothing to edit
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return rel
}

/** The manifest's default of autosaveIdleSeconds, said in its description (the schema has no `default`, see autosaveOf). */
const DEFAULT_IDLE_SECONDS = 3
const MAX_IDLE_SECONDS = 3600
/** The default micro's old `autosaveSeconds` had; see autosaveOf. */
const LEGACY_DEFAULT_SECONDS = 5
const idleOk = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_IDLE_SECONDS

/** A file tab's title starts with this while a view holds a conflict (see updateMarker). */
const CONFLICT_MARK = '⚠ '
/** How long a closed line's conflict report outlives it (a reconnect's new line reports within it). */
const MARKER_GRACE_MS = 3000
/** The grace timers, cleared when the plugin stops. */
const markerTimers = new Set()

/**
 * The file tabs' autosave from the app settings: `{ idleSeconds, onBlur }`. `autosaveIdleSeconds`
 * replaced micro's `autosaveSeconds` (design-editor.md §1: "read once as a default"), so the schema
 * gives the new field no `default` (ctx.settings would fill it in and hide that it was never set) and
 * an old `autosaveSeconds` the person had set, still in the stored values though no longer in the
 * schema, is the default until they set the new one. micro's own autosave follows the same value.
 * Exported for tests.
 */
function autosaveOf(app) {
  const a = app || {}
  // 5 was the old field's schema default, which main stores with every settings save (defaults are
  // applied before storing): a stored 5 cannot be told from one the person chose, so it counts as unset.
  const legacy = idleOk(a.autosaveSeconds) && a.autosaveSeconds !== LEGACY_DEFAULT_SECONDS ? a.autosaveSeconds : undefined
  const idleSeconds = idleOk(a.autosaveIdleSeconds) ? a.autosaveIdleSeconds : legacy !== undefined ? legacy : DEFAULT_IDLE_SECONDS
  return { idleSeconds, onBlur: a.autosaveOnBlur !== false }
}

/** micro's argv: options first, then the file, then +LINE. Exported for tests. */
function microArgv(app, rel, line) {
  const argv = [app.microPath || 'micro']
  argv.push('-autosave', String(autosaveOf(app).idleSeconds))
  if (app.colorscheme && /^[A-Za-z0-9._-]+$/.test(app.colorscheme)) argv.push('-colorscheme', app.colorscheme)
  // A file name starting with '-' or '+' would read as an option; './' keeps it a file.
  argv.push(/^[-+]/.test(rel) ? `./${rel}` : rel)
  const n = Math.floor(Number(line))
  if (n >= 1) argv.push(`+${n}`)
  return argv
}

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

/**
 * Whether a project file opens in a file tab: a binary one (a NUL in its first BINARY_SNIFF_BYTES)
 * goes to the project's file opener instead (the reviewer shows images and PDFs, else the app's
 * built-in viewer). `real` is the realpath resolveInProject checked; only a regular file is read (a
 * FIFO would block the host). A missing file opens a tab (a new file, created by its first save).
 */
function isBinaryFile(real) {
  let fd
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) throw new Error('not a regular file')
    fd = fs.openSync(real, 'r')
    const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** A positive whole number from `v` (a line or a column from a caller), else undefined. */
function position(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1 ? n : undefined
}

exports.autosaveOf = autosaveOf
exports.microArgv = microArgv
exports.relativePath = relativePath
exports.editableFile = editableFile
exports.parseTarget = parseTarget
exports.overlayTitle = overlayTitle
exports.INSTALL_HINT = INSTALL_HINT

exports.activate = (ctx) => {
  const app = () => ctx.settings.app || {}

  // micro's presence is checked once per binary path, not on every open.
  const checked = new Set()
  async function ensureMicro(bin) {
    if (checked.has(bin)) return
    let ok = false
    try {
      const r = await ctx.exec([bin, '-version'], { timeoutMs: 10000 })
      ok = r.code === 0 && /version/i.test(r.stdout)
    } catch {
      ok = false // not found: exec rejects when the program cannot be started
    }
    if (!ok) throw new Error(INSTALL_HINT)
    checked.add(bin)
  }

  async function openEditor(p, line) {
    const rel = relativePath(p)
    const a = app()
    await ensureMicro(a.microPath || 'micro')
    // The terminal's cwd defaults to the project folder, so the relative path resolves there.
    const handle = ctx.overlay.start({ kind: 'terminal', argv: microArgv(a, rel, line), title: overlayTitle('Edit: ', rel), size: 'large' })
    // start() gives no "shown" signal, but a refused overlay (3 open, 10 a minute, a failed spawn)
    // rejects `result` at once, and micro failing right after spawning (bad option, unreadable
    // terminal) resolves it with a nonzero exit; one that opened settles only when the person closes
    // it, never within the wait. So any end within the wait is a failed open: without this, the
    // reviewer closed itself for an editor that never appeared and `ccc edit` reported success.
    const ended = await earlyEnd(handle.result)
    if (ended && ended.error) throw new Error(`the editor overlay did not open: ${ended.error.message}`)
    if (ended) {
      const r = ended.result
      throw new Error(r && r.kind === 'exit' ? `micro exited at once with code ${r.code}` : 'the editor overlay closed at once')
    }
    handle.result.catch((e) => ctx.log.warn(`editor overlay: ${e.message}`))
    return rel
  }

  // The Reviewer's diff of a file (a click on Claude's changes in the gutter): the public `reviewer`
  // service (v1) `open(path)`, the project's own pick, so a replaced Reviewer answers it.
  // Looked up at the click, not at activation: a click is rare, and the service resolves on every call.
  async function openReview(rel) {
    if (typeof ctx.services.use !== 'function') throw new Error('this app has no plugin services')
    await ctx.services.use('reviewer').open(rel)
  }

  // ---- file tabs ----
  // `contributes.tabs` type `file`: the host reads, saves by compare-and-swap and watches
  // (lib/files.js); the page (dist/pages/file.html) keeps its base and merges (design-editor.md §2).
  // An older app has no ctx.tabs: the editor then serves micro only, as before.
  const hasTabs = typeof ctx.tabs === 'object' && ctx.tabs !== null
  /** tab id -> the instances of that tab now connected (one per view: the desktop, each browser). */
  const instances = new Map()
  /**
   * tab id -> a goto for a tab with no connected page (its frame unmounted by the LRU, or not yet
   * mounted): sent with the page's next first open. `firstOpened` holds the tabs whose first open
   * already used the tab's own params.line, so a later remount never jumps back to it.
   */
  const pendingGoto = new Map()
  const firstOpened = new Set()
  /**
   * The conflict marker (design-editor.md §2 "the tab shows a conflict marker"): the title starts
   * with it while a view's page holds a conflict (a merge to resolve, the file deleted on disk or no
   * longer savable). The title is the tab's one shared label, so the marker is on while ANY view
   * reports one. `conflictViews`: tab id -> the instances reporting one; `marked`: what this host
   * last put in the title (unknown after a host restart: the pages report again on their new line).
   */
  const conflictViews = new Map()
  const marked = new Map()
  /** Who reports: one entry per view (`tab.view`, the desktop's undefined), so a new line replaces it. */
  const viewKey = (tab) => (typeof tab.view === 'string' ? tab.view : '')
  /** Drops `tab`'s report when it is still the view's (a newer line of the same view keeps its own). */
  function dropReport(tab) {
    const views = conflictViews.get(tab.id)
    if (!views || views.get(viewKey(tab)) !== tab) return false
    views.delete(viewKey(tab))
    if (views.size === 0) conflictViews.delete(tab.id)
    return true
  }

  /** Puts the marker in or takes it out of tab `id`'s title, through `tab` (an instance of it). */
  async function updateMarker(tab, rel) {
    let shown = marked.get(tab.id)
    if (shown === undefined) {
      // First report since this host started: the saved title may carry a marker from before.
      const t = (await ctx.tabs.list('file')).find((x) => x.id === tab.id)
      if (!t) return
      // Another report settled it while the list was on its way.
      shown = marked.has(tab.id) ? marked.get(tab.id) : typeof t.title === 'string' && t.title.startsWith(CONFLICT_MARK)
    }
    // Read after the wait: the reports may have moved meanwhile.
    const want = (conflictViews.get(tab.id)?.size ?? 0) > 0
    marked.set(tab.id, want)
    if (shown === want) return
    await tab.setTitle(`${want ? CONFLICT_MARK : ''}${path.basename(rel)}`, 'file')
  }

  /**
   * Opens a project file in a file tab, or focuses the tab that already shows it and moves it to
   * `line`. The path is checked by realpath inside the project (a link out of it is refused); a
   * binary file goes to the project's file opener (`ctx.files.open`: the reviewer's preview, else
   * the app's built-in viewer), never into a tab that cannot show it. Resolves `{ tabId }` or
   * `{ via }` (the opener's answer).
   *
   * `focus: false` (`ccc edit`) points without selecting: a new tab opens with the unseen dot, an
   * open one gets the dot again (ctx.tabs.markUnseen; main skips the tab the window shows) and its
   * cursor moves without the page taking the keyboard (`goto` with `focus: false`).
   */
  async function openFileTab(p, opts = {}) {
    const r = files.resolveInProject(ctx.projectDir, p)
    if (r.exists && isBinaryFile(r.real)) {
      if (!ctx.files || typeof ctx.files.open !== 'function') throw new Error(`${r.rel} is a binary file`)
      const res = await ctx.files.open(r.rel)
      return { via: res && res.via }
    }
    return showTab('path', r.rel, opts)
  }

  /**
   * The file tab whose params hold `key: value` (`path`: a project file; `outside`: a file outside
   * the project, read-only), focused (or pointed at, `focus: false`) and moved to the line, or a new
   * one. Resolves `{ tabId }`.
   */
  async function showTab(key, value, opts) {
    const line = position(opts.line)
    const col = line === undefined ? undefined : position(opts.col)
    const open = (await ctx.tabs.list('file')).find((t) => t.params && typeof t.params === 'object' && t.params[key] === value)
    if (open) {
      const point = opts.focus === false
      if (!point && typeof ctx.tabs.focus === 'function') await ctx.tabs.focus(open.id)
      // An older app has no markUnseen: the cursor still moves, the tab just gets no dot.
      if (point && typeof ctx.tabs.markUnseen === 'function') await ctx.tabs.markUnseen(open.id)
      if (line !== undefined) {
        const live = instances.get(open.id)
        const goto = { t: 'goto', line, ...(col ? { col } : {}), ...(point ? { focus: false } : {}) }
        if (live && live.size > 0) for (const tab of live) tab.post(goto)
        else pendingGoto.set(open.id, { line, col })
      }
      return { tabId: open.id }
    }
    const params = { [key]: value }
    if (line !== undefined) params.line = line
    if (col !== undefined) params.col = col
    const tabId = await ctx.tabs.openPage('file', params, { title: path.basename(value), icon: 'file', focus: opts.focus !== false })
    return { tabId }
  }

  /**
   * A definition or reference outside the project (node_modules, the module cache, vendor): a
   * read-only tab (lib/files.js readOutside), only for a path a language server returned as a
   * location (design-editor.md §3); any other path a page names is refused. The path goes into the
   * tab's params, which main keeps, so the tab comes back after a restart without the page naming
   * anything.
   */
  async function openOutsideTab(abs, opts = {}) {
    if (!lspShared || !lspShared.allowsOutside(abs)) throw new Error('only a location a language server returned opens outside the project')
    // Main caps params at 4 KiB: a path that long is not shown.
    if (abs.length > 3000) throw new Error('the path is too long to open in a tab')
    return showTab('outside', abs, opts)
  }

  if (hasTabs) {
    const mine = files.makeFiles(ctx.projectDir, { log: ctx.log })
    shared = mine
    const settingsMessage = () => ({ t: 'settings', ...autosaveOf(app()) })
    // Quick open and find in files run rg through ctx.processes (lib/search.js); an older app has none.
    const spawn = ctx.processes && typeof ctx.processes.spawn === 'function' ? (argv, o) => ctx.processes.spawn(argv, o) : undefined
    // The language servers (lib/lsp, design-editor.md §3): one per language for this project, the
    // host their only client. None on an app without ctx.processes (the pages get highlighting only).
    const lsp = spawn ? new LspManager({ root: ctx.projectDir, spawn, log: ctx.log, servers: app().servers }) : null
    lspShared = lsp
    if (lsp) {
      // Project changes reach the servers as workspace/didChangeWatchedFiles (gopls and tsserver go
      // stale otherwise): every event of the folders the file tabs already watch, and the files the
      // project's Claude tabs write (ctx.sessions' `files`), new ones at once and all of a tab's again
      // when its status moves (a turn ended: a file written twice is listed once).
      mine.watcher.onFolderEvent((real) => lsp.noteChanged(real))
      if (ctx.sessions && typeof ctx.sessions.onChange === 'function') {
        const seen = new Map() // tabId -> { count, status }
        ctx.sessions.onChange((list) => {
          if (!Array.isArray(list)) return
          const live = new Set()
          for (const s of list) {
            if (!s || !Array.isArray(s.files)) continue
            live.add(s.tabId)
            const was = seen.get(s.tabId)
            seen.set(s.tabId, { count: s.files.length, status: s.status })
            if (!lsp.running()) continue
            if (!was || was.status !== s.status) lsp.noteSessionFiles(s.files)
            else if (s.files.length > was.count) lsp.noteSessionFiles(s.files.slice(was.count))
          }
          for (const id of seen.keys()) if (!live.has(id)) seen.delete(id)
        })
      }
    }
    ctx.tabs.onOpen('file', (tab) => {
      files.serveFileTab(mine, tab, ctx.log)
      const searching = search.serveSearch(tab, { spawn, root: ctx.projectDir, log: ctx.log })
      const speaking = serveLsp(tab, lsp, ctx.log)
      // Claude's changes in the gutter: the tab's own file at git HEAD, and the Reviewer's diff on a click.
      const tabPath = tab.params && typeof tab.params === 'object' && typeof tab.params.path === 'string' ? tab.params.path : undefined
      const gitting = git.serveGit(tab, { spawn, root: ctx.projectDir, rel: tabPath, review: openReview, log: ctx.log })
      const set = instances.get(tab.id) || new Set()
      set.add(tab)
      instances.set(tab.id, set)
      tab.post(settingsMessage())
      const params = tab.params && typeof tab.params === 'object' ? tab.params : {}
      tab.onMessage((m) => {
        if (!m || typeof m !== 'object') return
        if (searching(m)) return
        if (speaking(m)) return
        if (gitting(m)) return
        // The page's first load (not a reconnect, which keeps the person's cursor): the tab's line.
        // serveFileTab answered the same `open` first (synchronously), so the page has the text.
        if (m.t === 'open' && m.first === true) {
          // The tab's own line only for its first mount; later mounts take a pending goto, else keep the top.
          let at = pendingGoto.get(tab.id)
          pendingGoto.delete(tab.id)
          if (!at && !firstOpened.has(tab.id)) at = { line: position(params.line), col: position(params.col) }
          firstOpened.add(tab.id)
          if (at && at.line !== undefined) tab.post({ t: 'goto', line: at.line, ...(at.col ? { col: at.col } : {}) })
        } else if (m.t === 'openFile') {
          // Quick open's pick or a find-in-files result: a path the page names, so untrusted;
          // openFileTab checks it by realpath inside the project like any other open. A definition
          // or reference outside the project names `outside`: only one a server returned opens.
          if (typeof m.outside === 'string') {
            openOutsideTab(m.outside, { line: m.line, col: m.col }).catch((e) => tab.post({ t: 'search-error', kind: 'open', message: e.message }))
            return
          }
          let rel
          try {
            rel = relativePath(m.path)
          } catch (e) {
            tab.post({ t: 'search-error', kind: 'open', message: e.message })
            return
          }
          openFileTab(rel, { line: m.line, col: m.col }).catch((e) => tab.post({ t: 'search-error', kind: 'open', message: `${rel}: ${e.message}` }))
        } else if (m.t === 'micro') {
          // Always the tab's own file (main's params), never a path the page names.
          openEditor(params.path).catch((e) => {
            ctx.log.warn(`Open in micro ${params.path}: ${e.message}`)
            tab.post({ t: 'error', message: `Open in micro: ${e.message}` })
          })
        } else if (m.t === 'conflict' && typeof params.path === 'string') {
          if (m.on === true) {
            const views = conflictViews.get(tab.id) || new Map()
            views.set(viewKey(tab), tab)
            conflictViews.set(tab.id, views)
          } else {
            const views = conflictViews.get(tab.id)
            if (views) views.delete(viewKey(tab))
            if (views && views.size === 0) conflictViews.delete(tab.id)
          }
          updateMarker(tab, params.path).catch((e) => ctx.log.warn(`conflict marker ${params.path}: ${e.message}`))
        } else if (m.t === 'close') {
          // The deleted bar's Close: this tab only (main's id), closed the person's way, so text
          // unsaved in any view is asked about first.
          if (typeof ctx.tabs.close !== 'function') return
          // Only a view that reported a conflict (the deleted bar is the sender): any other page frame
          // could otherwise close a dirty tab with the core confirmation off.
          if (conflictViews.get(tab.id)?.get(viewKey(tab)) !== tab) return
          ctx.tabs.close(tab.id).catch((e) => tab.post({ t: 'error', message: `Close: ${e.message}` }))
        }
      })
      tab.onClose(() => {
        set.delete(tab)
        if (set.size === 0 && instances.get(tab.id) === set) instances.delete(tab.id)
        // A view's page gone (unmounted) holds no conflict any more. A reconnect closes the old line
        // first and its page reports again on the new one, so the drop waits a moment: the new line's
        // report replaces this one and the title does not blink.
        if (conflictViews.get(tab.id)?.get(viewKey(tab)) !== tab) return
        const timer = setTimeout(() => {
          markerTimers.delete(timer)
          // The tab itself may be gone (closed): then main refuses the title, which is fine.
          if (dropReport(tab) && typeof params.path === 'string') updateMarker(tab, params.path).catch(() => {})
        }, MARKER_GRACE_MS)
        if (typeof timer.unref === 'function') timer.unref()
        markerTimers.add(timer)
      })
    })
    if (typeof ctx.onSettingsChange === 'function') {
      ctx.onSettingsChange(() => {
        if (lsp) lsp.setServers(app().servers)
        const m = settingsMessage()
        for (const set of instances.values()) for (const tab of set) tab.post(m)
      })
    }
  }

  ctx.services.provide('editor', {
    // `editor` v1 (Files' Edit, the reviewer, other plugins): a file tab, or micro on an older app.
    async open(p, options) {
      try {
        const o = options && typeof options === 'object' ? options : {}
        if (hasTabs) {
          await openFileTab(relativePath(p), { line: o.line, col: o.col })
          return { opened: true }
        }
        await openEditor(p, o.line)
        return { opened: true }
      } catch (e) {
        throw new Error(`editor: ${e.message}`)
      }
    },
  })

  // A plain click on a file (the Sessions panel's changed files, the Files tree): the editor declares
  // `contributes.openFile` with `whenPicked`, so the clicks come here only when the project picked
  // "Editor" in Settings > This Project ("Plugin used to open files"); with no pick the Reviewer
  // (or whichever opener the project has) keeps them, as before. Main sends only a regular file
  // inside the project. A binary one is refused here, never handed to ctx.files.open: that routes
  // to the project's opener, which is this listener, so it would loop; refused, main opens its
  // built-in viewer (ctx.files.onOpen: a listener that throws within 1 s).
  if (hasTabs && ctx.files && typeof ctx.files.onOpen === 'function') {
    ctx.files.onOpen(async ({ path: p }) => {
      const r = files.resolveInProject(ctx.projectDir, relativePath(p))
      if (r.exists && isBinaryFile(r.real)) throw new Error(`${r.rel} is a binary file: the built-in viewer shows it`)
      await openFileTab(r.rel)
    })
  }

  // "Edit" on a `file` overlay (the reviewer's file review, among others): the file's tab, and the
  // overlay closes so the tab shows (micro on an older app, on top of the overlay). An older app has
  // no ctx.overlay.buttons: the editor then only serves `editor.open` and `ccc edit`.
  if (typeof ctx.overlay.buttons === 'function') {
    ctx.overlay.buttons('file', (o) => {
      const rel = editableFile(ctx.projectDir, o.type.data)
      if (rel === null) return []
      return [
        {
          id: 'edit',
          label: 'Edit',
          run: async () => {
            // A failure (micro missing, the overlay refused, the tab cap) is told: the click otherwise just ends.
            try {
              if (hasTabs) {
                await openFileTab(rel)
                return { close: true }
              }
              await openEditor(rel)
            } catch (e) {
              ctx.log.warn(`Edit ${rel}: ${e.message}`)
              Promise.resolve(ctx.notify(`Edit ${rel}: ${e.message}`)).catch(() => {})
            }
            return undefined
          },
        },
      ]
    })
  }

  ctx.cli.register('edit', async (argv, { cwd }) => {
    if (!argv.length || argv[0] === 'help' || argv.includes('--help')) {
      return { stdout: `${EDIT_USAGE}\n` }
    }
    try {
      const t = parseTarget(argv)
      // Resolve against the caller's cwd, then make it project-relative. The cwd a shell reports is
      // a realpath (getcwd), so a project opened through a symlinked folder is compared by its
      // realpath too; resolveInProject checks the result by realpath again either way.
      const root = ctx.projectDir
      const abs = path.resolve(cwd || root, t.file)
      let rel = path.relative(root, abs)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        try {
          rel = path.relative(fs.realpathSync(root), abs)
        } catch {
          // The project folder is gone: relativePath below refuses the `..` path as it stands.
        }
      }
      if (!hasTabs) {
        const shown = await openEditor(rel, t.line)
        return { stdout: `editing ${shown}\n` }
      }
      // Only a text file that exists: a missing one would open a "deleted on disk" tab and say it
      // is open (a typo, or a form parseTarget does not read such as `a.ts:12-20`), and a binary one
      // would go to the file opener, whose overlay takes the keyboard from the terminal that ran this.
      const r = files.resolveInProject(root, relativePath(rel))
      if (!r.exists) throw new Error(`no such file: ${r.rel} (the forms are <file>, <file>:<line>, <file>:<line>:<col>)`)
      if (isBinaryFile(r.real)) throw new Error(`${r.rel} is not a text file (the editor opens text files only)`)
      // Never focus: the person may be typing in the terminal that ran this. A new tab opens with
      // the unseen dot (main sets it); an open one gets the dot again and moves to the position
      // (design-editor.md §4).
      await openFileTab(r.rel, { line: t.line, col: t.col, focus: false })
      const at = t.line ? `:${t.line}${t.col ? `:${t.col}` : ''}` : ''
      return { stdout: `${r.rel}${at} is open in the editor (the tab is marked, not selected)\n` }
    } catch (e) {
      return { stderr: `edit: ${e.message}\n`, code: 1 }
    }
  })

  ctx.log.info('activated')
}

// The file tabs' folder watches are the one thing that outlives ctx (the service, the CLI command,
// the overlays and the tab listeners all end with it): a plugin reload closes them here.
let shared = null
// The language servers too: ctx.processes kills them with the plugin anyway, but a `shutdown` first
// lets a server write its caches (gopls, tsserver) instead of dying mid-write.
let lspShared = null
exports.deactivate = () => {
  if (shared) shared.watcher.close()
  shared = null
  const lsp = lspShared
  lspShared = null
  for (const t of markerTimers) clearTimeout(t)
  markerTimers.clear()
  // Returned: the loader awaits it (5 s cap) before the ctx dispose kills the children, so the
  // servers' shutdown/exit gets its time.
  return lsp ? lsp.dispose().catch(() => {}) : undefined
}
