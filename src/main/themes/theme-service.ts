// Themes in main: the built-in light and dark, themes contributed by plugins (Task 24), and the
// active choice. The renderer never decides which theme is current; it applies what main says,
// so every window (and later every plugin panel) always shows the same one.
//
// Active choice: `app.json` `theme` holds the id the user picked. Unset, or naming a theme that
// is not registered (a plugin was disabled, a file removed), means "follow the OS": the built-in
// light or dark by the OS appearance. The stored id is kept in the second case, so the theme
// comes back when the plugin does.
//
// Pure Node: the OS appearance and the broadcast come in as functions.
import darkJson from '../../themes/dark.json'
import lightJson from '../../themes/light.json'
import { isPlainObject } from '../../shared/guards'
import { validateTheme, type Theme } from '../../shared/theme'

export interface ThemeSettings {
  data: { theme?: string }
  save(): void
}

export interface ThemeServiceOptions {
  settings: ThemeSettings
  /** The OS is in dark mode. */
  isDark: () => boolean
  /** The effective theme changed: broadcast it to every window. */
  onChange: (theme: Theme) => void
}

function builtin(json: unknown): Theme {
  const result = validateTheme(json)
  // A broken built-in is a build defect, not a runtime condition to recover from.
  if (!result.ok) throw new Error(`built-in theme is invalid: ${result.errors.join('; ')}`)
  return result.theme
}

export const BUILTIN_THEMES: readonly Theme[] = [builtin(lightJson), builtin(darkJson)]
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id))

/**
 * Validate a plugin theme and lay it over the built-in of its kind. Shell variables the theme does
 * not set are taken from that built-in: applyTheme removes every variable the new theme lacks, so a
 * theme written before a token existed (the accent and surface tokens came after hello-dusk) would
 * otherwise leave the shell and its panels with no accent, no focus ring and transparent surfaces.
 */
function withBase(input: unknown): Theme {
  const result = validateTheme(input)
  if (!result.ok) throw new Error(`invalid theme: ${result.errors.join('; ')}`)
  const base = BUILTIN_THEMES.find((t) => t.kind === result.theme.kind)
  return { ...result.theme, vars: { ...base?.vars, ...result.theme.vars } }
}

/** Same entries, in any key order (two hosts may build the same palette in different orders). */
function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

function sameTheme(a: Theme, b: Theme): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    sameRecord(a.vars, b.vars) &&
    sameRecord(a.xterm as Record<string, string>, b.xterm as Record<string, string>)
  )
}

export class ThemeService {
  private readonly contributed = new Map<string, Theme>()
  private last: Theme

  constructor(private readonly options: ThemeServiceOptions) {
    this.last = this.current()
  }

  list(): Theme[] {
    return [...BUILTIN_THEMES, ...this.contributed.values()]
  }

  /** The id the user picked (kept even while it names nothing registered); undefined = follow the OS. */
  selected(): string | undefined {
    return this.options.settings.data.theme
  }

  /** The theme to show now. */
  current(): Theme {
    const wanted = this.options.settings.data.theme
    const picked = wanted === undefined ? undefined : this.find(wanted)
    if (picked) return picked
    const kind = this.options.isDark() ? 'dark' : 'light'
    return BUILTIN_THEMES.find((t) => t.kind === kind) ?? BUILTIN_THEMES[0]!
  }

  /**
   * Add a plugin theme. Throws on invalid input or an id that is already taken. Shell variables the
   * theme does not set come from the built-in of its kind (withBase).
   */
  register(input: unknown): Theme {
    const theme = withBase(input)
    if (BUILTIN_IDS.has(theme.id) || this.contributed.has(theme.id)) {
      throw new Error(`theme id already in use: ${theme.id}`)
    }
    this.contributed.set(theme.id, theme)
    this.refresh()
    return theme
  }

  /**
   * Replace a registered plugin theme in place (ctx.themes.set; HostApi forces `id` to the calling
   * plugin's own declared contribution, so `input.id` is ignored). A full replacement, inheriting
   * from the built-in of its (possibly new) kind like `register`: an omitted `name` keeps the
   * registered one, omitted `vars` or `xterm` are empty. Only a registered contributed id: a theme
   * whose file did not load, a plugin that is unloaded or a built-in is refused. Every project
   * window runs its own plugin host, so N hosts send the same update: one that changes nothing is a
   * no-op (false, no broadcast); otherwise true, and a broadcast only when it is the theme shown.
   * In memory only: a reload or update of the plugin registers its file again.
   */
  update(id: string, input: unknown): boolean {
    const prev = this.contributed.get(id)
    if (!prev) throw new Error(`theme is not registered (its file did not load, or the plugin is not loaded): ${id}`)
    if (!isPlainObject(input)) throw new Error('invalid theme: theme must be an object')
    const theme = withBase({
      ...input,
      id,
      name: input.name ?? prev.name,
      vars: input.vars ?? {},
      xterm: input.xterm ?? {}
    })
    if (sameTheme(prev, theme)) return false
    // Map.set on a present key keeps its place: the Appearance list order does not move.
    this.contributed.set(id, theme)
    this.refresh()
    return true
  }

  /** Remove a plugin theme; when it was active the app falls back to the OS-matching built-in. */
  unregister(id: string): void {
    if (this.contributed.delete(id)) this.refresh()
  }

  /** The user's pick; `undefined` goes back to following the OS. Unknown ids are refused. */
  setActive(id: string | undefined): void {
    if (id !== undefined && !this.find(id)) throw new Error(`unknown theme: ${id}`)
    if (id === undefined) delete this.options.settings.data.theme
    else this.options.settings.data.theme = id
    this.options.settings.save()
    this.refresh()
  }

  /** Re-evaluate (OS appearance changed, registry changed) and broadcast when the result differs. */
  refresh(): void {
    const next = this.current()
    if (next === this.last) return
    this.last = next
    this.options.onChange(next)
  }

  private find(id: string): Theme | undefined {
    return BUILTIN_THEMES.find((t) => t.id === id) ?? this.contributed.get(id)
  }
}
