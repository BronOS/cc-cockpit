// `<data>/plugins.json`: which plugins are installed, at which version, from where (plan: Data dir
// layout; Task 24). One entry per plugin id. The installer is the only writer.
//
// What is deliberately NOT stored: the folder a git-installed plugin lives in. It is always derived
// from the validated id and version (`plugins/<id>@<version>/`), so a hand-edited or corrupted
// plugins.json can never point an uninstall's recursive remove at some other directory. A linked
// plugin stores its folder because that is its whole identity, and nothing ever deletes it.
//
// Pure Node over the shared atomic JsonFile store; every mutation is flushed at once (an install
// whose record sat in a debounce window when the app crashed would leave an unrecorded folder).
import { isAbsolute } from 'node:path'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, PLUGIN_VERSION_PATTERN } from '../../shared/manifest'
import { JsonFile, type FsOps, type Versioned } from '../store/json-file'

/**
 * Where a plugin came from: a git URL at a tag (cloned into the data dir), a dev folder, or the
 * app itself (`bundled`: a folder in the app resources, never copied; the installer re-derives its
 * folder from its own allowlist, so the stored path is informational and never trusted).
 */
export type PluginSource =
  | { kind: 'git'; url: string; tag: string }
  | { kind: 'linked'; path: string }
  | { kind: 'bundled'; path: string }

/** Result of the last manifest check; a failed one keeps the entry (the user sees why) but disables it. */
export type PluginState = { ok: true } | { ok: false; reason: string; revoked?: PluginRevocation }

/** A marketplace index with authority over this plugin revoked its commit: it must not run. */
export interface PluginRevocation {
  /** The index's text: untrusted, shown as plain text only. */
  reason: string
  /** The URL of the index that revoked it. */
  source: string
}

export interface PluginEntry {
  id: string
  version: string
  source: PluginSource
  state: PluginState
  /**
   * Bundled plugins only: on for every project that has not switched it off (the project record's
   * `disabledPlugins`). It lives here and not in the manifest so that a git or linked plugin cannot
   * claim it: parseEntry drops it for any other source and the installer never sets it for one.
   */
  enabledByDefault?: boolean
  /**
   * Git installs only: the commit that was cloned, which is what revocation matches. Absent on a
   * record written before commits were recorded; such a plugin stays valid and is simply never matched.
   */
  commit?: string
  /**
   * Git installs only: the URL of the marketplace index with say over this plugin's updates and
   * revocation (set by the first pinned install, never replaced by another index). It says nothing
   * about the current commit: an unpinned update keeps it on a commit that index never listed.
   */
  marketplace?: string
}

export interface PluginsFile extends Versioned {
  plugins: PluginEntry[]
}

export interface PluginIndexOptions {
  filePath: string
  fs?: FsOps
  log?: (message: string) => void
  now?: () => number
}

const MAX_REASON_LENGTH = 2000
/** parseEntry drops a longer one, so the installer refuses to record one (it would vanish on restart). */
export const MAX_MARKETPLACE_URL_LENGTH = 2048

/** A full git object id: sha-1, or sha-256 for a repo that uses it (a marketplace pin is always sha-1). */
export const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * The entry as stored, checked field by field; null when it is unusable. The id and version end up
 * in a path (`plugins/<id>@<version>`) that uninstall removes recursively, so they get the same
 * patterns the manifest validator applies. The git URL and tag are only checked for type here:
 * the installer re-validates both before any clone uses them.
 */
function parseEntry(raw: unknown): PluginEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(o.id)) return null
  if (typeof o.version !== 'string' || o.version.length > 64 || !PLUGIN_VERSION_PATTERN.test(o.version)) return null
  const s = o.source as Record<string, unknown> | null | undefined
  let source: PluginSource
  if (s && s.kind === 'git' && typeof s.url === 'string' && typeof s.tag === 'string') {
    source = { kind: 'git', url: s.url, tag: s.tag }
  } else if (s && s.kind === 'linked' && typeof s.path === 'string' && isAbsolute(s.path)) {
    source = { kind: 'linked', path: s.path }
  } else if (s && s.kind === 'bundled' && typeof s.path === 'string' && isAbsolute(s.path)) {
    source = { kind: 'bundled', path: s.path }
  } else {
    return null
  }
  const st = o.state as Record<string, unknown> | null | undefined
  const state: PluginState =
    st && st.ok === false && typeof st.reason === 'string' ? notOkState(st.reason, st.revoked) : { ok: true }
  // A hand-edited plugins.json must not make a git plugin default-on in every project.
  if (source.kind === 'bundled' && o.enabledByDefault === true) return { id: o.id, version: o.version, source, state, enabledByDefault: true }
  const entry: PluginEntry = { id: o.id, version: o.version, source, state }
  // A malformed value is dropped, not fatal: the plugin stays, as a record from before these fields.
  // A linked or bundled plugin has neither, so revocation can never match one by a hand-added commit.
  if (source.kind === 'git') {
    if (typeof o.commit === 'string' && GIT_COMMIT_PATTERN.test(o.commit)) entry.commit = o.commit
    if (typeof o.marketplace === 'string' && o.marketplace.length <= MAX_MARKETPLACE_URL_LENGTH) entry.marketplace = o.marketplace
  }
  return entry
}

