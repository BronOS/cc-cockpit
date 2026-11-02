import { useCallback, useEffect, useState } from 'react'
import { ipcErrorMessage } from '../ipc-error'

export interface Loaded<T> {
  /** Null until the first answer. */
  data: T | null
  /** The last load's failure, if it failed. */
  error: string | null
  /** Ask again (after a change); the previous data stays on screen until the answer arrives. */
  reload: () => void
}

/**
 * Load a settings page's data with `load` (a module-level function, so its identity is stable)
 * and again on `reload()`. State is set only from the promise callbacks, and a page that went away
 * meanwhile ignores the answer.
 */
export function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    load().then(
      (data) => {
        if (live) setState({ data, error: null })
      },
      (err: unknown) => {
        if (live) setState((s) => ({ ...s, error: ipcErrorMessage(err) }))
      }
    )
    return () => {
      live = false
    }
  }, [load, tick])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, reload }
}
