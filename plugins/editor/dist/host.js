'use strict'
// Editor for cc-cockpit: provides the "editor" plugin service (v1) by running micro
// (https://micro-editor.github.io), a terminal editor, in a large terminal overlay.
//
//   const editor = ctx.services.use('editor')
//   await editor.open(path, { line? })   // path relative to the project folder; resolves once shown
//
// `ccc edit <file> [line]` uses it. Any plugin that provides "editor" v1 can replace this one
// (Settings > Plugins, "Plugin used for editor").
//
// It also adds "Edit" to every overlay of the well-known type `file` { path } (a review, a file
// shown by another plugin) for a text file of the project: micro opens on top, the overlay under it
// stays.

const fs = require('node:fs')
const path = require('node:path')

const INSTALL_HINT =
  'micro is not installed (or not on your login-shell PATH). Install it with `brew install micro` (macOS), ' +
  '`sudo pacman -S micro` (Arch) or `sudo apt install micro` (Debian, Ubuntu), or see https://micro-editor.github.io. ' +
  'If it is installed elsewhere, set its path in Settings > Plugins > Editor (micro), setting "microPath".'

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

/** micro's argv: options first, then the file, then +LINE. Exported for tests. */
function microArgv(app, rel, line) {
  const argv = [app.microPath || 'micro']
  const autosave = Number.isInteger(app.autosaveSeconds) ? app.autosaveSeconds : 5
  argv.push('-autosave', String(autosave))
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

  ctx.services.provide('editor', {
    async open(p, options) {
      try {
        const line = options && typeof options === 'object' ? options.line : undefined
        await openEditor(p, line)
        return { opened: true }
      } catch (e) {
        throw new Error(`editor: ${e.message}`)
      }
    },
  })

  // "Edit" on a `file` overlay (the reviewer's file review, among others). An older app has no
  // ctx.overlay.buttons: the editor then only serves `editor.open` and `ccc edit`.
  if (typeof ctx.overlay.buttons === 'function') {
    ctx.overlay.buttons('file', (o) => {
      const rel = editableFile(ctx.projectDir, o.type.data)
      if (rel === null) return []
      return [
        {
          id: 'edit',
          label: 'Edit',
          run: async () => {
            // A failure (micro missing, the overlay refused) is told: the click otherwise just ends.
            try {
              await openEditor(rel)
            } catch (e) {
              ctx.log.warn(`Edit ${rel}: ${e.message}`)
              Promise.resolve(ctx.notify(`Edit ${rel}: ${e.message}`)).catch(() => {})
            }
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

// No deactivate: the editor registers nothing that outlives its ctx (the service, the CLI command
// and its overlays all end with it), and the loader treats deactivate as optional.
