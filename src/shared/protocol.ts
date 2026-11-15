// The CLI socket protocol (plan: Technical Details > Socket). Shared by main's socket server and
// the `ccc` CLI (Task 13), so it stays pure Node: no Electron, no fs.
//
// Newline-delimited JSON, one request or reply per line:
//   request  { "v": 1, "id": n, "token"?: string, "project"?: string, "cmd": string, "args": {...} }
//   reply    { "id": n, "ok": true, "result": ... }  |  { "id": n, "ok": false, "error": string }
//            either may carry "appVersion": the running app's version. An older app sends none. Only
//            the reply has it: the CLI does the comparing, and a hook's request line stays as it was.
// A reply to a line that could not be parsed (or has no usable id) carries `"id": null`.
// A client may half-close after its last request (`socket.end(line)`): main still answers every
// request on the connection, then ends it. A connection with no traffic and nothing in progress
// is closed after a while (socket-server.ts), so a client sends its request right after connecting.
// Hooks are fire-and-forget except `Stop`, which reads one reply and may ack it (`hook.ack`): see STOP_REPLY_ARG.

import { isPlainObject } from './guards'
import { isPointerText } from './room-pointer'

export const PROTOCOL_VERSION = 1

/**
 * Longest accepted line, in bytes, excluding the newline. A hook payload is at most ~1 MiB of
 * stdin (the CLI caps it); anything longer is a broken or hostile peer and the connection closes,
 * so main never buffers an unbounded line.
 */
export const MAX_LINE_BYTES = 1024 * 1024

/**
 * Commands a caller without a tab token may use, and only with `project` set. Everything else
 * (the `hook` stream, `session note`/`steps`) must prove which Claude session it comes from: a
 * session token (a Claude tab's) is the only thing that ties a request to one, and an outside
 * process has none. Fixed here rather than chosen per handler, so registering a handler can never
 * widen it.
 */
export const TOKENLESS_COMMANDS: readonly string[] = [
  'open',
  'notify',
  'overlay',
  'sessions',
  // `ccc --project <path> <plugin command> …` (plan B Task 5): the spec lookup and the call. Both
  // act on the named project's window only, like `overlay`. (`plugin.cli.list`, behind `ccc
  // help`, is tab-only: help outside a tab prints the core usage.)
  'plugin.cli.spec',
  'plugin.cli',
  // `ccc plugin link|unlink|list --project <path>` (plan B Task 6): link shows its confirm dialog
  // in that project's window, unlink acts on the global plugin list (handlers.ts), list reports
  // for that project. test/unit/cli-commands.test.ts runs every documented `--project` form and
  // checks each request it sends is in this list.
  'plugin.link',
  'plugin.unlink',
  'plugin.list',
  // `ccc plugin config --project <path> <id> …` (friction round 1, Task 6): reads and sets that
  // project's plugin settings (and the app-wide ones). Nothing beyond what writing app.json or the
  // project record already lets any local process do; secret fields are refused.
  'plugin.config',
  // `ccc panel show --project <path> <plugin>/<panel>` (friction round 1, Task 7): reveals a panel in
  // that project's open window, as the user could by clicking its icon.
  'panel.show',
  // `ccc plugin limits <id>` (design-rooms.md §6): reads a plugin's caps, app-wide (so in PROJECTLESS_COMMANDS too).
  // Allowed from a tab and from outside one: the person reads them before changing them. The write is host-only.
  'plugin.limits'
]

/**
 * Tokenless commands that need no project at all (Task 21): `notify` shows a system notification
 * and `sessions` lists the Claude tabs of every window, so neither acts inside one project and
 * `--project` would be a pointless demand. The rest of TOKENLESS_COMMANDS act on a window (or name
 * their folder) and still must name `--project`. A subset of TOKENLESS_COMMANDS, fixed here for the
 * same reason: registering a handler can never widen what an anonymous caller may do.
 */
export const PROJECTLESS_COMMANDS: readonly string[] = ['notify', 'sessions', 'plugin.limits']

/**
 * Commands a WINDOW token may use (a shell tab's, a command tab's, a terminal overlay's; main
 * decides the kind from its own tables, socket-server.ts). Such a token stands for "this window"
 * the way `--project <path>` does, and grants nothing `--project` does not already grant any
 * local process; it only spares naming the folder and keeps naming the right window after the
 * shell cd's elsewhere. So: the TOKENLESS_COMMANDS, plus `plugin.cli.list` (behind `ccc help`,
 * which lists the window's plugin commands wherever the window is known). Never `hook` or
 * `session.*`: a shell tab is not a Claude session, and a hook or a note from one must not create
 * or touch a status entry. Fixed here for the same reason as TOKENLESS_COMMANDS.
 */
