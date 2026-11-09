// The `statusline` socket command: `ccc statusline` (cli/statusline.ts) forwards the few usage
// fields of Claude Code's status line JSON here (`{cmd:'statusline', token, args:{rate_limits?,
// cost?, context_window?}}`, Claude's own field names). The server already turned the token into a
// tab: a Claude tab's session token only (a window token is refused before any handler, as for
// `hook`), so the tab is the one main resolved, never one the payload names. Everything in `args`
// is checked again (shared/rate-limits.ts parseStatusLineReport) before it is kept.
//
// Synchronous, like the hook handler: nothing here waits, and the CLI does not read the reply.
import { parseStatusLineReport } from '../../shared/rate-limits'
import type { Handler } from '../socket/socket-server'
import type { RateLimitsStore } from './rate-limits-store'
import type { SessionRegistry } from './session-registry'

export interface StatusLineHandlerDeps {
  registry: Pick<SessionRegistry, 'setUsage'>
  rateLimits: Pick<RateLimitsStore, 'report'>
  /**
   * The app setting "Rate limits from the status line" (`app.json` › `statusLineUsage`). Off, a
   * report is dropped: tabs started before it was turned off still run `ccc statusline` until they
   * restart (their `--settings` file was read at start), and the setting must mean what it says.
   */
  enabled(): boolean
}

export function statusLineHandler(deps: StatusLineHandlerDeps): Handler {
  return (args, caller) => {
    // The second line behind the server's refusal of a window token (socket-server.ts identify).
    if (caller.kind !== 'session') throw new Error('statusline needs a Claude session token')
    if (!deps.enabled()) return null
    const report = parseStatusLineReport(args)
    if (report.rateLimits) deps.rateLimits.report(report.rateLimits)
    if (report.costUsd !== undefined || report.contextPercent !== undefined) {
      deps.registry.setUsage(caller.tabId, {
        ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
        ...(report.contextPercent !== undefined ? { contextPercent: report.contextPercent } : {})
      })
    }
    return null
  }
}
