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
// Project, "Plugin used for editor"). `ccc edit <file> [line]` still opens micro (plan Task 10
// moves it to file tabs).
//
// It also adds "Edit" to every overlay of the well-known type `file` { path } (a review, a file
// shown by another plugin) for a text file of the project: the file's tab, and the overlay closes.

const fs = require('node:fs')
const path = require('node:path')
const files = require('./lib/files.js')

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
   * Opens a project file in a file tab, or focuses the tab that already shows it and moves it to
   * `line`. The path is checked by realpath inside the project (a link out of it is refused); a
   * binary file goes to the project's file opener (`ctx.files.open`: the reviewer's preview, else
   * the app's built-in viewer), never into a tab that cannot show it. Resolves `{ tabId }` or
   * `{ via }` (the opener's answer).
   */
  async function openFileTab(p, opts = {}) {
    const r = files.resolveInProject(ctx.projectDir, p)
    if (r.exists && isBinaryFile(r.real)) {
      if (!ctx.files || typeof ctx.files.open !== 'function') throw new Error(`${r.rel} is a binary file`)
      const res = await ctx.files.open(r.rel)
      return { via: res && res.via }
    }
    const line = position(opts.line)
    const col = line === undefined ? undefined : position(opts.col)
    const open = (await ctx.tabs.list('file')).find((t) => t.params && typeof t.params === 'object' && t.params.path === r.rel)
    if (open) {
      if (opts.focus !== false && typeof ctx.tabs.focus === 'function') await ctx.tabs.focus(open.id)
      if (line !== undefined) {
        const live = instances.get(open.id)
        if (live && live.size > 0) for (const tab of live) tab.post({ t: 'goto', line, ...(col ? { col } : {}) })
        else pendingGoto.set(open.id, { line, col })
      }
      return { tabId: open.id }
    }
    const params = { path: r.rel }
    if (line !== undefined) params.line = line
    if (col !== undefined) params.col = col
    const tabId = await ctx.tabs.openPage('file', params, { title: path.basename(r.rel), icon: 'file', focus: opts.focus !== false })
    return { tabId }
  }

  if (hasTabs) {
    const mine = files.makeFiles(ctx.projectDir, { log: ctx.log })
    shared = mine
    const settingsMessage = () => ({ t: 'settings', ...autosaveOf(app()) })
    ctx.tabs.onOpen('file', (tab) => {
      files.serveFileTab(mine, tab, ctx.log)
      const set = instances.get(tab.id) || new Set()
      set.add(tab)
      instances.set(tab.id, set)
      tab.post(settingsMessage())
      const params = tab.params && typeof tab.params === 'object' ? tab.params : {}
      tab.onMessage((m) => {
        if (!m || typeof m !== 'object') return
        // The page's first load (not a reconnect, which keeps the person's cursor): the tab's line.
        // serveFileTab answered the same `open` first (synchronously), so the page has the text.
        if (m.t === 'open' && m.first === true) {
          // The tab's own line only for its first mount; later mounts take a pending goto, else keep the top.
          let at = pendingGoto.get(tab.id)
          pendingGoto.delete(tab.id)
          if (!at && !firstOpened.has(tab.id)) at = { line: position(params.line), col: position(params.col) }
          firstOpened.add(tab.id)
          if (at && at.line !== undefined) tab.post({ t: 'goto', line: at.line, ...(at.col ? { col: at.col } : {}) })
        } else if (m.t === 'micro') {
          // Always the tab's own file (main's params), never a path the page names.
          openEditor(params.path).catch((e) => {
            ctx.log.warn(`Open in micro ${params.path}: ${e.message}`)
            tab.post({ t: 'error', message: `Open in micro: ${e.message}` })
          })
        }
      })
      tab.onClose(() => {
        set.delete(tab)
        if (set.size === 0 && instances.get(tab.id) === set) instances.delete(tab.id)
      })
    })
    if (typeof ctx.onSettingsChange === 'function') {
      ctx.onSettingsChange(() => {
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
      return { stdout: 'usage: ccc edit <file> [line]   edit a file of this project in micro\n' }
    }
    try {
      // Resolve against the caller's cwd, then make it project-relative.
      const root = ctx.projectDir
      const rel = path.relative(root, path.resolve(cwd || root, argv[0]))
      const shown = await openEditor(rel, argv[1])
      return { stdout: `editing ${shown}\n` }
    } catch (e) {
      return { stderr: `edit: ${e.message}\n`, code: 1 }
    }
  })

  ctx.log.info('activated')
}

// The file tabs' folder watches are the one thing that outlives ctx (the service, the CLI command,
// the overlays and the tab listeners all end with it): a plugin reload closes them here.
let shared = null
exports.deactivate = () => {
  if (shared) shared.watcher.close()
  shared = null
}
