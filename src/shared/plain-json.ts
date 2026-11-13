import type { JsonValue } from '../sdk/types'

/**
 * `value` through JSON once (slot params, page tab params): what is kept is the parsed copy, so a
 * getter, a prototype or a function cannot ride along, and the byte count is that of the text that
 * is saved and handed back to the plugin. Throws `<label> must be plain JSON` or `<label> are larger
 * than <maxBytes> bytes as JSON`.
 */
export function plainJsonOf(value: unknown, maxBytes: number, label: string): JsonValue {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    // A cycle or a BigInt: the same answer as a function, without the engine's text.
    text = undefined
  }
  if (text === undefined) throw new Error(`${label} must be plain JSON`)
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`${label} are larger than ${maxBytes} bytes as JSON`)
  return JSON.parse(text) as JsonValue
}
