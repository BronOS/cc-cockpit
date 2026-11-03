// The OS sound files the notification "Sound" setting can pick (design §5 "Notifications";
// shared/notify-sound.ts has the ids). Pure Node, no Electron: unit tests walk temp folders.
//
// Only fixed folders are read, never one from a renderer, a plugin or app.json:
//   Linux    /usr/share/sounds (sound themes; freedesktop's stereo files listed first), ~/.local/share/sounds
//   macOS    /System/Library/Sounds, ~/Library/Sounds
//   Windows  %WINDIR%\Media
// An id names a root by its index in that list and a path under it. Every use (a pick, the bytes
// for a chime) lists the folders again and matches the id against that listing, so a hand-edited
// app.json or a renderer's request reaches only a file the listing itself would show.
//
// What is listed: regular files (a symlink is followed, but its target must stay inside the root's
// realpath: a theme links one sound to another, while a link to ~/.ssh/id_rsa must not become
// readable), with one of SYSTEM_SOUND_EXTENSIONS, non-empty and at most MAX_SYSTEM_SOUND_BYTES,
// no dot files, folders at most MAX_DEPTH deep (a symlinked folder is not entered: no loops), at
// most MAX_ENTRIES directory entries looked at per root and MAX_SYSTEM_SOUNDS sounds in all.
// Reading opens the listed realpath and checks that the open file is still the one listed (same
// device and inode, still regular and small), so a swap after the listing reads nothing.
import { readdir, realpath, stat, open } from 'node:fs/promises'
import { extname, join, win32 } from 'node:path'
import type { NotificationSoundData, NotificationSoundGroup } from '../../shared/ipc'
import {
  BUILTIN_SOUNDS,
  MAX_SYSTEM_SOUND_BYTES,
  MAX_SYSTEM_SOUNDS,
  parseSoundId,
  SYSTEM_SOUND_EXTENSIONS,
  soundMediaType,
  systemSoundId
} from '../../shared/notify-sound'
import { within } from '../path-within'

/** One OS sound folder: where it is and the dropdown group it fills. */
export interface SoundRoot {
  dir: string
  label: string
}

/** Folder levels below a root that are walked (a theme is `<theme>/stereo/<file>`: 2). */
const MAX_DEPTH = 4
/** Directory entries looked at per root: bounds the walk of a folder with thousands of files. */
const MAX_ENTRIES = 5000

export interface SoundListLimits {
  maxSounds?: number
  maxBytes?: number
  maxDepth?: number
  maxEntries?: number
}

/** A listed sound file. `path` is its realpath (inside the root's), `dev`/`ino` what it was then. */
export interface SystemSound {
  id: string
  name: string
  root: number
  rel: string
  path: string
  dev: number
  ino: number
}

/** The fixed sound folders of `platform`, in id order (the index is part of every system id). */
export function systemSoundRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): SoundRoot[] {
  if (platform === 'darwin') {
    return [
      { dir: '/System/Library/Sounds', label: 'macOS sounds' },
      { dir: join(home, 'Library', 'Sounds'), label: 'Your sounds' }
    ]
  }
  if (platform === 'win32') {
    // %WINDIR% is the documented way to the Windows folder; a value that is not an absolute path
    // is not trusted to be one.
    const windir = [env.WINDIR, env.SystemRoot].find((d) => typeof d === 'string' && win32.isAbsolute(d)) ?? 'C:\\Windows'
    return [{ dir: win32.join(windir, 'Media'), label: 'Windows sounds' }]
  }
  return [
    { dir: '/usr/share/sounds', label: 'System sounds' },
    { dir: join(home, '.local', 'share', 'sounds'), label: 'Your sounds' }
  ]
}

/**
 * Listing order inside a root: freedesktop's stereo files first (the desktop's own event sounds
 * on most Linux systems), then any other theme's stereo folder, then the rest; by path within each.
 * The cap keeps the first ones, so a big theme cannot push the familiar sounds out.
 */
function rank(rel: string): number {
  if (rel.startsWith('freedesktop/stereo/')) return 0
  const parts = rel.split('/')
  return parts.length >= 2 && parts[parts.length - 2] === 'stereo' ? 1 : 2
}

function isSoundFile(name: string): boolean {
  return (SYSTEM_SOUND_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase())
}

