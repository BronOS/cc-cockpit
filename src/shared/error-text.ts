/** The message of a caught value for a log line or an error shown to the user (a throw can be anything). */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A caught value as an Error, for a rejection or an error callback that promises one (a throw can be anything). */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** The `code` of a caught node error (`EEXIST`, `ENOENT`), or undefined when it has none. */
export function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
