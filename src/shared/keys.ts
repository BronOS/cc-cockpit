// Key chords: parsing, normalising, matching a key event, and resolving defaults plus the user's
// overrides into one binding table. Pure and DOM-free: main resolves the table, the renderer only
// compares an event against it.
//
// Canonical form: lower-case modifiers in a fixed order, then the key: `ctrl+alt+shift+meta+key`.
// Written by a user or a plugin as `Cmd+Shift+P`. `cmd` means the platform's command key: Meta on
// macOS, Ctrl elsewhere (design: "on Linux Cmd = Ctrl"), which is why normalising needs the
// platform while matching an event does not (the event says which modifier is down).
//
// Every table below is a plain object looked up by text a plugin or a user wrote, so lookups go
// through `own` (never `TABLE[text]`): see guards.ts for the `constructor+p` incident.
import { own } from './guards'

export type KeyPlatform = 'darwin' | 'linux' | 'win32'

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

const MODIFIER_ALIASES: Record<string, Modifier | 'cmd'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  super: 'meta',
  cmd: 'cmd',
  command: 'cmd',
  cmdorctrl: 'cmd',
  commandorcontrol: 'cmd'
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  spacebar: 'space',
  ' ': 'space',
  plus: '+',
  comma: ',',
  del: 'delete',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right'
}

const NAMED_KEYS =
  /^(escape|enter|tab|space|backspace|delete|home|end|pageup|pagedown|up|down|left|right|f([1-9]|1\d|2[0-4]))$/

/**
 * Normalise a chord string, or null when it is not one: empty, no key, an unknown modifier, a
 * repeated modifier, an unknown key name, or a chord with no modifier that is not Escape or a
 * function key (a bare letter would swallow typing in the terminal). Shift alone does not count as
 * a modifier: `Shift+K` is an upper-case K, `Shift+Enter` Claude's newline and `Shift+Tab` its mode
 * switch, and the window's capture-phase key handler would take each from every terminal and field.
 */
export function normalizeChord(input: string, platform: KeyPlatform): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '') return null
  // '+' is both the separator and a key (`Cmd++`): a '+' only separates when it follows text.
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '+' && current !== '') {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  const keyRaw = parts.pop()?.trim().toLowerCase()
  if (!keyRaw) return null
  const mods = new Set<Modifier>()
  for (const raw of parts) {
    const alias = own(MODIFIER_ALIASES, raw.trim().toLowerCase())
    if (!alias) return null
    const mod: Modifier = alias === 'cmd' ? (platform === 'darwin' ? 'meta' : 'ctrl') : alias
    if (mods.has(mod)) return null
    mods.add(mod)
  }
  const key = own(KEY_ALIASES, keyRaw) ?? keyRaw
  if (typeof key !== 'string' || (key.length > 1 && !NAMED_KEYS.test(key))) return null
  // Decided on the modifiers the chord is written with, not on `mods.size`: whatever slipped into
  // the set without being a real modifier would vanish from the written chord and leave a bare key.
  const written = MODIFIER_ORDER.filter((m) => mods.has(m))
  const typing = written.length === 0 || (written.length === 1 && written[0] === 'shift')
  if (typing && key !== 'escape' && !/^f\d+$/.test(key)) return null
  const chord = [...written, key].join('+')
  // Whatever is accepted here (saved, sent to every renderer) must come apart again in
  // splitChord, which the renderer's display and the menu use: never accept what they reject.
  return splitChord(chord) ? chord : null
}

/**
 * A canonical chord (what `normalizeChord` and `chordFromEvent` write) split into its modifiers
 * and its key, or null when it is not shaped like one. '+' is both the separator and a key:
 * `meta++` is Meta and Plus, and a plain `split('+')` gave `['meta', '', '']`, whose empty key
 * crashed the window's React UI where the chord was displayed. Everything that takes a chord
 * apart goes through here so that main's validation and the renderer's display agree. A trailing
 * '+' is the key only after another '+' (or alone); any other empty part (`meta+`, `++`,
 * `meta++p`) is refused.
 */
export function splitChord(chord: string): { mods: string[]; key: string } | null {
  if (typeof chord !== 'string' || chord === '') return null
  let key: string
  let rest: string
  if (chord.endsWith('+')) {
    key = '+'
    rest = chord.slice(0, -1)
    if (rest !== '') {
      // `meta++`: drop the separator before the '+' key; `meta+` and `++` have an empty part.
      if (!rest.endsWith('+')) return null
      rest = rest.slice(0, -1)
      if (rest === '') return null
    }
  } else {
    const at = chord.lastIndexOf('+')
    key = chord.slice(at + 1)
    rest = at < 0 ? '' : chord.slice(0, at)
    if (at === 0) return null
  }
  const mods = rest === '' ? [] : rest.split('+')
  if (mods.some((m) => m === '')) return null
  return { mods, key }
}

/** The fields of a DOM `KeyboardEvent` that decide a chord. */
export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Shifted US punctuation -> the key a chord names it by (`Cmd+Shift+,` arrives as '<'). '+' is left alone: `Cmd++` is already how a plus chord is written. */
const UNSHIFTED: Record<string, string> = {
  '<': ',',
  '>': '.',
  '?': '/',
  ':': ';',
  '"': "'",
  '{': '[',
  '}': ']',
  '|': '\\',
  _: '-',
  '~': '`'
}

