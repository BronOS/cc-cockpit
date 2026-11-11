// `ctx.log` on disk: one file per plugin, `<data>/logs/<pluginId>.log`, rotated at 5 MiB
// (`<pluginId>.log.1` keeps the previous file; the one before is dropped, so a plugin that logs
// without end holds at most ~10 MiB).
//
// Main writes it, not the host: main already rate-caps a host's lines and escapes their line
// breaks (host-manager.ts onEvent), and the file name then comes from a plugin id main knows, never
// from the host. One file serves every project the plugin runs in (the lines carry the project id).
// Writes are synchronous appends: at most 100 short lines per host per 10 s, and no log line may
// be lost to a crash or the quit that follows it.
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../shared/manifest'
import { warnLog } from '../warn-log'

export const MAX_PLUGIN_LOG_BYTES = 5 * 1024 * 1024

/** The slice of `node:fs` used here; tests wrap it to count calls. */
export interface LogFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown
  statSync(path: string): { size: number }
  appendFileSync(path: string, data: string, options: { mode: number }): void
  renameSync(from: string, to: string): void
}

export interface PluginLogWriterOptions {
  /** `<data>/logs`. */
  dir: string
  maxBytes?: number
  fs?: LogFs
  now?: () => number
  log?: (message: string) => void
}

export class PluginLogWriter {
  private readonly dir: string
  private readonly maxBytes: number
  private readonly fs: LogFs
  private readonly now: () => number
  private readonly log: (message: string) => void
  /** Known size of each open log file, so the hot path does no stat. */
  private readonly sizes = new Map<string, number>()
  private dirReady = false

  constructor(options: PluginLogWriterOptions) {
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? MAX_PLUGIN_LOG_BYTES
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? Date.now
    this.log = options.log ?? warnLog
  }

  /** Append one line (`text` is already a single line). Never throws; a failure is logged. */
  write(entry: { pluginId: string; projectId: string; level: string; text: string }): void {
    // The id came from main's plugin index and is path-safe already; this is the last line of
    // defence for a file name, since a bad one would write outside the logs dir.
    if (entry.pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(entry.pluginId)) {
      this.log(`plugin log: refusing the file name for "${entry.pluginId}"`)
      return
    }
    const line = `${new Date(this.now()).toISOString()} ${entry.level} [${entry.projectId}] ${entry.text}\n`
    const file = join(this.dir, `${entry.pluginId}.log`)
    try {
      if (!this.dirReady) {
        this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        this.dirReady = true
      }
      let size = this.sizes.get(file)
      if (size === undefined) {
        try {
          size = this.fs.statSync(file).size
        } catch {
          size = 0
        }
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        // rename replaces an older `.1` atomically on one filesystem.
        this.fs.renameSync(file, `${file}.1`)
        size = 0
      }
      this.fs.appendFileSync(file, line, { mode: 0o600 })
      this.sizes.set(file, size + Buffer.byteLength(line))
    } catch (err) {
      // Forget the size: the next write re-reads what is really on disk.
      this.sizes.delete(file)
      this.log(`plugin log: cannot write ${file}: ${String(err)}`)
    }
  }
}
