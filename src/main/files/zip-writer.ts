// The zip a folder downloads as (design-download.md §1.4 "Writer"): our own small writer on `node:zlib`,
// streamed from the folder walk to the response with nothing buffered but one entry's deflate window.
// Why our own: no zip library is in `dependencies`, the subset is small and fixed, and a runtime
// dependency is one more thing to vet; never `zip` or `tar` as a process (a server may lack them, and
// a process per download is one more thing to kill on a cancel).
//
// The subset, and why each choice:
// - A file entry has flag bit 3 (CRC and sizes in a data descriptor after the data: the deflated size
//   is unknown until the end, and buffering an entry to learn it would hold up to 2 GiB in main) and
//   bit 11 (the name is UTF-8). Always method 8 (deflate, `createDeflateRaw` level 6, run on the thread
//   pool), never method 0 with a data descriptor: Archive Utility and some unzippers cannot find the end
//   of a stored entry whose size is only after it.
// - A folder entry is method 0, size 0, CRC 0, no bit 3 (nothing follows it, so nothing to describe).
// - Version made by Unix, external attributes `0644`, or `0755` for a file with any exec bit and for
//   folders: never setuid, setgid or sticky (a zip extracted as root would keep them), and never the
//   group/other write bits of the server's file.
// - DOS time from the mtime in the server's local time (what unzippers show), plus the `0x5455`
//   extended timestamp (UTC seconds) for those that read it.
// - zip32 only: the caps (2 GiB of file bytes, 20,000 entries) keep every offset and count far inside
//   it; an offset past 4 GiB anyway (incompressible data plus headers cannot get there) throws rather
//   than wrap.
//
// Each file is opened through `openVerified` with the walk's lstat as `expect` (a file swapped for a link
// or another file since the walk is refused), and read through that one descriptor. A file that cannot
// be opened now is skipped before its local header goes out, so the zip stays valid; one that shrank
// while read is written with what it had (the descriptor carries the real CRC and sizes), one that grew
// is cut at its `fstat` size (what the caps were checked against). A read error after the header,
// a cap passed mid-stream (a file grown between the counting pass and the open) and an abort throw: the
// caller's `pipeline` then destroys the response before the end record, so the browser sees a failed
// download, never a truncated zip that looks whole.
//
// The writer is an async generator: the response pulls it through `pipeline(Readable.from(zip), res)`,
// so back-pressure reaches the deflate stream and the file reads, and a closed socket returns the
// generator, which closes the open descriptor and returns the walk (its own `signal` stops it too).
//
// Pure Node, no Electron (the plan's rule for `main/files/downloads.ts` and its helpers).
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { crc32, createDeflateRaw } from 'node:zlib'
import { DOWNLOAD_ZIP_MAX_BYTES, DOWNLOAD_ZIP_MAX_ENTRIES, type DownloadSkipped, type DownloadSkipReason } from '../../shared/downloads'
import { openVerified, type VerifiedOpen, type VerifiedProblem } from '../verified-read'
import type { WalkEntry } from './folder-walk'

/** Bytes read from a file per chunk (and the CRC's step); also the batch size of the central directory. */
export const ZIP_CHUNK_BYTES = 64 * 1024

const LOCAL_SIG = 0x04034b50
const DESCRIPTOR_SIG = 0x08074b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
/** 2.0: deflate and folders (APPNOTE 4.4.3.2). */
const VERSION_NEEDED = 20
/** Upper byte 3: Unix, so unzippers read the external attributes' upper half as a mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
/** Info-ZIP's extended timestamp: flags byte (bit 0: mtime present) and the mtime as Unix seconds. */
const EXTENDED_TIME_ID = 0x5455
const EXTRA_BYTES = 4 + 5
const MODE_FILE = 0o100644
const MODE_EXEC = 0o100755
const MODE_FOLDER = 0o040755
/** MS-DOS "directory" attribute in the external attributes' low byte. */
const DOS_DIRECTORY = 0x10
const U32 = 0xffffffff

