// The view a plugin is acting for (design-web.md §5.3 "Where an action came from"), carried
// implicitly so that `ctx.sessions.focus` from a phone's click selects on the phone with no plugin
// change. Ported from spike 2 (branch `spike/web-plugin-panel`), with the bound the spike lacked.
//
// The host runs each page-message listener (a panel's `ctx.panels.onMessage`, a slot's
// `onMessage`) inside `dispatchInView(view, …)`, and host/index.ts wraps its RPC call in
// `carryView`, which adds `currentView()` to every request the plugin makes (rpc.ts `view`;
// `currentView` is exported for the unit tests). AsyncLocalStorage follows the listener's awaits,
// so `await ctx.sessions.focus(id)` after an `await` still knows its view.
//
// The bound. AsyncLocalStorage also follows everything the listener STARTS: in the spike a
// `setInterval` a panel's first `hello` started made every later call of the plugin look like the
// phone's, for good. So the store is one object per dispatch that dies:
// - when the listener's own work ends: at once for a listener that returns a plain value, when its
//   promise settles for an async one (the awaited chain is the listener's work, nothing else);
// - at the latest DISPATCH_VIEW_MS after the dispatch, for a listener that never settles.
// A timer, a cached promise or an event subscription created inside keeps the same store object,
// sees it dead, and gets no view. What is left: a timer that fires while its listener is still
// awaiting gets the view, which is the click's own work in all but name.
//
// Main treats the view only as a hint for WHERE an action shows, never as identity: it checks the
// view belongs to the asking host's own window and ignores it otherwise (plugins/host-api.ts
// originOf). A wrong view costs a focus on the wrong screen, nothing more.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ViewId } from '../../shared/views'

/** The longest a dispatch carries its view, whatever the listener still awaits. */
export const DISPATCH_VIEW_MS = 10_000

interface Origin {
  /** undefined: the desktop window's own page. */
  readonly view: ViewId | undefined
  readonly until: number
  ended: boolean
}

const storage = new AsyncLocalStorage<Origin>()

/**
 * Run a page-message listener for `view` (undefined: the desktop window's page). Returns what
 * `fn` returned; a throw ends the dispatch and propagates (the caller logs it). An async listener's
 * rejection goes to `onReject` (the caller logs it in the plugin's log, as it does a throw); without
 * one it is rethrown on a derived promise, as unhandled as the listener's own would have been.
 */
export function dispatchInView<T>(view: ViewId | undefined, fn: () => T, onReject?: (err: unknown) => void): T {
  const origin: Origin = { view, until: Date.now() + DISPATCH_VIEW_MS, ended: false }
  const end = (): void => {
    origin.ended = true
  }
  let out: T
  try {
    out = storage.run(origin, fn)
  } catch (err) {
    end()
    throw err
  }
  if (!isThenable(out)) {
    end()
    return out
  }
  try {
    out.then(end, (err: unknown) => {
      end()
      if (onReject) onReject(err)
      else throw err
    })
  } catch {
    // A plugin's odd thenable whose `then` throws: no end to wait for.
    end()
  }
  return out
}

/**
 * The remote view of the page message being handled now, if any: undefined for the desktop
 * window's page, outside any dispatch, and once the dispatch ended (see the top).
 */
export function currentView(): ViewId | undefined {
  const origin = storage.getStore()
  if (!origin || origin.ended || Date.now() > origin.until) return undefined
  return origin.view
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * `call` (the host's RPC call to main) with the current view added to each request's options, so
 * every ctx method a listener calls names the view it acts for. No view: the options untouched,
 * so a request looks exactly as before web access.
 */
export function carryView<O extends { view?: ViewId }, R>(
  call: (method: string, params: unknown, options?: O) => R
): (method: string, params: unknown, options?: O) => R {
  return (method, params, options) => {
    const view = currentView()
    return call(method, params, view === undefined ? options : ({ ...options, view } as O))
  }
}