/** The candidates under one root (a `/`-separated path each), bounded by depth and entry count. */
async function walk(realRoot: string, maxDepth: number, maxEntries: number): Promise<string[]> {
  const found: string[] = []
  let seen = 0
  const queue: { rel: string[]; depth: number }[] = [{ rel: [], depth: 0 }]
  while (queue.length > 0 && seen < maxEntries) {
    const dir = queue.shift() as { rel: string[]; depth: number }
    let entries
    try {
      entries = await readdir(join(realRoot, ...dir.rel), { withFileTypes: true })
    } catch {
      continue // unreadable: skipped, like a missing root
    }
    // freedesktop and stereo first, so the entry cap reaches them before the rest.
    entries.sort((a, b) => {
      const pa = a.name === 'freedesktop' || a.name === 'stereo' ? 0 : 1
      const pb = b.name === 'freedesktop' || b.name === 'stereo' ? 0 : 1
      return pa - pb || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    })
    for (const entry of entries) {
      if (++seen > maxEntries) break
      if (entry.name.startsWith('.')) continue
      const rel = [...dir.rel, entry.name]
      if (entry.isDirectory()) {
        if (dir.depth < maxDepth) queue.push({ rel, depth: dir.depth + 1 })
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isSoundFile(entry.name)) {
        found.push(rel.join('/'))
      }
    }
  }
  return found.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** "message-new-instant.oga" → "message new instant". */
function stemName(rel: string): string {
  const file = rel.slice(rel.lastIndexOf('/') + 1)
  const stem = file.slice(0, file.length - extname(file).length)
  return stem.replace(/[-_]+/g, ' ').trim() || stem
}

/**
 * Friendly names within one root: the file stem; a stem that two files share gets its folder
 * (`bell (freedesktop/stereo)`), and when that still clashes the extension too. The relative path
 * is the last resort, unique by construction.
 */
function nameAll(sounds: SystemSound[]): void {
  const clashes = (names: string[]): Set<string> => {
    const count = new Map<string, number>()
    for (const n of names) count.set(n.toLowerCase(), (count.get(n.toLowerCase()) ?? 0) + 1)
    return new Set([...count].filter(([, c]) => c > 1).map(([n]) => n))
  }
  const base = sounds.map((s) => stemName(s.rel))
  const dupBase = clashes(base)
  const withDir = sounds.map((s, i) => {
    const name = base[i] as string
    if (!dupBase.has(name.toLowerCase())) return name
    const slash = s.rel.lastIndexOf('/')
    return slash < 0 ? name : `${name} (${s.rel.slice(0, slash)})`
  })
  const dupDir = clashes(withDir)
  const withExt = sounds.map((s, i) => {
    const name = withDir[i] as string
    if (!dupDir.has(name.toLowerCase())) return name
    const ext = extname(s.rel).slice(1).toLowerCase()
    return name.endsWith(')') ? `${name.slice(0, -1)}, ${ext})` : `${name} (${ext})`
  })
  const dupExt = clashes(withExt)
  sounds.forEach((s, i) => {
    const name = withExt[i] as string
    s.name = dupExt.has(name.toLowerCase()) ? s.rel : name
  })
}

/** Every sound file under `roots` that passes the rules in the file header, in dropdown order. */
export async function listSystemSounds(roots: readonly SoundRoot[], limits: SoundListLimits = {}): Promise<SystemSound[]> {
  const maxSounds = limits.maxSounds ?? MAX_SYSTEM_SOUNDS
  const maxBytes = limits.maxBytes ?? MAX_SYSTEM_SOUND_BYTES
  const out: SystemSound[] = []
  for (const [index, root] of roots.entries()) {
    if (out.length >= maxSounds) break
    let realRoot: string
    try {
      realRoot = await realpath(root.dir)
    } catch {
      continue // no such folder on this machine (no ~/Library/Sounds yet)
    }
    const inRoot: SystemSound[] = []
    for (const rel of await walk(realRoot, limits.maxDepth ?? MAX_DEPTH, limits.maxEntries ?? MAX_ENTRIES)) {
      if (out.length + inRoot.length >= maxSounds) break
      try {
        const real = await realpath(join(realRoot, ...rel.split('/')))
        if (!within(realRoot, real) || real === realRoot) continue
        const st = await stat(real)
        if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue
        inRoot.push({ id: systemSoundId(index, rel), name: '', root: index, rel, path: real, dev: st.dev, ino: st.ino })
      } catch {
        // A dangling link or a file that went away during the walk: not listed.
      }
    }
    nameAll(inRoot)
    out.push(...inRoot)
  }
  return out
}

/** The OS sounds as main serves them: the dropdown, the check of a pick, and the bytes for a chime. */
export class SystemSounds {
  constructor(
    private readonly roots: readonly SoundRoot[],
    private readonly limits: SoundListLimits = {}
  ) {}

  list(): Promise<SystemSound[]> {
    return listSystemSounds(this.roots, this.limits)
  }

  /** The dropdown: "Built-in" first, then one group per root that has sounds, names only. */
  async groups(): Promise<NotificationSoundGroup[]> {
    const listed = await this.list()
    const groups: NotificationSoundGroup[] = [
      { label: 'Built-in', sounds: BUILTIN_SOUNDS.map((s) => ({ id: `builtin:${s.name}`, name: s.title })) }
    ]
    for (const [index, root] of this.roots.entries()) {
      const sounds = listed.filter((s) => s.root === index).map((s) => ({ id: s.id, name: s.name }))
      if (sounds.length > 0) groups.push({ label: root.label, sounds })
    }
    return groups
  }

  /** The listed sound with this id now, or undefined (not a system id, gone, or never listable). */
  private async find(id: unknown): Promise<SystemSound | undefined> {
    const parsed = parseSoundId(id)
    if (parsed?.kind !== 'system' || parsed.root >= this.roots.length) return undefined
    return (await this.list()).find((s) => s.id === id)
  }

  /** A system id is in a fresh listing. */
  async has(id: string): Promise<boolean> {
    return (await this.find(id)) !== undefined
  }

  /** The bytes of a listed sound, read from the file the listing found; null for anything else. */
  async read(id: unknown): Promise<NotificationSoundData | null> {
    const sound = await this.find(id)
    if (!sound) return null
    const maxBytes = this.limits.maxBytes ?? MAX_SYSTEM_SOUND_BYTES
    let file
    try {
      file = await open(sound.path, 'r')
    } catch {
      return null
    }
    try {
      const st = await file.stat()
      if (!st.isFile() || st.dev !== sound.dev || st.ino !== sound.ino || st.size === 0 || st.size > maxBytes) return null
      const buf = Buffer.alloc(st.size)
      const { bytesRead } = await file.read(buf, 0, st.size, 0)
      return { data: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead), type: soundMediaType(sound.rel) }
    } catch {
      return null
    } finally {
      await file.close().catch(() => {})
    }
  }
}