/** The zip passed a cap while streaming (a file grew after the counting pass). */
export class ZipCapError extends Error {
  constructor(readonly cap: 'bytes' | 'entries') {
    super(cap === 'bytes' ? 'the folder grew past the size limit while it was zipped' : 'the folder grew past the file count limit while it was zipped')
    this.name = 'ZipCapError'
  }
}

export interface ZipOptions {
  /** The caller's abort (the socket closed, a revoke): checked per entry and per chunk; pass the same one to the walk. */
  signal?: AbortSignal
  /** Files that could not be opened now are added here, by reason, as the walk's skips are. */
  skipped?: DownloadSkipped
  /** Tests only: the caps instead of the shared ones. */
  maxBytes?: number
  maxEntries?: number
  /** Tests only: called after each chunk of a file is read, with the bytes read so far (a file changed mid-read). */
  onChunk?: (entry: WalkEntry, read: number) => void | Promise<void>
  /** Tests only: the open instead of `openVerified` (one that stalls, as on a dead network mount). */
  open?: typeof openVerified
}

interface Central {
  name: Buffer
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compressed: number
  size: number
  attrs: number
  mtime: number
  offset: number
}

/**
 * The zip of `entries` (the walk's, in its order), as chunks. Throws `ZipCapError` past a cap, the
 * signal's reason on abort, and a read or deflate error after an entry's header; each leaves the
 * archive without its end record, so the caller must destroy the response, never end it.
 */
export async function* zipEntries(entries: AsyncIterable<WalkEntry>, opts: ZipOptions = {}): AsyncGenerator<Buffer> {
  const maxBytes = opts.maxBytes ?? DOWNLOAD_ZIP_MAX_BYTES
  const maxEntries = opts.maxEntries ?? DOWNLOAD_ZIP_MAX_ENTRIES
  const signal = opts.signal
  const central: Central[] = []
  let offset = 0
  let fileBytes = 0
  const emit = (b: Buffer): Buffer => {
    offset += b.length
    if (offset > U32) throw new Error('the zip is past the zip32 limit')
    return b
  }

  for await (const entry of entries) {
    signal?.throwIfAborted()
    const name = Buffer.from(entry.name, 'utf8')
    // The walk's names are bounded by its depth; a field this short cannot hold more anyway.
    if (name.length > 0xffff) {
      bump(opts.skipped, 'name')
      continue
    }
    if (central.length + 1 > maxEntries) throw new ZipCapError('entries')

    if (entry.kind === 'folder') {
      const rec = record(name, FLAG_UTF8, METHOD_STORED, entry.stat, MODE_FOLDER, offset)
      rec.attrs = (rec.attrs | DOS_DIRECTORY) >>> 0
      yield emit(localHeader(rec))
      central.push(rec)
      continue
    }

    let opened: Awaited<ReturnType<typeof openVerified>>
    try {
      opened = await openRaced((opts.open ?? openVerified)(entry.path, entry.stat), signal)
    } catch {
      // EACCES, EIO at the open: nothing written for it yet, so the zip goes on without it.
      if (signal?.aborted) signal.throwIfAborted()
      bump(opts.skipped, 'unreadable')
      continue
    }
    if (!opened.ok) {
      bump(opts.skipped, openSkip(opened.problem))
      continue
    }
    const { handle, stat } = opened
    try {
      // Checked against the descriptor's size: what is read is cut there, so the sum never passes it.
      if (fileBytes + stat.size > maxBytes) throw new ZipCapError('bytes')
      const mode = (stat.mode & 0o111) !== 0 ? MODE_EXEC : MODE_FILE
      const rec = record(name, FLAG_UTF8 | FLAG_DESCRIPTOR, METHOD_DEFLATE, stat, mode, offset)
      yield emit(localHeader(rec))

      const read = { crc: 0, bytes: 0 }
      const deflate = createDeflateRaw({ level: 6, chunkSize: ZIP_CHUNK_BYTES })
      // Fed from the descriptor while this loop drains it: `pipeline` pauses the reads while the
      // deflate's output waits for the response (back-pressure). Its rejection is awaited below; the
      // catch here only keeps it from being unhandled when the loop throws first.
      const fed = pipeline(fileChunks(handle, stat.size, read, entry, opts), deflate, signal ? { signal } : {})
      fed.catch(() => undefined)
      let compressed = 0
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          compressed += chunk.length
          yield emit(chunk)
        }
      } finally {
        // On a return (the socket closed) the loop above destroyed the deflate, which ends `fed` too;
        // the descriptor is closed only after the last read on it settled.
        await fed.catch(() => undefined)
      }
      await fed
      rec.crc = read.crc
      rec.size = read.bytes
      rec.compressed = compressed
      fileBytes += read.bytes
      yield emit(descriptor(rec))
      central.push(rec)
    } catch (e) {
      // `pipeline` rejects an abort with an AbortError carrying the reason only as `cause`; the doc
      // promises the reason itself, as between entries.
      if (signal?.aborted && !(e instanceof ZipCapError)) signal.throwIfAborted()
      throw e
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  signal?.throwIfAborted()
  const cdOffset = offset
  let batch: Buffer[] = []
  let batchBytes = 0
  for (const rec of central) {
    const b = centralHeader(rec)
    batch.push(b)
    batchBytes += b.length
    if (batchBytes >= ZIP_CHUNK_BYTES) {
      yield emit(Buffer.concat(batch))
      batch = []
      batchBytes = 0
    }
  }
  const cdSize = offset + batchBytes - cdOffset
  batch.push(endRecord(central.length, cdSize, cdOffset))
  yield emit(Buffer.concat(batch))
}

