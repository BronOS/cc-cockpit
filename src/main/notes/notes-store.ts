// The Notes API's files (shared/design.md §3, spec-review S4): one JSON file per (project, plugin) under
// `<data>/notes/<projectId>/<sha256(pluginId)>.json`, each holding that plugin's keys. Pure file work and a cache; the
// rules (caps, authors, ids, pushes) are notes-service.ts's. Every operation runs through `serial`, one at a time across
// the whole store, so two writes to one file never interleave their read-modify-write (two views and a guest typing
// at once, a Discuss removal landing beside a page's add).
//
// The plugin id is hashed for the file name: ids are checked elsewhere, but a hash keeps any id (dots, a future
// character) from ever being a path. The project id is main's own (a registry id), checked here anyway, since it is
// the one name that becomes a folder.
//
// Keys are kept in a Map and written as a list of [key, state] pairs, never as an object's properties: a key such as
// `__proto__` is valid (isNotesKey's characters) and must stay data.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isNotesKey } from '../../shared/notes-limits'
import type { NoteAuthor, NotesState, OverlayNote } from '../../shared/overlay-envelope'

/** One plugin's keys in one project, in memory. */
export type PluginNotes = Map<string, NotesState>

/** A project id as main mints it; anything else never becomes a folder name. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/

const FILE_VERSION = 1

export function notesFileName(pluginId: string): string {
  return `${createHash('sha256').update(pluginId).digest('hex')}.json`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An author as stored: the shapes main writes, anything else dropped with its note. */
function authorOf(v: unknown): NoteAuthor | undefined {
  if (!isObj(v)) return undefined
  if (v.plugin === true) return { plugin: true }
  if (v.access !== 'owner' && v.access !== 'write') return undefined
  if (v.person === undefined) return { access: v.access }
  return typeof v.person === 'string' ? { access: v.access, person: v.person } : undefined
}

/** A stored note, or undefined for a malformed one (the file is user-writable: lenient, never a crash). */
function noteOf(v: unknown): OverlayNote | undefined {
  if (!isObj(v)) return undefined
  const author = authorOf(v.author)
  if (typeof v.id !== 'string' || v.id === '' || typeof v.quote !== 'string' || typeof v.text !== 'string') return undefined
  if (typeof v.rev !== 'number' || !Number.isSafeInteger(v.rev) || v.rev < 1 || !author) return undefined
  return { id: v.id, quote: v.quote, anchor: v.anchor ?? null, text: v.text, rev: v.rev, author }
}

function stateOf(v: unknown): NotesState | undefined {
  if (!isObj(v)) return undefined
  const notes = Array.isArray(v.notes) ? v.notes.map(noteOf).filter((n): n is OverlayNote => n !== undefined) : []
  const global = typeof v.global === 'string' ? v.global : ''
  const rev = typeof v.rev === 'number' && Number.isSafeInteger(v.rev) && v.rev >= 0 ? v.rev : 0
  return { global, notes, rev }
}

/** A file's text as keys, lenient: an unreadable entry is dropped, never the whole file. */
export function parseNotesFile(text: string): PluginNotes {
  const out: PluginNotes = new Map()
  const raw: unknown = JSON.parse(text)
  if (!isObj(raw) || !Array.isArray(raw.keys)) return out
  for (const entry of raw.keys) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isNotesKey(entry[0])) continue
    const state = stateOf(entry[1])
    if (state) out.set(entry[0], state)
  }
  return out
}

export class NotesStore {
  private readonly cache = new Map<string, PluginNotes>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly log: (message: string) => void
  ) {}

  /** Run `fn` after every earlier operation has ended (a failed one included). */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private projectDir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('notes: not a project id')
    return join(this.dir, projectId)
  }

  private fileOf(projectId: string, pluginId: string): string {
    return join(this.projectDir(projectId), notesFileName(pluginId))
  }

  /** The plugin's keys in the project (empty when it has none). Call inside `serial`. */
  async load(projectId: string, pluginId: string): Promise<PluginNotes> {
    const cacheKey = `${projectId}\0${pluginId}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    const file = this.fileOf(projectId, pluginId)
    let notes: PluginNotes = new Map()
    try {
      notes = parseNotesFile(await readFile(file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Kept aside, never written over: the person's notes may still be in it.
        const aside = `${file}.unreadable-${Date.now()}`
        this.log(`notes: ${file} is unreadable (${String(err)}); moved to ${aside}`)
        await rename(file, aside).catch(() => undefined)
      }
    }
    this.cache.set(cacheKey, notes)
    return notes
  }

  /**
   * Write the plugin's keys (the Map `load` gave, changed in place by the caller). No keys left: the file goes, and the
   * project's folder too once it is empty. Written to a temp file beside it, then renamed over it, so a crash leaves
   * the old file or the new one, never half of one. Call inside `serial`.
   */
  async save(projectId: string, pluginId: string, notes: PluginNotes): Promise<void> {
    const file = this.fileOf(projectId, pluginId)
    if (notes.size === 0) {
      await unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
      await rmdir(this.projectDir(projectId)).catch(() => undefined)
      return
    }
    await mkdir(this.projectDir(projectId), { recursive: true })
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
    const body = JSON.stringify({ version: FILE_VERSION, keys: [...notes.entries()] })
    try {
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
  }

  /** Uninstall: the plugin's file in every project. Call inside `serial`. */
  async removePlugin(pluginId: string): Promise<void> {
    for (const key of [...this.cache.keys()]) if (key.endsWith(`\0${pluginId}`)) this.cache.delete(key)
    let projects: string[]
    try {
      projects = await readdir(this.dir)
    } catch {
      return
    }
    const name = notesFileName(pluginId)
    for (const projectId of projects) {
      if (!PROJECT_ID.test(projectId)) continue
      await unlink(join(this.dir, projectId, name)).catch(() => undefined)
      await rmdir(join(this.dir, projectId)).catch(() => undefined)
    }
  }

  /** Project forget: every plugin's notes in the project. Call inside `serial`. */
  async dropProject(projectId: string): Promise<void> {
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${projectId}\0`)) this.cache.delete(key)
    await rm(this.projectDir(projectId), { recursive: true, force: true })
  }
}
