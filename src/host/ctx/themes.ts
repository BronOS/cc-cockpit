// `ctx.themes`: the plugin replaces one of its own contributed themes while the app runs (a theme
// that follows the desktop's palette). Main owns the theme registry for every window, so `set` is
// one RPC, and main is the authority on everything: that the id is one this plugin's manifest
// declares, the colours (validateTheme), the size and the rate (host-api.ts themesSet). The checks
// here are only the call's shape, so a wrong call fails at the call site with a TypeError.
import type { PluginContext, PluginThemeInput } from '../../sdk/types'

export interface ThemesDeps {
  pluginId: string
  call(method: string, params: unknown): Promise<unknown>
  /** Rejects once the plugin is deactivated, and turns a synchronous throw into a rejection. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
}

export function createThemesApi(deps: ThemesDeps): PluginContext['themes'] {
  const { pluginId, call, guardAsync } = deps
  return Object.freeze({
    set: (themeId: string, theme: PluginThemeInput): Promise<void> =>
      guardAsync(async () => {
        if (typeof themeId !== 'string' || themeId === '') throw new TypeError('themes.set: themeId must be a non-empty string')
        if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
          throw new TypeError('themes.set: theme must be an object')
        }
        // `pluginId` is this plugin's own; main refuses an id its host does not run and namespaces
        // `themeId` by it, so no call here can reach another plugin's theme.
        await call('themes.set', { pluginId, themeId, theme })
      })
  })
}
