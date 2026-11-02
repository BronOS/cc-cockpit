// Theme format and validator, shared by main (built-ins, plugin-contributed themes) and the
// renderer. A theme is a set of CSS variables for the shell (and the plugin panels, which get the
// same variables injected) plus an xterm palette. Types and pure functions only.

/**
 * The xterm palette. Structurally the subset of xterm's `ITheme` we accept (colour strings
 * only), declared here so main and the CLI typecheck without the DOM-flavoured xterm typings.
 */
export interface XtermTheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  selectionInactiveBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export interface Theme {
  /** Stable id; contributed themes are namespaced by the plugin loader (Task 24). */
  id: string
  name: string
  /** Drives `color-scheme` and the "follow the OS" choice between the two built-ins. */
  kind: 'light' | 'dark'
  /** CSS custom properties, `--name` -> colour. Names the shell does not use are allowed. */
  vars: Record<string, string>
  xterm: XtermTheme
}

export const XTERM_KEYS: readonly (keyof XtermTheme)[] = [
  'foreground',
  'background',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

// Caps for untrusted input (plugin themes): a real theme has a few dozen entries.
const MAX_ENTRIES = 200
const MAX_VALUE_LENGTH = 100
const MAX_VAR_NAME_LENGTH = 100
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/
const VAR_NAME = /^--[A-Za-z][A-Za-z0-9_-]*$/
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
// rgb()/rgba()/hsl()/hsla() with plain numeric arguments (comma or space separated, optional
// %, deg and a /alpha). Deliberately narrow: the value ends up in a style property, so anything
// that is not obviously a colour is refused rather than escaped.
const NUM = String.raw`-?\d+(?:\.\d+)?(?:%|deg)?`
const FUNC = new RegExp(
  String.raw`^(?:rgb|rgba|hsl|hsla)\(\s*${NUM}(?:\s*,\s*${NUM}){2,3}\s*\)$|` +
    String.raw`^(?:rgb|rgba|hsl|hsla)\(\s*${NUM}(?:\s+${NUM}){2}(?:\s*/\s*${NUM})?\s*\)$`
)

/** True for `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` and plain rgb()/rgba()/hsl()/hsla(). */
export function isColor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VALUE_LENGTH && (HEX.test(value) || FUNC.test(value))
}

export type ThemeValidation = { ok: true; theme: Theme } | { ok: false; errors: string[] }

/** Check untrusted JSON (a theme file from disk or a plugin) and return a clean copy. */
export function validateTheme(input: unknown): ThemeValidation {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['theme must be an object'] }
  }
  const o = input as Record<string, unknown>

  if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) errors.push('id must match ' + ID_PATTERN.source)
  if (typeof o.name !== 'string' || o.name.trim() === '' || o.name.length > 100) {
    errors.push('name must be a non-empty string of at most 100 characters')
  }
  if (o.kind !== 'light' && o.kind !== 'dark') errors.push('kind must be "light" or "dark"')

  const vars: Record<string, string> = {}
  if (typeof o.vars !== 'object' || o.vars === null || Array.isArray(o.vars)) {
    errors.push('vars must be an object')
  } else {
    const entries = Object.entries(o.vars)
    if (entries.length > MAX_ENTRIES) errors.push(`vars: at most ${MAX_ENTRIES} entries`)
    for (const [name, value] of entries.slice(0, MAX_ENTRIES)) {
      if (name.length > MAX_VAR_NAME_LENGTH || !VAR_NAME.test(name)) errors.push(`vars: "${name}" is not a CSS variable name (--name)`)
      else if (!isColor(value)) errors.push(`vars: ${name} is not a colour`)
      else vars[name] = value
    }
  }

  const xterm: XtermTheme = {}
  if (typeof o.xterm !== 'object' || o.xterm === null || Array.isArray(o.xterm)) {
    errors.push('xterm must be an object')
  } else {
    for (const [key, value] of Object.entries(o.xterm).slice(0, MAX_ENTRIES)) {
      if (!(XTERM_KEYS as readonly string[]).includes(key)) errors.push(`xterm: unknown key "${key}"`)
      else if (!isColor(value)) errors.push(`xterm: ${key} is not a colour`)
      else (xterm as Record<string, string>)[key] = value
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    theme: { id: o.id as string, name: o.name as string, kind: o.kind as 'light' | 'dark', vars, xterm }
  }
}
