// The `ccc` client side of the socket (plan: Task 13, user commands Task 21). The one invariant of
// this file: nothing the app does or fails to do may fail a Claude hook. Not running, a stale socket file, a hung owner, a
// foreign listener, an unsafe directory: every one of them ends in a silent exit 0 (`run` resolves,
// index.ts exits 0), for a hook and for every other command alike but `ccc web`, which a person on
// the server runs to see who gets in and is told "not running" with exit 1. A hook that exits non-zero
// shows up in the user's Claude session. Anything else a user command throws is exit 1 with the
// message: a script must not read a failure as success.
//
// Pure Node, no Electron: this is bundled into out/cli/index.js and started by the wrapper as
// `ELECTRON_RUN_AS_NODE=1 electron out/cli/index.js`. It imports `socketPath()` (paths.ts) so the
// CLI and main compute the same path, and the `connect` transport.
import type { Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { dataPaths, defaultDataDir, fallbackSocketDir, isPrivateDir, resolveDataDir, socketPath } from '../main/paths'
import { connect } from '../main/socket/transport'
import { BUILD_VERSION } from '../shared/app-version'
import { errorText } from '../shared/error-text'
import { isPlainObject } from '../shared/guards'
import { ADD_DEVICE_EXPIRES_TEXT } from '../shared/web-access'
import {
  encodeRequest,
  HOOK_ACK_COMMAND,
  LineFramer,
  MAX_LINE_BYTES,
  parseReply,
  PROTOCOL_VERSION,
  ROOM_READ_ACK_COMMAND,
  STOP_REPLY_ARG,
  stopBlockOf,
  type Reply,
  type Request,
  type StopBlockReply
} from '../shared/protocol'
import {
  CLI_CLIENT_DEADLINE_MS,
  CLI_REPLY_TIMEOUT_MS,
  CLI_TIMEOUT_CODE,
  encodedBytes,
  MAX_CLI_IO_BYTES,
  normalizeCliResult,
  type PluginCliSpec
} from '../shared/plugin-cli'
import { formatPluginConfig, formatPluginConfigSet, type PluginConfigSetResult, type PluginConfigView } from '../shared/plugin-config'
import { formatPluginLimits } from '../shared/plugin-limits'
import { formatUsageEntry, parseArgs, USAGE, usageFor, type Command } from './args'
import { guideText, topicList } from './guide'
import { hookSocketPath } from './hook-socket'
import { runPluginLogs } from './plugin-logs'
import { runPluginNew } from './plugin-new'
import { runStatusLine } from './statusline'
import { formatRoomDocs, formatRoomJoin, formatRoomLeave, formatRoomSend, formatRoomStatus } from './room-format'
import { formatWebSaved, formatWebStatus } from './web-format'
import { readStdinBounded, readStdinCapped } from './stdin-read'
import { readPassword } from './web-password'
import { MAX_PASSWORD_LENGTH } from '../main/web/password'

type Env = Record<string, string | undefined>

export { hookSocketPath }

/** Total time `ccc hook` may take: reading stdin, connecting and writing. Then it exits 0. */
export const HOOK_BUDGET_MS = 500
/**
 * `ccc hook Stop`'s total: two round trips (the Stop and its reply, the ack and its answer) on top of the above. Longer
 * than the other events so a main whose event loop stalls for a moment (start, a pty burst) still answers in time,
 * and well under Claude Code's hook timeout (hooks-file.ts HOOK_TIMEOUT_SECONDS, 5 s). Claude waits this long at a Stop
 * only when main is slow; with main down the connect fails at once.
 */
export const STOP_HOOK_BUDGET_MS = 2000

/** The budget `ccc hook <event>` runs in (index.ts adds its backstop margin to the same number). */
export function hookBudgetMs(event: string): number {
  return event === 'Stop' ? STOP_HOOK_BUDGET_MS : HOOK_BUDGET_MS
}
/** Most of the hook payload read from stdin. A Claude hook payload is far smaller than this. */
export const STDIN_CAP_BYTES = 1024 * 1024

export interface SystemInputs {
  platform: string
  /** undefined where the OS has no uids (Windows): the fallback-dir ownership check is skipped. */
  uid: number | undefined
  tmpdir: string
  home: string
}

export function systemInputs(): SystemInputs {
  return { platform: process.platform, uid: process.getuid?.(), tmpdir: tmpdir(), home: homedir() }
}

/**
 * The socket for a user-facing command (Task 21). Inside a tab it is the hook rule above. Outside
 * one it is computed like main does (`$CC_COCKPIT_SOCK`, else `<data>/app.sock`, else the
 * short fallback), and a path in the fallback dir is used only if that directory is a real
 * directory owned by us with no group/other access, the check the server makes before it binds
 * there. On a shared /tmp another user could otherwise have pre-created `ccc-<uid>/` and be
 * listening in it. `undefined` means: exit 0 without connecting.
 */
export function resolveSocketPath(env: Env, system: SystemInputs = systemInputs()): string | undefined {
  if (env.APP_TAB_TOKEN) return hookSocketPath(env)
  const dataDir = resolveDataDir(defaultDataDir(system.platform, env, system.home), env)
  const uid = system.uid ?? 'nouid'
  const path = socketPath(dataDir, env, uid, system.tmpdir)
  const fallbackDir = fallbackSocketDir(system.tmpdir, uid)
  if (dirname(path) === fallbackDir && !isPrivateDir(fallbackDir, system.uid)) return undefined
  return path
}

/**
 * The request line for a hook: `{ cmd: 'hook', token, args: { event, payload } }`. The payload is
 * Claude's JSON; text that is not JSON becomes `null`. A payload over the stdin cap is dropped
 * (`payload: null`, `truncated: true`): cut-off JSON cannot be parsed, and main still learns the
 * event happened, which is all the status needs. The same is done when the payload is under the
 * cap but its request line would exceed the server's line limit (the connection would be closed).
 * A Stop also carries `reply: true` (protocol.ts STOP_REPLY_ARG): this `ccc` reads the reply, so
 * main may answer it with the room pointer.
 */
export function buildHookRequestLine(
  event: string,
  token: string,
  stdin: { text: string; truncated: boolean }
): string {
  let payload: unknown = null
  let truncated = stdin.truncated
  if (!truncated && stdin.text.trim() !== '') {
    try {
      payload = JSON.parse(stdin.text)
    } catch {
      payload = null
    }
  }
  const reply = event === 'Stop' ? { [STOP_REPLY_ARG]: true } : {}
  const make = (): string =>
    encodeRequest({
      v: PROTOCOL_VERSION,
      id: FIRST_REQUEST_ID,
      token,
      cmd: 'hook',
      args: truncated ? { event, payload, truncated: true, ...reply } : { event, payload, ...reply }
    })
  let line = make()
  // The framer's cap is on the line without its newline.
  if (Buffer.byteLength(line) - 1 > MAX_LINE_BYTES) {
    payload = null
    truncated = true
    line = make()
  }
  return line
}

/** Write `line` and half-close, without reading the reply: a hook has nothing to wait for. */
function sendAndForget(socket: Socket, line: string): Promise<void> {
  return new Promise((resolve) => {
    // The callback (or an error) means the bytes are in the kernel; the server still reads them
    // after we close, and its reply to a closed socket is an EPIPE it ignores (socket-server.ts).
    socket.once('error', () => resolve())
    socket.end(line, () => resolve())
  })
}

/**
 * Reads the reply lines of one connection, in order: each call resolves with the next reply, or undefined once the
 * connection is closed, ended or broken, an over-long line came (nothing after it can be framed), or the line is not a
 * reply. Never rejects. The hook's deadline ends a wait from outside: runHook destroys the socket, which settles it
 * through 'close'.
 */
function replyReader(socket: Socket): () => Promise<Reply | undefined> {
  const framer = new LineFramer()
  const lines: string[] = []
  let gone = false
  let wake: (() => void) | undefined
  const notify = (): void => {
    const w = wake
    wake = undefined
    w?.()
  }
  socket.on('data', (chunk: Buffer) => {
    try {
      lines.push(...framer.push(chunk))
    } catch {
      // An over-long line: not a reply this client accepts, and nothing after it can be framed.
      gone = true
      lines.length = 0
    }
    notify()
  })
  const end = (): void => {
    gone = true
    notify()
  }
  // `on`, not `once`: a second 'error' with no listener would throw out of the hook.
  socket.on('error', end)
  socket.on('close', end)
  socket.on('end', end)
  return async () => {
    while (lines.length === 0 && !gone) await new Promise<void>((r) => (wake = r))
    const line = lines.shift()
    if (line === undefined) return undefined
    try {
      return parseReply(line)
    } catch {
      return undefined
    }
  }
}

/**
 * Request ids on a connection that carries a request and then its ack (the Stop exchange, `ccc room read`). Main
 * answers in order, so a reply under the other id is a confused peer's and is never taken for this one.
 */
const FIRST_REQUEST_ID = 1
const ACK_REQUEST_ID = 2

/**
 * The Stop hook's exchange (protocol.ts STOP_REPLY_ARG) on one connection, never half-closed until it is over: the
 * Stop, then its reply; for a valid block, `hook.ack` and main's answer. Resolves with the block to print only when
 * main confirmed the ack (`{ acked: true }`), else undefined (a plain Stop, garbage, an error reply, a refused ack, a
 * closed connection). The order is the safety argument (rooms/room-stop.ts): main undoes a block whose connection
 * closes unacked, which is right only because nothing is printed before main has the ack.
 */
async function stopExchange(socket: Socket, line: string, token: string): Promise<StopBlockReply | undefined> {
  const next = replyReader(socket)
  socket.write(line)
  const reply = await next()
  const block = reply?.ok === true && reply.id === FIRST_REQUEST_ID ? stopBlockOf(reply.result) : undefined
  if (block === undefined) return undefined
  socket.write(encodeRequest({ v: PROTOCOL_VERSION, id: ACK_REQUEST_ID, token, cmd: HOOK_ACK_COMMAND, args: { ackId: block.ackId } }))
  const answer = await next()
  const acked = answer?.ok === true && answer.id === ACK_REQUEST_ID && isPlainObject(answer.result) && answer.result.acked === true
  return acked ? block : undefined
}

/** The line `ccc hook Stop` prints for a block: Claude Code's Stop hook decision, the fixed pointer as the reason. */
export function stopBlockOutput(block: StopBlockReply): string {
  return `${JSON.stringify({ decision: 'block', reason: block.block })}\n`
}

/**
 * `ccc hook <event>`: report one Claude hook to main. Fire-and-forget within `budgetMs` in total,
 * except Stop, which reads main's reply in its own budget (STOP_HOOK_BUDGET_MS): a valid block (the
 * room pointer, design-rooms.md §2) is acked on the same connection with `hook.ack`, and printed
 * with `write` as Claude Code's `decision: block` JSON only once main confirmed the ack (stopExchange
 * says why the order matters). Never rejects. Resolves (and so lets the caller exit 0) in every
 * case, including when stdin never closes or the owner of the socket accepts and never reads or
 * never answers: whatever has not finished by the deadline is abandoned, and nothing is printed
 * after it. A print that fails after the ack (stdout closed; EPIPE arrives later as an event)
 * leaves main keeping the tab `working` (room-stop.ts), which the person's next prompt recovers.
 */
export async function runHook(
  event: string,
  env: Env,
  stdin: Readable,
  budgetMs: number = hookBudgetMs(event),
  write: (text: string) => void = () => {}
): Promise<void> {
  const path = hookSocketPath(env)
  const token = env.APP_TAB_TOKEN
  if (!path || !token) return

  let socket: Socket | undefined
  let over = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
  })
  // Reading stdin and connecting overlap: connecting is the slower of the two when Claude is
  // quick, and a hook should cost one round of both, not the sum.
  const work = (async (): Promise<void> => {
    const connecting = connect(path, budgetMs).then((s) => {
      if (over) s.destroy()
      else socket = s
      return s
    })
    const [input, connected] = await Promise.all([readStdinCapped(stdin, STDIN_CAP_BYTES), connecting])
    if (over) return
    const line = buildHookRequestLine(event, token, input)
    if (event !== 'Stop') {
      await sendAndForget(connected, line)
      return
    }
    const block = await stopExchange(connected, line, token)
    // Past the deadline main may have the ack already: printing nothing then leaves the tab `working`, the safe side.
    if (over || block === undefined) return
    try {
      write(stopBlockOutput(block))
    } catch {
      // stdout closed: Claude gets no block; main took the ack, so the tab stays working (the safe side)
    }
  })().catch(() => {
    // ENOENT / ECONNREFUSED / ETIMEDOUT / EPIPE: the app is not there or not listening. Silent.
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    over = true
    clearTimeout(timer)
    socket?.destroy()
  }
}

