// Task 15, host side: ctx.settingsPage (the backend of a plugin's html settings page) as a plugin
// sees it. A page's MessagePort is an in-memory port pair, opened the way host/index.ts does it
// (settingsPageOpenTag + attachSettingsPagePort), closed by main's `settingsPage.close` or the port.
import { describe, expect, it } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import { settingsPageOpenTag } from '../../src/host/ctx/settings-page'
import type { PanelPort } from '../../src/host/ctx/ui'
import { parsePluginSpecs } from '../../src/host/loader'
import type { PluginContext, SettingsPageInstance } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setup(): { contexts: HostContexts; withPage: PluginContext; appOnly: PluginContext; without: PluginContext; logs: { pluginId: string; level: LogLevel; text: string }[] } {
  const logs: { pluginId: string; level: LogLevel; text: string }[] = []
  const deps: ContextDeps = { log: (pluginId, level, text) => logs.push({ pluginId, level, text }) }
  const contexts = new HostContexts(deps)
  const withPage = contexts.create(hostSpec({ id: 'p.inbox', dir: '/p/inbox', main: 'h.js', settingsPage: ['app', 'project'] }))
  const appOnly = contexts.create(hostSpec({ id: 'p.jev', dir: '/p/jev', main: 'h.js', settingsPage: ['app'] }))
  const without = contexts.create(hostSpec({ id: 'p.plain', dir: '/p/plain', main: 'h.js' }))
  return { contexts, withPage, appOnly, without, logs }
}

/** Main hands the host a page: the tag text and the host's end of the port, plus the page's end. */
function openPage(contexts: HostContexts, tag: Record<string, unknown>): { page: MemoryPort; port: PanelPort & { closed: boolean }; attached: boolean } {
  const [hostEnd, page] = memoryPortPair()
  const port = {
    closed: false,
    postMessage: (m: string) => hostEnd.postMessage(m),
    onMessage: (l: (m: unknown) => void) => hostEnd.onMessage(l),
    close() {
      port.closed = true
    }
  }
  const parsed = settingsPageOpenTag(JSON.stringify({ settingsPageOpen: tag }))
  if (!parsed) throw new Error('bad tag')
  return { page, port, attached: contexts.attachSettingsPagePort(parsed, port) }
}

const TAG = { pluginId: 'p.inbox', id: 'p1', scope: 'project' }

