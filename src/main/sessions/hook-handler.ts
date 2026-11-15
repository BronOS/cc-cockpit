// The `hook` socket command: `ccc hook <Event>` forwards a Claude hook here (cli/client.ts sends
// `{cmd:'hook', token, args:{event, payload, truncated?}}`). The server already turned the token
// into a tab; this only validates the shape and hands the event to the registry.
//
// SYNCHRONOUS ON PURPOSE, no `async`, no `await`: the registry applies the event before this
// returns, and the socket server calls handlers in arrival order. Hook events carry no
// timestamp or sequence number and are in Claude's order only because every hook is synchronous
// (hooks-file.ts), so an `await` here would let the per-connection async serve() reorder two
// hooks. Do not add one.
//
// A Stop is first offered to the room stop (rooms/room-stop.ts, design-rooms.md §2 "The Stop
// pointer"), also synchronously: a member with room messages that may be continued gets the fixed
// pointer as the reply `{ block, ackId }` (`ccc hook Stop` acks it with `hook.ack`, hookAckHandler
// below, and prints it as `decision: block` once main confirmed; protocol.ts STOP_REPLY_ARG), and the
// Stop is applied as blocked, so the tab stays working and the gate delivers nothing. The connection
// closing before the ack undoes the block (undoBlockOnClose). Only a Stop whose request says
// `reply: true` is offered: a `ccc` from before the reply protocol closes without reading, and a
// Stop taken as blocked there would leave the tab working with Claude stopped. Every other event,
// and a Stop with no block, answers null as before.
import { isPlainObject } from '../../shared/guards'
import { isHookEvent, type HookEvent } from '../../shared/hooks'
import { STOP_REPLY_ARG } from '../../shared/protocol'
import type { StopBlock } from '../rooms/room-stop'
import type { Handler } from '../socket/socket-server'
import { errorText } from '../../shared/error-text'
import { warnLog } from '../warn-log'
import type { SessionRegistry } from './session-registry'

/** The tab manager as a hook reaches it (TabManager): a session id to resume, a prompt that makes it resumable. */
export interface HookTabs {
  sessionStarted(tabId: string, sessionId: string, source?: string): void
  sessionPrompted(tabId: string): void
}

/**
 * What hookHandler applies a hook to in main (index.ts): the session registry, then the tab manager for what restart
 * and restore resume (a SessionStart's session id once the reducer took it, a prompt making it resumable). A function
 * rather than a closure in index.ts so a test sees that `blocked` (the ack id of the room pointer a Stop was answered
 * with, rooms/room-stop.ts) reaches the registry: dropped, a blocked Stop would be applied as plain (`waiting`, the
 * gate's head delivered) while Claude goes on working.
 */
export function hookTarget(
  sessions: Pick<SessionRegistry, 'applyHook' | 'unblockStop' | 'get'>,
  tabs: HookTabs
): Pick<SessionRegistry, 'applyHook' | 'unblockStop'> {
  return {
    applyHook: (tabId: string, event: HookEvent, payload: unknown, blocked?: string): boolean => {
      if (!sessions.applyHook(tabId, event, payload, blocked)) return false
      const sessionId = sessions.get(tabId)?.sessionId
      if (event === 'SessionStart' && sessionId !== undefined) {
        // `source` tells an interactive `/resume` (a stored conversation, stays resumable) from
        // `/clear` (an empty one); a non-string counts as neither.
        const source = isPlainObject(payload) ? payload.source : undefined
        tabs.sessionStarted(tabId, sessionId, typeof source === 'string' ? source : undefined)
      }
      if (event === 'UserPromptSubmit') tabs.sessionPrompted(tabId)
      return true
    },
    // A blocked Stop whose `ccc` closed without acking (it never printed): applied as the plain Stop it was.
    unblockStop: (tabId, ackId, payload) => sessions.unblockStop(tabId, ackId, payload)
  }
}

/** What the hook handler needs of the room stop (rooms/room-stop.ts RoomStop). */
export interface HookRoomStop {
  stop(tabId: string, payload: unknown): StopBlock | undefined
  closedUnacked(tabId: string, ackId: string): boolean
  /**
   * The plain Stop of an unacked block was applied (the tab is waiting now): what waits for the member is offered
   * through the gate, since no Stop is coming to carry the pointer.
   */
  unblocked?(tabId: string): void
}

