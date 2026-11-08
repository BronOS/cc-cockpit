// ctx.themes.set: the host → main `themes.set` RPC with main's checks (the plugin is this host's,
// the id one its manifest declares, the payload a valid theme of at most 32 KiB, a per-plugin budget,
// the id forced to the plugin's namespace) over a real ThemeService, and the host-side ctx member.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { HostApi, MAX_THEME_SET_BYTES, MAX_THEME_SETS_PER_WINDOW, type HostApiDeps, type HostScope } from '../../src/main/plugins/host-api'
import { ThemeService } from '../../src/main/themes/theme-service'
import type { Theme } from '../../src/shared/theme'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const ROOT = '/nonexistent/themes-set'
const file = { name: 'Dusk', kind: 'dark', vars: { '--cc-bg': '#101010' }, xterm: { red: '#aa0000' } }
const live = { name: 'Live', kind: 'dark', vars: { '--cc-bg': '#202020' }, xterm: { red: '#ff0000' } }

const apis: HostApi[] = []
afterEach(() => {
  for (const api of apis.splice(0)) api.dispose()
})

/** A ThemeService with acme.dusk/dusk and acme.other/dusk registered (as the installer would). */
function themeService(active?: string): { themes: ThemeService; changes: Theme[] } {
  const changes: Theme[] = []
  const themes = new ThemeService({
    settings: { data: active === undefined ? {} : { theme: active }, save: () => {} },
    isDark: () => false,
    onChange: (t) => changes.push(t)
  })
  themes.register({ ...file, id: 'acme.dusk/dusk' })
  themes.register({ ...file, id: 'acme.other/dusk', name: 'Other dusk' })
  changes.length = 0
  return { themes, changes }
}

function deps(themes: ThemeService | null): HostApiDeps {
  return {
    listSessions: () => [],
    session: () => undefined,
    send: () => {
      throw new Error('not used')
    },
    onSessionsChange: () => () => {},
    openTab: async () => {
      throw new Error('not used')
    },
    setBadge: () => false,
    openOverlay: async () => {
      throw new Error('not used')
    },
    secrets: unusedSecrets,
    oauth: unusedOAuth,
    ...(themes ? { updateTheme: (id: string, theme: unknown) => themes.update(id, theme) } : {}),
    log: () => {}
  }
}

const scope = (windowId = 1): HostScope => ({
  projectId: 'aaaaaaaaaaaaaaaa',
  windowId,
  projectDir: ROOT,
  plugins: [
    // `broken` is declared but not registered (its file was refused at load).
    { id: 'acme.dusk', dir: join(ROOT, 'acme.dusk'), panels: [], themes: ['dusk', 'broken'] },
    { id: 'acme.plain', dir: join(ROOT, 'acme.plain'), panels: [] }
  ]
})

function host(d: HostApiDeps, s: HostScope = scope()): { call: (method: string, params?: unknown) => Promise<unknown>; api: HostApi } {
  const api = new HostApi(d, s, () => {})
  apis.push(api)
  const handlers = api.handlers
  return { api, call: (method, params) => Promise.resolve().then(() => handlers[method]!(params)) }
}

const themeOf = (themes: ThemeService, id: string): Theme | undefined => themes.list().find((t) => t.id === id)

