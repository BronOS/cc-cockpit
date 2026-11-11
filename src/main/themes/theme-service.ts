// Themes in main: the built-in light and dark, themes contributed by plugins (Task 24), and the
// active choice. The renderer never decides which theme is current; it applies what main says,
// so every window (and later every plugin panel) always shows the same one.
//
// Active choice: `app.json` `theme` holds the id the user picked. Unset, or naming a theme that
// is not registered (a plugin was disabled, a file removed), means "follow the OS": the built-in
// light or dark by the OS appearance. The stored id is kept in the second case, so the theme
// comes back when the plugin does.
//
// Per view (design-web.md §5.7 "Theme per view"): "follow the OS" means the appearance of the screen
// the view is on. The desktop page (and server mode's hidden page) follows Electron's nativeTheme;
// a browser view reports its own `prefers-color-scheme` (at `hello` and on every change, channel
// `theme.scheme`), and with no pick it gets the built-in of that kind. Before, one app-wide theme
// went to every view, so a headless server (no OS appearance: nativeTheme says light) painted every
// dark browser light, and a phone took the desktop's appearance. The hint only chooses between the
// two built-ins for that one view: a pick (a plugin theme included) still wins everywhere.
//
// Pure Node: the OS appearance and the broadcast come in as functions.
import darkJson from '../../themes/dark.json'
import lightJson from '../../themes/light.json'
import { isPlainObject } from '../../shared/guards'
import { validateTheme, type Theme } from '../../shared/theme'
import { isRemoteViewId, type ViewId } from '../../shared/views'

export interface ThemeSettings {
  data: { theme?: string }
  save(): void
}

export interface ThemeServiceOptions {
  settings: ThemeSettings
  /** The OS is in dark mode (the desktop's appearance; a browser view reports its own). */
  isDark: () => boolean
  /**
   * The effective theme changed for some views: `themeOf(viewId)` is that view's new theme, or
   * undefined when its theme is unchanged (it is sent nothing). Called synchronously; main walks its
   * views with it (ViewRegistry.toEach), so each view gets exactly its own theme.
   */
  onChange: (themeOf: (viewId: ViewId) => Theme | undefined) => void
}

/**
 * The three ways a view can resolve with no pick: the OS rule (the desktop, and a browser that has
 * not reported), or a browser's reported dark or light. With a pick all three are the pick.
 */
type SchemeKey = 'os' | 'dark' | 'light'
const SCHEME_KEYS: readonly SchemeKey[] = ['os', 'dark', 'light']

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
  /** What each scheme key resolved to at the last refresh, to tell which views a change reaches. */
  private last: Record<SchemeKey, Theme>
  /**
   * Browser views' reported `prefers-color-scheme`, by view id. Remote ids only (`setViewScheme`
   * refuses the rest); an entry goes with its view (`viewGone`), so the map is bounded by the
   * gateway's connection cap.
   */
  private readonly schemes = new Map<ViewId, 'dark' | 'light'>()

  constructor(private readonly options: ThemeServiceOptions) {
    this.last = this.resolveAll()
  }

  list(): Theme[] {
    return [...BUILTIN_THEMES, ...this.contributed.values()]
  }

  /** The id the user picked (kept even while it names nothing registered); undefined = follow the OS. */
  selected(): string | undefined {
    return this.options.settings.data.theme
  }

  /**
   * The theme by the OS rule: the pick, else the built-in of the OS appearance. What the desktop
   * page shows, and what app-level readers with no view use.
   */
  current(): Theme {
    return this.resolve('os')
  }

  /**
   * The theme one view shows: the pick, else for a browser view that reported its appearance the
   * built-in of that kind, else the OS rule (`current`). Undefined (no view: a tab nobody typed in)
   * is the OS rule too.
   */
  forView(viewId: ViewId | undefined): Theme {
    return this.resolve(viewId === undefined ? 'os' : this.keyOf(viewId))
  }

  /**
   * A browser view joined (at `hello`, before `ready`) with its appearance: recorded with no event,
   * since the view has not read its theme yet (its first `theme.get` answers by it) and nothing may
   * reach its socket before `ready`. A desktop id is ignored: only a browser reports.
   */
  viewJoined(viewId: ViewId, dark: boolean | undefined): void {
    if (dark === undefined || !isRemoteViewId(viewId)) return
    this.schemes.set(viewId, dark ? 'dark' : 'light')
  }

  /**
   * A browser view's appearance changed (`theme.scheme`): that view alone is sent its theme, when the
   * change moves it (with a pick nothing does). A desktop id is ignored (the router already drops a
   * call from a desktop view; this is the second check): the desktop follows nativeTheme, and a page
   * must not be able to repaint the host's window.
   */
  setViewScheme(viewId: ViewId, dark: boolean): void {
    if (!isRemoteViewId(viewId)) return
    const before = this.forView(viewId)
    this.schemes.set(viewId, dark ? 'dark' : 'light')
    const after = this.forView(viewId)
    if (after !== before) this.options.onChange((id) => (id === viewId ? after : undefined))
  }

  /**
   * The theme a tab's terminal colour queries (OSC 10/11/12, answered by the mirror worker) are
   * answered from. One answer per tab while views may differ: the view that typed there last (the
   * program is talking to that person's screen; the same owner idea as the terminal's size), else
   * the view sizing it (a tab nobody typed in yet: the browser that opened it, in server mode), else
   * the OS rule.
   */
  forTerminal(typedBy: ViewId | undefined, sizer: ViewId | undefined): Theme {
    return this.forView(typedBy ?? sizer)
  }

  /** The view is gone (its socket closed): its reported appearance goes with it. */
  viewGone(viewId: ViewId): void {
    this.schemes.delete(viewId)
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

  /**
   * Re-evaluate (OS appearance changed, registry changed) and tell the views whose theme moved. Only
   * those: the OS turning dark under a pick sends nothing, and it reaches the desktop and unreported
   * browsers but not a browser that reported its own appearance.
   */
  refresh(): void {
    const next = this.resolveAll()
    const moved = new Set(SCHEME_KEYS.filter((k) => next[k] !== this.last[k]))
    this.last = next
    if (moved.size === 0) return
    this.options.onChange((viewId) => {
      const key = this.keyOf(viewId)
      return moved.has(key) ? next[key] : undefined
    })
  }

  private keyOf(viewId: ViewId): SchemeKey {
    return this.schemes.get(viewId) ?? 'os'
  }

  private resolve(key: SchemeKey): Theme {
    const wanted = this.options.settings.data.theme
    const picked = wanted === undefined ? undefined : this.find(wanted)
    if (picked) return picked
    const kind = key === 'os' ? (this.options.isDark() ? 'dark' : 'light') : key
    return BUILTIN_THEMES.find((t) => t.kind === kind) ?? BUILTIN_THEMES[0]!
  }

  private resolveAll(): Record<SchemeKey, Theme> {
    return { os: this.resolve('os'), dark: this.resolve('dark'), light: this.resolve('light') }
  }

  private find(id: string): Theme | undefined {
    return BUILTIN_THEMES.find((t) => t.id === id) ?? this.contributed.get(id)
  }
}