export function hookHandler(registry: Pick<SessionRegistry, 'applyHook' | 'unblockStop'>, rooms?: HookRoomStop): Handler {
  return (args, caller, peerGone) => {
    // A hook always runs inside a Claude tab. A --project caller has no business here, and
    // neither has a window token (a shell tab running `ccc hook` by hand, or a `claude` started in
    // one whose user hooks call it): applying it would create a status entry for a tab that is
    // not a Claude session. The server refuses that token for `hook` already; this is the second
    // line. A refused hook still exits 0 (the CLI never fails a hook).
    if (caller.kind !== 'session') throw new Error('hook needs a Claude session token')
    const event = args.event
    if (typeof event !== 'string' || !isHookEvent(event)) throw new Error('unknown hook event')
    // `payload` is null when the CLI could not parse stdin (oversized or not JSON; `truncated`
    // says which, and changes nothing here): the event still counts, with no payload to read.
    // The reducer treats any non-object payload that way, so it is passed through as is.
    //
    // A block needs the connection it is answered on (`peerGone`): `ccc` prints only after main confirmed its ack, so
    // the connection closing first proves the block was never printed, and the Stop is then applied as plain
    // (undoBlockOnClose). With no signal, or a peer already gone (it gave up before main read the line), there is
    // nobody to print it: a plain Stop.
    const offer = event === 'Stop' && args[STOP_REPLY_ARG] === true && peerGone !== undefined && !peerGone.aborted
    const block = offer ? roomStop(rooms, caller.tabId, args.payload) : undefined
    registry.applyHook(caller.tabId, event, args.payload, block?.ackId)
    if (block === undefined) return null
    if (rooms && peerGone) undoBlockOnClose(registry, rooms, peerGone, caller.tabId, block.ackId, args.payload)
    return { block: block.block, ackId: block.ackId }
  }
}

/**
 * When the Stop's connection closes (or half-closes: `ccc` never does, so either means it is gone) with the block
 * unacked, the room stop drops it and the Stop is applied as the plain Stop it was for Claude (room-stop.ts, the
 * header's step 3). An acked block, or a tab whose turn moved on since (SessionEntry.blockedStop), is left alone.
 */
function undoBlockOnClose(
  registry: Pick<SessionRegistry, 'unblockStop'>,
  rooms: HookRoomStop,
  peerGone: AbortSignal,
  tabId: string,
  ackId: string,
  payload: unknown
): void {
  peerGone.addEventListener(
    'abort',
    () => {
      try {
        if (!rooms.closedUnacked(tabId, ackId)) return
        if (registry.unblockStop(tabId, ackId, payload)) rooms.unblocked?.(tabId)
      } catch (err) {
        warnLog(`hook: undoing the unacked Stop pointer of tab ${tabId} failed: ${errorText(err)}`)
      }
    },
    { once: true }
  )
}

/**
 * The room stop's decision, never a throw: a bad room state must not cost the plain Stop (the
 * registry would never see it and the tab would stay `working` for good). A throw is a plain Stop,
 * which is what a member with no room gets anyway.
 */
function roomStop(
  rooms: HookRoomStop | undefined,
  tabId: string,
  payload: unknown
): StopBlock | undefined {
  if (!rooms) return undefined
  try {
    return rooms.stop(tabId, payload)
  } catch (err) {
    warnLog(`hook: the room stop threw for tab ${tabId}, applied as a plain Stop: ${errorText(err)}`)
    return undefined
  }
}

/**
 * `hook.ack` (protocol.ts HOOK_ACK_COMMAND): `ccc hook Stop` got the block main answered with and will
 * print it once this answers `{ acked: true }` (and only then). A Claude tab's session token only, like `hook`; the tab is the token's, never anything in
 * `args`, and the room stop confirms only the block it is waiting on for that tab with that id
 * (room-stop.ts `ack`), so a forged or replayed id changes nothing. Synchronous for the same reason
 * as `hook`: the ack follows its Stop on one connection and must not overtake a later hook.
 * Answers `{ acked }`, which `ccc` reads: on false (the block was dropped, or no room stop) it prints nothing.
 */
export function hookAckHandler(rooms?: { ack(tabId: string, ackId: unknown): boolean }): Handler {
  return (args, caller) => {
    if (caller.kind !== 'session') throw new Error('hook.ack needs a Claude session token')
    if (!rooms) return { acked: false }
    try {
      return { acked: rooms.ack(caller.tabId, args.ackId) }
    } catch (err) {
      warnLog(`hook: the room stop threw on an ack for tab ${caller.tabId}: ${errorText(err)}`)
      return { acked: false }
    }
  }
}
