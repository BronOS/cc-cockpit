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
// pointer as the reply `{ block, ackId }` (`ccc hook Stop` prints it as `decision: block` and acks
// with `hook.ack`, hookAckHandler below; protocol.ts STOP_REPLY_ARG), and the Stop is applied as
// blocked, so the tab stays working and the gate delivers nothing. Only a Stop whose request says
// `reply: true` is offered: a `ccc` from before the reply protocol closes without reading, and a
// Stop taken as blocked there would leave the tab working with Claude stopped. Every other event,
// and a Stop with no block, answers null as before.
import { isHookEvent } from '../../shared/hooks'
import { STOP_REPLY_ARG } from '../../shared/protocol'
import type { StopBlock } from '../rooms/room-stop'
import type { Handler } from '../socket/socket-server'
import { errorText } from '../../shared/error-text'
import { warnLog } from '../warn-log'
import type { SessionRegistry } from './session-registry'

export function hookHandler(
  registry: Pick<SessionRegistry, 'applyHook'>,
  rooms?: { stop(tabId: string, payload: unknown): StopBlock | undefined }
): Handler {
  return (args, caller) => {
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
    const block = event === 'Stop' && args[STOP_REPLY_ARG] === true ? roomStop(rooms, caller.tabId, args.payload) : undefined
    registry.applyHook(caller.tabId, event, args.payload, block?.ackId)
    return block === undefined ? null : { block: block.block, ackId: block.ackId }
  }
}

/**
 * The room stop's decision, never a throw: a bad room state must not cost the plain Stop (the
 * registry would never see it and the tab would stay `working` for good). A throw is a plain Stop,
 * which is what a member with no room gets anyway.
 */
function roomStop(
  rooms: { stop(tabId: string, payload: unknown): StopBlock | undefined } | undefined,
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
 * `hook.ack` (protocol.ts HOOK_ACK_COMMAND): `ccc hook Stop` printed the block main answered with and
 * says so. A Claude tab's session token only, like `hook`; the tab is the token's, never anything in
 * `args`, and the room stop confirms only the block it is waiting on for that tab with that id
 * (room-stop.ts `ack`), so a forged or replayed id changes nothing. Synchronous for the same reason
 * as `hook`: the ack follows its Stop on one connection and must not overtake a later hook.
 * Answers `{ acked }`; `ccc` does not read it.
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
