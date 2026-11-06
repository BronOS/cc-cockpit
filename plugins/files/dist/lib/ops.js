'use strict'
// The tree's own writes: New file, New folder, Rename (the right-click menu). They run here in the
// host with Node fs, not in main: they create or rename inside the project only, which any plugin
// host may already do, and the person typed the name in the panel a moment before. Moving to the
// Trash and handing a file to the system are main's (ctx.files.trash / reveal / openWithSystem):
// those need the desktop session the host does not have, and the Trash needs the person's yes.
//
// Confinement, by real path: the folder a new entry goes into (or the folder holding the entry to
// rename) is realpath'd and must be the project folder or inside it, so a folder link out of the
// project (`out` -> `/etc`) cannot be written through; the new name is one path segment, so the
// entry lands in that folder. An existing name is refused, never replaced: a new file is opened with
// O_EXCL (which also refuses a dangling symlink of that name), a new folder with a plain mkdir, and
// a rename looks first (Node has no rename-without-replace; the window between the look and the
// rename is the person's own folder, accepted). A rename that only changes case on a
// case-insensitive disk (macOS) names the same entry, and is allowed.

const fs = require('node:fs/promises')
const path = require('node:path')
const { normalizeRelative } = require('./tree')

/** A file name's limit on every common file system (bytes, as UTF-8). */
const MAX_NAME_BYTES = 255

/**
 * A new name for an entry: one path segment. Throws with the reason the panel shows. Refused: not a
 * string, empty, `.` or `..`, a `/` (or `\` on Windows, where it separates too), a NUL, or over 255
 * bytes. Spaces are kept as typed (a name may end in one), except that a name of only spaces is empty.
 */
function checkName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('Type a name.')
  if (name === '.' || name === '..') throw new Error(`"${name}" cannot be a name.`)
  if (name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) throw new Error('A name cannot contain "/".')
  if (name.includes('\0')) throw new Error('A name cannot contain a NUL character.')
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw new Error(`A name is at most ${MAX_NAME_BYTES} bytes.`)
  return name
}

const joinRel = (dir, name) => (dir === '' ? name : `${dir}/${name}`)
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1)

/** Inside `root` (a real path) or `root` itself. */
function within(root, abs) {
  const r = path.relative(root, abs)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/** The real path of folder `relDir` of the project, checked to be inside it and a folder. */
async function realDirInside(root, relDir) {
  const realRoot = await fs.realpath(root)
  let real
  try {
    real = await fs.realpath(path.join(realRoot, relDir))
  } catch {
    throw new Error(`${relDir || 'The project folder'} is gone.`)
  }
  if (!within(realRoot, real)) throw new Error(`${relDir} is outside the project.`)
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${relDir} is not a folder.`)
  return real
}

const exists = (name) => new Error(`"${name}" already exists there.`)

/** New empty file `name` in folder `relDir`; its relative path. */
async function createFile(root, relDir, name) {
  const dir = normalizeRelative(relDir)
  checkName(name)
  const real = await realDirInside(root, dir)
  try {
    // 'wx': O_CREAT | O_EXCL, never an existing file or link, never truncating one.
    const fh = await fs.open(path.join(real, name), 'wx')
    await fh.close()
  } catch (e) {
    if (e.code === 'EEXIST') throw exists(name)
    throw e
  }
  return joinRel(dir, name)
}

/** New folder `name` in folder `relDir`; its relative path. */
async function createFolder(root, relDir, name) {
  const dir = normalizeRelative(relDir)
  checkName(name)
  const real = await realDirInside(root, dir)
  try {
    await fs.mkdir(path.join(real, name))
  } catch (e) {
    if (e.code === 'EEXIST') throw exists(name)
    throw e
  }
  return joinRel(dir, name)
}

/**
 * Rename the entry at `rel` (a file, a folder or a link: the entry itself, never a link's target)
 * to `name` in the same folder; its new relative path.
 */
async function renameEntry(root, rel, name) {
  const from = normalizeRelative(rel)
  if (from === '') throw new Error('The project folder cannot be renamed here.')
  checkName(name)
  const dir = parentOf(from)
  const real = await realDirInside(root, dir)
  const source = path.join(real, baseOf(from))
  let before
  try {
    before = await fs.lstat(source)
  } catch {
    throw new Error(`${from} is gone.`)
  }
  if (name === baseOf(from)) return from
  const target = path.join(real, name)
  const there = await fs.lstat(target).catch(() => null)
  // The same entry under another case of its name (a case-insensitive disk): a real rename.
  if (there && !(there.ino === before.ino && there.dev === before.dev)) throw exists(name)
  await fs.rename(source, target)
  return joinRel(dir, name)
}

module.exports = { checkName, createFile, createFolder, renameEntry, MAX_NAME_BYTES }