/**
 * The canonical chord of a key event, or null for a lone modifier press. Letters and digits come
 * from `code` (the physical key) when `key` cannot be matched against a chord written in ASCII:
 * Alt is down (Option+X types another character on macOS), Shift/Ctrl/Cmd is down on a digit
 * (`key` is '!' for Shift+1, AZERTY types '&' for 1), or the layout is not Latin (Cyrillic Cmd+T
 * gives 'е'). Otherwise `key` is used, so Dvorak and friends keep their letters. Chords are
 * written unshifted, so shifted punctuation is mapped back.
 */
export function chordFromEvent(e: KeyEventLike): string | null {
  let key = e.key.toLowerCase()
  if (key === 'control' || key === 'alt' || key === 'shift' || key === 'meta') return null
  const m = e.code ? /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code) : null
  if (m) {
    const digit = m[2] !== undefined
    const asciiKey = /^[\x20-\x7e]$/.test(e.key)
    if (e.altKey || !asciiKey || (digit && (e.shiftKey || e.ctrlKey || e.metaKey))) {
      key = (m[1] ?? m[2] ?? key).toLowerCase()
    }
  }
  if (e.shiftKey) key = own(UNSHIFTED, key) ?? key
  key = own(KEY_ALIASES, key) ?? key
  const mods: Modifier[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('meta')
  return [...mods, key].join('+')
}

/** A command as far as key resolution cares. `key` is its default chord (any accepted spelling). */
export interface KeyedCommand {
  id: string
  key?: string
  /** A core command: its default chord beats a plugin's default for the same chord. */
  core?: boolean
}

export interface KeyConflict {
  /** The canonical chord more than one command claims. */
  chord: string
  /** The claimants, in command order. */
  commands: string[]
}

export interface ResolvedKeys {
  /** commandId -> its canonical chord; absent when unbound. */
  keys: Map<string, string>
  /** chord -> command, for the chords that are not in an unresolved conflict. */
  bindings: Map<string, string>
  /** Chords claimed by several commands (see `resolveKeys` for which of them still fires). */
  conflicts: KeyConflict[]
  /** Override entries that were ignored: an unknown command id or an invalid chord. */
  ignored: string[]
}

/**
 * Defaults plus overrides. An override replaces the command's default (it does not add a second
 * chord); an empty string unbinds the command. Overrides for unknown commands (a plugin that is
 * gone) and malformed chords are ignored and listed, never thrown: a stale line in `app.json`
 * must not stop the app from starting. A chord claimed by several commands is reported as a
 * conflict. Precedence is user override > core default > plugin default: when exactly one claimant
 * holds the highest rank present it gets the chord (a plugin cannot take Cmd+T from the app, the
 * user can); otherwise the chord is bound to none of them. A losing claimant is still reported, so
 * the settings screen can warn.
 */
export function resolveKeys(
  commands: readonly KeyedCommand[],
  overrides: Readonly<Record<string, string>>,
  platform: KeyPlatform
): ResolvedKeys {
  const known = new Set(commands.map((c) => c.id))
  const coreIds = new Set(commands.filter((c) => c.core).map((c) => c.id))
  const ignored: string[] = []
  const chosen = new Map<string, { chord: string; fromUser: boolean }>()
  for (const c of commands) {
    if (c.key === undefined) continue
    const chord = normalizeChord(c.key, platform)
    // A bad default is its author's bug; skip it like a bad user chord instead of failing startup.
    if (chord) chosen.set(c.id, { chord, fromUser: false })
  }
  for (const [id, value] of Object.entries(overrides)) {
    if (!known.has(id)) {
      ignored.push(id)
      continue
    }
    if (value === '') {
      chosen.delete(id)
      continue
    }
    const chord = normalizeChord(value, platform)
    if (!chord) {
      ignored.push(id)
      continue
    }
    chosen.set(id, { chord, fromUser: true })
  }
  const byChord = new Map<string, string[]>()
  for (const c of commands) {
    const pick = chosen.get(c.id)
    if (!pick) continue
    const list = byChord.get(pick.chord) ?? []
    list.push(c.id)
    byChord.set(pick.chord, list)
  }
  const keys = new Map<string, string>()
  const bindings = new Map<string, string>()
  const conflicts: KeyConflict[] = []
  for (const [chord, ids] of byChord) {
    for (const id of ids) keys.set(id, chord)
    if (ids.length === 1) {
      bindings.set(chord, ids[0] as string)
      continue
    }
    conflicts.push({ chord, commands: ids })
    const rank = (id: string): number => (chosen.get(id)?.fromUser ? 2 : coreIds.has(id) ? 1 : 0)
    const top = Math.max(...ids.map(rank))
    const winners = ids.filter((id) => rank(id) === top)
    if (winners.length === 1) bindings.set(chord, winners[0] as string)
  }
  return { keys, bindings, conflicts, ignored }
}
