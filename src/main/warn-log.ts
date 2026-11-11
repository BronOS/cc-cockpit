// The default log of main's services: a warning on stderr (the app's log when packaged). One
// function instead of a `(m) => console.warn(m)` closure in every constructor and call site. It
// reads `console.warn` on each call, so a test spying on it still sees the message.

/** Log one line as a warning. */
export function warnLog(message: string): void {
  console.warn(message)
}
