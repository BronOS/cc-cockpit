// ctx.files (friction round 1, Task 12): a plugin takes over the click on a changed file in core's
// Sessions panel. Main decides which plugin gets the click (the project's pick, src/shared/services.ts
// selectOpenFile), checks the tab and the path, and sends this host `files.open { pluginId, path,
// tabId? }`; the answer is the ack. `tabId` is absent when the open came from a plugin's
// `ctx.files.open` without a tab of this project (the file tree), not from a tab's list. `false` (nobody listening, every listener failed) and no answer
// within main's bound both make main open its built-in viewer, so the user always sees something.
//
// The ack must come quickly but a listener may legitimately run long (it opens an overlay and awaits
// the user's answer), so a listener's promise is waited for only OPEN_LISTENER_WAIT_MS: a throw or a
// rejection before then is a failure, a promise still pending then counts as handled. The wait stays
// well inside main's 2 s (OPEN_FILE_ACK_MS in host-manager.ts), so a host that is merely busy for a
// moment is not mistaken for one that failed.
//
// `ctx.files.open(path, { tabId? })` is the other direction: a request to main (`files.open`, the same
// method name the other way; src/main/plugins/host-api.ts), which routes the file exactly like a click
// and answers `{ via }`. Main checks the path and the tab; here only the shapes, so the mistake
// surfaces as a rejection at the call site. Any plugin may call it, declared or not.
//
// `reveal`, `openWithSystem` and `trash` hand a project file to the operating system the same way
// (requests to main: host-api.ts, main/files/system-files.ts). The host has no display or desktop
// session in its env (host-manager.ts hostEnv), so `open` / `xdg-open` / `gio trash` from ctx.exec
// fail on Linux, and the env stays narrow: main is where files leave for the system, with its path
// checks, its refusal of runnable files and the person's confirmation for the Trash.
import type { Disposer, OpenFileRequest, PluginContext } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { viewIdOf, type ViewId } from '../../shared/views'
import { dispatchInView } from './origin-view'

/** How long a listener's promise may take to reject and still count as a failure. */
export const OPEN_LISTENER_WAIT_MS = 1_000

type Listener = (req: OpenFileRequest) => unknown

export interface FilesApiDeps {
  pluginId: string
  /** The manifest declares `contributes.openFile` (HostPluginSpec.openFile). */
  declared: boolean
  /** Throws when the plugin is deactivated. */
  alive(): void
  /** A request to main. */
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  /** Runs `body` unless the plugin is deactivated; any throw becomes a rejection. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  /** This plugin's listeners (owned by the runtime, so dispose drops them with it). */
  listeners: Set<Listener>
}

export function createFilesApi(deps: FilesApiDeps): PluginContext['files'] {
  return Object.freeze({
    onOpen: (listener: Listener): Disposer => {
      deps.alive()
      if (typeof listener !== 'function') throw new TypeError('files.onOpen needs a function')
      // The manifest is the contract (as for commands and cli): main offers only declared plugins
      // in Settings, so a listener without the declaration would never be called. Say so here.
      if (!deps.declared) throw new Error('files.onOpen needs "contributes": { "openFile": { "title": … } } in plugin.json')
      // A wrapper per registration: the same function added twice is two listeners, and each
      // disposer removes only its own.
      const entry: Listener = (req) => listener(req)
      deps.listeners.add(entry)
      return () => {
        deps.listeners.delete(entry)
      }
    },
    open: (path: string, options?: { tabId?: string }): Promise<{ via: 'plugin' | 'builtin' }> =>
      deps.guardAsync(async () => {
        if (typeof path !== 'string' || path === '') throw new TypeError('files.open needs a path relative to the project folder')
        if (options !== undefined && (options === null || typeof options !== 'object')) {
          throw new TypeError('files.open: options must be an object')
        }
        const tabId: unknown = options?.tabId
        if (tabId !== undefined && typeof tabId !== 'string') throw new TypeError('files.open: tabId must be a string')
        const answer = (await deps.call('files.open', {
          pluginId: deps.pluginId,
          path,
          ...(tabId !== undefined ? { tabId } : {})
        })) as { via?: unknown } | null
        const via = answer?.via
        if (via !== 'plugin' && via !== 'builtin') throw new Error('files.open: unexpected answer from the app')
        return { via }
      }),
    reveal: (path: string): Promise<void> =>
      deps.guardAsync(async () => {
        checkSystemPath('files.reveal', path, true)
        await deps.call('files.reveal', { pluginId: deps.pluginId, path })
      }),
    openWithSystem: (path: string): Promise<void> =>
      deps.guardAsync(async () => {
        checkSystemPath('files.openWithSystem', path, false)
        await deps.call('files.openWithSystem', { pluginId: deps.pluginId, path })
      }),
    trash: (path: string): Promise<void> =>
      deps.guardAsync(async () => {
        checkSystemPath('files.trash', path, false)
        // No timeout: the person answers the dialog when they do (sessions.close waits the same way);
        // main closes it when this host goes, which ends the call.
        const answer = (await deps.call('files.trash', { pluginId: deps.pluginId, path }, { timeoutMs: Infinity })) as {
          trashed?: unknown
        } | null
        if (answer?.trashed === true) return
        if (answer?.trashed === false) throw cancelledError()
        throw new Error('files.trash: unexpected answer from the app')
      })
  })
}