describe('themes.set (HostApi)', () => {
  it('replaces the plugin’s own declared theme under its namespaced id, ignoring any id sent', async () => {
    const { themes, changes } = themeService('acme.dusk/dusk')
    const { call } = host(deps(themes))
    expect(await call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: { ...live, id: 'acme.other/dusk' } })).toBeNull()
    expect(themeOf(themes, 'acme.dusk/dusk')).toMatchObject({ name: 'Live', xterm: { red: '#ff0000' } })
    expect(themeOf(themes, 'acme.other/dusk')!.name).toBe('Other dusk')
    expect(changes.map((t) => t.name)).toEqual(['Live'])
  })

  it('two windows’ hosts sending the same update broadcast once', async () => {
    const { themes, changes } = themeService('acme.dusk/dusk')
    const a = host(deps(themes), scope(1))
    const b = host(deps(themes), scope(2))
    await a.call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: live })
    await b.call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: { ...live } })
    expect(changes).toHaveLength(1)
  })

  it('refuses an undeclared id, another plugin’s theme, a built-in and a plugin the host does not run', async () => {
    const { themes } = themeService()
    const { call } = host(deps(themes))
    const notDeclared = "themes.set: themeId is not one of this plugin's contributes.themes ids"
    for (const themeId of ['other', 'acme.other/dusk', '../acme.other/dusk', 'dark', 'light', '', 42, undefined]) {
      await expect(call('themes.set', { pluginId: 'acme.dusk', themeId, theme: live })).rejects.toThrow(notDeclared)
    }
    // A plugin with no themes declares none.
    await expect(call('themes.set', { pluginId: 'acme.plain', themeId: 'dusk', theme: live })).rejects.toThrow(notDeclared)
    await expect(call('themes.set', { pluginId: 'acme.other', themeId: 'dusk', theme: live })).rejects.toThrow('themes.set: unknown plugin')
    expect(themeOf(themes, 'acme.other/dusk')!.name).toBe('Other dusk')
  })

  it('refuses an invalid colour, a non-object, an oversized or non-JSON theme, and a declared theme that did not load', async () => {
    const { themes } = themeService()
    const { call } = host(deps(themes))
    const set = (theme: unknown, themeId = 'dusk') => call('themes.set', { pluginId: 'acme.dusk', themeId, theme })
    await expect(set({ ...live, vars: { '--cc-bg': 'url(x)' } })).rejects.toThrow('themes.set: invalid theme: vars: --cc-bg is not a colour')
    await expect(set({ ...live, xterm: { red: 'expression(1)' } })).rejects.toThrow('themes.set: invalid theme: xterm: red is not a colour')
    await expect(set([live])).rejects.toThrow('themes.set: theme must be an object')
    await expect(set(null)).rejects.toThrow('themes.set: theme must be an object')
    const cyclic: Record<string, unknown> = { ...live }
    cyclic.self = cyclic
    await expect(set(cyclic)).rejects.toThrow('themes.set: theme must be JSON')
    await expect(set({ ...live, pad: 'x'.repeat(MAX_THEME_SET_BYTES) })).rejects.toThrow(`themes.set: theme is over ${MAX_THEME_SET_BYTES} bytes as JSON`)
    // Declared, but its file was refused at load: nothing registered to replace.
    await expect(set(live, 'broken')).rejects.toThrow('themes.set: theme is not registered')
    expect(themeOf(themes, 'acme.dusk/dusk')!.name).toBe('Dusk')
  })

  it('allows a budget of updates per plugin per window; refusals do not spend it', async () => {
    const { themes } = themeService()
    const { call } = host(deps(themes))
    const set = (theme: unknown) => call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme })
    for (let i = 0; i < 3; i++) await expect(set({ ...live, kind: 'sepia' })).rejects.toThrow('invalid theme')
    for (let i = 0; i < MAX_THEME_SETS_PER_WINDOW; i++) await set({ ...live, name: `Live ${i}` })
    await expect(set(live)).rejects.toThrow(`themes.set: more than ${MAX_THEME_SETS_PER_WINDOW} in 10 s`)
    expect(themeOf(themes, 'acme.dusk/dusk')!.name).toBe(`Live ${MAX_THEME_SETS_PER_WINDOW - 1}`)
    // Another window's host has its own budget.
    const other = host(deps(themes), scope(2))
    await other.call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: live })
    expect(themeOf(themes, 'acme.dusk/dusk')!.name).toBe('Live')
  })

  it('is refused without the theme service and once the host is stopping', async () => {
    await expect(host(deps(null)).call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: live })).rejects.toThrow(
      'themes.set: themes are not available'
    )
    const { themes } = themeService()
    const { call, api } = host(deps(themes))
    api.revoke()
    await expect(call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: live })).rejects.toThrow('the plugin host is stopping')
  })

  it('follows a reload: updatePlugin with new declarations is what is checked', async () => {
    const { themes } = themeService()
    const { call, api } = host(deps(themes))
    api.updatePlugin({ id: 'acme.dusk', dir: join(ROOT, 'acme.dusk'), panels: [], themes: [] })
    await expect(call('themes.set', { pluginId: 'acme.dusk', themeId: 'dusk', theme: live })).rejects.toThrow('contributes.themes')
  })
})

describe('ctx.themes.set (host)', () => {
  function ctxFor(themes: ThemeService) {
    const { call } = host(deps(themes))
    const calls: { method: string; params: unknown }[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: (method, params) => {
        calls.push({ method, params })
        return call(method, params)
      }
    })
    return { ctx: contexts.create(hostSpec({ id: 'acme.dusk', dir: join(ROOT, 'acme.dusk'), main: 'm.js' })), contexts, calls }
  }

  it('sends one themes.set with its own plugin id and resolves undefined', async () => {
    const { themes } = themeService()
    const { ctx, calls } = ctxFor(themes)
    await expect(ctx.themes.set('dusk', { kind: 'dark', vars: { '--cc-bg': '#303030' } })).resolves.toBeUndefined()
    expect(calls).toEqual([
      { method: 'themes.set', params: { pluginId: 'acme.dusk', themeId: 'dusk', theme: { kind: 'dark', vars: { '--cc-bg': '#303030' } } } }
    ])
    // The name was omitted: the registered one stays.
    expect(themeOf(themes, 'acme.dusk/dusk')).toMatchObject({ name: 'Dusk', xterm: {} })
    await expect(ctx.themes.set('other', live as never)).rejects.toThrow('contributes.themes')
  })

  it('refuses a bad call shape before asking main, and rejects after deactivate', async () => {
    const { themes } = themeService()
    const { ctx, calls, contexts } = ctxFor(themes)
    await expect(ctx.themes.set('', live as never)).rejects.toThrow('themes.set: themeId must be a non-empty string')
    await expect(ctx.themes.set(1 as never, live as never)).rejects.toThrow('themeId must be a non-empty string')
    await expect(ctx.themes.set('dusk', null as never)).rejects.toThrow('themes.set: theme must be an object')
    await expect(ctx.themes.set('dusk', [] as never)).rejects.toThrow('theme must be an object')
    expect(calls).toEqual([])
    contexts.dispose('acme.dusk')
    await expect(ctx.themes.set('dusk', live as never)).rejects.toThrow('deactivated')
  })
})