/** A failed state as stored, capped, with `revoked` kept only when well-formed (load recomputes it anyway). */
function notOkState(reason: string, revoked: unknown): PluginState {
  const r = revoked as Record<string, unknown> | null | undefined
  return {
    ok: false,
    reason: reason.slice(0, MAX_REASON_LENGTH),
    ...(r && typeof r.reason === 'string' && typeof r.source === 'string'
      ? { revoked: { reason: r.reason.slice(0, MAX_REASON_LENGTH), source: r.source.slice(0, MAX_MARKETPLACE_URL_LENGTH) } }
      : {})
  }
}

export class PluginIndex {
  private readonly file: JsonFile<PluginsFile>
  private readonly entries = new Map<string, PluginEntry>()
  private readonly log: (message: string) => void

  constructor(options: PluginIndexOptions) {
    this.log = options.log ?? ((m) => console.error(m))
    this.file = new JsonFile<PluginsFile>({
      filePath: options.filePath,
      defaults: () => ({ schemaVersion: 1, plugins: [] }),
      fs: options.fs,
      log: options.log,
      now: options.now
    })
    const stored = Array.isArray(this.file.data.plugins) ? (this.file.data.plugins as unknown[]) : []
    for (const raw of stored) {
      const entry = parseEntry(raw)
      if (entry === null) {
        this.log(`plugins.json: ignoring a malformed entry: ${JSON.stringify(raw)?.slice(0, 200)}`)
      } else if (this.entries.has(entry.id)) {
        this.log(`plugins.json: ignoring a second entry for ${entry.id}`)
      } else {
        this.entries.set(entry.id, entry)
      }
    }
  }

  /**
   * True when plugins.json must not be written (newer schemaVersion, unreadable). The installer
   * refuses every change then: a plugin folder whose record cannot be saved would be orphaned.
   */
  get readOnly(): boolean {
    return this.file.readOnly
  }

  list(): PluginEntry[] {
    return [...this.entries.values()].map((e) => structuredClone(e))
  }

  get(id: string): PluginEntry | undefined {
    const e = this.entries.get(id)
    return e ? structuredClone(e) : undefined
  }

  /** Add or replace the entry for `entry.id`, and write the file now. */
  put(entry: PluginEntry): void {
    const prev = this.entries.get(entry.id)
    this.entries.set(entry.id, structuredClone(entry))
    this.commitWrite(() => (prev ? this.entries.set(entry.id, prev) : this.entries.delete(entry.id)))
  }

  remove(id: string): void {
    const prev = this.entries.get(id)
    if (prev && this.entries.delete(id)) this.commitWrite(() => this.entries.set(id, prev))
  }

  setState(id: string, state: PluginState): void {
    const e = this.entries.get(id)
    if (!e) return
    const next: PluginState = state.ok ? { ok: true } : notOkState(state.reason, state.revoked)
    // Checked at every launch: an unchanged result is not worth a write.
    if (JSON.stringify(next) === JSON.stringify(e.state)) return
    e.state = next
    this.write()
  }

  /** Write anything pending (call on quit; every mutation already flushes). */
  flush(): void {
    this.file.flush()
  }

  /**
   * Write now; when the write fails (JsonFile logs and swallows ENOSPC/EACCES) undo the in-memory
   * change and throw, so the installer can roll back instead of reporting an install that a restart
   * would forget.
   */
  private commitWrite(undo: () => void): void {
    this.write()
    if (!this.file.pending) return
    undo()
    this.write()
    throw new Error('could not write plugins.json')
  }

  private write(): void {
    this.file.update((d) => {
      d.plugins = [...this.entries.values()]
    })
    this.file.flush()
  }
}
