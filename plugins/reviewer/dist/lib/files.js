'use strict'
// Reading the two sides of a review: the file at HEAD (git) and the file in the working tree.
// Kept free of `ctx`: `exec` is passed in (ctx.exec in the host, a fake in tests).
//
// Every path that reaches here is relative to the project folder. The app promises that for an
// `openFile` click, but the `reviewer` service and `ccc review` take paths from other plugins and
// from the command line, so the checks below hold for all of them: no absolute path, no `..`, and
// after resolving symlinks the file still lies inside the project folder.

const fs = require('node:fs')
const path = require('node:path')

// One overlay message holds both sides and must stay under ~1 MiB of JSON (`ccc guide api`,
// overlay.start), with room for escaping and the draft. Past this, the built-in viewer is better.
const MAX_SIDE_BYTES = 400 * 1024
const BINARY_SNIFF_BYTES = 8000

class ReviewError extends Error {
  /** fallback: true when the built-in viewer should show the file instead (binary, too big). */
  constructor(message, { fallback = false } = {}) {
    super(message)
    this.name = 'ReviewError'
    this.fallback = fallback
  }
}

/** A project-relative path, normalised to `/` separators, or a ReviewError. */
function normalizeRelative(p) {
  if (typeof p !== 'string' || !p.trim()) throw new ReviewError('path must be a non-empty string')
  if (p.includes('\0')) throw new ReviewError('path contains a NUL byte')
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) throw new ReviewError(`path must be relative to the project folder: ${p}`)
  const norm = path.posix.normalize(p.replace(/\\/g, '/'))
  if (norm === '.' || norm === '..' || norm.startsWith('../')) throw new ReviewError(`path leaves the project folder: ${p}`)
  return norm.replace(/^\.\//, '')
}

/**
 * The project-relative form of a path given on the command line, resolved against the caller's
 * cwd. Throws when it is outside the project.
 */
function relativeFromCwd(root, cwd, arg) {
  const abs = path.resolve(cwd || root, arg)
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ReviewError(`not inside the project folder: ${arg}`)
  return rel.split(path.sep).join('/')
}

/** True when `abs` (after following symlinks) is inside `root` (already a real path). */
function insideRoot(root, abs) {
  let real
  try {
    real = fs.realpathSync(abs)
  } catch {
    // Missing file (deleted in the working tree): check its nearest existing parent instead.
    const parent = path.dirname(abs)
    if (parent === abs) return false
    return insideRoot(root, parent)
  }
  return real === root || real.startsWith(root + path.sep)
}

const isBinary = (buf) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)

/**
 * Both sides of `rel` for a review:
 * { path, root, git, head, old, new, oldMissing, newMissing, mode, note }
 * mode: 'diff' (both or one side present in git), 'plain' (no git or no commit: the file only).
 */
async function readSides(exec, root, rel) {
  rel = normalizeRelative(rel)
  const abs = path.join(root, rel)
  if (!insideRoot(root, abs)) throw new ReviewError(`path leaves the project folder through a symlink: ${rel}`)

  // Working tree side.
  let newText = null
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) throw new ReviewError(`${rel} is a folder`, { fallback: true })
    if (st.size > MAX_SIDE_BYTES) throw new ReviewError(`${rel} is larger than ${MAX_SIDE_BYTES / 1024} KiB`, { fallback: true })
    const buf = fs.readFileSync(abs)
    if (isBinary(buf)) throw new ReviewError(`${rel} is a binary file`, { fallback: true })
    newText = buf.toString('utf8')
  } catch (e) {
    if (e instanceof ReviewError) throw e
    if (e.code !== 'ENOENT') throw new ReviewError(`cannot read ${rel}: ${e.message}`)
  }

  // HEAD side. `HEAD:./<path>` is resolved against the cwd (the project folder), so it works when
  // the project is a subfolder of the repository.
  const inRepo = await exec(['git', 'rev-parse', '--is-inside-work-tree'])
  const git = inRepo.code === 0 && inRepo.stdout.trim() === 'true'
  let head = null
  let oldText = null
  if (git) {
    const h = await exec(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])
    if (h.code === 0) head = h.stdout.trim()
  }
  if (head) {
    const size = await exec(['git', 'cat-file', '-s', `HEAD:./${rel}`])
    if (size.code === 0) {
      if (Number(size.stdout.trim()) > MAX_SIDE_BYTES) {
        throw new ReviewError(`${rel} at HEAD is larger than ${MAX_SIDE_BYTES / 1024} KiB`, { fallback: true })
      }
      const show = await exec(['git', 'show', `HEAD:./${rel}`])
      if (show.code !== 0) throw new ReviewError(`git show failed: ${show.stderr.trim().slice(0, 200)}`)
      if (show.stdout.includes('\0')) throw new ReviewError(`${rel} is a binary file`, { fallback: true })
      oldText = show.stdout
    }
  }

  if (newText === null && oldText === null) throw new ReviewError(`${rel} does not exist, in the working tree or at HEAD`)

  let mode = 'diff'
  let note = null
  if (!git) {
    mode = 'plain'
    note = 'Not a git repository: showing the file, no diff.'
  } else if (!head) {
    mode = 'plain'
    note = 'The repository has no commits yet: showing the file, no diff.'
  } else if (oldText === null) {
    note = 'New file: not in the last commit.'
  } else if (newText === null) {
    note = 'Deleted: the file is gone from the working tree.'
  } else if (oldText === newText) {
    note = 'No changes since the last commit.'
  }

  return {
    path: rel,
    root,
    git,
    head,
    old: oldText === null ? '' : oldText,
    new: newText === null ? '' : newText,
    oldMissing: oldText === null,
    newMissing: newText === null,
    mode,
    note,
  }
}

module.exports = { ReviewError, MAX_SIDE_BYTES, normalizeRelative, relativeFromCwd, readSides }