export const WINDOW_TOKEN_COMMANDS: readonly string[] = [...TOKENLESS_COMMANDS, 'plugin.cli.list']

/**
 * Shell-only commands: `ccc web` (design-web.md §9.4), web access settings from a shell on the server, and the write
 * of `ccc plugin limits` (design-rooms.md §6, `plugin.limits.set`), the person's per-plugin caps. Answered only for
 * a TOKENLESS caller that names no project: a request that carries any token, a Claude tab's, a
 * shell tab's or a forged one, is refused in `identify` before a handler is looked up, with
 * HOST_ONLY_TEXT, and each handler (main/socket/web-handlers.ts) refuses every caller kind but the
 * tokenless one again. Projectless (no project is involved) and never in TOKENLESS_COMMANDS or
 * WINDOW_TOKEN_COMMANDS. All eight `web.*` names were listed before the first handler existed, so no
 * handler could ever be reached by a tab first; SocketServer.handle refuses a handler whose name is in a
 * HOST_ONLY_FAMILIES prefix but not here, and wraps every listed one so it refuses a non-anonymous caller again.
 *
 * Not a boundary: a tab's process is the same OS user and can drop its token (`env -u APP_TAB_TOKEN`) or edit
 * app.json itself (§9.12). It is there so a Claude session never reconfigures access, prints the access link into
 * its transcript or raises its own plugin's caps as a side effect of a prompt (an injection included), and so v1's
 * rule "a view does not widen its own access" stays visible: a shell tab is reached from a browser too.
 */
export const HOST_ONLY_COMMANDS: readonly string[] = [
  'web.status',
  'web.revoke',
  'web.stop',
  'web.link',
  'web.add-device',
  'web.password',
  'web.mode',
  'web.set',
  'plugin.limits.set'
]

/**
 * Name prefixes that belong to host-only commands: a handler registered under one of these whose name is not in
 * HOST_ONLY_COMMANDS is a start-up error (SocketServer.handle), since identify would let a session token reach it.
 * `plugin.limits` itself (the read) is no member: the family is the dot after it.
 */
export const HOST_ONLY_FAMILIES: readonly string[] = ['web.', 'plugin.limits.']

/** What a tab (any token) is told for a `ccc web` request, whatever the request and whether it has a handler. */
export const HOST_ONLY_TEXT = 'run `ccc web` from a shell on the server, outside cc-cockpit'

/** What a tab is told for the `ccc plugin limits` write. */
export const PLUGIN_LIMITS_HOST_ONLY_TEXT =
  'the limits are the person\'s: change them in Settings › Plugins or with `ccc plugin limits` from a shell outside cc-cockpit'

/** The refusal of a HOST_ONLY_COMMANDS request from any caller but a tokenless, projectless one. */
export function hostOnlyText(cmd: string): string {
  return cmd.startsWith('plugin.limits.') ? PLUGIN_LIMITS_HOST_ONLY_TEXT : HOST_ONLY_TEXT
}

/** A name a handler may be registered under only when HOST_ONLY_COMMANDS lists it. */
export function inHostOnlyFamily(cmd: string): boolean {
  return HOST_ONLY_FAMILIES.some((prefix) => cmd.startsWith(prefix))
}

/**
 * The Stop hook's reply (design-rooms.md §2 "The Stop pointer", plan Task 7). Every hook event is fire-and-forget:
 * `ccc hook <Event>` writes `{ cmd: 'hook', token, args: { event, payload } }` and closes without reading, so a hook
 * costs one write. Only `Stop` asks for a reply, with `args.reply: true` (STOP_REPLY_ARG): `ccc` then reads one reply
 * line within its budget (cli/client.ts STOP_HOOK_BUDGET_MS). A result `{ block, ackId }` (StopBlockReply) means main
 * answered the Stop with the room pointer: `ccc` then sends
 *   { v, id: 2, cmd: 'hook.ack', token, args: { ackId } }
 * on the same connection, reads main's answer, and only on `{ acked: true }` prints
 * `{"decision":"block","reason":<block>}` for Claude Code. The connection is never half-closed before that. Main undoes
 * a block whose connection closes before its ack (the Stop is applied as plain): the ack coming first is what proves
 * an unacked block was never printed. Any other result (null: a plain Stop), an error, garbage, a reason that is not
 * exactly the fixed pointer text, a refused ack or a slow reply prints nothing, and the hook still exits 0.
 *
 * Main blocks only a Stop that asked (`reply === true`): a `ccc` from before this change never prints the block, and a
 * Stop main took as blocked would leave that tab `working`. `hook.ack` is a session-token command like `hook` (a window
 * token, a `--project` caller and an anonymous one are refused), confirms only the block main just issued to that same
 * tab with that id (rooms/room-stop.ts `ack`), and is neither HOST_ONLY nor a `ccc` command a person types
 * (CORE_CLI_COMMANDS).
 */