/**
 * What `ccc hook SessionStart` prints on stdout, which Claude adds to the session's context: the
 * second way in to the docs besides the core skill (claude-plugins/core-skill.md), so a session
 * that does not load the skill is still told where to look. One short line: it is written before
 * the event is delivered, and a line this size goes out in one pipe write, so neither the 500 ms
 * budget nor index.ts's backstop exit can cut it off.
 */
export const SESSION_START_NOTE =
  "You are inside cc-cockpit; run `ccc guide` to learn the `ccc` CLI and the plugin API, and `ccc help` for the commands this project's plugins add."

/** How long a user command waits to reach the app before it counts as "not running". */
export const CONNECT_TIMEOUT_MS = 2000
/** How long a command that does not wait for the user may wait for main's reply. */
export const REPLY_TIMEOUT_MS = 10_000
/**
 * `ccc download`'s wait for main's reply: it never waits for the person's click (main answers once
 * the offer is out), but a folder is counted first, a walk bounded by DOWNLOAD_WALK_MS (10 s), which
 * the plain 10 s reply wait would cut off just as it finished. Bounded all the same.
 */
export const DOWNLOAD_REPLY_TIMEOUT_MS = 30_000

export interface Output {
  stdout(text: string): void
  stderr(text: string): void
  /**
   * `stdout`, resolved with whether the text was written out (not merely queued), for a caller that must know before it
   * goes on (`ccc room read`'s ack). Absent in an Output whose writes are synchronous: `stdout` is then enough.
   */
  stdoutFlushed?(text: string): Promise<boolean>
}

