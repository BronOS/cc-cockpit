// A plugin's `contributes.skills` (plan: Claude-operable foundation, Task 3): the files of each
// skill folder, read under limits, and the strict SKILL.md front-matter check. One code path for
// both users so they cannot disagree: validate.ts runs it when the manifest is checked (a failure
// is a manifest error, the plugin is disabled with the reason), claude-plugins.ts runs it again
// when it copies the skills into `<data>/claude-plugins/<pluginId>/` (the folder may have changed
// in between: a linked dev folder, or anyone with write access to it).
//
// Why so strict: a skill is text Claude reads as instructions inside the user's session, and its
// front matter can widen what Claude may do (`allowed-tools` pre-approves tools, `model`, `hooks`).
// So only `name` and `description` are accepted, read by our own parser rather than a YAML library:
// a value that two YAML readers could read differently (quotes, block scalars, `key: value` inside
// a value, booleans) is refused, so what this check saw is what Claude sees.
//
// Synchronous on purpose: ClaudePlugins.build() is synchronous (a tab spawn must never see half a
// tree) and the whole read is capped at MAX_SKILL_BYTES.
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import * as path from 'node:path'
import { relativePathProblem, type SkillContribution } from '../../shared/manifest'
import { within } from '../path-within'
import { sameFile, VERIFIED_OPEN_FLAGS } from '../verified-read'

// The copy limits (the plan's), all of a plugin's skills together. The guide's `plugins` topic
// and docs/design.md state them; test/unit/cli-guide.test.ts checks they say these values.
/** Files copied per plugin. */
export const MAX_SKILL_FILES = 50
/** Bytes copied per plugin. */
export const MAX_SKILL_BYTES = 1024 * 1024
/** Folders walked per plugin: bounds a walk of empty nested folders, which the file cap does not see. */
export const MAX_SKILL_DIRS = 50
/**
 * Directory entries looked at per plugin, dot entries included: the walk is synchronous on main's
 * thread, and a folder of thousands of skipped dot files (or empty names) consumes none of the
 * other caps.
 */
export const MAX_SKILL_ENTRIES = 1000
/** Folder depth below a skill folder. */
export const MAX_SKILL_DEPTH = 8
/** Claude's own cap on a skill description. */
export const MAX_SKILL_DESCRIPTION = 1024

/**
 * One file of a skill: its path relative to the skill folder ("/"-separated), its bytes, and
 * whether its owner may execute it (a helper script the skill runs keeps that bit in the copy).
 */
export interface SkillFile {
  path: string
  data: Buffer
  executable: boolean
}

export interface SkillFiles {
  id: string
  files: SkillFile[]
}

export type SkillRead = { ok: true; skills: SkillFiles[] } | { ok: false; error: string }

/** A refusal with the wording the user sees; anything else thrown is an fs error. */
class SkillProblem extends Error {}

/**
 * Read every skill of a plugin from `realRoot` (the plugin folder's realpath). Refuses, with the
 * first problem found (the walk stops there; a 10,000-file folder is not enumerated to say "too
 * many"): a skill folder that is missing, not a folder, reached through a symlink or a dot
 * segment; any symlink or non-regular file inside it (dot entries are skipped, never copied); more
 * than MAX_SKILL_FILES files or MAX_SKILL_BYTES bytes; a missing SKILL.md or one whose front matter is not exactly
 * `name: <id>` and `description: <one line>`; a SKILL.md (any letter case) in a folder below it.
 */
export function readSkillFiles(realRoot: string, skills: readonly SkillContribution[]): SkillRead {
  const budget = new SkillBudget()
  const out: SkillFiles[] = []
  for (const skill of skills) {
    const label = `skill "${skill.id}"`
    try {
      const base = skillFolder(realRoot, skill.dir)
      const files = walk(base, '', 0, budget)
      const clash = pathCollision(files)
      if (clash !== null) throw new SkillProblem(clash)
      const md = files.find((f) => f.path === 'SKILL.md')
      if (!md) throw new SkillProblem(`${skill.dir}/SKILL.md not found`)
      const problem = skillFrontMatterProblem(md.data.toString('utf8'), skill.id)
      if (problem !== null) throw new SkillProblem(`SKILL.md ${problem}`)
      out.push({ id: skill.id, files })
    } catch (err) {
      const why = err instanceof SkillProblem ? err.message : `cannot be read: ${(err as Error).message}`
      return { ok: false, error: `${label}: ${why}` }
    }
  }
  return { ok: true, skills: out }
}

