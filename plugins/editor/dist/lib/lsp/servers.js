'use strict'
// Which language server a file gets (design-editor.md §3 "Servers"): a built-in table with
// fallbacks, plus the app setting `servers` ({ language, extensions, argv }[]) that adds a language
// or overrides a built-in one. Only main's app settings and this table name a binary: the page sends
// a path, the host picks the language from its extension and the argv from here (the page never
// names a program, a flag or a setting a server would use).
//
// Programs are looked up on the host's PATH, which is the person's login-shell PATH (main gives the
// plugin host the allow-listed login-shell env, host-manager.ts hostEnv): `gopls` in ~/go/bin or a
// global npm bin resolves as it does in a terminal. A server that is not installed is not an error:
// the file gets highlighting only and the page a bar with the install command (`missing`).

const fs = require('node:fs')
const path = require('node:path')

/**
 * The built-in servers. `candidates` are tried in order (the first found on PATH wins): PHP prefers
 * intelephense, else phpactor; Python basedpyright, else pyright. `languageIds` maps an extension to
 * the LSP languageId of `textDocument/didOpen` (one server serves TS and JS, which have four ids).
 * `install` is the bar's text when no candidate is found.
 */
const BUILTIN = [
  {
    language: 'typescript',
    name: 'TypeScript / JavaScript',
    languageIds: {
      ts: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascriptreact',
    },
    candidates: [['typescript-language-server', '--stdio']],
    install: 'npm install -g typescript-language-server typescript',
  },
  {
    language: 'go',
    name: 'Go',
    languageIds: { go: 'go' },
    candidates: [['gopls']],
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    language: 'php',
    name: 'PHP',
    languageIds: { php: 'php' },
    candidates: [
      ['intelephense', '--stdio'],
      ['phpactor', 'language-server'],
    ],
    install: 'npm install -g intelephense (or install phpactor)',
  },
  {
    language: 'python',
    name: 'Python',
    languageIds: { py: 'python', pyi: 'python' },
    candidates: [
      ['basedpyright-langserver', '--stdio'],
      ['pyright-langserver', '--stdio'],
    ],
    install: 'pip install basedpyright (or npm install -g pyright)',
  },
]

/** A language name in the `servers` setting: a short lowercase word (it keys the server, it is shown). */
const LANGUAGE_RE = /^[a-z0-9][a-z0-9_+.-]{0,39}$/
/** An extension, without its dot: `rs`, `d.ts` is not one (the last one counts). */
const EXTENSION_RE = /^[a-z0-9_+-]{1,16}$/
const MAX_ENTRIES = 50
const MAX_EXTENSIONS = 32
const MAX_ARGV = 64
const MAX_ARG_CHARS = 4096

/** `rs, .ron  toml` -> ['rs', 'ron', 'toml']: spaces or commas, a leading dot dropped, lowercase. */
function parseExtensions(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []
  const out = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const e = raw.trim().toLowerCase().replace(/^\./, '')
    if (EXTENSION_RE.test(e) && !out.includes(e)) out.push(e)
    if (out.length >= MAX_EXTENSIONS) break
  }
  return out
}

/** A setting entry's argv: 1..64 strings, none empty or with a NUL; else null (the entry is skipped). */
function cleanArgv(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ARGV) return null
  for (const a of v) if (typeof a !== 'string' || a.length > MAX_ARG_CHARS || a.includes('\0')) return null
  if (v[0].trim() === '') return null
  return [...v]
}

/**
 * The table in force: the built-ins with the `servers` setting applied. An entry for a built-in
 * language replaces its argv (no fallback then: the person named the one they want) and, when it
 * lists extensions, its extensions; an entry for a new language needs extensions (else it could
 * never be chosen). A broken entry is skipped and reported in `problems` (logged by the host), never
 * thrown: one bad row must not take every language server away. A later entry for the same language
 * wins. An extension claimed by two languages goes to the one listed last (a setting beats a built-in).
 */
