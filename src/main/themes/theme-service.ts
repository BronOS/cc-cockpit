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
   * theme does not set are taken from the built-in of its kind: applyTheme removes every variable
   * the new theme lacks, so a theme written before a token existed (the accent and surface tokens
   * came after hello-dusk) would otherwise leave the shell and its panels with no accent, no focus
   * ring and transparent surfaces.
   */
  register(input: unknown): Theme {
    const result = validateTheme(input)
    if (!result.ok) throw new Error(`invalid theme: ${result.errors.join('; ')}`)
    const base = BUILTIN_THEMES.find((t) => t.kind === result.theme.kind)
    const theme: Theme = { ...result.theme, vars: { ...base?.vars, ...result.theme.vars } }
    if (BUILTIN_IDS.has(theme.id) || this.contributed.has(theme.id)) {
      throw new Error(`theme id already in use: ${theme.id}`)
    }
    this.contributed.set(theme.id, theme)
    this.refresh()
    return theme
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