const processOutput: Output = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  stdoutFlushed: (text) =>
    new Promise<boolean>((resolve) => {
      // A pipe's write is async: the callback runs once it is flushed, with the error when the reader went away (EPIPE).
      // That error is also emitted as an `error` event afterwards, which with no listener would crash the process (exit
      // 1, index.ts): so the listener stays after a failed write (a stream emits `error` once), and only a write that
      // flushed takes it off again, so repeated calls do not pile listeners up.
      const failed = (): void => resolve(false)
      process.stdout.once('error', failed)
      process.stdout.write(text, (err) => {
        const ok = err === null || err === undefined
        if (ok) process.stdout.off('error', failed)
        resolve(ok)
      })
    })
}

/** A version as the app reports it. Anything else in a reply is not worth printing. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_VERSION_LENGTH = 64

/**
 * After an upgrade over a running app, `ccc` (rewritten to the new bundle) and the app that answers
 * it are different versions. Say so on stderr and carry on: stdout stays clean for `--json` and
 * scripts, and the exit code remains the command's. Not for hooks, which never read a reply. An
 * older app sends no version, which never warns; nor does a value that is not a version, since the
 * reply is only as trustworthy as whatever owns the socket.
 */
function warnOnVersionMismatch(trip: RoundTrip, out: Output): void {
  if (!('reply' in trip)) return
  const running = trip.reply.appVersion
  if (running === undefined || running === BUILD_VERSION) return
  if (running.length > MAX_VERSION_LENGTH || !VERSION_RE.test(running)) return
  try {
    out.stderr(`ccc: the app is running version ${plainLine(running)}, this ccc is version ${plainLine(BUILD_VERSION)}. Restart cc-cockpit.\n`)
  } catch {
    // The warning must not change the command's result. This only covers a write that throws: on
    // process.stderr a closed pipe fails later as an `error` event, handled in index.ts.
  }
}

/**
 * A command that talks to the app with one request (everything `parseArgs` returns except
 * hook/help/guide/usage/none, and `plugin`, which takes two: runPlugin).
 */
export type UserCommand = Exclude<
  Command,
  { kind: 'hook' | 'statusline' | 'help' | 'guide' | 'usage' | 'none' | 'plugin' | 'plugin-new' | 'plugin-logs' | 'room-read' }
>

/**
 * How a request names the caller's window: a tab's token, or the project folder outside a tab.
 * Every tab has a token (a Claude tab's session token; a shell or command tab's, or a terminal
 * overlay's, window token). The CLI cannot tell the kinds apart and does not need to: main decides
 * on lookup, and refuses a window token for `hook` and `session note`/`steps`.
 */
export type Routing = Pick<Request, 'token' | 'project'>

/**
 * The routing of a command that acts on a window: inside a tab its token picks the window (a
 * `--project` is then ignored); outside one `--project` must name the folder, made absolute
 * against the CLI's cwd. `what` names the command in the error, `where` says where the flag goes.
 */
export function callerOf(env: Env, project: string | undefined, cwd: string, what: string, where = ''): Routing | { error: string } {
  const token = env.APP_TAB_TOKEN || undefined
  if (token) return { token }
  if (project === undefined) return { error: `${what} outside a cockpit tab needs --project <path>${where}` }
  return { project: resolve(cwd, project) }
}