describe('ctx.settingsPage.onOpen', () => {
  it('throws without contributes.settings.page, and for a non-function', () => {
    const { withPage, without } = setup()
    expect(() => without.settingsPage.onOpen(() => {})).toThrow('declares no contributes.settings.page')
    expect(() => withPage.settingsPage.onOpen(5 as unknown as () => void)).toThrow('needs a function')
  })

  it('hands the listener a frozen page with its scope', () => {
    const { contexts, withPage } = setup()
    const seen: SettingsPageInstance[] = []
    withPage.settingsPage.onOpen((p) => seen.push(p))
    expect(openPage(contexts, TAG).attached).toBe(true)
    expect(seen.map((p) => p.scope)).toEqual(['project'])
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('closes the port of a plugin that is not here, has no page, or not that scope', () => {
    const { contexts } = setup()
    for (const tag of [{ ...TAG, pluginId: 'p.none' }, { ...TAG, pluginId: 'p.plain' }, { ...TAG, pluginId: 'p.jev' }]) {
      const opened = openPage(contexts, tag)
      expect(opened.attached, tag.pluginId).toBe(false)
      expect(opened.port.closed).toBe(true)
    }
    expect(openPage(contexts, { ...TAG, pluginId: 'p.jev', scope: 'app' }).attached).toBe(true)
  })

  it('routes messages both ways with the panel rules', async () => {
    const { contexts, withPage, logs } = setup()
    let page!: SettingsPageInstance
    withPage.settingsPage.onOpen((p) => (page = p))
    const { page: end } = openPage(contexts, TAG)
    const heard: unknown[] = []
    page.onMessage((m) => heard.push(m))
    const atPage: unknown[] = []
    end.onMessage((m) => atPage.push(m))
    page.post({ rules: [] })
    await flush()
    expect(atPage).toEqual(['{"rules":[]}'])
    expect(() => page.post('x'.repeat(1024 * 1024 + 1))).toThrow(RangeError)
    expect(() => page.post(undefined as never)).toThrow('not JSON')
    end.postMessage('{"type":"save"}')
    end.postMessage('not json')
    await flush()
    expect(heard).toEqual([{ type: 'save' }])
    expect(logs.some((l) => l.text.includes('not JSON'))).toBe(true)
  })

  it('keeps one page per plugin: a new open ends the older one', () => {
    const { contexts, withPage } = setup()
    const closed: string[] = []
    withPage.settingsPage.onOpen((p) => p.onClose(() => closed.push(p.scope)))
    const first = openPage(contexts, TAG)
    openPage(contexts, { ...TAG, id: 'p2', scope: 'app' })
    expect(closed).toEqual(['project'])
    expect(first.port.closed).toBe(true)
  })

  it("ends with main's close for that id only, or that port's close; a late onClose is still told", async () => {
    const { contexts, withPage } = setup()
    const pages: SettingsPageInstance[] = []
    const closed: string[] = []
    withPage.settingsPage.onOpen((p) => {
      pages.push(p)
      p.onClose(() => closed.push(`closed ${pages.length}`))
    })
    const first = openPage(contexts, TAG)
    // A stale close (an older id) leaves the page alone.
    contexts.handleEvent('settingsPage.close', { pluginId: 'p.inbox', id: 'p0' })
    expect(closed).toEqual([])
    contexts.handleEvent('settingsPage.close', { pluginId: 'p.inbox', id: 'p1' })
    expect(closed).toEqual(['closed 1'])
    const late: string[] = []
    pages[0]!.onClose(() => late.push('late'))
    await flush()
    expect(late).toEqual(['late'])
    // The old port's close after a new page opened does not take the new one down.
    openPage(contexts, { ...TAG, id: 'p2' })
    contexts.detachSettingsPagePort('p.inbox', 'p1', first.port)
    expect(closed).toEqual(['closed 1'])
  })

  it('ends the page and drops listeners when the plugin is disposed', () => {
    const { contexts, withPage } = setup()
    const closed: string[] = []
    let opens = 0
    withPage.settingsPage.onOpen((p) => {
      opens++
      p.onClose(() => closed.push(p.scope))
    })
    openPage(contexts, TAG)
    contexts.dispose('p.inbox')
    expect(closed).toEqual(['project'])
    expect(opens).toBe(1)
  })
})

describe('settingsPageOpenTag', () => {
  it("reads main's tag and nothing else", () => {
    expect(settingsPageOpenTag(JSON.stringify({ settingsPageOpen: TAG }))).toEqual(TAG)
    for (const bad of [
      { settingsPageOpen: { ...TAG, scope: 'global' } },
      { settingsPageOpen: { ...TAG, id: 'x' } },
      { settingsPageOpen: { ...TAG, pluginId: 5 } },
      { panelPort: { pluginId: 'p.inbox', panelId: 'main' } },
      null
    ]) {
      expect(settingsPageOpenTag(JSON.stringify(bad))).toBeUndefined()
    }
    expect(settingsPageOpenTag('not json')).toBeUndefined()
    expect(settingsPageOpenTag({ settingsPageOpen: TAG })).toBeUndefined()
  })
})

describe('the settingsPage field of a host spec', () => {
  const base = { id: 'p.a', dir: '/p', main: 'h.js', projectDir: '/x', dataDir: '/d', appDataDir: '/a', storageFile: '/s', commands: [], settings: { project: {}, app: {} } }
  it('is passed through when it lists scopes, and refused otherwise', () => {
    expect(parsePluginSpecs({ plugins: [{ ...base, settingsPage: ['project'] }] })[0]?.settingsPage).toEqual(['project'])
    expect(parsePluginSpecs({ plugins: [base] })[0]?.settingsPage).toBeUndefined()
    expect(() => parsePluginSpecs({ plugins: [{ ...base, settingsPage: ['global'] }] })).toThrow('settingsPage must be')
    expect(() => parsePluginSpecs({ plugins: [{ ...base, settingsPage: 'app' }] })).toThrow('settingsPage must be')
  })
})
