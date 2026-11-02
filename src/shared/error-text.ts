/** The message of a caught value for a log line or an error shown to the user (a throw can be anything). */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A caught value as an Error, for a rejection or an error callback that promises one (a throw can be anything). */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
