/** A JSON-style object: not null and not an array (both are `typeof 'object'` too). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * `map[key]` only when `map` itself holds `key`. Lookup tables are plain objects, so a plain
 * `map[key]` on an untrusted string answers `constructor`, `__proto__` or `toString` with an
 * Object.prototype member: `constructor+p` once passed as a modifier alias and normalised to a
 * bare `p`, a plugin chord that would have swallowed typing in the terminal.
 */
export function own<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}