/**
 * Why two entries of one skill would land on the same path on a case-insensitive or
 * Unicode-normalizing filesystem (macOS APFS/HFS+, Windows), or null. Review finding: a linked
 * folder on a case-sensitive disk can hold the validated `SKILL.md` and a `skill.md` whose front
 * matter was never checked; copied into app storage on a case-insensitive disk the second write
 * would replace the first, and Claude would read `allowed-tools` the check never saw.
 *
 * An early refusal for the common cases only, with a clear message at validation time: the fold
 * (NFC, lower case) is not what any real filesystem compares (APFS also folds `ſ` U+017F to `s`,
 * and other case-folding and normalization quirks differ per filesystem). The guarantee is the
 * copy step, which creates every file exclusively in a fresh folder so the destination disk itself
 * refuses a second file under a name it treats as taken (ClaudePlugins.writeChild). Exported for
 * the tests (a case-insensitive CI disk cannot hold the colliding files). Every folder prefix is
 * compared too (`Docs/a.md` next to `docs/b.md`).
 */
export function pathCollision(files: readonly SkillFile[]): string | null {
  const seen = new Map<string, string>()
  const fold = (p: string): string => p.normalize('NFC').toLowerCase().normalize('NFC')
  for (const f of files) {
    const parts = f.path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      const key = fold(prefix)
      const prior = seen.get(key)
      if (prior === undefined) seen.set(key, prefix)
      else if (prior !== prefix) return `${prior} and ${prefix} differ only in letter case or Unicode form (they would overwrite each other on some filesystems)`
    }
  }
  return null
}

/**
 * The skill folder's absolute path. `realpath(p) === p` means no component of `dir` is a symlink
 * (the root already is a realpath), which also keeps it inside the plugin folder: `..` is refused
 * by the syntax check, so a resolved path can only leave through a link.
 */
function skillFolder(realRoot: string, dir: string): string {
  const syntax = relativePathProblem(dir)
  if (syntax !== null) throw new SkillProblem(`dir "${dir}" ${syntax}`)
  if (dir.split('/').some((s) => s.startsWith('.') && s !== '.')) {
    throw new SkillProblem(`dir "${dir}" must not contain dot-folders`)
  }
  const target = path.resolve(realRoot, dir)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new SkillProblem(`dir "${dir}" not found`)
  }
  if (real !== target) throw new SkillProblem(`dir "${dir}" must not be or go through a symlink`)
  if (target === realRoot || !within(realRoot, target)) {
    throw new SkillProblem(`dir "${dir}" must be a folder inside the plugin folder`)
  }
  if (!lstatSync(target).isDirectory()) throw new SkillProblem(`dir "${dir}" is not a folder`)
  return target
}

/**
 * What one plugin's skills have used so far, all skill folders together, and the refusals past
 * each limit. One per readSkillFiles call.
 */
class SkillBudget {
  private files = 0
  private bytes = 0
  private dirs = 0
  private entries = 0

  /** A folder is about to be walked, `depth` below its skill folder. */
  enterFolder(rel: string, depth: number): void {
    if (++this.dirs > MAX_SKILL_DIRS) throw new SkillProblem(`more than ${MAX_SKILL_DIRS} folders`)
    if (depth > MAX_SKILL_DEPTH) throw new SkillProblem(`${rel} is nested deeper than ${MAX_SKILL_DEPTH} folders`)
  }

  /** A directory entry was listed, whatever it is (dot entries too, which no other cap sees). */
  seeEntry(): void {
    if (++this.entries > MAX_SKILL_ENTRIES) throw new SkillProblem(`more than ${MAX_SKILL_ENTRIES} entries`)
  }

  /** A regular file is about to be read; returns how many bytes it may have. */
  takeFile(): number {
    if (++this.files > MAX_SKILL_FILES) throw new SkillProblem(`more than ${MAX_SKILL_FILES} files`)
    return MAX_SKILL_BYTES - this.bytes
  }

  spend(bytes: number): void {
    this.bytes += bytes
  }
}

