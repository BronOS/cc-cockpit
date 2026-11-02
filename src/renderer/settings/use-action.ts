import { useCallback, useState } from 'react'
import { ipcErrorMessage } from '../ipc-error'

export interface Action {
  /** What is running (the label passed to `run`), or null. */
  busy: string | null
  /** The last failure, cleared by the next `run`. */
  error: string | null
  /**
   * Run one settings action: marks it busy, shows its failure as text, and resolves with the
   * result (undefined when it failed). Actions of one page run one at a time: a second `run`
   * while one is busy is ignored, so a double click cannot install a plugin twice.
   */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>
  setError: (message: string | null) => void
}

export function useAction(): Action {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (busy !== null) return undefined
      setBusy(label)
      setError(null)
      try {
        return await fn()
      } catch (err) {
        setError(ipcErrorMessage(err))
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [busy]
  )
  return { busy, error, run, setError }
}