/** The request for a user command, or an error message for a call that cannot be made. */
export function buildRequest(command: UserCommand, env: Env, cwd: string): Request | { error: string } {
  const token = env.APP_TAB_TOKEN || undefined
  // main's cwd means nothing to the caller: every path is made absolute here, against ours.
  const abs = (path: string): string => resolve(cwd, path)
  let cmd: string
  let args: Record<string, unknown> = {}
  // A command main answers for a Claude tab only (note, steps) or for anyone (sessions, notify) sends
  // the token when there is one and nothing else.
  let routing: Routing | { error: string } = token ? { token } : {}
  switch (command.kind) {
    case 'open':
      cmd = 'open'
      args = { path: abs(command.path) }
      // A call from outside a tab must name a project; for `open` that is the folder itself.
      routing = callerOf(env, command.path, cwd, 'open')
      break
    case 'note':
      cmd = 'session.note'
      args = { text: command.text }
      break
    case 'steps':
      cmd = 'session.steps'
      args = { done: command.done, total: command.total }
      break
    case 'sessions':
      cmd = 'sessions'
      break
    case 'notify':
      cmd = 'notify'
      args = { text: command.text }
      break
    case 'download':
      // Only from a tab of the project (a Claude tab's or a window token): a tokenless caller names no
      // window anybody looks at (design-download.md §1.1). main refuses it again (protocol.ts).
      if (!token) return { error: 'download: run it in a tab of the project' }
      cmd = 'download'
      args = { path: abs(command.path) }
      break
    case 'overlay': {
      cmd = 'overlay'
      const t = command.target
      if (t.mode === 'terminal') args = { terminal: t.argv, cwd }
      else if (t.mode === 'url') args = { url: t.url }
      else args = { html: abs(t.file) }
      routing = callerOf(env, command.project, cwd, 'overlay')
      break
    }
    case 'plugin-link':
      cmd = 'plugin.link'
      args = { path: abs(command.dir) }
      routing = callerOf(env, command.project, cwd, 'plugin link')
      break
    case 'plugin-unlink':
      cmd = 'plugin.unlink'
      args = { id: command.id }
      routing = callerOf(env, command.project, cwd, 'plugin unlink')
      break
    case 'plugin-list':
      cmd = 'plugin.list'
      routing = callerOf(env, command.project, cwd, 'plugin list')
      break
    case 'panel-show':
      cmd = 'panel.show'
      args = { plugin: command.plugin, panel: command.panel }
      routing = callerOf(env, command.project, cwd, 'panel show')
      break
    case 'plugin-config':
      // No project in args: main takes the project from the routing (token or --project).
      cmd = 'plugin.config'
      args = { id: command.id }
      if (command.useGlobal !== undefined && command.useGlobal.length > 0) args.useGlobal = command.useGlobal
      else if (command.set.length > 0) {
        args.set = command.set
        if (command.scope !== undefined) args.scope = command.scope
      }
      routing = callerOf(env, command.project, cwd, 'plugin config')
      break
    // `ccc plugin limits`: app-wide, so no project; the token goes along when there is one (the default routing), for
    // the read (allowed from a tab) and so main refuses the write with the host-only text (protocol.ts HOST_ONLY_COMMANDS).
    case 'plugin-limits':
      args = { id: command.id }
      if (command.set.length > 0 || command.reset.length > 0) {
        cmd = 'plugin.limits.set'
        if (command.set.length > 0) args.set = command.set
        if (command.reset.length > 0) args.reset = command.reset
      } else cmd = 'plugin.limits'
      break
    // `ccc room ...`: the token alone (the default routing); main takes the tab, room and name from it, never from args.
    case 'room-status':
      cmd = 'room.status'
      break
    case 'room-join':
      cmd = 'room.join'
      args = { invite: command.invite }
      break
    case 'room-leave':
      cmd = 'room.leave'
      break
    case 'room-send':
      cmd = 'room.send'
      args = { to: command.to, text: command.text ?? '' }
      break
    case 'room-doc-ls':
      cmd = 'room.doc.ls'
      break
    case 'room-doc-get':
      cmd = 'room.doc.get'
      args = { path: command.path }
      break
    case 'room-doc-put':
      cmd = 'room.doc.put'
      args = { path: command.path, text: command.text ?? '' }
      break
    // `ccc web` never names a project; in a tab the token goes along (the default routing above)
    // only so main refuses it with the host-only text (protocol.ts HOST_ONLY_COMMANDS).
    case 'web-status':
      cmd = 'web.status'
      break
    case 'web-revoke':
      cmd = 'web.revoke'
      args = command.all ? { all: true } : { id: command.id }
      break
    case 'web-stop':
      cmd = 'web.stop'
      break
    case 'web-link':
      cmd = 'web.link'
      if (command.regenerate) args = { regenerate: true }
      break
    case 'web-add-device':
      cmd = 'web.add-device'
      break
    case 'web-password':
      // Only in the request's args over the private socket: never argv, never printed.
      cmd = 'web.password'
      if (command.password !== undefined) args = { password: command.password }
      break
    case 'web-mode':
      cmd = 'web.mode'
      args = command.confirm.length > 0 ? { mode: command.mode, confirm: command.confirm } : { mode: command.mode }
      break
    case 'web-set': {
      // Field names are WebAccessPatch's; main's cwd means nothing to the caller, so TLS paths and the
      // start folder are made absolute here, as `--project` is (main refuses a relative one).
      cmd = 'web.set'
      if (command.bind !== undefined) args.bind = command.bind
      if (command.port !== undefined) args.port = command.port
      if (command.origin !== undefined) args.externalOrigin = command.origin
      if (command.hosts !== undefined) args.hosts = command.hosts
      if (command.tls !== undefined) args.tls = command.tls === null ? null : { certPath: abs(command.tls.cert), keyPath: abs(command.tls.key) }
      if (command.confirm.length > 0) args.confirm = command.confirm
      // '' clears it (main reads it as the home folder); anything else is a path, made absolute here.
      if (command.startFolder !== undefined) args.startFolder = command.startFolder === '' ? null : abs(command.startFolder)
      break
    }
  }
  if ('error' in routing) return routing
  return { v: PROTOCOL_VERSION, id: 1, cmd, args, ...routing }
}

type RoundTrip = { reply: Reply } | { closed: true } | { timedOut: true }

/** Send one request and read its one reply. `timeoutMs` undefined waits as long as it takes. */
function roundTrip(socket: Socket, line: string, timeoutMs: number | undefined): Promise<RoundTrip> {
  return new Promise((settle) => {
    const framer = new LineFramer()
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (result: RoundTrip): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(result)
    }
    if (timeoutMs !== undefined) timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const l of framer.push(chunk)) {
          if (l.trim() !== '') return finish({ reply: parseReply(l) })
        }
      } catch {
        finish({ closed: true }) // a reply we cannot read is no reply
      }
    })
    socket.once('close', () => finish({ closed: true }))
    socket.once('error', () => finish({ closed: true }))
    socket.write(line)
  })
}

/** What `ccc web` prints, exit 1, when nothing answers on the socket. */
export const NOT_RUNNING = 'cc-cockpit is not running'

/** A command a person runs to see or change the app's own settings: "not running" is an answer they need. */
function isWebCommand(command: UserCommand): boolean {
  return command.kind.startsWith('web-') || command.kind === 'plugin-limits'
}

/**
 * A user command (everything but `hook`): one request, one reply. Exit codes: 0 with the result
 * printed, or 0 and silent when the app is not there (not running, stale socket), because scripts and skills call `ccc` without checking that the cockpit is
 * open (`ccc web` and `ccc plugin limits` excepted: exit 1, NOT_RUNNING); 1 with the app's error on stderr (main refused the request, or dropped the connection unanswered); 2 for a usage error.
 */
export async function runCommand(
  command: UserCommand,
  env: Env,
  cwd: string,
  out: Output = processOutput
): Promise<number> {
  const request = buildRequest(command, env, cwd)
  if ('error' in request) {
    out.stderr(`ccc: ${request.error}\n`)
    return 2
  }
  // `ccc web` is run by a person or a script on the server to see or change who gets in: "not
  // running" is an answer they need, so it is exit 1 with a line, unlike every other command's
  // silent 0 (kept for hooks and the skills that call `ccc` without checking, design-web.md §9.4).
  const absent = (): number => {
    if (!isWebCommand(command)) return 0
    out.stderr(`ccc: ${NOT_RUNNING}\n`)
    return 1
  }
  const path = resolveSocketPath(env)
  if (!path) return absent()
  let socket: Socket
  try {
    socket = await connect(path, CONNECT_TIMEOUT_MS)
  } catch {
    return absent()
  }
  try {
    // An overlay lives until the user is done with it, however long that takes; so does the
    // confirm dialog of `plugin link`, which a person reads before they answer. `plugin unlink`
    // waits its turn in the installer's serial queue (behind a clone of up to two minutes) and for
    // the hosts to reload: cut off at 10 s it printed "did not answer" and exit 1 while the unlink
    // still went through, and the retry then failed with "is not installed" (review finding).
    // `plugin config` with values to set (or overrides to drop) likewise: it waits in the plugin's
    // settings save queue (behind a form save that may be at a keychain prompt) and for a host
    // restarted by the change.
    const waits =
      command.kind === 'overlay' ||
      command.kind === 'plugin-link' ||
      command.kind === 'plugin-unlink' ||
      (command.kind === 'plugin-config' && (command.set.length > 0 || (command.useGlobal?.length ?? 0) > 0))
        ? undefined
        : command.kind === 'download'
          ? DOWNLOAD_REPLY_TIMEOUT_MS
          : REPLY_TIMEOUT_MS
    const trip = await roundTrip(socket, encodeRequest(request), waits)
    warnOnVersionMismatch(trip, out)
    if ('closed' in trip) {
      // The connection was made and then dropped with no reply: not "the app is not there". Main
      // drops a request over the size limit and the framer refuses an oversized reply, so silence
      // would pass for success. (Not a hook: those never reach this function.)
      out.stderr('ccc: the app closed the connection without a reply\n')
      return 1
    }
    if ('timedOut' in trip) {
      out.stderr('ccc: the app did not answer\n')
      return 1
    }
    if (!trip.reply.ok) {
      out.stderr(`ccc: ${plainError(trip.reply.error)}\n`)
      return 1
    }
    const text = formatResult(command, trip.reply.result)
    if (text !== '') out.stdout(text)
    const warnings = resultWarnings(command, trip.reply.result)
    if (warnings !== '') out.stderr(warnings)
    return 0
  } finally {
    socket.destroy()
  }
}

