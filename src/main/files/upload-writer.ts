// The bytes of an upload on disk (design-upload.md §2.4, §3.2): a temp per file in its target folder,
// chunks written at their offsets, the commit to the final name, and the temps record a restart sweeps.
// `uploads.ts` decides what may be written (the folder, the names, the choice, the size) and binds it to
// a token; this takes the token's binding as the only truth and never reads a page's word for anything.
// The gateway's `/u/` route hands each PUT's body here (`writeChunk`) after its own checks (Origin,
// cookie and key, the token's device) and maps the answer's status to the response.
//
// The rules, each against a case:
//   - The temp is `.cc-upload-<16 hex>` in the target folder (a link or a rename cannot cross
//     filesystems, and a project may span mounts), created `O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY`,
//     `0644` under the umask, at the first chunk. Its path goes into `<data>/uploads/temps.json`, on
//     disk, before the temp exists: a crash between the two leaves an entry with no file, never a file
//     with no entry (a hidden partial of up to 2 GiB nobody would find). The folder is resolved again
//     first, and again after the create with the temp's `lstat` against the descriptor's `fstat`
//     (Node has no openat): a folder swapped for a link since begin, or in the window of the record's
//     fsync, gets at most an empty file, removed, never the bytes.
//   - Chunks of one file run one at a time (a chain per token): a client's retry can arrive while the
//     request it gave up on is still being cut (Chromium resends after the request bound's 408, plan
//     Task 1), and the offset check must see what the earlier one left. `offset` must be exactly what
//     is written (409 with `expected`), `offset + length` within the declared size (413). The body is
//     written as it arrives (`for await` reads the next piece only after the last one is on disk: the
//     request's back-pressure), at its position. A body that ends short, errors or runs past its length
//     is truncated back to `offset` and the token stays live for the retry; `written` moves only once
//     the whole chunk is on disk. Each piece read restarts the upload's idle clock (`touch`).
//   - Commit after the last byte (a declared-empty file on its one zero-length chunk): the folder must
//     still resolve to begin's real path, and the temp's `lstat` be the descriptor's file (dev, ino).
//     Every placement acts on the temp's path again, so each is checked after it too: the name placed
//     must `lstat` as that file (a temp swapped for a link meanwhile: macOS's `link` follows a link in
//     its source, Linux's links the link itself: the file fails and that name is left, since only the
//     written file's identity tells what is ours), and the copy opens the temp `O_NOFOLLOW` and checks
//     its `fstat` before reading. New and Keep both: an exclusive `link` (EEXIST on any entry, a link
//     included, never followed: the next number), or on a filesystem with no hard links an exclusive
//     copy (`copyExclusive`, which restarts the idle clock per chunk: a 2 GiB copy on a slow mount is not
//     idle). A cancel or a drop that lands while the link or copy ran removes what it placed (404), as
//     the copy does on its own. Replace: the target must still be a regular file; the temp takes its
//     permission bits minus setuid, setgid and sticky, then `rename` (atomic, and it replaces the entry,
//     never following a link): past it the file is placed, whatever an abort says.
//   - Abort (a cancel, the idle clock, a drop: `abortUpload`) destroys the body being read, waits for
//     the chunk to stop, then closes and deletes every temp of the upload. A failed file (ENOSPC, a
//     commit refused) deletes its temp at once and settles with its reason; a write failing mid-body
//     leaves the rest of the body unread, not destroyed, so the route can still deliver that reason.
//     A temp's record entry goes only once its name is gone (deleted, or not ours): a delete refused
//     (EACCES, EBUSY, EIO), at an abort or after a commit, keeps it for the next start's sweep.
// Reasons reach the view (a guest's too, D-33): fixed words and display-safe names, never an fs error's
// message (it names the absolute path). No Electron (the plan's rule).
import { randomBytes } from 'node:crypto'
import { constants as fsConstants, type Stats } from 'node:fs'
import { link as fsLink, lstat, open as fsOpen, realpath, rename as fsRename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { codeOf, errorText } from '../../shared/error-text'
import { numberedUploadName, UPLOAD_CHUNK_MAX_BYTES, UPLOAD_TEMP_PREFIX, type UploadChunkReply } from '../../shared/uploads'
import { displayText } from '../plugins/link-request'
import { within } from '../path-within'
import { JsonFile, type Versioned } from '../store/json-file'
import { sameFile } from '../verified-read'
import { copyExclusive, NO_HARD_LINKS, removeIfOwn, unlinkInDir, type CopyOptions } from './copy-exclusive'
import { resolveProjectEntry } from './system-files'
import { numberingRefusal, type UploadFileOutcome, type UploadGrant } from './uploads'

/** What the writer needs of `Uploads`: a token's binding, the idle clock's stamp and a file's end. */
export interface UploadGrantsPort {
  grant(token: string): UploadGrant | undefined
  touch(uploadId: string): void
  settle(token: string, outcome: UploadFileOutcome): void
}

/** The fs calls a test makes fail (ENOSPC on a write, EXDEV on a link); the rest is node:fs/promises. */
export interface UploadWriterFs {
  open(path: string, flags: number, mode: number): Promise<FileHandle>
  link(existing: string, newPath: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Every delete of a temp or a placed name (a refused one keeps the record entry); default `unlink`. */
  unlink(path: string): Promise<void>
  /** The no-hard-link fallback; default `copyExclusive`. */
  copy(temp: string, final: string, mode: number, opts: CopyOptions): Promise<Stats>
}

export interface UploadWriterDeps {
  /** `Uploads`, which takes this writer in its own deps: a getter, read on each call. */
  grants: () => UploadGrantsPort
  /** The window's project folder (the folder is resolved again before the temp and at commit). */
  projectRoot(windowId: number): string | undefined
  /** `<data>/uploads/temps.json` (`dataPaths().uploadTempsJson`). */
  tempsFile: string
  fs?: Partial<UploadWriterFs>
  /** Default crypto.randomBytes. */
  random?: (size: number) => Buffer
  log?: (line: string) => void
}

/**
 * A chunk's answer, by the HTTP status the route sends: 200 with the reply; 400 (the shape, or a body
 * that ended short or ran long: truncated back, `expected` is where to resume); 404 (no such token: never
 * minted, settled, or the upload ended); 409 with `expected` (the offset); 413 (past the declared size or
 * the chunk cap); 507 (the disk is full) and 500 (the temp, the record or the commit failed). `failed`:
 * the file is settled as failed and its temp deleted, so a retry finds 404.
 */
export type UploadChunkResult =
  | { status: 200; reply: UploadChunkReply }
  | { status: 400 | 404 | 409 | 413 | 500 | 507; error: string; expected?: number; failed?: true }

/** The words of a 404: the same for a token never minted, one settled and one whose upload ended. */
export const UPLOAD_TOKEN_UNKNOWN_TEXT = 'no such upload'
export const UPLOAD_DISK_FULL_TEXT = "the server's disk is full"

/** A temp's name as this writer makes it; the sweep deletes nothing else, whatever the record says. */
const TEMP_NAME = /^\.cc-upload-[0-9a-f]{16}$/

/** A temp on the record: its path, and the project folder it was made in (the sweep stays inside it). */
interface TempEntry {
  path: string
  root: string
}

interface TempsRecord extends Versioned {
  temps: TempEntry[]
}

/** An entry as this writer writes it: a hand-edited record may hold anything. */
function isTempEntry(entry: unknown): entry is TempEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const { path, root } = entry as Record<string, unknown>
  return typeof path === 'string' && typeof root === 'string' && isAbsolute(path) && isAbsolute(root) && TEMP_NAME.test(basename(path))
}

/** A file whose first chunk came: its temp, what is written, and the chain its chunks run on. */
interface LiveFile {
  token: string
  uploadId: string
  /** The temp's path in the target folder (begin's real path). */
  temp: string
  handle?: FileHandle
  /** The descriptor's `fstat`: the identity the commit and every delete check against. */
  st?: Stats
  /** Bytes on disk, from 0: moved only once a whole chunk is written. */
  written: number
  /** The previous chunk's end: the next one starts after it, so chunks of a file never overlap. */
  chain: Promise<unknown>
  /** The body being read now: an abort destroys it so the chunk stops. */
  body?: Readable
  aborted: boolean
  /** Fired by an abort: stops a commit's copy (up to 2 GiB on a filesystem with no hard links). */
  stop: AbortController
}

/** A write error, kept apart from the body's own errors (a client gone mid-chunk is a retry, ENOSPC is not). */
class WriteError extends Error {
  constructor(readonly original: unknown) {
    super(errorText(original))
  }
}

export class UploadWriter {
  private readonly files = new Map<string, LiveFile>()
  private readonly temps: JsonFile<TempsRecord>
  private readonly fs: UploadWriterFs
  private readonly random: (size: number) => Buffer
  private readonly log: (line: string) => void

  constructor(private readonly deps: UploadWriterDeps) {
    this.log = deps.log ?? ((line) => console.error(line))
    this.random = deps.random ?? randomBytes
    this.fs = {
      open: deps.fs?.open ?? ((path, flags, mode) => fsOpen(path, flags, mode)),
      link: deps.fs?.link ?? fsLink,
      rename: deps.fs?.rename ?? fsRename,
      unlink: deps.fs?.unlink ?? unlink,
      copy: deps.fs?.copy ?? copyExclusive,
    }
    this.temps = new JsonFile<TempsRecord>({ filePath: deps.tempsFile, defaults: () => ({ schemaVersion: 1, temps: [] }), log: this.log })
    // A record damaged by hand: nothing in it is trusted as a list.
    if (!Array.isArray(this.temps.data.temps)) this.temps.data.temps = []
  }

  /**
   * At start, before the gateway takes a PUT: every temp the record lists is deleted (none can be live
   * after a restart: tokens live in memory only). Only a regular file named as this writer names temps,
   * in a folder whose real path is inside the project folder recorded with it, is deleted, so a record
   * edited by hand cannot make main unlink anything else. An entry that could not be dealt with (its
   * project folder not there, a volume not mounted yet; an lstat or unlink refused) stays for the next
   * start: those are the hidden partials of up to 2 GiB the record exists for. Answers how many were
   * deleted. Never throws.
   */
  async sweepTemps(): Promise<number> {
    const live = (): Set<string> => new Set([...this.files.values()].map((f) => f.temp))
    // The entries listed now, as a copy: the start goes on past a stalled sweep (a network share), and a new
    // upload's temp pushed onto the record's own array meanwhile would be reached by the loop and unlinked
    // under its writer. Live temps are read again before each entry for the same reason.
    const listed = [...(this.temps.data.temps as unknown[])]
    const retry: TempEntry[] = []
    let removed = 0
    for (const entry of listed) {
      if (!isTempEntry(entry) || live().has(entry.path)) continue
      const outcome = await sweepOne(entry)
      if (outcome === 'removed') removed++
      else if (outcome === 'retry') retry.push(entry)
    }
    // What the sweep went through is replaced by what it kept; an entry recorded while it ran is kept as it
    // is (live, or kept by an abort whose delete was refused: that one is the next start's to sweep).
    const walked = new Set<unknown>(listed)
    this.temps.update((d) => {
      const still = live()
      d.temps = [...(d.temps as unknown[]).filter((e): e is TempEntry => isTempEntry(e) && (still.has(e.path) || !walked.has(e))), ...retry]
    })
    this.temps.flush()
    if (removed > 0) this.log(`uploads: deleted ${removed} temp file(s) a previous run left`)
    if (retry.length > 0) this.log(`uploads: ${retry.length} temp file(s) a previous run left could not be reached, kept for the next start`)
    return removed
  }

  /**
   * One PUT's body for `token` at `offset`, `length` bytes (the request's Content-Length). Refusals
   * before the body is read leave `body` untouched, and one partway through it (a failed write) leaves
   * the rest unread, never destroyed: the route reads off what is left so its answer arrives. Only an
   * abort destroys the body. Never rejects.
   */
  async writeChunk(token: string, offset: number, body: Readable, length: number): Promise<UploadChunkResult> {
    const grant = this.deps.grants().grant(token)
    if (!grant) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return { status: 400, error: 'the offset or the length is not valid' }
    }
    if (length > UPLOAD_CHUNK_MAX_BYTES) return { status: 413, error: `a chunk is at most ${UPLOAD_CHUNK_MAX_BYTES} bytes` }
    if (offset + length > grant.size) return { status: 413, error: 'the chunk goes past the size the file was declared with' }
    // Only an empty file takes an empty chunk (its one PUT, which commits it): elsewhere it is a no-op
    // that would still restart nothing and answer nothing new.
    if (length === 0 && grant.size !== 0) return { status: 400, error: 'an empty chunk is only for an empty file' }

    // Registered before any await: an abort that comes while the temp is being made finds it.
    let file = this.files.get(token)
    if (!file) {
      file = {
        token,
        uploadId: grant.uploadId,
        temp: join(grant.folderReal, `${UPLOAD_TEMP_PREFIX}${this.random(8).toString('hex')}`),
        written: 0,
        chain: Promise.resolve(),
        aborted: false,
        stop: new AbortController(),
      }
      this.files.set(token, file)
    }
    const live = file
    const run = live.chain.then(() => this.chunk(live, grant, offset, body, length))
    live.chain = run.catch(() => undefined)
    return run
  }

  /** `UploadWriterPort`: every temp of the upload closed and deleted, a chunk in flight stopped first. */
  async abortUpload(uploadId: string): Promise<void> {
    const files = [...this.files.values()].filter((f) => f.uploadId === uploadId)
    await Promise.all(
      files.map(async (file) => {
        file.aborted = true
        file.body?.destroy()
        file.stop.abort()
        // The chunk running now sees `aborted` after its next await and returns; a queued one returns at once.
        await file.chain
        if (this.files.get(file.token) === file) await this.discard(file)
      })
    )
  }

  // -------------------------------------------------------------------------------------------------

  /** A chunk on the file's chain. Catches its own failures: a throw here would be a bug, and fails the file. */
  private async chunk(file: LiveFile, grant: UploadGrant, offset: number, body: Readable, length: number): Promise<UploadChunkResult> {
    // From the chunk's turn on, an abort destroys its body (the live request, §3.4), whatever step it is at.
    file.body = body
    try {
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      if (offset !== file.written) return { status: 409, error: `the next byte expected is ${file.written}`, expected: file.written }
      if (!file.handle) {
        const problem = await this.openTemp(file, grant)
        if (problem) return problem
      }
      const received = await this.receive(file, offset, body, length)
      if (received !== 'ok') return received
      if (file.written < grant.size) return { status: 200, reply: { received: file.written } }
      return await this.commit(file, grant)
    } catch (err) {
      this.log(`upload ${grant.uploadId.slice(0, 8)}: file ${grant.index} failed: ${errorText(err)}`)
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      return this.fail(file, 500, 'the file could not be written')
    } finally {
      file.body = undefined
    }
  }

  /** Still the token's live file: not aborted, not settled (an end deletes the grant first). */
  private current(file: LiveFile): boolean {
    return !file.aborted && this.files.get(file.token) === file && this.deps.grants().grant(file.token) !== undefined
  }

  /** The temp made, recorded first; a refusal answer, or undefined when it is open. */
  private async openTemp(file: LiveFile, grant: UploadGrant): Promise<UploadChunkResult | undefined> {
    const root = await this.folderStill(grant)
    if (root === undefined) {
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      return this.fail(file, 500, 'the folder changed since the upload began')
    }
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    // On disk before the temp exists (a synchronous write: a debounced one could lose the entry to a
    // crash after the temp was made). Not saved (a full data disk, a record from a newer version left
    // read-only): no temp either, since a crash would leave it where no sweep looks.
    this.temps.update((d) => {
      d.temps.push({ path: file.temp, root })
    })
    this.temps.flush()
    if (this.temps.pending || this.temps.readOnly) return this.fail(file, 500, 'the upload could not be recorded on the server')
    let handle: FileHandle
    try {
      handle = await this.fs.open(file.temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY, 0o644)
    } catch (err) {
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      return codeOf(err) === 'ENOSPC' ? this.fail(file, 507, UPLOAD_DISK_FULL_TEXT) : this.fail(file, 500, 'the file could not be created on the server')
    }
    // Kept before any other await: an abort from here on closes and deletes it.
    file.handle = handle
    file.st = await handle.stat()
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    // Again after the create, before any byte: the folder swapped for a link to somewhere outside while
    // the record was fsynced or the open ran would otherwise take every chunk (up to 2 GiB) until the
    // commit's check. The temp's path must still lead to the file opened; the fail removes it (through
    // that path, so the empty file made outside goes too).
    const still = (await this.folderStill(grant)) !== undefined
    const at = await lstat(file.temp).catch(() => undefined)
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    if (!still || !at?.isFile() || !sameFile(at, file.st)) return this.fail(file, 500, 'the folder changed since the upload began')
    return undefined
  }

  /**
   * The body written at `offset`: 'ok' with `written` moved past it, or the answer. A short, broken or
   * long body is truncated back to `offset` (the token stays for a retry from there).
   */
  private async receive(file: LiveFile, offset: number, body: Readable, length: number): Promise<UploadChunkResult | 'ok'> {
    const handle = file.handle as FileHandle
    const end = offset + length
    let at = offset
    let over = false
    let broken = false
    try {
      // Never destroyed by leaving the loop: a write failing mid-body (ENOSPC) left a destroyed request,
      // Node then reset the socket, and the 507 was lost (the retry found 404, the reason gone). What is
      // left unread is the route's to read off before it answers; only an abort destroys the body.
      for await (const piece of body.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer | string>) {
        const buf = typeof piece === 'string' ? Buffer.from(piece) : piece
        this.touch(file)
        if (at + buf.length > end) {
          over = true
          break
        }
        await writeAt(handle, buf, at)
        at += buf.length
        if (file.aborted) break
      }
    } catch (err) {
      if (err instanceof WriteError) {
        if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
        this.log(`upload ${file.uploadId.slice(0, 8)}: a write failed: ${err.message}`)
        return codeOf(err.original) === 'ENOSPC' ? this.fail(file, 507, UPLOAD_DISK_FULL_TEXT) : this.fail(file, 500, 'the file could not be written')
      }
      // The body's own error: the client went, the request was cut (or an abort destroyed it).
      broken = true
    }
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    if (!over && !broken && at === end) {
      file.written = end
      return 'ok'
    }
    try {
      await handle.truncate(offset)
    } catch {
      // The file can no longer be put back where a retry would start: it fails rather than hold a gap.
      return this.fail(file, 500, 'the file could not be written')
    }
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    const error = over ? 'the body is longer than its length' : 'the body ended before its length'
    return { status: 400, error, expected: offset }
  }

  /** The last byte is on disk: the temp placed at its name (§2.4), the file settled. */
  private async commit(file: LiveFile, grant: UploadGrant): Promise<UploadChunkResult> {
    const handle = file.handle as FileHandle
    const st = file.st as Stats
    this.touch(file)
    if ((await this.folderStill(grant)) === undefined) {
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      return this.fail(file, 500, 'the folder changed since the upload began')
    }
    const now = await lstat(file.temp).catch(() => undefined)
    if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
    if (!now?.isFile() || !sameFile(now, st)) return this.fail(file, 500, 'the file changed on the server while it was written')

    let placed: string
    // The temp's name still there after a placement whose delete of it was refused (a hard link's
    // second name, or the copy fallback's whole source): its record entry stays for the next start's sweep.
    let tempLeft = false
    if (grant.choice === 'replace') {
      const target = join(grant.folderReal, grant.name)
      const old = await lstat(target).catch(() => undefined)
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      // A folder or a link that took the name since the answer (or the file gone): not what the person
      // chose to replace.
      if (!old?.isFile()) return this.fail(file, 500, `${displayText(grant.name)} changed meanwhile`)
      // The replaced file's permission bits (a script keeps its exec bit) minus setuid, setgid and
      // sticky: an upload never makes a set-id file. Through the descriptor, never a path.
      await handle.chmod(old.mode & 0o777)
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      // Past this the file is placed: an abort that comes now finds it settled.
      await this.fs.rename(file.temp, target)
      // The rename moved whatever was at the temp's path: it must have been the file written.
      const after = await lstat(target).catch(() => undefined)
      if (!after || !sameFile(after, st)) {
        this.log(`upload ${grant.uploadId.slice(0, 8)}: file ${grant.index}: what replaced the target is not the file written`)
        if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
        return this.fail(file, 500, 'the file changed on the server while it was written')
      }
      placed = grant.name
    } else {
      const done = await this.placeNew(file, grant, st, now.mode & 0o666)
      if ('status' in done) return done
      // A cancel or a drop that landed while the link or the copy ran: what was placed goes (it is this
      // call's, checked by identity), as a copy cancelled midway removes itself, and nothing reports a
      // file the person cancelled as written.
      if (!this.current(file)) {
        await removeIfOwn(done.final, done.st, this.fs.unlink)
        return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      }
      placed = done.name
      tempLeft = done.tempLeft
    }
    // Settled in the same step as the entry goes: a PUT for this token while the close below runs must
    // find no grant (404), never a fresh entry that would make a second temp nothing deletes.
    const path = grant.folderRel === '' ? placed : `${grant.folderRel}/${placed}`
    this.files.delete(file.token)
    this.deps.grants().settle(file.token, { ok: true, name: placed, path })
    await handle.close().catch(() => undefined)
    if (tempLeft) this.log(`upload ${grant.uploadId.slice(0, 8)}: file ${grant.index}: its temp could not be deleted, kept for the next start`)
    else this.dropRecord(file.temp)
    return { status: 200, reply: { done: true, name: placed, path } }
  }

  /**
   * A new name or Keep both: the planned name, else numbered from it (a name that appeared since begin is
   * numbered too, never overwritten), by exclusive link, or exclusive copy where hard links are refused.
   * Answers the name, its path, the placed entry's identity (from a descriptor: the temp's `fstat` for a
   * link, which shares its inode, the copy's own for a copy) and whether the temp's name could not be
   * deleted, or the answer that ends the chunk.
   */
  private async placeNew(
    file: LiveFile,
    grant: UploadGrant,
    st: Stats,
    mode: number
  ): Promise<{ name: string; final: string; st: Stats; tempLeft: boolean } | UploadChunkResult> {
    // `numberedUploadName` answers the name itself for 0 (checkUploadName passed it) and null past the
    // numbering's limit or the name limit.
    for (let n = 0; ; n++) {
      const name = numberedUploadName(grant.name, n)
      if (name === null) break
      if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
      const final = join(grant.folderReal, name)
      let placedSt: Stats
      try {
        await this.fs.link(file.temp, final)
      } catch (err) {
        const code = codeOf(err)
        if (code === 'EEXIST') continue
        if (!NO_HARD_LINKS.has(code ?? '')) throw err
        try {
          placedSt = await this.fs.copy(file.temp, final, mode, { signal: file.stop.signal, source: st, onChunk: () => this.touch(file) })
        } catch (copyErr) {
          // Aborted mid-copy: the copy removed its own file, the abort deletes the temp.
          if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
          if (codeOf(copyErr) === 'EEXIST') continue
          if (codeOf(copyErr) === 'ENOSPC') return this.fail(file, 507, UPLOAD_DISK_FULL_TEXT)
          throw copyErr
        }
        const tempLeft = (await removeIfOwn(file.temp, st, this.fs.unlink)) === 'failed'
        return { name, final, st: placedSt, tempLeft }
      }
      // The link acted on the temp's path: the name must hold the file written. A temp swapped for a
      // link meanwhile made it a hard link to that link's target (macOS) or the link itself (Linux), and
      // the file fails. The name is left as it is: the only identity this call can tell its own by is the
      // written file's (`st`, from the descriptor), and what the name holds is not it. An `lstat` taken
      // now names whatever is there now, so a delete checked against it could take a file another process
      // put at the name after the link (external review). Whoever swapped the temp could have made that
      // link themselves; the log says what happened.
      const linked = await lstat(final).catch(() => undefined)
      if (!linked || !sameFile(linked, st)) {
        this.log(`upload ${grant.uploadId.slice(0, 8)}: file ${grant.index}: what was linked is not the file written, left in place`)
        if (!this.current(file)) return { status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT }
        return this.fail(file, 500, 'the file changed on the server while it was written')
      }
      // Placed (the link shares the temp's inode): the temp's name goes.
      const tempLeft = (await removeIfOwn(file.temp, st, this.fs.unlink)) === 'failed'
      return { name, final, st, tempLeft }
    }
    return this.fail(file, 500, numberingRefusal(grant.name, 'in this folder'))
  }

  /** The upload's idle clock starts again (a body piece read, a commit's copy chunk written). */
  private touch(file: LiveFile): void {
    this.deps.grants().touch(file.uploadId)
  }

  /** The folder still resolves, inside the project, to the real path begin checked (§2.4): the project folder, or undefined. */
  private async folderStill(grant: UploadGrant): Promise<string | undefined> {
    const root = this.deps.projectRoot(grant.windowId)
    if (!root) return undefined
    try {
      const entry = await resolveProjectEntry(root, grant.folderRel, true)
      return entry.real === grant.folderReal && (await lstat(entry.real)).isDirectory() ? root : undefined
    } catch {
      return undefined
    }
  }

  /** The file fails: its token dies first (no chunk after this), then its temp goes. */
  private async fail(file: LiveFile, status: 500 | 507, reason: string): Promise<UploadChunkResult> {
    this.deps.grants().settle(file.token, { ok: false, reason })
    await this.discard(file)
    return { status, error: reason, failed: true }
  }

  /**
   * The temp closed and deleted, and its record entry dropped. Deleted only while it is still the file
   * written (a file someone put at the name is never ours); a temp moved away (its folder swapped), or
   * one whose delete was refused, at least gives its bytes back, truncated through the descriptor. A
   * refused delete (EACCES, EBUSY, an I/O error: anything but "not there") keeps the record entry, so the
   * next start's sweep deletes the temp: dropped, nothing would ever find it again. Never throws.
   */
  private async discard(file: LiveFile): Promise<void> {
    if (this.files.get(file.token) === file) this.files.delete(file.token)
    const handle = file.handle
    file.handle = undefined
    if (handle) {
      // No fstat to check against (it failed right after the O_EXCL create): the name is still ours, but
      // only in begin's real folder (the temp was named there, so its `dirname` is that real path), so a
      // folder swapped since is refused rather than followed (`unlinkInDir`).
      const outcome = file.st
        ? await removeIfOwn(file.temp, file.st, this.fs.unlink)
        : await unlinkInDir(file.temp, dirname(file.temp), this.fs.unlink)
      if (outcome !== 'removed') await handle.truncate(0).catch(() => undefined)
      await handle.close().catch(() => undefined)
      if (outcome === 'failed') {
        this.log(`upload ${file.uploadId.slice(0, 8)}: a temp could not be deleted, kept for the next start`)
        return
      }
    }
    this.dropRecord(file.temp)
  }

  /** The entry goes lazily (a debounced save): a stale one costs the next sweep a missing file, no more. */
  private dropRecord(temp: string): void {
    if (!this.temps.data.temps.some((e) => e.path === temp)) return
    this.temps.update((d) => {
      d.temps = d.temps.filter((e) => e.path !== temp)
    })
  }
}

