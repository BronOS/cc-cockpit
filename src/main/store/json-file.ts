// Atomic, debounced JSON file store (plan: Technical Details > Data dir layout).
//
// Every state file (app.json, projects/<id>.json, plugins.json, ...) goes through this. The goals:
//  - a crash or power loss mid-write never leaves a half-written file (tmp + fsync + rename);
//  - a corrupt file never blocks startup and never silently destroys the evidence (a
//    `.corrupt-<ts>` copy is kept, defaults are used);
//  - a file written by a NEWER app version is never overwritten by this older one (it would drop
//    fields the newer version relies on), so it is loaded as defaults and made read-only.
// Pure Node (`node:fs` behind an `FsOps` interface so tests can inject write failures).
// The plugin host imports it too (host/ctx/storage.ts), like kill-child.ts: Node-only code shared
// by main, host and cli lives under src/main (cli imports paths.ts and socket/transport.ts),
// because src/shared is type-checked for the renderer without Node types. No electron import here.
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'

export interface Versioned {
  schemaVersion: number
}

/** The slice of `node:fs` this module uses; tests wrap it to make individual calls throw. */
export interface FsOps {
  readFileSync(path: string, encoding: 'utf8'): string
  mkdirSync(path: string, options: { recursive: true }): unknown
  openSync(path: string, flags: string, mode?: number): number
  /** Bytes actually written: may be fewer than `length` (a short write); see writeAll. */
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  copyFileSync(from: string, to: string): void
  unlinkSync(path: string): void
}

export interface JsonFileOptions<T extends Versioned> {
  filePath: string
  /** Fresh defaults on every call (a shared object would leak mutations between loads). */
  defaults: () => T
  /** The version this build reads and writes. Default 1. */
  schemaVersion?: number
  /** Save window in ms. Default 300. */
  debounceMs?: number
  fs?: FsOps
  log?: (message: string) => void
  now?: () => number
}

export const DEFAULT_DEBOUNCE_MS = 300
const MAX_RETRIES = 3

export class JsonFile<T extends Versioned> {
  /** True when the file on disk must not be overwritten (newer schemaVersion, or unreadable). */
  readOnly = false

  private current: T
  private dirty = false
  private retries = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly filePath: string
  private readonly version: number
  private readonly debounceMs: number
  private readonly fs: FsOps
  private readonly log: (message: string) => void
  private readonly now: () => number
  private readonly defaults: () => T

  constructor(options: JsonFileOptions<T>) {
    this.filePath = options.filePath
    this.defaults = options.defaults
    this.version = options.schemaVersion ?? 1
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.fs = options.fs ?? nodeFs
    this.log = options.log ?? ((m) => console.error(m))
    this.now = options.now ?? Date.now
    this.current = this.load()
  }

  /** The live object. Mutate it, then call `save()`; or use `update()`. */
  get data(): T {
    return this.current
  }

  /** True while a change is not on disk (a failed write leaves it set). */
  get pending(): boolean {
    return this.dirty
  }

  update(mutate: (data: T) => void): void {
    mutate(this.current)
    this.save()
  }