/**
 * How long a `stdin: true` plugin command waits for its stdin to end (it is never read from a
 * terminal). As long as the call's own hard deadline: a slow producer gets the same time a slow
 * plugin does, and an open pipe that never closes ends in exit 124 instead of a hang.
 */
export const STDIN_READ_TIMEOUT_MS = CLI_CLIENT_DEADLINE_MS

/** A plugin command as parseArgs returned it. */
export type PluginCommand = Extract<Command, { kind: 'plugin' }>

/**
 * One request on its own connection, with its one reply. `absent` is "the app is not there" (no
 * socket path, or nothing answers the connect): every command exits 0 silently for it.
 */
async function ask(env: Env, request: Request, timeoutMs: number): Promise<RoundTrip | { absent: true }> {
  const path = resolveSocketPath(env)
  if (!path) return { absent: true }
  let socket: Socket
  try {
    socket = await connect(path, CONNECT_TIMEOUT_MS)
  } catch {
    return { absent: true }
  }
  try {
    return await roundTrip(socket, encodeRequest(request), timeoutMs)
  } finally {
    socket.destroy()
  }
}

/**
 * `ask` under a hard deadline of its own (CLI_CLIENT_DEADLINE_MS for a plugin command): whatever
 * the round trip does or fails to do, this settles by `deadlineMs`. The timer is separate from
 * the reply timer on purpose, a backstop for the case nothing else catches; `ask`'s own finally
 * destroys the socket once it settles, and the process exits right after anyway.
 */
