// The start order after `ready` (design-web.md §9.1 "Start order"), as a function over its effects so
// unit tests run both modes in plain Node. index.ts passes the CLI socket, the web access service and
// the rest of the start (the session lock-down, the schemes, the windows and their restored tabs).
//
// On the desktop the order is today's: the socket is awaited (milliseconds; false only logs, the app
// runs without one), the gateway is not (a port in use only logs and no window waits for it), and the
// windows open.
//
// In server mode web access is the only way in, and `ccc web` (the CLI socket) the only way to fix its
// settings, so both are awaited before any window opens or tab restores. Either failing exits 1:
// systemd shows the failure and retries (`Restart=on-failure`) without Claude tabs resuming and being
// killed on every try. A stored setting the gateway refuses (an unconfirmed §4.3 risk, §9.2) is not a
// failure: the app runs on so `ccc web set` can apply it, and the first lines say how.
import { errorText } from '../shared/error-text'
import type { GatewayStatus } from './web/gateway'

export interface StartOrderDeps {
  /** Main's `server` flag for the run (server-mode.ts). */
  server: boolean
  /** The CLI socket; false when it cannot listen (SocketServer logs why). */
  startSocket(): Promise<boolean>
  /** Applies the stored web access settings to the gateway (WebAccessService.apply). */
  applyWebAccess(): Promise<GatewayStatus>
  /** Server mode's first lines (WebAccessService.serverStartLines); prints nothing on the desktop. */
  printLines(): void
  /** Everything after the order: windows, restored tabs, the update check. */
  open(): void | Promise<void>
  /** Logs a line on stderr. */
  log(line: string): void
  /** Ends the run with status 1 (index.ts: a quit that saves, then exit 1). */
  fail(): void
}

/** Why a server start stopped, on stderr before the exit. */
export const SERVER_SOCKET_FAILED = 'server mode: the CLI socket cannot start, so `ccc web` could not reach this run; exiting'
export function serverGatewayFailed(reason: string): string {
  return `server mode: web access cannot listen (${reason}), and it is the only way in; exiting`
}

/**
 * Runs the start order. Resolves 'failed' when server mode ended the run (`fail` was called and
 * `open` was not), else 'started'.
 */
export async function runStartOrder(deps: StartOrderDeps): Promise<'started' | 'failed'> {
  const socketUp = await deps.startSocket()
  if (!deps.server) {
    // Not awaited: a port in use only logs, and no window waits for the gateway.
    void deps
      .applyWebAccess()
      .then(() => deps.printLines())
      .catch((err: unknown) => deps.log(`web access not applied: ${errorText(err)}`))
    await deps.open()
    return 'started'
  }
  if (!socketUp) {
    deps.log(SERVER_SOCKET_FAILED)
    deps.fail()
    return 'failed'
  }
  let status: GatewayStatus
  try {
    status = await deps.applyWebAccess()
  } catch (err) {
    status = { state: 'failed', reason: errorText(err) }
  }
  // The lines first, failed or not: they carry the reason and, for a refused setting, the
  // `ccc web set` line. A throw there (an odd stored origin) must not end a run that listens.
  try {
    deps.printLines()
  } catch (err) {
    deps.log(`server start lines not printed: ${errorText(err)}`)
  }
  // `off` cannot follow serverStart's write unless that write was lost; nothing would listen then
  // either, so it ends the run as a failure does. `refused` runs on (see the header).
  if (status.state === 'failed' || status.state === 'off') {
    deps.log(serverGatewayFailed(status.state === 'off' ? 'web access is off' : status.reason))
    deps.fail()
    return 'failed'
  }
  await deps.open()
  return 'started'
}
