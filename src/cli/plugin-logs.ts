// `ccc plugin logs <id> [--follow]` (plan B Task 6): print a plugin's log, `<data>/logs/<id>.log`.
//
// Read locally, not through the socket: a socket request has one reply, so it could not stream,
// and the file is the plugin's own log that main already wrote (plugin-log.ts). That is also why
// the id is checked against PLUGIN_ID_PATTERN here before it becomes part of a path: `ccc plugin
// logs ../../x` must not read outside the logs folder, whoever typed it (a Claude session passes
// ids it got from somewhere).
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { errorText } from '../shared/error-text'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../shared/manifest'

/** How many lines the plain form prints: a log may hold ~10 MiB, which nobody reads in a tab. */
export const LOG_TAIL_LINES = 200
/** The most of the file's end read to find those lines. */
const TAIL_READ_BYTES = 256 * 1024
/** How often `--follow` looks at the file. */
export const FOLLOW_POLL_MS = 250
/** How long the plain form waits for a log caught mid-rotation before it says there is none. */
const ROTATION_RETRY_MS = 50

export interface LogOutput {
  stdout(text: string): void
  stderr(text: string): void
}

/** The log file of a plugin, or undefined when `id` cannot be a plugin id. */
export function pluginLogFile(logsDir: string, id: string): string | undefined {
  if (id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) return undefined
  return join(logsDir, `${id}.log`)
}

/** Resolves after `ms`, or at once (false) when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A missing file: not logged yet, or caught in the instant between a rotation's rename and the next write. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** What one look at the log saw: its inode, where the read ended, and the bytes read. */
interface LogRead {
  ino: number
  end: number
  data: Buffer
}

/**
 * Open the log, take its size and inode from the open descriptor, and read `[startOf(size, ino),
 * size)` through that same descriptor; undefined when there is no file. One descriptor on purpose
 * (review finding): a `stat` by name and a later `open` by name can look at two different files
 * when plugin-log.ts rotates in between, and the old file's size was then used to read the new
 * one. Any other error (EACCES, EISDIR, EIO) propagates.
 */
async function readLog(file: string, startOf: (size: number, ino: number) => number): Promise<LogRead | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  }
  try {
    const st = await handle.stat()
    const start = Math.min(startOf(st.size, st.ino), st.size)
    const buf = Buffer.alloc(st.size - start)
    const { bytesRead } = buf.length === 0 ? { bytesRead: 0 } : await handle.read(buf, 0, buf.length, start)
    return { ino: st.ino, end: start + bytesRead, data: buf.subarray(0, bytesRead) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Print the last lines of the plugin's log; with `follow`, keep printing what is appended until
 * `signal` aborts (Ctrl+C kills the process before that in real use, the signal is for tests and
 * for a clean end). Exit code: 0, or 1 when there is no log yet (without `follow`: a plugin that
 * never logged has no file, and saying so beats printing nothing) or the log cannot be read
 * (EACCES and the like, with the reason; review finding: that used to escape as a silent 0).
 */
export async function runPluginLogs(
  logsDir: string,
  id: string,
  follow: boolean,
  out: LogOutput,
  signal?: AbortSignal,
  pollMs: number = FOLLOW_POLL_MS
): Promise<number> {
  const file = pluginLogFile(logsDir, id)
  if (file === undefined) {
    out.stderr(`ccc: not a plugin id: ${id}\n`)
    return 2
  }
  const cannotRead = (err: unknown): number => {
    out.stderr(`ccc: cannot read the log of ${id}: ${errorText(err)}\n`)
    return 1
  }

  // Where the first read began: a read that began mid-file starts mid-line.
  let firstStart = 0
  const tailStart = (size: number): number => (firstStart = Math.max(0, size - TAIL_READ_BYTES))
  let first: LogRead | undefined
  try {
    first = await readLog(file, tailStart)
    // Missing for an instant while plugin-log.ts rotates (rename, then the next write creates the
    // file): one more look before saying there is no log. --follow waits for the file anyway.
    if (first === undefined && !follow && (await sleep(ROTATION_RETRY_MS, signal))) first = await readLog(file, tailStart)
  } catch (err) {
    return cannotRead(err)
  }
  if (first === undefined && !follow) {
    out.stderr(`ccc: no log for ${id} yet (the plugin has not logged anything, or it is not installed)\n`)
    return 1
  }

  let offset = 0
  let ino: number | undefined
  if (first !== undefined) {
    const text = first.data.toString('utf8')
    // Drop the cut first line of a read that began mid-file.
    const lines = (firstStart > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n')
    if (lines.at(-1) === '') lines.pop()
    const tail = lines.slice(-LOG_TAIL_LINES)
    if (tail.length > 0) out.stdout(`${tail.join('\n')}\n`)
    offset = first.end
    ino = first.ino
  }
  if (!follow) return 0

  // Complete characters only: a read may end inside a multi-byte one.
  const decoder = new StringDecoder('utf8')
  while (await sleep(pollMs, signal)) {
    let read: LogRead | undefined
    try {
      read = await readLog(file, (size, now) => {
        // A new file (plugin-log.ts renames the log away and starts a new one) is read whole. The
        // inode tells even when the new one grew past the old offset within one poll; a file
        // smaller than the offset is a new one too.
        if ((ino !== undefined && now !== ino) || size < offset) {
          offset = 0
          decoder.end() // drop a split multi-byte character left from the old file
        }
        ino = now
        return offset
      })
    } catch (err) {
      // Not a rotation (a missing file is, below): the log cannot be read, and polling on would
      // print nothing forever.
      return cannotRead(err)
    }
    // Not there (yet, or mid-rotation): wait. The offset stays: a file that comes back as a new one
    // has another inode (read whole, above), and the same file seen again must not print twice.
    if (read === undefined) continue
    offset = read.end
    const chunk = decoder.write(read.data)
    if (chunk !== '') out.stdout(chunk)
  }
  return 0
}