/**
 * The person's no to a ctx.files.trash dialog: a rejection (the promise is void, and a caller must
 * not refresh as if the file went) that is told apart from a failure by `name`, the DOM's convention
 * for a cancelled operation, so a menu can stay quiet about it.
 */
function cancelledError(): Error {
  const err = new Error('files.trash: cancelled; nothing was moved')
  err.name = 'AbortError'
  return err
}

/**
 * The shape of a reveal / openWithSystem / trash path, at the call site: main checks it all again
 * (relative, no `..`, inside the project by its real path). '' is the project folder, for reveal only.
 */
function checkSystemPath(method: string, path: unknown, allowRoot: boolean): void {
  if (typeof path !== 'string') throw new TypeError(`${method} needs a path relative to the project folder`)
  if (path === '' && !allowRoot) throw new TypeError(`${method} needs a path relative to the project folder, not the folder itself`)
}

/**
 * Main's `files.open` params, checked (main built them; the shapes are verified anyway). `tabId` is
 * optional: absent for a ctx.files.open that named no tab of this project.
 */
export function parseOpenFile(params: unknown): { pluginId: string; path: string; tabId?: string; view?: ViewId } {
  const { pluginId, path, tabId, view: rawView } = (params ?? {}) as Record<string, unknown>
  if (typeof pluginId !== 'string' || typeof path !== 'string' || (tabId !== undefined && typeof tabId !== 'string')) {
    throw new Error('files.open: pluginId and path must be strings, tabId a string when present')
  }
  // `view`: the remote view the open started in. One main did not mint is refused, never read as
  // the desktop's (as slots.ts does); main then opens its built-in viewer.
  const view = viewIdOf(rawView)
  if (rawView !== undefined && view === undefined) throw new Error('files.open: view is not a view id')
  return { pluginId, path, ...(tabId !== undefined ? { tabId } : {}), ...(view !== undefined ? { view } : {}) }
}

/**
 * Call every listener with its own frozen request; true when at least one returned, resolved, or is
 * still pending after `waitMs`. A throw or rejection is logged against the plugin. False with no
 * listener at all. Each runs in `req.view` (origin-view.ts; none: the desktop's), so what it opens
 * or focuses shows on the screen the open started on.
 */
export async function runOpenListeners(
  listeners: Iterable<Listener>,
  req: { path: string; tabId?: string; view?: ViewId },
  log: (message: string) => void,
  waitMs = OPEN_LISTENER_WAIT_MS
): Promise<boolean> {
  const list = [...listeners]
  if (list.length === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), waitMs)
  })
  try {
    const outcomes = await Promise.all(
      list.map((listener) => {
        // Through a resolved promise, so a synchronous throw lands in the same catch as a rejection.
        const run = Promise.resolve()
          // No `tabId` key at all when there is none, so `'tabId' in req` agrees with the type.
          .then(() =>
            dispatchInView(
              req.view,
              () => listener(Object.freeze(req.tabId !== undefined ? { path: req.path, tabId: req.tabId } : { path: req.path })),
              // Logged below, where the outcome is read.
              () => undefined
            )
          )
          .then(
            () => true,
            (err: unknown) => {
              log(`a files.onOpen listener failed: ${errorText(err)}`)
              return false
            }
          )
        return Promise.race([run, pending])
      })
    )
    return outcomes.some((ok) => ok)
  } finally {
    clearTimeout(timer)
  }
}
