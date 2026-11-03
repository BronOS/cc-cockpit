'use strict'
// The pure part of the file tree: reading one folder, git's ignore and status answers, and the
// filter. No ctx here: the host passes `exec` (ctx.exec's shape, argv only) and the project root, so
// every rule runs under node:test against a temp dir.
//
// Paths: everything the page and the host exchange is relative to the project folder with `/`
// separators, '' being the project folder itself. A relative path from the page is checked
// (normalizeRelative) before it touches the file system: the page is ours, but a bug there must
// not list /etc.

const fs = require('node:fs')
const path = require('node:path')

/** Entries listed per folder; the rest is counted ("N more not shown"). */
const MAX_ENTRIES = 2000
/** Paths the filter returns. */
const MAX_RESULTS = 200
/** Files a non-git filter walk visits before it stops. */
const MAX_WALK = 20000

/**
 * '' for the project folder, else a clean `a/b` path. Throws on an absolute path, a `..` step, a
 * backslash or a NUL: none can come from our own tree.
 */
function normalizeRelative(rel) {
  if (typeof rel !== 'string') throw new Error('path must be a string')
  if (rel.includes('\0') || rel.includes('\\')) throw new Error(`bad path: ${rel}`)
  if (rel.startsWith('/')) throw new Error(`not relative: ${rel}`)
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error(`outside the project: ${rel}`)
  return parts.join('/')
}

const joinRel = (dir, name) => (dir === '' ? name : `${dir}/${name}`)

/** Inside `root` (a real path) or `root` itself. */
function within(root, abs) {
  const r = path.relative(root, abs)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

// Folders first, then by name: case-insensitive, numbers by value (file2 before file10).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
function compareEntries(a, b) {
  const da = a.kind === 'dir' ? 0 : 1
  const db = b.kind === 'dir' ? 0 : 1
  return da - db || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * The names git ignores among `rels` (paths relative to the project root, which is exec's cwd), as
 * a Set. One `git check-ignore` call for the whole folder; it stats each path itself, so a folder
 * matched by `dist/` is found without a trailing slash, and a path inside an ignored folder counts
 * as ignored. Not a git repo, or git missing: nothing is ignored.
 */
async function ignoredSet(exec, rels) {
  if (rels.length === 0) return new Set()
  let r
  try {
    r = await exec(['git', 'check-ignore', '-z', '--stdin'], { stdin: rels.join('\0') + '\0' })
  } catch {
    return new Set()
  }
  // 0: some ignored, 1: none, 128: not a repo (or another fatal error).
  if (r.code !== 0) return new Set()
  return new Set(String(r.stdout).split('\0').filter(Boolean))
}

/**
 * One folder of the tree: `{ path, entries: [{ name, kind, link?, blocked?, ignored? }], more }`.
 * `kind` is 'dir', 'file' or 'other' (a socket, a fifo, a dangling link). `.git` is never listed.
 * A symlink gets `link: true` and the kind of its target; a linked folder whose real path leaves
 * the project gets `blocked: true` and is not expandable (no loops through `..`, no listing of
 * a folder outside the project). Throws when the folder cannot be read.
 */
async function listDir(root, rel, { exec, hideHidden = false, hideIgnored = false } = {}) {
  const dir = normalizeRelative(rel)
  const abs = path.join(root, dir)
  // The folder itself must still be inside the project by its real path: an expanded folder may
  // have been swapped for a link since the page listed its parent.
  const realDir = await fs.promises.realpath(abs)
  if (!within(root, realDir)) throw new Error(`outside the project: ${dir}`)
  const dirents = await fs.promises.readdir(abs, { withFileTypes: true })
  let entries = []
  for (const d of dirents) {
    if (d.name === '.git') continue
    if (hideHidden && d.name.startsWith('.')) continue
    const e = { name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }
    if (d.isSymbolicLink()) {
      e.link = true
      try {
        const target = path.join(abs, d.name)
        const st = await fs.promises.stat(target)
        e.kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
        if (e.kind === 'dir' && !within(root, await fs.promises.realpath(target))) e.blocked = true
      } catch {
        e.kind = 'other' // dangling
      }
    }
    entries.push(e)
  }
  if (exec) {
    const ignored = await ignoredSet(
      exec,
      entries.map((e) => joinRel(dir, e.name)),
    )
    for (const e of entries) if (ignored.has(joinRel(dir, e.name))) e.ignored = true
    if (hideIgnored) entries = entries.filter((e) => !e.ignored)
  }
  entries.sort(compareEntries)
  const more = Math.max(0, entries.length - MAX_ENTRIES)
  return { path: dir, entries: entries.slice(0, MAX_ENTRIES), more }
}

/**
 * `git status --porcelain=v1 -z` output -> { files: { path: code }, dirs: [paths of folders holding
 * a change], untracked: [untracked folders] }, paths relative to the project folder. `prefix` is
 * `git rev-parse --show-prefix` (the project folder inside the repo, `sub/` or ''): porcelain paths
 * are relative to the repo root, and a change outside the project folder is dropped.
 * The code is one letter: the worktree's if it has one, else the index's (`M`, `A`, `D`, `R`, `U`,
 * `?`).
 */
function parseStatus(out, prefix = '') {
  const files = {}
  const untracked = []
  const fields = String(out).split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.length < 4) continue
    const x = f[0]
    const y = f[1]
    let p = f.slice(3)
    // A rename or copy is followed by its old path in the next field.
    if (x === 'R' || x === 'C') i++
    if (prefix) {
      if (!p.startsWith(prefix)) continue
      p = p.slice(prefix.length)
    }
    if (p === '') continue
    let code
    if (x === '?') code = '?'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) code = 'U'
    else code = y !== ' ' ? y : x
    if (code === 'T') code = 'M'
    if (p.endsWith('/')) {
      untracked.push(p.slice(0, -1))
      continue
    }
    files[p] = code
  }
  const dirs = new Set()
  for (const p of [...Object.keys(files), ...untracked]) {
    const parts = p.split('/')
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/'))
  }
  for (const u of untracked) dirs.add(u)
  return { files, dirs: [...dirs].sort(), untracked: untracked.sort() }
}