  /**
   * Schedule a write. Calls inside the window coalesce into one write. The timer is deliberately
   * NOT reset by later calls (not a trailing debounce): a steady stream of changes, such as window
   * bounds while the user drags, would otherwise postpone the write forever and a crash would lose
   * all of it. A change is on disk at most `debounceMs` after the first unsaved one.
   */
  save(): void {
    if (this.readOnly) {
      this.log(`not saving ${this.filePath}: the file on disk must not be overwritten`)
      return
    }
    this.dirty = true
    if (this.timer !== undefined) return
    this.arm()
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.writeNow()
      // A transient failure (ENOSPC) with no further save() would otherwise leave the change
      // unwritten until quit. Retry a bounded number of times, then wait for save()/flush().
      if (this.dirty && !this.readOnly && this.retries < MAX_RETRIES) {
        this.retries++
        this.arm()
      }
    }, this.debounceMs)
  }

  /** Write any pending change now, synchronously (call on quit). No-op when nothing is pending. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.writeNow()
  }

  private load(): T {
    let text: string
    try {
      text = this.fs.readFileSync(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Present but unreadable (EACCES, EISDIR): do not overwrite it with defaults on a later save.
        this.readOnly = true
        this.log(`cannot read ${this.filePath}, using defaults and not saving: ${String(err)}`)
      }
      return this.defaults()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      return this.quarantine(`invalid JSON (${String(err)})`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return this.quarantine('not a JSON object')
    }
    const version = (parsed as { schemaVersion?: unknown }).schemaVersion
    if (typeof version === 'number' && Number.isInteger(version) && version > this.version) {
      this.readOnly = true
      this.log(
        `${this.filePath} has schemaVersion ${version}, this app reads ${this.version}: ` +
          'using defaults and leaving the file untouched'
      )
      return this.defaults()
    }
    if (version !== this.version) {
      // Missing, non-integer or older. There is only version 1 so far, hence no migration step;
      // when a bump happens, add migrations here BEFORE this branch or old files get quarantined.
      return this.quarantine(`unsupported schemaVersion ${String(version)}`)
    }
    // Shallow merge so a key added in a later app version still gets its default.
    return { ...this.defaults(), ...(parsed as T) }
  }

  /** Keep the unusable file as `.corrupt-<ts>` so the user can recover it, and start from defaults. */
  private quarantine(reason: string): T {
    const copy = `${this.filePath}.corrupt-${this.now()}`
    try {
      this.fs.copyFileSync(this.filePath, copy)
      this.log(`${this.filePath} is unusable (${reason}); kept a copy at ${copy}, using defaults`)
    } catch (err) {
      // Without the copy, the next save would destroy the only trace of the file: stay read-only.
      this.readOnly = true
      this.log(`${this.filePath} is unusable (${reason}) and could not be copied, not saving: ${String(err)}`)
    }
    return this.defaults()
  }

  private writeNow(): void {
    if (!this.dirty || this.readOnly) return
    const tmp = `${this.filePath}.tmp`
    let fd: number | undefined
    try {
      this.fs.mkdirSync(dirname(this.filePath), { recursive: true })
      // Stamp the version here, not from the caller's object, so a caller cannot write a file the
      // next load would quarantine.
      const text = JSON.stringify({ ...this.current, schemaVersion: this.version }, null, 2) + '\n'
      fd = this.fs.openSync(tmp, 'w', 0o600)
      this.writeAll(fd, Buffer.from(text, 'utf8'))
      this.fs.fsyncSync(fd)
      this.fs.closeSync(fd)
      fd = undefined
      // rename is atomic on one filesystem: readers see the old or the new file, never a mix.
      this.fs.renameSync(tmp, this.filePath)
      this.dirty = false
      this.retries = 0
    } catch (err) {
      // Stay dirty so the next save()/flush() retries; the old file is untouched because the
      // rename never ran. Cannot throw from a timer callback anyway.
      this.log(`failed to save ${this.filePath}: ${String(err)}`)
      if (fd !== undefined) {
        try {
          this.fs.closeSync(fd)
        } catch {
          /* already failing */
        }
      }
      try {
        this.fs.unlinkSync(tmp)
      } catch {
        /* no tmp to clean */
      }
    }
  }

  /**
   * Write every byte of `bytes`, or throw. write(2) may write fewer bytes than asked (a short
   * write: the disk filling up mid-write, a signal) and says so only in its return value; the
   * one writeSync call this used to be ignored it, so the rename put a truncated JSON file over
   * the good one and cleared the dirty flag: the saved state was gone and nothing retried. A write
   * that makes no progress at all throws instead of spinning.
   */
  private writeAll(fd: number, bytes: Buffer): void {
    let offset = 0
    while (offset < bytes.length) {
      const written = this.fs.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw new Error(`short write: ${offset} of ${bytes.length} bytes written`)
      }
      offset += written
    }
  }
}
