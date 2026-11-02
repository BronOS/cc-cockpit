// The `hook` socket command: `ccc hook <Event>` forwards a Claude hook here (cli/client.ts sends
// `{cmd:'hook', token, args:{event, payload, truncated?}}`). The server already turned the token
// into a tab; this only validates the shape and hands the event to the registry.
//
// SYNCHRONOUS ON PURPOSE, no `async`, no `await`: the registry applies the event before this
// returns, and the socket server calls handlers in arrival order. Hook events carry no
// timestamp or sequence number and are in Claude's order only because every hook is synchronous
// (hooks-file.ts), so an `await` here would let the per-connection async serve() reorder two
// hooks. Do not add one.
import { isHookEvent } from '../../shared/hooks'
import type { Handler } from '../socket/socket-server'
import type { SessionRegistry } from './session-registry'

export function hookHandler(registry: Pick<SessionRegistry, 'applyHook'>): Handler {
  return (args, caller) => {
    // A hook always runs inside a Claude tab. A --project caller has no business here, and
    // neither has a window token (a shell tab running `ccc hook` by hand, or a `claude` started in
    // one whose user hooks call it): applying it would create a status entry for a tab that is
    // not a Claude session. The server refuses that token for `hook` already; this is the second
    // line. The CLI does not read the reply, so the hook still exits 0.
    if (caller.kind !== 'session') throw new Error('hook needs a Claude session token')
    const event = args.event
    if (typeof event !== 'string' || !isHookEvent(event)) throw new Error('unknown hook event')
    // `payload` is null when the CLI could not parse stdin (oversized or not JSON; `truncated`
    // says which, and changes nothing here): the event still counts, with no payload to read.
    // The reducer treats any non-object payload that way, so it is passed through as is.
    registry.applyHook(caller.tabId, event, args.payload)
    return null
  }
}
