/**
 * Single-quote `value` for a POSIX shell: `'` becomes `'\''` (close the quote, an escaped quote,
 * reopen). Inside single quotes nothing is special, so spaces, `$`, backticks and newlines in a
 * path are all inert. Claude runs a hook `command` through a shell, and the data dir can sit
 * under a home directory with a space (or an apostrophe) in its name.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
