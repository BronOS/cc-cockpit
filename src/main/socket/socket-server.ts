// The CLI socket server (plan: Technical Details > Socket). `ccc` (Task 13) and Claude's hooks
// talk to main here.
//
// Authority (CLAUDE.md: main is the only authority): a request never names its tab or project
// in a way main trusts. The server builds the caller's identity itself, before any handler runs:
//   - with a token: whatever main's own tables say it is (TabManager and OverlayManager compare
//     with timingSafeEqual). A Claude tab's token is a SESSION token: that tab and its project,
//     for every command. A shell tab's, a command tab's or a terminal overlay's is a WINDOW token:
//     that window's project, like `--project` names it, and only for the WINDOW_TOKEN_COMMANDS
//     (never `hook` or `session.*`). The kind comes from the lookup, never from the request. A
//     token that matches nothing is refused outright, even for a command a tokenless caller could
//     use: a stale or forged token is a broken caller, not an anonymous one.
//   - without a token: only the TOKENLESS_COMMANDS, and only with `project` (`--project <path>`),
//     which main resolves against its own project registry. The PROJECTLESS_COMMANDS (notify,
//     sessions) may leave `project` out; they act on no single project.
// Handlers get that identity as `caller`; anything in `args` that looks like a tab or project id
// is just data to be looked up inside the caller's scope.
//
// No Electron import: unit tests run this over real sockets in a temp dir.
import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs'
import type { Server, Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { errorText } from '../../shared/error-text'
import {
  encodeReply,
  LineFramer,
  parseRequest,
  PROJECTLESS_COMMANDS,
  ProtocolError,
  TOKENLESS_COMMANDS,
  WINDOW_TOKEN_COMMANDS,
  type Reply,
  type Request
} from '../../shared/protocol'
import { connect, listen } from './transport'

/**
 * What a token belongs to, as main's tables say (SocketServerOptions.resolveToken). `session`: a
 * Claude tab, the only owner that is a Claude session. `window`: a shell or command tab, or a
 * terminal overlay; it carries no tab id, so nothing downstream can mistake it for a session.
 */
export type TokenOwner = { kind: 'session'; tabId: string; projectId: string } | { kind: 'window'; projectId: string }

/**
 * Who is asking, as main resolved it. Kept a union of distinct kinds (not a flag on one tab kind)
 * so every handler must say which it takes: the session-only ones test `kind === 'session'` and
 * so refuse a window token, a `--project` and an anonymous caller alike.
 */
export type Caller =
  /** A Claude tab, by its session token: `tabId` is the session the request is about. */
  | { kind: 'session'; tabId: string; projectId: string }
  /** A window token (a shell or command tab, a terminal overlay): its window's project, nothing more. */
  | { kind: 'window'; projectId: string }
  /**
   * A tokenless caller naming a project folder. `path` is the canonical (real) path; `projectId`
   * is undefined when no project record exists for it yet: `ccc open <new folder>` (Task 21) must
   * reach its handler, and each handler decides whether it needs a known (or open) project.
   */
  | { kind: 'project'; path: string; projectId: string | undefined }
  /** A tokenless caller of a PROJECTLESS_COMMANDS command that named no project (`ccc sessions`). */
  | { kind: 'anonymous' }

/**
 * A command handler. `args` is the caller's raw parsed JSON: untrusted, any shape below the top
 * level (parseRequest only refuses top-level `__proto__`/`constructor`/`prototype` keys). Read the
 * fields you need and check their types; never merge args (or a nested object from it) into a live
 * object with Object.assign or for...in. Spread and destructuring are safe. `peerGone` aborts when
 * the peer closes or half-closes (a killed process looks like a half-close here: its FIN arrives
 * as 'end' and the socket does not fully close while a request is in flight), so a long wait
 * (`ccc overlay`) can end when its caller is killed. The CLI never half-closes; a client that does
 * (`nc -U`) should not use the commands that watch the signal.
 */
export type Handler = (args: Record<string, unknown>, caller: Caller, peerGone?: AbortSignal) => unknown

export interface SocketServerOptions {
  /** The effective socket path (paths.ts `socketPath()`): the same string main exports to tabs. */
  path: string
  /**
   * The per-uid fallback directory (paths.ts `fallbackSocketDir()`). When `path` lives directly
   * in it, the directory is created 0700 and checked before use: `os.tmpdir()` is shared on Linux,
   * and a directory pre-created by another user would let them swap the socket under us.
   */
  fallbackDir?: string
  /** A token -> its owner and that owner's project; undefined when nothing has that token. */
  resolveToken(token: string): TokenOwner | undefined
  /** An absolute folder path -> its canonical path and project id (if a record exists). */
  resolveProject(path: string): { path: string; projectId: string | undefined }
  log?: (message: string) => void
  /** How long the stale-socket probe waits for an answer. */
  probeTimeoutMs?: number
  /** The uid the fallback dir must belong to; defaults to this process's (undefined off POSIX). */
  uid?: number
  /** Close a connection after this long with no traffic and no request in progress. */
  idleTimeoutMs?: number
  /** Connections held at once; one more is closed on arrival. */
  maxConnections?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 500
/**
 * `ccc` connects, sends and goes within a second; anything quiet for this long with nothing in
 * progress is a stuck or hostile peer holding a file descriptor main needs for PTYs.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
/** Hooks from every tab can overlap, but each `ccc` call is short; far above real use. */
const DEFAULT_MAX_CONNECTIONS = 128
/**
 * Requests one connection may have in progress before main stops reading from it. The CLI sends
 * one request per connection; pipelining is allowed but must not fan out without bound.
 */
const MAX_IN_FLIGHT = 16

/** Socket errors a client causes just by going away: `ccc hook` closes without reading the reply. */
const PEER_GONE = new Set(['EPIPE', 'ECONNRESET'])

export class SocketServer {
  private readonly handlers = new Map<string, Handler>()
  private readonly sockets = new Set<Socket>()
  private readonly log: (message: string) => void
  private server: Server | undefined
  /** Inode of the socket file we bound, so stop() never unlinks a file someone else put there. */
  private boundIno: number | undefined

  constructor(private readonly options: SocketServerOptions) {
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /** Register the handler for `cmd`. One per command; a second registration is a bug. */
  handle(cmd: string, handler: Handler): void {
    if (this.handlers.has(cmd)) throw new Error(`socket command ${cmd} is already registered`)
    this.handlers.set(cmd, handler)
  }

  get listening(): boolean {
    return this.server !== undefined
  }

  /**
   * Bind the socket. Resolves false (after logging why) when the server must not run: an unsafe
   * fallback dir, a live owner of the path, a non-socket file in the way, or a bind error. The app
   * keeps working without a socket; Claude tabs just lose their status (the CLI exits 0 silently).
   */
  async start(): Promise<boolean> {
    if (this.server) return true
    const { path } = this.options
    if (this.options.fallbackDir !== undefined && dirname(path) === this.options.fallbackDir) {
      if (!this.ensurePrivateDir(this.options.fallbackDir)) return false
    }
    if (!(await this.clearStale(path))) return false
    let server: Server
    try {
      server = await listen(path, (socket) => this.onConnection(socket))
    } catch (err) {
      this.log(`socket: cannot listen on ${path}: ${errorText(err)}`)
      return false
    }
    // transport.listen() already binds under umask 0177 (the file is born 0600, with no window
    // for a queued connect). The chmod is belt and braces for a platform where that did not take.
    try {
      chmodSync(path, 0o600)
      this.boundIno = lstatSync(path).ino
    } catch (err) {
      this.log(`socket: cannot restrict ${path} to 0600: ${errorText(err)}`)
      await closeServer(server)
      return false
    }
    server.on('error', (err) => this.log(`socket: server error: ${errorText(err)}`))
    this.server = server
    return true
  }

  /**
   * Stop accepting, drop every connection and unlink the socket file. The unlink is synchronous so
   * a caller on its way out (app `will-quit`) can ignore the promise and still leave no file.
   */
  stop(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const closed = closeServer(server)
    this.unlinkOwn()
    return closed
  }

  /**
   * One connection. Only same-uid processes get here (0600), but a buggy or stuck one must not be
   * able to take main down, so every resource a connection holds is bounded:
   *   - descriptors: at most `maxConnections`, and an idle one (no traffic, nothing in progress)
   *     is closed after `idleTimeoutMs`. A request in progress keeps it open: `overlay` waits for
   *     the user.
   *   - work: at most MAX_IN_FLIGHT requests run at once; further lines wait in `queue`, and while
   *     anything waits main stops reading, so the queue holds at most one chunk's lines.
   *   - replies: when the peer does not read them (write() reports a full buffer), main stops
   *     reading and starting requests until the buffer drains.
   *   - the line buffer: LineFramer caps it at MAX_LINE_BYTES.
   * A peer that half-closes (allowHalfOpen, transport.ts) still gets every reply; main ends the
   * connection after the last one.
   */
  private onConnection(socket: Socket): void {
    const max = this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    // Also refuse while stopping: stop() has already destroyed the tracked set.
    if (!this.server || this.sockets.size >= max) {
      if (this.server) this.log(`socket: refusing a connection: ${max} already open`)
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    const gone = new AbortController()
    socket.on('close', () => {
      this.sockets.delete(socket)
      gone.abort()
    })
    // Without a listener an 'error' event would throw and take main down with it.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!PEER_GONE.has(err.code ?? '')) this.log(`socket: connection error: ${errorText(err)}`)
    })
    const framer = new LineFramer()
    const queue: string[] = []
    let inFlight = 0
    let peerEnded = false

    const pump = (): void => {
      while (inFlight < MAX_IN_FLIGHT && queue.length > 0 && !socket.writableNeedDrain) {
        const line = queue.shift() as string
        inFlight++
        void this.serve(socket, line, gone.signal).finally(() => {
          inFlight--
          pump()
        })
      }
      if (socket.destroyed) return
      if (queue.length > 0 || socket.writableNeedDrain) socket.pause()
      else if (peerEnded) {
        if (inFlight === 0 && !socket.writableEnded) socket.end()
      } else socket.resume()
    }

    socket.setTimeout(this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
    socket.on('timeout', () => {
      // Every write and read re-arms the timer, so this fires only after a quiet stretch. Lines
      // queued behind an undrained reply do not count: that peer is not reading.
      if (inFlight === 0) socket.destroy()
    })
    socket.on('drain', pump)
    socket.on('end', () => {
      peerEnded = true
      gone.abort()
      pump()
    })
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = framer.push(chunk)
      } catch (err) {
        // Oversized line: nothing after it can be framed, and buffering it is what we refuse.
        this.log(`socket: closing connection: ${errorText(err)}`)
        socket.destroy()
        return
      }
      for (const line of lines) if (line.trim() !== '') queue.push(line)
      pump()
    })
  }

  /** Answer one line. Never throws: every failure becomes an error reply on this connection only. */
  private async serve(socket: Socket, line: string, peerGone: AbortSignal): Promise<void> {
    let id: number | null = null
    let reply: Reply
    try {
      const request = parseRequest(line)
      id = request.id
      const result = await this.dispatch(request, peerGone)
      reply = { id, ok: true, result: result ?? null }
    } catch (err) {
      reply = { id: err instanceof ProtocolError ? err.id : id, ok: false, error: errorText(err) }
    }
    let text: string
    try {
      text = encodeReply(reply)
    } catch (err) {
      // A handler returned something JSON cannot carry (a cycle, a BigInt).
      text = encodeReply({ id, ok: false, error: `unserializable result: ${errorText(err)}` })
    }
    // The client may be gone: `ccc hook` is fire-and-forget and closes without reading.
    if (!socket.destroyed && socket.writable) socket.write(text)
  }

  /** Identity first, then the allow-list, then the handler: an unauthorised caller learns nothing. */
  private dispatch(request: Request, peerGone: AbortSignal): unknown {
    const caller = this.identify(request)
    const handler = this.handlers.get(request.cmd)
    if (!handler) throw new Error(`unknown command: ${request.cmd}`)
    return handler(request.args, caller, peerGone)
  }

  private identify(request: Request): Caller {
    if (request.token !== undefined) {
      const owner = this.options.resolveToken(request.token)
      if (!owner) throw new Error('invalid token')
      // Copied field by field: the caller is exactly what the type says, nothing the resolver
      // happened to carry along.
      if (owner.kind === 'session') return { kind: 'session', tabId: owner.tabId, projectId: owner.projectId }
      // Refused before any handler runs (each session-only handler refuses it again): a window
      // token from a shell tab must never reach `hook`, which would create a status entry.
      if (!WINDOW_TOKEN_COMMANDS.includes(request.cmd)) {
        throw new Error(`${request.cmd} needs a Claude session (run it inside a cockpit Claude tab, not a shell tab)`)
      }
      return { kind: 'window', projectId: owner.projectId }
    }
    if (!TOKENLESS_COMMANDS.includes(request.cmd)) {
      throw new Error(`${request.cmd} needs a tab token (run it inside a cockpit Claude tab)`)
    }
    if ((request.project === undefined || request.project === '') && PROJECTLESS_COMMANDS.includes(request.cmd)) {
      return { kind: 'anonymous' }
    }
    if (request.project === undefined || request.project === '') {
      throw new Error('a call from outside a tab must name a project (--project <path>)')
    }
    // main's cwd means nothing to the caller; the CLI resolves a relative path against its own.
    if (!isAbsolute(request.project)) throw new Error('project must be an absolute path')
    const project = this.options.resolveProject(request.project)
    return { kind: 'project', path: project.path, projectId: project.projectId }
  }

  /**
   * The fallback dir must be ours alone: a real directory (lstat, so a symlink planted in the
   * shared tmpdir does not count), owned by our uid, with no group/other bits. mkdir's mode is
   * filtered by the umask, which can only remove bits, so a dir we just made always passes.
   */
  private ensurePrivateDir(dir: string): boolean {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log(`socket: cannot create ${dir}: ${errorText(err)}`)
        return false
      }
    }
    let st: Stats
    try {
      st = lstatSync(dir)
    } catch (err) {
      this.log(`socket: cannot stat ${dir}: ${errorText(err)}`)
      return false
    }
    const uid = this.options.uid ?? process.getuid?.()
    let problem: string | undefined
    if (!st.isDirectory()) problem = 'is not a directory'
    else if (uid !== undefined && st.uid !== uid) problem = `is owned by uid ${st.uid}, not ${uid}`
    else if ((st.mode & 0o077) !== 0) problem = `has mode ${(st.mode & 0o777).toString(8)}, want 700`
    if (problem) {
      this.log(`socket: refusing fallback dir ${dir}: it ${problem}; no CLI socket this run`)
      return false
    }
    return true
  }

  /**
   * Make the path free to bind. A socket file nobody answers on is left over from a crash: unlink
   * it. One that answers belongs to a running instance (another data dir pointed at the same
   * `$CC_COCKPIT_SOCK`): leave it alone and run without a socket. Anything that is not a socket
   * is never deleted: the path may come from the user's env and could name a real file.
   *
   * Two instances sharing a path (two data dirs, one `$CC_COCKPIT_SOCK`; the single-instance lock
   * is per data dir) can both find the stale file dead. If A unlinks it and binds first, B must not
   * then unlink A's live socket: B unlinks only the inode it probed, and otherwise fails its own
   * bind (EADDRINUSE) and runs without a socket. What is left is the gap between B's lstat and
   * unlink, two back-to-back syscalls.
   */
  private async clearStale(path: string): Promise<boolean> {
    let st: Stats
    try {
      st = lstatSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.log(`socket: cannot stat ${path}: ${errorText(err)}`)
      return false
    }
    if (!st.isSocket()) {
      this.log(`socket: ${path} exists and is not a socket; not touching it`)
      return false
    }
    try {
      const probe = await connect(path, this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
      probe.destroy()
      this.log(`socket: ${path} is in use by another running instance; no CLI socket this run`)
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true // removed between the stat and the probe
      if (code !== 'ECONNREFUSED') {
        // A timeout means something holds the socket but does not answer: not provably dead.
        this.log(`socket: probing ${path} failed (${errorText(err)}); not replacing it`)
        return false
      }
    }
    try {
      if (lstatSync(path).ino !== st.ino) {
        this.log(`socket: ${path} was replaced while probing it; not touching it`)
        return false
      }
      unlinkSync(path)
      return true
    } catch (err) {
      // ENOENT: someone else cleared it in the meantime; the bind will tell whether it is free.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.log(`socket: cannot remove stale ${path}: ${errorText(err)}`)
      return false
    }
  }

  private unlinkOwn(): void {
    const { path } = this.options
    try {
      // libuv may already have removed it on close; and if another file took its place since,
      // it is not ours to delete.
      if (lstatSync(path).ino === this.boundIno) unlinkSync(path)
    } catch {
      // ENOENT: already gone.
    }
    this.boundIno = undefined
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