export const STOP_REPLY_ARG = 'reply'
export const HOOK_ACK_COMMAND = 'hook.ack'

/** A Stop reply that blocks: the pointer text and the id the ack carries back. */
export interface StopBlockReply {
  block: string
  ackId: string
}

/** Most characters an ack id may have; main's are 32 hex characters (room-stop.ts). */
const MAX_ACK_ID_LENGTH = 64

/**
 * The block in a Stop reply's result, or undefined for anything else. Strict on purpose: what `ccc` prints goes into
 * Claude's context, so the reason must be exactly the fixed pointer text (nothing a socket owner could choose beyond a
 * count), and the ack id a short run of letters, digits, `-` or `_`.
 */
export function stopBlockOf(result: unknown): StopBlockReply | undefined {
  if (!isPlainObject(result)) return undefined
  const { block, ackId } = result
  if (!isPointerText(block)) return undefined
  if (typeof ackId !== 'string' || ackId.length === 0 || ackId.length > MAX_ACK_ID_LENGTH) return undefined
  for (const c of ackId) {
    const ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-' || c === '_'
    if (!ok) return undefined
  }
  return { block, ackId }
}

/**
 * `ccc room read` (design-rooms.md §2 "Pull, not push"), a two-step read so no message is lost to a reply that never
 * reached Claude (a `ccc` killed by Esc or its 40 s deadline, a socket closed before main wrote, a framer refusing the
 * line). `room.read` (session token, no args) answers RoomReadReply and takes nothing off the queue: the oldest
 * messages that fit ROOM_READ_MAX_TEXT_BYTES, fenced, with `more` still waiting after them and, when `more` > 0, the
 * room pointer for `more` as the text's last line (outside every fence). `ccc` prints `text` and only then sends
 *   { v, id: 2, cmd: 'room.read.ack', token, args: { ack } }
 * on the same connection, with the reply's `ack`, and reads main's `{ acked: n }`. Main then drops the queue's head up
 * to and including that batch; an ack main does not know (already acked, the member left, a later batch) drops
 * nothing. A read with no ack is delivered again by the next read: at least once, never lost; a `ccc` killed between
 * its print and its ack repeats that batch once. `count` 0 means nothing waits (`text` empty, no `ack`).
 */
export const ROOM_READ_ACK_COMMAND = 'room.read.ack'

/** `room.read`'s result. */
export interface RoomReadReply {
  /** Messages in this batch. */
  count: number
  /** Messages still waiting after it (the next read's). */
  more: number
  /** The fenced batch (and the pointer line when `more` > 0); empty for none. */
  text: string
  /** What `room.read.ack` carries back once `text` is printed; absent for an empty read. */
  ack?: string
}

/**
 * Most bytes the JSON encoding of a read's `text` may take when a second message is added (JSON escapes counted, not
 * characters, so the printed text is never longer than this in characters). Near 25k because Claude Code's Bash tool
 * shows about 30k characters of output inline and saves more to a file with a short preview (older versions cut the
 * middle): a batch past that is "delivered" and acked but not seen. A batch always holds at least one message, so
 * one alone may pass it: 20k characters (room-registry.ts MAX_ROOM_MESSAGE_CHARS) print as up to about 60k when they
 * are mostly line breaks (`| ` and a line break each), and encode to at most 9 bytes a character once fenced (a
 * visibly escaped character: `\u{202e}` encodes as 9), so at most 180 KB: far below MAX_LINE_BYTES, which is the hard
 * line. The `more` pointer after the batch makes the next read fetch the rest.
 */
export const ROOM_READ_MAX_TEXT_BYTES = 25 * 1000

/** Keys that reach an object's prototype when copied with Object.assign or a for...in loop. */
const RESERVED_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface Request {
  v: number
  id: number
  /**
   * The tab token from `$APP_TAB_TOKEN` (32 random bytes, hex): a Claude tab's session token or a
   * shell/command tab's (or terminal overlay's) window token. The request never says which; main
   * looks it up.
   */
  token?: string
  /** Absolute folder path naming the project, for callers outside a tab (`--project <path>`). */
  project?: string
  cmd: string
  args: Record<string, unknown>
}

export type Reply =
  | { id: number | null; ok: true; result: unknown; appVersion?: string }
  | { id: number | null; ok: false; error: string; appVersion?: string }