/** The git marks of the project, or empty ones outside a repo. */
async function gitMarks(exec) {
  const empty = { files: {}, dirs: [], untracked: [], git: false }
  try {
    const top = await exec(['git', 'rev-parse', '--show-prefix'])
    if (top.code !== 0) return empty
    const prefix = String(top.stdout).trim()
    const st = await exec(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeoutMs: 15000 })
    if (st.code !== 0) return empty
    return { ...parseStatus(st.stdout, prefix), git: true }
  } catch {
    return empty
  }
}

/** Every space-separated word of `query` appears in `p` (case-insensitive). */
function matches(p, words) {
  const l = p.toLowerCase()
  return words.every((w) => l.includes(w))
}

/** The words of a filter query; none for an empty one. */
const queryWords = (q) =>
  String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

/**
 * Rank the matches: a hit in the file name before a hit only in its folders, then shorter paths.
 * Returns { paths (at most MAX_RESULTS), total }.
 */
function rankMatches(paths, query, { hideHidden = false } = {}) {
  const words = queryWords(query)
  if (words.length === 0) return { paths: [], total: 0 }
  const hits = []
  for (const p of paths) {
    if (hideHidden && p.split('/').some((s) => s.startsWith('.'))) continue
    if (!matches(p, words)) continue
    const base = p.slice(p.lastIndexOf('/') + 1)
    hits.push({ p, inName: matches(base, words) ? 0 : 1 })
  }
  hits.sort((a, b) => a.inName - b.inName || a.p.length - b.p.length || collator.compare(a.p, b.p))
  return { paths: hits.slice(0, MAX_RESULTS).map((h) => h.p), total: hits.length }
}

/**
 * The files the filter searches: git's tracked and untracked-not-ignored files in a repo (fast,
 * and ignored folders like node_modules stay out of the results), else a bounded walk that skips
 * `.git` and does not follow links.
 */
async function searchablePaths(exec, root) {
  try {
    const r = await exec(['git', 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { timeoutMs: 15000 })
    if (r.code === 0) return [...new Set(String(r.stdout).split('\0').filter(Boolean))]
  } catch {
    // not git: walk below
  }
  const out = []
  const stack = ['']
  while (stack.length && out.length < MAX_WALK) {
    const dir = stack.pop()
    let ds
    try {
      ds = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of ds) {
      if (d.name === '.git') continue
      const rel = joinRel(dir, d.name)
      if (d.isDirectory()) stack.push(rel)
      else if (d.isFile()) out.push(rel)
      if (out.length >= MAX_WALK) break
    }
  }
  return out
}

module.exports = {
  MAX_ENTRIES,
  MAX_RESULTS,
  normalizeRelative,
  joinRel,
  within,
  compareEntries,
  ignoredSet,
  listDir,
  parseStatus,
  gitMarks,
  queryWords,
  rankMatches,
  searchablePaths,
}
