// Kept Ask chats (decision D14, design-parts.md §7): the owner's chat of each (project, plugin, notes key), so a window
// reopened after Esc or a restart shows the chat again and the next question resumes its Claude session.
//
// `<data>/ask/<projectId>/<sha256(pluginId)>.json`, one JsonFile per (project, plugin), written by main one change at a
// time and flushed at once (a turn is rare; a quit right after one must not lose it). The plugin id is hashed so the
// file name never carries a name a manifest chose; the project id is main's own and checked as a path segment anyway.
// Main keeps its own copy of the turns for the restore, never Claude's session file (its format is Claude Code's,
// internal and changing). A write guest's chat is never stored (in memory only, ask-service.ts).
//
// Caps (shared/ask.ts): ASK_STORE_MAX_KEYS chats per file, the least recently used evicted; ASK_STORE_MAX_TURNS_CHARS of
// turns per chat as JSON, the oldest turns dropped first (the Claude session keeps them; only the shown history goes).
// Chats are an array, never an object keyed by the notes key: a key such as `__proto__` must stay data.
import { createHash } from 'node:crypto'
import { readdirSync, rmSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ASK_STORE_MAX_KEYS, ASK_STORE_MAX_TURNS_CHARS } from '../../shared/ask'
import type { AskTurn } from '../../shared/overlay-envelope'
import { JsonFile } from '../store/json-file'
import { cleanPick } from './ask-pick'
import { isSessionUuid } from './ask-argv'

export interface StoredChat {
  key: string
  /** The Claude session the next question resumes (a UUID only); absent once continued in a tab or never started. */
  sessionId?: string
  model?: string
  effort?: string
  turns: AskTurn[]
  updatedAt: number
  /** The tab the chat was continued in (D14), shown by the page; the session is the tab's from then on. */
  continuedIn?: string
}

interface ChatsFile {
  schemaVersion: number
  chats: unknown
}

/** A project id as a path segment: main's ids are short and plain; anything else is never a folder name here. */
const PROJECT_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

const pluginFile = (pluginId: string): string => `${createHash('sha256').update(pluginId, 'utf8').digest('hex')}.json`

function cleanTurn(raw: unknown): AskTurn | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const t = raw as Record<string, unknown>
  if (typeof t.question !== 'string' || typeof t.answer !== 'string') return undefined
  const turn: AskTurn = { question: t.question, answer: t.answer }
  if (typeof t.quote === 'string') turn.quote = t.quote
  if (typeof t.error === 'string') turn.error = t.error
  return turn
}

/** A stored entry as read (a hand-edited or older file): what is malformed is dropped, a non-UUID session included. */
function cleanChat(raw: unknown): StoredChat | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Record<string, unknown>
  if (typeof c.key !== 'string' || c.key === '') return undefined
  const chat: StoredChat = {
    key: c.key,
    turns: Array.isArray(c.turns) ? c.turns.map(cleanTurn).filter((t): t is AskTurn => t !== undefined) : [],
    updatedAt: typeof c.updatedAt === 'number' && Number.isFinite(c.updatedAt) ? c.updatedAt : 0
  }
  if (isSessionUuid(c.sessionId)) chat.sessionId = c.sessionId
  Object.assign(chat, cleanPick({ model: c.model, effort: c.effort }))
  if (typeof c.continuedIn === 'string' && c.continuedIn.length <= 200) chat.continuedIn = c.continuedIn
  return chat
}

/** The turns cut to the cap, oldest first out. */
export function capTurns(turns: readonly AskTurn[], maxChars = ASK_STORE_MAX_TURNS_CHARS): AskTurn[] {
  const out = [...turns]
  while (out.length > 0 && JSON.stringify(out).length > maxChars) out.shift()
  return out
}

export class AskStore {
  private readonly files = new Map<string, JsonFile<ChatsFile>>()

  constructor(
    private readonly dataDir: string,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  private root(): string {
    return join(this.dataDir, 'ask')
  }

  private file(projectId: string, pluginId: string): JsonFile<ChatsFile> | undefined {
    if (!PROJECT_SEGMENT.test(projectId) || typeof pluginId !== 'string' || pluginId === '') return undefined
    const path = join(this.root(), projectId, pluginFile(pluginId))
    let f = this.files.get(path)
    if (!f) {
      f = new JsonFile<ChatsFile>({ filePath: path, defaults: () => ({ schemaVersion: 1, chats: [] }), log: this.log })
      this.files.set(path, f)
    }
    return f
  }

  private chatsOf(f: JsonFile<ChatsFile>): StoredChat[] {
    const raw = f.data.chats
    return Array.isArray(raw) ? raw.map(cleanChat).filter((c): c is StoredChat => c !== undefined) : []
  }

  /** The stored chat of the key, or undefined. */
  get(projectId: string, pluginId: string, key: string): StoredChat | undefined {
    const f = this.file(projectId, pluginId)
    return f ? this.chatsOf(f).find((c) => c.key === key) : undefined
  }

  /** Store the key's chat (its turns capped; the least recently used key evicted past the cap). Written at once. */
  put(projectId: string, pluginId: string, chat: Omit<StoredChat, 'updatedAt'>): void {
    const f = this.file(projectId, pluginId)
    if (!f) return
    const entry = cleanChat({ ...chat, turns: capTurns(chat.turns), updatedAt: this.now() })
    if (!entry) return
    const others = this.chatsOf(f).filter((c) => c.key !== entry.key)
    others.sort((a, b) => b.updatedAt - a.updatedAt)
    const chats = [entry, ...others].slice(0, ASK_STORE_MAX_KEYS)
    f.update((data) => {
      data.chats = chats
    })
    f.flush()
  }

  /** Uninstall: the plugin's chats in every project. */
  removePlugin(pluginId: string): void {
    const name = pluginFile(pluginId)
    for (const [path, f] of [...this.files]) {
      if (basename(path) === name) {
        f.flush()
        this.files.delete(path)
      }
    }
    let projects: string[]
    try {
      projects = readdirSync(this.root())
    } catch {
      return
    }
    for (const project of projects) {
      if (!PROJECT_SEGMENT.test(project)) continue
      try {
        unlinkSync(join(this.root(), project, name))
      } catch {
        // none for this project
      }
    }
  }

  /** Project forget: the project's chats. */
  dropProject(projectId: string): void {
    if (!PROJECT_SEGMENT.test(projectId)) return
    const dir = join(this.root(), projectId)
    for (const [path, f] of [...this.files]) {
      if (dirname(path) === dir) {
        f.flush()
        this.files.delete(path)
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      this.log(`ask: dropping the chats of a project failed: ${String(err)}`)
    }
  }
}