/** One complete request line (with the trailing newline). */
export function encodeRequest(request: Request): string {
  return `${JSON.stringify(request)}\n`
}

export function encodeReply(reply: Reply): string {
  return `${JSON.stringify(reply)}\n`
}

/**
 * Parse one line into a request. Throws with a message fit for an error reply; `id` on the error
 * is the request id when the line got far enough to have one, so the caller can still match the
 * reply to its request.
 */
export function parseRequest(line: string): Request {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new ProtocolError('bad json', null)
  }
  if (!isPlainObject(value)) throw new ProtocolError('request must be an object', null)
  const id = Number.isSafeInteger(value.id) ? (value.id as number) : null
  if (id === null) throw new ProtocolError('request id must be an integer', null)
  if (value.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(`unsupported protocol version (want ${PROTOCOL_VERSION})`, id)
  }
  if (typeof value.cmd !== 'string' || value.cmd === '') {
    throw new ProtocolError('cmd must be a non-empty string', id)
  }
  if (value.token !== undefined && typeof value.token !== 'string') {
    throw new ProtocolError('token must be a string', id)
  }
  if (value.project !== undefined && typeof value.project !== 'string') {
    throw new ProtocolError('project must be a string', id)
  }
  if (value.args !== undefined && !isPlainObject(value.args)) {
    throw new ProtocolError('args must be an object', id)
  }
  // JSON.parse makes `"__proto__"` an own key, which Object.assign or a for...in copy into a live
  // object would turn into a prototype swap. No command names an argument like these, so refuse
  // them here, at the one boundary every handler sits behind. Nested values are not checked: the
  // Handler contract (socket-server.ts) is that args is never merged into a live object.
  const args = (value.args ?? {}) as Record<string, unknown>
  const badKey = Object.keys(args).find((k) => RESERVED_ARG_KEYS.has(k))
  if (badKey !== undefined) throw new ProtocolError(`args may not have a "${badKey}" key`, id)
  const request: Request = { v: value.v, id, cmd: value.cmd, args }
  if (value.token !== undefined) request.token = value.token
  if (value.project !== undefined) request.project = value.project
  return request
}

/** Parse one reply line (the CLI side). Throws on anything that is not a well-formed reply. */
export function parseReply(line: string): Reply {
  const value: unknown = JSON.parse(line)
  if (!isPlainObject(value)) throw new Error('reply must be an object')
  const id = value.id === null || Number.isSafeInteger(value.id) ? (value.id as number | null) : undefined
  if (id === undefined) throw new Error('reply id must be an integer or null')
  // Any string gets through here, unvalidated: only the CLI prints it, and it checks first (client.ts).
  const version = typeof value.appVersion === 'string' ? { appVersion: value.appVersion } : {}
  if (value.ok === true) return { id, ok: true, result: value.result, ...version }
  if (value.ok === false && typeof value.error === 'string') return { id, ok: false, error: value.error, ...version }
  throw new Error('malformed reply')
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly id: number | null
  ) {
    super(message)
  }
}

/**
 * Splits a byte stream into lines. Works on Buffers, not strings: a chunk boundary can fall inside
 * a multi-byte UTF-8 character, and the cap is in bytes. The cap applies to the unterminated tail
 * too, so a peer that never sends a newline cannot make the buffer grow past MAX_LINE_BYTES.
 */
export class LineFramer {
  private chunks: Buffer[] = []
  private pending = 0

  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  /**
   * Feed a chunk; returns the complete lines it finished (without the newline, `\r` kept).
   * Throws LineTooLongError once a line exceeds the cap; the framer is unusable afterwards and the
   * connection must be closed (nothing after an oversized line can be framed reliably).
   */
  push(chunk: Buffer): string[] {
    const lines: string[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl === -1) break
      const part = chunk.subarray(start, nl)
      if (this.pending + part.length > this.maxBytes) throw new LineTooLongError(this.maxBytes)
      const line = this.pending === 0 ? part : Buffer.concat([...this.chunks, part])
      lines.push(line.toString('utf8'))
      this.chunks = []
      this.pending = 0
      start = nl + 1
    }
    const rest = chunk.subarray(start)
    if (rest.length > 0) {
      if (this.pending + rest.length > this.maxBytes) throw new LineTooLongError(this.maxBytes)
      // Copy: the caller's Buffer may be pooled and reused by the stream.
      this.chunks.push(Buffer.from(rest))
      this.pending += rest.length
    }
    return lines
  }
}

export class LineTooLongError extends Error {
  constructor(maxBytes: number) {
    super(`line longer than ${maxBytes} bytes`)
  }
}