/** The regular files below `dir` (its path relative to the skill folder is `rel`), depth first. */
function walk(dir: string, rel: string, depth: number, budget: SkillBudget): SkillFile[] {
  budget.enterFolder(rel, depth)
  const files: SkillFile[] = []
  // opendir rather than readdir: the walk stops at the first refusal without listing the rest.
  const handle = opendirSync(dir)
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      budget.seeEntry()
      const name = entry.name
      const relPath = rel === '' ? name : `${rel}/${name}`
      // Dot entries (`.git`, `.env`, editor swap files, the `.DS_Store` a Finder visit drops into
      // a linked dev folder) are skipped, not refused: they are not skill content and are never
      // copied (the plan's "no dot-files"), but refusing would disable a plugin's skills over a
      // file its author never made. Skipped before the lstat, so a dot symlink is not followed.
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) throw new SkillProblem(`${relPath} is a symlink (only regular files are copied)`)
      if (st.isDirectory()) {
        files.push(...walk(full, relPath, depth + 1, budget))
      } else if (st.isFile()) {
        if (rel !== '' && isSkillFileName(name)) {
          throw new SkillProblem(`${relPath}: a SKILL.md below the skill folder is not allowed (only the top one is checked)`)
        }
        const { data, executable } = readRegularFile(full, relPath, st, budget.takeFile())
        budget.spend(data.length)
        files.push({ path: relPath, data, executable })
      } else {
        throw new SkillProblem(`${relPath} is not a regular file`)
      }
    }
  } finally {
    handle.closeSync()
  }
  // A folder swapped for a symlink to elsewhere after it was lstat'd (its entries above were then
  // read from the link's target): the folder no longer resolves to itself.
  if (realpathSync(dir) !== dir) throw new SkillProblem(`${rel || '.'} changed into a symlink while it was read`)
  return files
}

/**
 * A name some filesystem or skill loader may take for `SKILL.md`: letter case and Unicode
 * compatibility forms folded (NFKC maps `ſ` U+017F and the Kelvin sign to `s` and `K`; upper-casing
 * maps the dotless `ı` to `I`). Review finding: only the top SKILL.md gets the front-matter check,
 * yet the walk copies every file, so a nested `sub/SKILL.md` with `allowed-tools` would reach
 * `<data>/claude-plugins/` unchecked if Claude Code loads nested skills. Refused, so the rule
 * "any other key is refused" holds for every SKILL.md that is copied.
 */
function isSkillFileName(name: string): boolean {
  const folded = name.normalize('NFKC')
  return folded.toLowerCase() === 'skill.md' || folded.toUpperCase() === 'SKILL.MD'
}

/**
 * The bytes of a file just lstat'd as regular, checked again on the open descriptor (the rules of
 * verified-read.ts, synchronously): O_NOFOLLOW refuses a symlink swapped in since the lstat,
 * O_NONBLOCK keeps a FIFO swapped in from blocking the open, the descriptor's dev/inode must be the
 * lstat'd file's, and the name must still lead to it with no symlink on the way (a folder above it
 * swapped for a symlink to elsewhere sends the lstat and the open there alike, so the inode match
 * alone would not see it; the walk's own per-folder check comes only after the whole folder). The
 * file is read from that descriptor, so what was checked is what is copied. The read stops past
 * `room` bytes, so a file growing meanwhile cannot exceed the cap.
 */
function readRegularFile(full: string, relPath: string, st: Stats, room: number): { data: Buffer; executable: boolean } {
  const tooBig = (): SkillProblem => new SkillProblem(`the skill files are larger than ${MAX_SKILL_BYTES} bytes in total`)
  if (st.size > room) throw tooBig()
  let fd: number
  try {
    fd = openSync(full, VERIFIED_OPEN_FLAGS)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new SkillProblem(`${relPath} is a symlink (only regular files are copied)`)
    throw err
  }
  try {
    const now = fstatSync(fd)
    if (!now.isFile() || !sameFile(now, st) || !namesFileSync(full, now)) throw new SkillProblem(`${relPath} changed while it was read`)
    const buf = Buffer.alloc(Math.min(room, now.size) + 1)
    let length = 0
    for (;;) {
      if (length === buf.length) throw tooBig()
      const n = readSync(fd, buf, length, buf.length - length, null)
      if (n === 0) break
      length += n
    }
    // The mode of the descriptor read from, like the bytes; only the owner's exec bit is kept.
    return { data: buf.subarray(0, length), executable: (now.mode & 0o100) !== 0 }
  } finally {
    closeSync(fd)
  }
}

/** `full` still resolves to itself (no symlink on it) and names the file `st` describes. */
function namesFileSync(full: string, st: Stats): boolean {
  try {
    return realpathSync(full) === full && sameFile(statSync(full), st)
  } catch {
    return false
  }
}

// A value YAML reads as something other than the plain string written: booleans and null in both
// YAML 1.1 and 1.2 spellings, numbers (YAML 1.1 binary `0b…` and sexagesimal `12:30` = 750 too),
// infinities. Claude would see `true`, not "true". A number has at least one digit before its
// exponent (review finding: with every part optional, the skill id `e5` was refused as one).
const YAML_NON_STRING =
  /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[-+]?\d+)?|[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?|0x[0-9a-f]+|0o[0-7]+|[-+]?0b[01_]+|[-+]?\.inf|\.nan)$/i