function serverTable(setting) {
  const table = new Map()
  for (const b of BUILTIN) {
    table.set(b.language, { ...b, languageIds: { ...b.languageIds }, candidates: b.candidates.map((c) => [...c]), custom: false })
  }
  const problems = []
  const list = Array.isArray(setting) ? setting.slice(0, MAX_ENTRIES) : []
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object') return problems.push(`servers[${i}]: not an object`)
    const language = typeof e.language === 'string' ? e.language.trim().toLowerCase() : ''
    if (!LANGUAGE_RE.test(language)) return problems.push(`servers[${i}]: language must be a short lowercase name`)
    const argv = cleanArgv(e.argv)
    if (!argv) return problems.push(`servers[${i}] (${language}): argv must be 1 to ${MAX_ARGV} non-empty arguments`)
    const exts = parseExtensions(e.extensions)
    const base = table.get(language)
    if (!base && exts.length === 0) return problems.push(`servers[${i}] (${language}): a new language needs extensions`)
    // A custom server's documents use the language name as their languageId (`rust` for `rs`); a
    // built-in keeps its own ids for the extensions it knows.
    const languageIds = {}
    if (exts.length) for (const x of exts) languageIds[x] = (base && base.languageIds[x]) || language
    table.set(language, {
      language,
      name: base ? base.name : language,
      languageIds: exts.length ? languageIds : base.languageIds,
      candidates: [argv],
      install: `${argv[0]} was not found on your login-shell PATH (Settings > Plugins > Editor, "Language servers")`,
      custom: true,
    })
  })
  // Extension -> language, the later entries winning (Map order: built-ins first, then settings).
  const byExtension = new Map()
  for (const entry of table.values()) for (const x of Object.keys(entry.languageIds)) byExtension.set(x, entry.language)
  // An extension taken over by a later language is no longer the earlier one's.
  for (const entry of table.values()) {
    for (const x of Object.keys(entry.languageIds)) if (byExtension.get(x) !== entry.language) delete entry.languageIds[x]
  }
  return { table, byExtension, problems }
}

/** The server entry and LSP languageId for a project-relative path, or null (no server for it). */
function languageOf(rel, { table, byExtension }) {
  const ext = path.extname(rel).slice(1).toLowerCase()
  if (!ext) return null
  const language = byExtension.get(ext)
  if (!language) return null
  const entry = table.get(language)
  return { entry, languageId: entry.languageIds[ext] }
}

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where `name` runs from: an absolute path for a name found on the ABSOLUTE entries of `env.PATH`
 * (or a path with a slash, checked as it is, a relative one against `cwd`: the person's own
 * `servers` setting), else null. The lookup Node's spawn does with `options.env`, done first so a
 * missing server is told as such (with its install command) and the fallback candidate gets its
 * turn, instead of a spawn failing. A relative PATH entry (`.`, `node_modules/.bin`, common for JS
 * developers) is skipped: it would resolve against the project (the spawn's cwd), and a cloned
 * repository that ships `node_modules/.bin/typescript-language-server` would run as soon as a .ts
 * file opened. The argv then carries the absolute path, so the spawn's own PATH search (which
 * would take a relative entry too) never runs.
 */
function findOnPath(name, env = process.env, cwd = process.cwd()) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) return null
  if (name.includes('/') || (path.sep === '\\' && name.includes('\\'))) {
    const p = path.resolve(cwd, name)
    return isExecutable(p) ? p : null
  }
  const dirs = String((env && (env.PATH ?? env.Path)) || '').split(path.delimiter)
  const exts = process.platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue
    for (const x of exts) {
      const p = path.join(dir, name + x)
      if (isExecutable(p)) return p
    }
  }
  return null
}

/**
 * The absolute path of a program the editor runs by name (git, rg) on the host's PATH, absolute
 * entries only (findOnPath), or null when it is not installed there. Spawning the bare name instead
 * would let ctx.processes' PATH search take a relative entry, against the project folder.
 */
function programPath(name, env = process.env) {
  return findOnPath(name, env, '/')
}

/**
 * The argv to start `entry` with: the first candidate whose program is found, argv[0] made the
 * absolute path found (the process spawned is the one checked); `{ missing: true, install }` when
 * none is.
 */
function resolveServer(entry, { env = process.env, cwd } = {}) {
  for (const c of entry.candidates) {
    const bin = findOnPath(c[0], env, cwd)
    if (bin) return { argv: [bin, ...c.slice(1)] }
  }
  return { missing: true, install: entry.install, tried: entry.candidates.map((c) => c[0]) }
}

module.exports = { BUILTIN, serverTable, languageOf, findOnPath, programPath, resolveServer, parseExtensions }