async function askWithin(env: Env, request: Request, timeoutMs: number, deadlineMs: number): Promise<RoundTrip | { absent: true } | { deadline: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ask(env, request, timeoutMs),
      new Promise<{ deadline: true }>((resolve) => {
        timer = setTimeout(() => resolve({ deadline: true }), deadlineMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The reply's result, or the exit code after the reason went to stderr (see runCommand). */
function resultOf(trip: RoundTrip, out: Output): { result: unknown } | { code: number } {
  if ('closed' in trip) {
    out.stderr('ccc: the app closed the connection without a reply\n')
    return { code: 1 }
  }
  if ('timedOut' in trip) {
    out.stderr('ccc: the app did not answer\n')
    return { code: 1 }
  }
  if (!trip.reply.ok) {
    out.stderr(`ccc: ${plainError(trip.reply.error)}\n`)
    return { code: 1 }
  }
  return { result: trip.reply.result }
}

/**
 * Manifest text on a terminal: a plugin's summary or usage is one line of plain text, so control
 * characters (an escape sequence that would recolour or move the cursor) become spaces.
 */
function plainLine(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') : ''
}

/**
 * The app's error text on a terminal. It can quote untrusted text: a front-matter name or a file
 * name from a folder `ccc plugin link` is asked about, before anyone allowed it (review finding).
 * So control characters become spaces as in plainLine, but a line break stays (an error may span
 * lines) and so does a tab.
 */
function plainError(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof text === 'string' ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ') : ''
}

/** A stream that is a terminal (process.stdin on a tty); a pipe, a file or a test stream is not. */
function isTTY(stream: Readable): boolean {
  return (stream as Readable & { isTTY?: boolean }).isTTY === true
}

/**
 * `ccc <plugin command> …` (plan B Task 5): two requests. First the command's spec, answered by
 * main from the manifest (unknown command, plugin not enabled: exit 1 with the reason), which says
 * whether to read stdin and holds the usage for `--help`. Then the call itself, routed by main to
 * the plugin's host; stdout and stderr are printed as the plugin returned them, and the exit code
 * is the plugin's.
 *
 * stdin is read only for a command that declares `stdin: true` (with `stdinDash`, only when an
 * argument is exactly `-`), and only when it is not a
 * terminal (nobody would type EOF): reading whenever it is not a TTY would hang a `ccc` started
 * with an open but silent pipe (a tool runner's usual setup), and even then the read ends after
 * STDIN_READ_TIMEOUT_MS with exit 124. Over MAX_CLI_IO_BYTES once JSON-encoded it is refused here,
 * before anything is sent (exit 1), so the request line stays under the socket's limit.
 *
 * The call waits CLI_REPLY_TIMEOUT_MS: main gives the plugin 30 s and answers exit 124 itself, so
 * the CLI's own 10 s would cut a legitimate call short. No reply by then is exit 124 here too, and
 * CLI_CLIENT_DEADLINE_MS is a hard backstop over the whole call. Ctrl+C kills this process, whose
 * socket closing tells main to cancel the call and free its slot.
 */
export async function runPlugin(
  command: PluginCommand,
  env: Env,
  stdin: Readable,
  cwd: string,
  out: Output = processOutput
): Promise<number> {
  const routing = callerOf(env, command.project, cwd, command.name, ' before it')
  if ('error' in routing) {
    out.stderr(`ccc: ${routing.error}\n`)
    return 2
  }
  const request = (id: number, cmd: string, args: Record<string, unknown>): Request => ({ v: PROTOCOL_VERSION, id, cmd, args, ...routing })

  const specTrip = await ask(env, request(1, 'plugin.cli.spec', { name: command.name }), REPLY_TIMEOUT_MS)
  if ('absent' in specTrip) return 0
  // Once per command: the second request below goes to the same app.
  warnOnVersionMismatch(specTrip, out)
  const specResult = resultOf(specTrip, out)
  if ('code' in specResult) return specResult.code
  const spec = (specResult.result ?? {}) as Partial<PluginCliSpec>

  if (command.argv[0] === '--help' || command.argv[0] === '-h') {
    const usage = plainLine(spec.usage) || command.name
    const summary = plainLine(spec.summary)
    out.stdout(`usage: ccc ${usage}\n${summary === '' ? '' : `${summary}\n`}`)
    return 0
  }

  let input = ''
  // A `stdinDash` command reads only for a `-` argument: its other subcommands (`inbox list`) must
  // not wait on a script's inherited, never-closed stdin. Without a `-` it gets '' like a terminal.
  const wantsInput = spec.stdin === true && (spec.stdinDash !== true || command.argv.includes('-'))
  if (wantsInput && !isTTY(stdin)) {
    // One byte over the cap is enough to know: the encoded size is never below the raw one.
    // Bounded like the call itself: an open pipe nobody closes (a tool runner that leaves stdin
    // attached, `sleep 999 | ccc …`) would otherwise keep `ccc` waiting forever with no output,
    // the one unbounded wait left after friction round 1, Task 2. On a timeout the process exits
    // right after, so the abandoned read does not matter.
    const read = await readStdinBounded(stdin, MAX_CLI_IO_BYTES, STDIN_READ_TIMEOUT_MS)
    if ('timedOut' in read) {
      out.stderr(
        `ccc: ${command.name}: stdin was not closed within ${STDIN_READ_TIMEOUT_MS / 1000} s; pipe input or redirect </dev/null\n`
      )
      return CLI_TIMEOUT_CODE
    }
    // An EIO halfway through leaves a partial payload: the plugin is not run on it.
    if (read.error !== undefined) {
      out.stderr(`ccc: ${command.name}: reading stdin failed: ${read.error}\n`)
      return 1
    }
    if (read.truncated || encodedBytes(read.text) > MAX_CLI_IO_BYTES) {
      out.stderr(`ccc: ${command.name}: stdin is over ${MAX_CLI_IO_BYTES / 1024} KiB\n`)
      return 1
    }
    input = read.text
  }

  const args: Record<string, unknown> = { name: command.name, argv: command.argv, cwd }
  if (spec.stdin === true) args.stdin = input
  const runTrip = await askWithin(env, request(2, 'plugin.cli', args), CLI_REPLY_TIMEOUT_MS, CLI_CLIENT_DEADLINE_MS)
  // The app went away between the two requests: the same silent exit 0 as not running at all.
  if ('absent' in runTrip) return 0
  // No reply in time, by the reply timer or the backstop: exit 124 like main's own timeout answer
  // (and `timeout(1)`), never a hang and never the generic exit 1, so a script can tell "too slow,
  // try again" (a plugin that was reloading) from a refusal.
  if ('deadline' in runTrip || 'timedOut' in runTrip) {
    const seconds = Math.round(('deadline' in runTrip ? CLI_CLIENT_DEADLINE_MS : CLI_REPLY_TIMEOUT_MS) / 1000)
    out.stderr(`ccc: ${command.name}: no answer from the app within ${seconds} s\n`)
    return CLI_TIMEOUT_CODE
  }
  const runResult = resultOf(runTrip, out)
  if ('code' in runResult) return runResult.code
  const result = normalizeCliResult(runResult.result)
  if (result.stdout !== '') out.stdout(result.stdout)
  if (result.stderr !== '') out.stderr(result.stderr)
  return result.code
}

/** How long `ccc help` waits for the plugin list: help must answer at once, the list is extra. */
const HELP_LIST_TIMEOUT_MS = 2000

/**
 * The plugin commands of the caller's project, as lines to append to `ccc help`; '' when there are
 * none or the app cannot say (not running, refused, slow). Only inside a tab: outside one there is
 * no project to ask about, and help then is the core usage, exactly as before.
 */
export async function pluginHelp(env: Env): Promise<string> {
  const token = env.APP_TAB_TOKEN || undefined
  if (!token) return ''
  try {
    const trip = await ask(env, { v: PROTOCOL_VERSION, id: 1, token, cmd: 'plugin.cli.list', args: {} }, HELP_LIST_TIMEOUT_MS)
    if (!('reply' in trip) || !trip.reply.ok || !Array.isArray(trip.reply.result)) return ''
    // Laid out like USAGE's own entries (same column, same rule for the first description line).
    const lines = (trip.reply.result as Array<Partial<PluginCliSpec>>).map((c) => {
      const summary = plainLine(c.summary)
      return formatUsageEntry({ synopsis: [plainLine(c.usage) || plainLine(c.name)], text: summary === '' ? [] : [summary] })
    })
    return lines.length === 0 ? '' : `plugin commands of this project:\n${lines.join('\n')}\n`
  } catch {
    return ''
  }
}

/**
 * Warnings a successful command prints on stderr, like the CLI's other warnings, so a caller that
 * parses the stdout line (`linked ...`) gets only that (review finding). Only `plugin link` has any:
 * root-absolute URLs in the linked folder.
 */
function resultWarnings(command: UserCommand, result: unknown): string {
  // `ccc web mode none`: §9.12's shared-server warning, as main words it.
  if (command.kind === 'web-mode') {
    const warning = field(result, 'warning')
    return typeof warning === 'string' ? `ccc: warning: ${plainLine(warning)}\n` : ''
  }
  // A link on stdout alone (a script reads it); what it is goes to stderr.
  if (command.kind === 'web-add-device') return `ccc: ${ADD_DEVICE_EXPIRES_TEXT}\n`
  if (command.kind === 'web-link' && command.regenerate) return 'ccc: the old link no longer works; the devices that signed in with it are signed out\n'
  if (command.kind !== 'plugin-link') return ''
  const warnings = ((result ?? {}) as { warnings?: unknown }).warnings
  return Array.isArray(warnings) ? warnings.map((w) => `ccc: warning: ${plainLine(w)}\n`).join('') : ''
}

/** One field of a reply's result; undefined when the result is no object (an older or broken app). */
function field(result: unknown, key: string): unknown {
  return isPlainObject(result) ? result[key] : undefined
}

/** What a command prints on success. Only `overlay` and `sessions` have a result worth showing. */
function formatResult(command: UserCommand, result: unknown): string {
  switch (command.kind) {
    case 'overlay':
      return `${JSON.stringify(result)}\n`
    case 'plugin-link': {
      const r = (result ?? {}) as { id?: unknown; name?: unknown }
      return `linked ${plainLine(r.id)} (${plainLine(r.name)}) and enabled it in this project\n`
    }
    case 'plugin-unlink':
      return `unlinked ${command.id}\n`
    case 'panel-show':
      return `showing ${command.plugin}/${command.panel}\n`
    case 'download':
      return `${plainLine(field(result, 'text'))}\n`
    case 'plugin-config':
      if (command.json) return `${JSON.stringify(result)}\n`
      return command.set.length > 0 || (command.useGlobal?.length ?? 0) > 0
        ? formatPluginConfigSet(result as PluginConfigSetResult, plainLine)
        : formatPluginConfig(result as PluginConfigView, plainLine)
    case 'plugin-limits':
      return formatPluginLimits(result, plainLine)
    case 'plugin-list': {
      const list = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
      if (command.json) return `${JSON.stringify(list)}\n`
      return list
        .map((p) => [p.id, p.version, p.source, p.enabled === true ? 'enabled' : 'disabled', p.state].map((v) => plainLine(String(v))).join('\t'))
        .map((row) => `${row}\n`)
        .join('')
    }
    case 'room-status':
      return command.json ? `${JSON.stringify(result)}\n` : formatRoomStatus(result, plainLine)
    case 'room-join':
      return formatRoomJoin(result, plainLine)
    case 'room-leave':
      return formatRoomLeave(result, plainLine)
    case 'room-send':
      return formatRoomSend(result, plainLine)
    case 'room-doc-ls':
      return formatRoomDocs(result, plainLine)
    case 'room-doc-get': {
      // A doc exactly as stored (no flattening of its lines, no added newline): it may be piped on.
      const text = field(result, 'text')
      return typeof text === 'string' ? text : ''
    }
    case 'room-doc-put':
      return `saved ${command.path}\n`
    case 'web-status':
      return command.json ? `${JSON.stringify(result)}\n` : formatWebStatus(result, plainLine)
    case 'web-revoke': {
      const revoked = field(result, 'revoked')
      return `revoked ${typeof revoked === 'number' ? revoked : 0} device(s)\n`
    }
    case 'web-stop':
      return 'cc-cockpit is stopping\n'
    case 'web-link':
    case 'web-add-device':
      return `${plainLine(field(result, 'link'))}\n`
    case 'web-password':
      return field(result, 'mode') === 'password' ? 'password set\n' : 'password set; sign-in is not by password yet: ccc web mode password switches to it\n'
    case 'web-mode':
      return `sign-in mode: ${plainLine(field(result, 'mode'))}\n`
    case 'web-set':
      return formatWebSaved(result, plainLine)
    case 'sessions': {
      const list = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
      if (command.json) return `${JSON.stringify(list)}\n`
      return list
        .map((s) => [s.project, s.status, s.tool ?? '', s.tabId].map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t'))
        .map((row) => `${row}\n`)
        .join('')
    }
    default:
      return ''
  }
}

/** `s` without one final line break (LF or CRLF). */
function stripOneNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2)
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

/**
 * The text of `ccc room send <to> -` and `room doc put <path> -`: stdin, read within STDIN_READ_TIMEOUT_MS like a plugin
 * command's (an open pipe nobody closes is exit 124 with the same advice, never a hang). Over MAX_CLI_IO_BYTES raw, or
 * more than a socket line once JSON-encoded (a text of control characters grows to six times), is refused here, before
 * anything is sent: main would drop such a request without an answer. Main still checks the real limits (20000
 * characters a message, 256 KiB a doc, the characters a doc may hold) and says which one it was.
 */
async function readRoomStdin(stdin: Readable, what: string, out: Output): Promise<{ text: string } | { code: number }> {
  // Strict UTF-8: a Latin-1 or binary stdin would otherwise be sent with U+FFFD in place of its bytes (a doc "exactly as
  // given" stored changed, which main cannot tell from what was meant).
  const read = await readStdinBounded(stdin, MAX_CLI_IO_BYTES, STDIN_READ_TIMEOUT_MS, true)
  if ('timedOut' in read) {
    out.stderr(`ccc: ${what}: stdin was not closed within ${STDIN_READ_TIMEOUT_MS / 1000} s; pipe input or redirect </dev/null\n`)
    return { code: CLI_TIMEOUT_CODE }
  }
  // An EIO halfway through leaves a partial text: never sent as if it were all of it.
  if (read.error !== undefined) {
    out.stderr(`ccc: ${what}: reading stdin failed: ${read.error}\n`)
    return { code: 1 }
  }
  if (read.truncated) {
    out.stderr(`ccc: ${what}: stdin is over ${MAX_CLI_IO_BYTES / 1024} KiB\n`)
    return { code: 1 }
  }
  if (read.invalidUtf8) {
    out.stderr(`ccc: ${what}: stdin is not valid UTF-8 text\n`)
    return { code: 1 }
  }
  if (encodedBytes(read.text) > MAX_LINE_BYTES - 4096) {
    out.stderr(`ccc: ${what}: stdin is too large once encoded for the app (each control character takes up to six bytes)\n`)
    return { code: 1 }
  }
  return { text: read.text }
}

const TIMED_OUT = Symbol('timed out')

/** `promise` or TIMED_OUT after `ms`: every wait on main in this file has a deadline. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `ccc room read` (protocol.ts ROOM_READ_ACK_COMMAND), two requests on one connection: `room.read` answers the batch
 * and takes nothing off the queue; the batch's `text` is printed, and only then `room.read.ack` tells main it was
 * printed so it can drop those messages. A `ccc` killed between the two repeats that batch at the next read (at least
 * once, never lost), so a failed or unanswered ack is a stderr warning, not a failure: the text was printed. An empty
 * read (`count` 0) sends no ack. Each wait for main is REPLY_TIMEOUT_MS. The app not running is a silent exit 0 like
 * every command's (the Stop pointer is not printed then either).
 */
async function runRoomRead(env: Env, out: Output): Promise<number> {
  const path = resolveSocketPath(env)
  if (!path) return 0
  let socket: Socket
  try {
    socket = await connect(path, CONNECT_TIMEOUT_MS)
  } catch {
    return 0
  }
  try {
    const token = env.APP_TAB_TOKEN || undefined
    const next = replyReader(socket)
    const request = (id: number, cmd: string, args: Record<string, unknown>): string => encodeRequest({ v: PROTOCOL_VERSION, id, cmd, args, ...(token ? { token } : {}) })
    socket.write(request(FIRST_REQUEST_ID, 'room.read', {}))
    const reply = await within(next(), REPLY_TIMEOUT_MS)
    if (reply === TIMED_OUT) {
      out.stderr('ccc: the app did not answer\n')
      return 1
    }
    if (reply === undefined) {
      out.stderr('ccc: the app closed the connection without a reply\n')
      return 1
    }
    warnOnVersionMismatch({ reply }, out)
    // A reply to another request than the read (main answers in order, so only a confused peer sends one) is never
    // taken for the batch: its text would be printed as room messages and its `ack` sent for them.
    if (reply.id !== FIRST_REQUEST_ID) {
      out.stderr('ccc: the app answered a room read with something this ccc does not understand\n')
      return 1
    }
    if (!reply.ok) {
      out.stderr(`ccc: ${plainError(reply.error)}\n`)
      return 1
    }
    const result = reply.result
    const batch = isPlainObject(result) && typeof result.count === 'number' && typeof result.text === 'string' ? result : undefined
    if (batch === undefined) {
      out.stderr('ccc: the app answered a room read with something this ccc does not understand\n')
      return 1
    }
    if (batch.count === 0) {
      out.stdout('no room messages waiting\n')
      return 0
    }
    // main's fenced text as it is: its fence escapes the control characters, and flattening it would join its lines.
    // The ack goes only once the text has left this process: `write` returns as soon as it is queued, and a reader that
    // went away (Esc, the Bash tool's timeout) would leave messages acked and dropped that nobody saw. Not flushed in
    // time, or a write error: no ack, so the same batch shows again at the next read.
    const text = `${batch.text}\n`
    let written: boolean | typeof TIMED_OUT = true
    try {
      if (out.stdoutFlushed) written = await within(out.stdoutFlushed(text), REPLY_TIMEOUT_MS)
      else out.stdout(text)
    } catch {
      written = false
    }
    if (written !== true) {
      out.stderr('ccc: could not write the room messages to stdout; they stay queued and show again at the next ccc room read\n')
      return 0
    }
    const ack = typeof batch.ack === 'string' ? batch.ack : undefined
    if (ack === undefined) {
      out.stderr('ccc: the app sent no ack for this read; the messages may show again\n')
      return 0
    }
    socket.write(request(ACK_REQUEST_ID, ROOM_READ_ACK_COMMAND, { ack }))
    const answer = await within(next(), REPLY_TIMEOUT_MS)
    const acked = answer !== TIMED_OUT && answer?.ok === true && answer.id === ACK_REQUEST_ID && isPlainObject(answer.result) && typeof answer.result.acked === 'number'
    if (!acked) out.stderr('ccc: could not confirm the read with the app; these messages may show again at the next ccc room read\n')
    return 0
  } finally {
    socket.destroy()
  }
}

/**
 * Entry point of the CLI after argument parsing: the process exit code. Never rejects. The
 * `hook` path is always 0 (the invariant at the top of this file); the other commands answer as
 * `runCommand` says, and one that throws (a file it cannot read, a bug) prints the message and
 * exits 1. "The app is not running" never throws: each command returns 0 for it itself.
 */
export async function run(
  argv: readonly string[],
  env: Env,
  stdin: Readable,
  out: Output = processOutput,
  cwd: string = process.cwd(),
  signal?: AbortSignal
): Promise<number> {
  try {
    const command = parseArgs(argv)
    switch (command.kind) {
      case 'hook':
        // Produced here with no socket round trip, and before delivery, so it is printed when the
        // app is not running or delivery fails. Only SessionStart here, and Stop's block below:
        // any other event's stdout would land in Claude's context or transcript (a
        // UserPromptSubmit hook's stdout is added to the prompt). A failing write is swallowed:
        // the hook still delivers and exits 0.
        if (command.event === 'SessionStart') {
          try {
            out.stdout(`${SESSION_START_NOTE}\n`)
          } catch {
            // stdout closed: nothing to tell
          }
        }
        // Stop may print the room pointer's block (runHook); every other event prints nothing.
        await runHook(command.event, env, stdin, hookBudgetMs(command.event), (text) => out.stdout(text))
        return 0
      case 'statusline':
        // index.ts runs the exact call itself without this file (startup cost); this path is the
        // same function, for a caller that goes through `run`. Exit 0 whatever happens, like a hook.
        await runStatusLine({ env, stdin, write: (data) => out.stdout(data.toString('utf8')), cwd })
        return 0
      case 'none':
        return 0
      case 'help':
        out.stdout(`${(command.command !== undefined && usageFor(command.command)) || USAGE}\n`)
        // The whole usage (not one command's) lists what this project's plugins add, when the
        // app can say; a failure there leaves the core usage alone.
        if (command.command === undefined) {
          const plugins = await pluginHelp(env)
          if (plugins !== '') out.stdout(plugins)
        }
        return 0
      case 'plugin':
        return await runPlugin(command, env, stdin, cwd, out)
      case 'plugin-new': {
        // Pure local, like guide: it writes files and needs nothing from the app.
        return runPluginNew(
          {
            dir: resolve(cwd, command.dir),
            ...(command.id !== undefined ? { id: command.id } : {}),
            panel: command.panel,
            ...(command.cli !== undefined ? { cli: command.cli } : {}),
            skill: command.skill
          },
          out
        )
      }
      case 'plugin-logs': {
        // Pure local too: the log is a file in the data dir (the wrapper sets CC_COCKPIT_DATA_DIR).
        const dataDir = resolveDataDir(defaultDataDir(process.platform, env, homedir()), env)
        return await runPluginLogs(dataPaths(dataDir).logsDir, command.id, command.follow, out, signal)
      }
      case 'guide': {
        // Pure local: the docs are bundled, so this works with the app closed.
        const text = guideText(command.topic)
        if (text === undefined) {
          out.stderr(`ccc: unknown guide topic: ${command.topic}\nTopics:\n${topicList()}\n`)
          return 2
        }
        out.stdout(text)
        return 0
      }
      case 'usage':
        out.stderr(`ccc: ${command.message}\n${USAGE}\n`)
        return 2
      case 'room-read':
        return await runRoomRead(env, out)
      case 'room-send':
      case 'room-doc-put': {
        if (command.text !== undefined) return await runCommand(command, env, cwd, out)
        // Nothing to wait up to 40 s for stdin over: main refuses a tokenless caller anyway (and stays the authority).
        // A tab's env always has the token, app running or not, so this is never the app-closed silent exit 0.
        if (!env.APP_TAB_TOKEN) {
          out.stderr('ccc: ccc room needs a Claude tab (run it inside a cockpit Claude tab)\n')
          return 1
        }
        const what = command.kind === 'room-send' ? 'room send' : 'room doc put'
        const read = await readRoomStdin(stdin, what, out)
        if ('code' in read) return read.code
        // A pipe ends its text with a newline the sender did not mean (`echo hi | ccc room send bob -`); a doc is kept exact.
        const text = command.kind === 'room-send' ? stripOneNewline(read.text) : read.text
        return await runCommand({ ...command, text }, env, cwd, out)
      }
      case 'web-password': {
        // In a tab main refuses `ccc web` before any handler (HOST_ONLY_TEXT): nothing is asked or
        // read there, and the refusal comes back for a request with no password in it.
        if (env.APP_TAB_TOKEN) return await runCommand(command, env, cwd, out)
        // Read before the request (and its deadline) starts: a person types at their own pace.
        const read = await readPassword(stdin, out.stderr, { maxChars: MAX_PASSWORD_LENGTH, stdinTimeoutMs: STDIN_READ_TIMEOUT_MS })
        if ('error' in read) {
          out.stderr(`ccc: web password: ${read.error}\n`)
          return 1
        }
        return await runCommand({ ...command, password: read.password }, env, cwd, out)
      }
      default:
        return await runCommand(command, env, cwd, out)
    }
  } catch (err) {
    // The invariant of this file: nothing makes a hook fail. Decided from argv, not the parsed
    // command, since parseArgs is inside this try.
    if (argv[0] === 'hook') return 0
    // Review finding: this used to be a silent 0 for every command too, so `ccc plugin logs` on an
    // unreadable file (or a failed `plugin new`) looked like success to a script.
    try {
      out.stderr(`ccc: ${errorText(err)}\n`)
    } catch {
      // stderr closed: the exit code still says it failed
    }
    return 1
  }
}
