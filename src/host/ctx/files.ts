// ctx.files (friction round 1, Task 12): a plugin takes over the click on a changed file in core's
// Sessions panel. Main decides which plugin gets the click (the project's pick, src/shared/services.ts
// selectOpenFile), checks the tab and the path, and sends this host `files.open { pluginId, path,
// tabId }`; the answer is the ack. `false` (nobody listening, every listener failed) and no answer
// within main's bound both make main open its built-in viewer, so the user always sees something.
//
// The ack must come quickly but a listener may legitimately run long (it opens an overlay and awaits
// the user's answer), so a listener's promise is waited for only OPEN_LISTENER_WAIT_MS: a throw or a
// rejection before then is a failure, a promise still pending then counts as handled. The wait stays
// well inside main's 2 s (OPEN_FILE_ACK_MS in host-manager.ts), so a host that is merely busy for a
// moment is not mistaken for one that failed.
import type { Disposer, OpenFileRequest, PluginContext } from '../../sdk/types'
import { errorText } from '../../shared/error-text'

/** How long a listener's promise may take to reject and still count as a failure. */
export const OPEN_LISTENER_WAIT_MS = 1_000

type Listener = (req: OpenFileRequest) => unknown

export interface FilesApiDeps {
  /** The manifest declares `contributes.openFile` (HostPluginSpec.openFile). */
  declared: boolean
  /** Throws when the plugin is deactivated. */
  alive(): void
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
    }
  })
}

/** Main's `files.open` params, checked (main built them; the shapes are verified anyway). */
export function parseOpenFile(params: unknown): { pluginId: string; path: string; tabId: string } {
  const { pluginId, path, tabId } = (params ?? {}) as Record<string, unknown>
  if (typeof pluginId !== 'string' || typeof path !== 'string' || typeof tabId !== 'string') {
    throw new Error('files.open: pluginId, path and tabId must be strings')
  }
  return { pluginId, path, tabId }
}

/**
 * Call every listener with its own frozen request; true when at least one returned, resolved, or is
 * still pending after `waitMs`. A throw or rejection is logged against the plugin. False with no
 * listener at all.
 */
export async function runOpenListeners(
  listeners: Iterable<Listener>,
  req: { path: string; tabId: string },
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
          .then(() => listener(Object.freeze({ path: req.path, tabId: req.tabId })))
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
