'use strict'
// Editor for cc-cockpit: provides the "editor" plugin service (v1) by running micro
// (https://micro-editor.github.io), a terminal editor, in a large terminal overlay.
//
//   const editor = ctx.services.use('editor')
//   await editor.open(path, { line? })   // path relative to the project folder; resolves once shown
//
// The reviewer's Edit button and `ccc edit <file> [line]` use it. Any plugin that provides
// "editor" v1 can replace this one (Settings > Plugins, "Plugin used for editor").

const path = require('node:path')

const INSTALL_HINT = 'micro is not installed (or not on your login-shell PATH): https://micro-editor.github.io, e.g. `brew install micro` or `pacman -S micro`; or set its path in Settings > Plugins > Editor (micro)'

let disposers = []

/** A project-relative path, or a thrown Error: no absolute path, no `..`, no NUL. */
function relativePath(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('path must be a non-empty string')
  if (path.isAbsolute(p)) throw new Error(`path must be relative to the project folder: ${p}`)
  const norm = path.posix.normalize(p.replace(/\\/g, '/'))
  if (norm === '..' || norm.startsWith('../') || norm === '.') throw new Error(`path leaves the project folder: ${p}`)
  return norm.replace(/^\.\//, '')
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

exports.microArgv = microArgv
exports.relativePath = relativePath

exports.activate = (ctx) => {
  const app = () => ctx.settings.app || {}

  // micro's presence is checked once per binary path, not on every open.
  const checked = new Map()
  async function ensureMicro(bin) {
    if (checked.get(bin) === true) return
    let ok = false
    try {
      const r = await ctx.exec([bin, '-version'], { timeoutMs: 10000 })
      ok = r.code === 0 && /version/i.test(r.stdout)
    } catch {
      ok = false // not found: exec rejects when the program cannot be started
    }
    if (!ok) throw new Error(INSTALL_HINT)
    checked.set(bin, true)
  }

  async function openEditor(p, line) {
    const rel = relativePath(p)
    const a = app()
    await ensureMicro(a.microPath || 'micro')
    // The terminal's cwd defaults to the project folder, so the relative path resolves there.
    const handle = ctx.overlay.start({ kind: 'terminal', argv: microArgv(a, rel, line), title: `Edit: ${rel}`, size: 'large' })
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

  ctx.cli.register('edit', async (argv, { cwd }) => {
    if (!argv.length || argv[0] === 'help' || argv.includes('--help')) {
      return { stdout: 'usage: ccc edit <file> [line]   edit a file of this project in micro\n' }
    }
    try {
      // Resolve against the caller's cwd, then make it project-relative: the project folder is
      // exec's default cwd (the guide has no ctx.projectDir).
      const r = await ctx.exec(['pwd', '-P'])
      const root = r.stdout.trim()
      const rel = path.relative(root, path.resolve(cwd || root, argv[0]))
      const shown = await openEditor(rel, argv[1])
      return { stdout: `editing ${shown}\n` }
    } catch (e) {
      return { stderr: `edit: ${e.message}\n`, code: 1 }
    }
  })

  ctx.log.info('activated')
}

exports.deactivate = () => {
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      // nothing to clean up
    }
  }
  disposers = []
}