/**
 * `opening` rejected with the signal's reason when it aborts first. An open stalled on a dead network
 * mount would otherwise hold the generator (and with it the response's `pipeline` and the download's
 * live slot) past a browser close or a revoke, since a generator's `return` waits for its pending
 * await. The open itself runs on; a descriptor it returns after the abort is closed then.
 */
function openRaced(opening: Promise<VerifiedOpen>, signal: AbortSignal | undefined): Promise<VerifiedOpen> {
  if (!signal) return opening
  return new Promise<VerifiedOpen>((resolve, reject) => {
    let late = false
    const onAbort = (): void => {
      late = true
      reject(signal.reason)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    opening.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        if (late && v.ok) void v.handle.close().catch(() => undefined)
        else resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * The bytes of one file, from its verified descriptor, in chunks of ZIP_CHUNK_BYTES, never past `size`
 * (its fstat size: a file that grew is cut there) and stopping early at its end (one that shrank). The
 * CRC is updated per chunk as it goes.
 */
async function* fileChunks(
  handle: FileHandle,
  size: number,
  read: { crc: number; bytes: number },
  entry: WalkEntry,
  opts: ZipOptions,
): AsyncGenerator<Buffer> {
  while (read.bytes < size) {
    opts.signal?.throwIfAborted()
    // A fresh buffer per chunk: the deflate stream keeps a reference until it has consumed it.
    const buf = Buffer.allocUnsafe(Math.min(ZIP_CHUNK_BYTES, size - read.bytes))
    const { bytesRead } = await handle.read(buf, 0, buf.length, read.bytes)
    if (bytesRead === 0) return
    const chunk = buf.subarray(0, bytesRead)
    read.crc = crc32(chunk, read.crc)
    read.bytes += bytesRead
    yield chunk
    await opts.onChunk?.(entry, read.bytes)
  }
}

function openSkip(problem: Exclude<VerifiedProblem, 'too-large'>): DownloadSkipReason {
  if (problem === 'symlink') return 'symlink'
  if (problem === 'not-file') return 'special'
  // Gone, or no longer the file the walk saw.
  return 'unreadable'
}

function bump(skipped: DownloadSkipped | undefined, reason: DownloadSkipReason): void {
  if (skipped) skipped[reason] = (skipped[reason] ?? 0) + 1
}

function record(name: Buffer, flags: number, method: number, stat: Stats, mode: number, offset: number): Central {
  const { time, date } = dosTime(stat.mtime)
  return {
    name,
    flags,
    method,
    time,
    date,
    crc: 0,
    compressed: 0,
    size: 0,
    attrs: (mode << 16) >>> 0,
    mtime: unixSeconds(stat.mtimeMs),
    offset,
  }
}

/**
 * MS-DOS date and time fields of `d` in the server's local time, at two-second resolution. DOS dates
 * run from 1980 to 2107: an mtime outside is clamped to the nearest end (a 1970 mtime from a tarball,
 * a far-future one from a bad clock), never wrapped into a different date.
 */
export function dosTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear()
  if (Number.isNaN(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 }
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** The `0x5455` mtime: signed 32-bit Unix seconds (Info-ZIP's reading), clamped rather than wrapped. */
function unixSeconds(ms: number): number {
  const s = Math.floor(ms / 1000)
  if (!Number.isFinite(s)) return 0
  return Math.max(-0x80000000, Math.min(0x7fffffff, s))
}

function extendedTime(rec: Central): Buffer {
  const b = Buffer.alloc(EXTRA_BYTES)
  b.writeUInt16LE(EXTENDED_TIME_ID, 0)
  b.writeUInt16LE(5, 2)
  b.writeUInt8(1, 4)
  b.writeInt32LE(rec.mtime, 5)
  return b
}

function localHeader(rec: Central): Buffer {
  const b = Buffer.alloc(30)
  b.writeUInt32LE(LOCAL_SIG, 0)
  b.writeUInt16LE(VERSION_NEEDED, 4)
  b.writeUInt16LE(rec.flags, 6)
  b.writeUInt16LE(rec.method, 8)
  b.writeUInt16LE(rec.time, 10)
  b.writeUInt16LE(rec.date, 12)
  // CRC and sizes: 0 here, in the data descriptor for a file, and truly 0 for a folder.
  b.writeUInt32LE(0, 14)
  b.writeUInt32LE(0, 18)
  b.writeUInt32LE(0, 22)
  b.writeUInt16LE(rec.name.length, 26)
  b.writeUInt16LE(EXTRA_BYTES, 28)
  return Buffer.concat([b, rec.name, extendedTime(rec)])
}

function descriptor(rec: Central): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(DESCRIPTOR_SIG, 0)
  b.writeUInt32LE(rec.crc >>> 0, 4)
  b.writeUInt32LE(rec.compressed, 8)
  b.writeUInt32LE(rec.size, 12)
  return b
}

function centralHeader(rec: Central): Buffer {
  const b = Buffer.alloc(46)
  b.writeUInt32LE(CENTRAL_SIG, 0)
  b.writeUInt16LE(VERSION_MADE_BY, 4)
  b.writeUInt16LE(VERSION_NEEDED, 6)
  b.writeUInt16LE(rec.flags, 8)
  b.writeUInt16LE(rec.method, 10)
  b.writeUInt16LE(rec.time, 12)
  b.writeUInt16LE(rec.date, 14)
  b.writeUInt32LE(rec.crc >>> 0, 16)
  b.writeUInt32LE(rec.compressed, 20)
  b.writeUInt32LE(rec.size, 24)
  b.writeUInt16LE(rec.name.length, 28)
  b.writeUInt16LE(EXTRA_BYTES, 30)
  b.writeUInt16LE(0, 32) // comment
  b.writeUInt16LE(0, 34) // disk
  b.writeUInt16LE(0, 36) // internal attributes
  b.writeUInt32LE(rec.attrs, 38)
  b.writeUInt32LE(rec.offset, 42)
  return Buffer.concat([b, rec.name, extendedTime(rec)])
}

function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const b = Buffer.alloc(22)
  b.writeUInt32LE(END_SIG, 0)
  b.writeUInt16LE(0, 4)
  b.writeUInt16LE(0, 6)
  b.writeUInt16LE(count, 8)
  b.writeUInt16LE(count, 10)
  b.writeUInt32LE(cdSize, 12)
  b.writeUInt32LE(cdOffset, 16)
  b.writeUInt16LE(0, 20)
  return b
}