/**
 * Why `text` (a SKILL.md) does not start with the only front matter accepted, or null:
 *
 *   ---
 *   name: <id>
 *   description: <one line>
 *   ---
 *
 * in either order, each key once, blank lines allowed between them, LF line endings. Anything
 * else is refused: another key (`allowed-tools`, `model`, `hooks`, …), a comment, an indented
 * line, a value YAML would not read as that exact plain string. Exported for the tests.
 */
export function skillFrontMatterProblem(text: string, id: string): string | null {
  if (text.startsWith('﻿')) return 'must not start with a byte order mark'
  if (text.includes('\r')) return 'must use LF line endings'
  if (!text.startsWith('---\n')) return 'must start with a "---" front matter line'
  // The closing line, also as the file's last line with no newline after it. Searched from index 3
  // so an empty front matter (`---\n---\n`) finds its closing line; reported below as missing keys.
  let end = text.indexOf('\n---\n', 3)
  if (end === -1 && text.endsWith('\n---')) end = text.length - 4
  if (end === -1) return 'front matter is not closed by a "---" line'
  const body = text.slice(4, Math.max(4, end))
  const values = new Map<string, string>()
  for (const line of body === '' ? [] : body.split('\n')) {
    if (line === '') continue
    const m = /^([A-Za-z0-9_-]+):(?: (.*))?$/.exec(line)
    if (!m) return `front matter line ${JSON.stringify(line.slice(0, 80))} is not "key: value"`
    const key = m[1] as string
    if (key !== 'name' && key !== 'description') {
      return `front matter key "${key}" is not allowed (only "name" and "description"; other keys change what Claude may do)`
    }
    if (values.has(key)) return `front matter key "${key}" appears twice`
    // Only space and tab, which is all YAML trims around a plain scalar: String.trim also takes
    // Unicode spaces, so `name: demo<NBSP>` passed as `demo` while YAML keeps the NBSP in the name
    // (review finding).
    values.set(key, (m[2] ?? '').replace(/^[ \t]+|[ \t]+$/g, ''))
  }
  const name = values.get('name')
  if (name === undefined) return 'front matter has no "name"'
  if (name !== id) return `front matter name "${name.slice(0, 80)}" must equal the skill id "${id}"`
  // Review finding: `name: true`, `null` or `123` equals an id SKILL_ID_PATTERN allows, but YAML
  // reads it as a boolean, null or number, not the string id. The SKILL.md cannot quote it (the
  // name must equal the id), so the id itself has to change.
  const nameProblem = skillNameProblem(name)
  if (nameProblem !== null) return nameProblem
  const description = values.get('description')
  if (description === undefined || description === '') return 'front matter has no "description"'
  if (description.length > MAX_SKILL_DESCRIPTION) return `description is longer than ${MAX_SKILL_DESCRIPTION} characters`
  return descriptionProblem(description)
}

/**
 * Why a skill `name` (equal to its id) would not read back from YAML as that string, or null. The
 * same rules as a description. Exported for `ccc plugin new`, which derives a skill id and must not
 * scaffold one that never loads.
 */
export function skillNameProblem(name: string): string | null {
  const why = plainScalarProblem(name)
  return why === null ? null : `skill id "${name.slice(0, 80)}" ${why}, so it cannot be the front matter name (pick another skill id)`
}

function descriptionProblem(d: string): string | null {
  const why = plainScalarProblem(d)
  return why === null ? null : `description ${why} (write it as plain text on one line)`
}

/**
 * A front matter value must be a YAML plain scalar that reads back as itself. It starts with a
 * letter or digit (no quote, `>`/`|` block scalar, `&`/`*` anchor, `!` tag, `[`/`{` flow, `#`
 * comment, `-`/`?`/`:` indicators, backtick or `@`), has no `: ` (YAML: a nested mapping, an error)
 * or ` #` (YAML: the rest is a comment), does not end with `:`, has no control character (C0, DEL
 * and C1: a YAML 1.1 reader takes NEL `\x85` for a line break and js-yaml refuses the other C1
 * codes) and no U+2028/U+2029 (line breaks to YAML 1.1 too), and is not a boolean, null, number or
 * date. Returns why not, or null.
 */
function plainScalarProblem(v: string): string | null {
  if (!/^[\p{L}\p{N}]/u.test(v)) return 'must start with a letter or digit'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v)) return 'must not contain control characters or line separators'
  if (v.includes(': ') || v.endsWith(':')) return 'must not contain ": " or end with ":"'
  if (v.includes(' #')) return 'must not contain " #"'
  if (YAML_NON_STRING.test(v)) return 'reads as a YAML boolean, null or number'
  // A YAML 1.1 reader (js-yaml) turns `2024-01-01` and `2024-01-01 10:00` into a Date.
  if (/^\d{4}-\d\d-\d\d/.test(v)) return 'must not start with a date'
  return null
}