/** Every byte of `buf` at `position` (a write may take fewer); its failure marked as the disk's, not the body's. */
async function writeAt(handle: FileHandle, buf: Buffer, position: number): Promise<void> {
  try {
    for (let done = 0; done < buf.length; ) {
      const { bytesWritten } = await handle.write(buf, done, buf.length - done, position + done)
      if (bytesWritten <= 0) throw new Error('a write made no progress')
      done += bytesWritten
    }
  } catch (err) {
    throw new WriteError(err)
  }
}

/**
 * One record entry at the sweep: 'removed', 'drop' (nothing of ours there: gone, not a regular file, or
 * a folder whose real path left the project), or 'retry' (could not be reached: kept for the next start).
 */
async function sweepOne(entry: TempEntry): Promise<'removed' | 'drop' | 'retry'> {
  // The project folder itself not there (a volume not mounted yet, a network share down): nothing can
  // be said about the temp, so it waits.
  const realRoot = await realpath(entry.root).catch(() => undefined)
  if (realRoot === undefined) return 'retry'
  let realDir: string
  try {
    realDir = await realpath(dirname(entry.path))
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? 'drop' : 'retry'
  }
  // Never outside the project it was made in, whatever the record says.
  if (!within(realRoot, realDir)) return 'drop'
  const path = join(realDir, basename(entry.path))
  let st: Stats
  try {
    st = await lstat(path)
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? 'drop' : 'retry'
  }
  if (!st.isFile()) return 'drop'
  // The folder re-checked just before the unlink: an ancestor swapped for a link after the `realpath`
  // above is refused (kept for the next start, whose `realpath` and `within` drop it if it now leads out).
  return (await unlinkInDir(path, realDir)) === 'failed' ? 'retry' : 'removed'
}
