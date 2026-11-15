import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EnablementPlugin } from '../../src/main/plugins/enablement'
import type { RoomOwner } from '../../src/main/rooms/room-registry'
import { RoomsPluginGate } from '../../src/main/rooms/rooms-plugin-gate'

// The two halves of "a room ends with its plugin" (design-rooms.md §1): the sweep and the refusal share one rule.
function setup() {
  const plugins = new Map<string, { plugin: EnablementPlugin; revoked: boolean }>([
    ['x.team', { plugin: { id: 'x.team', source: { kind: 'git' } }, revoked: false }],
    ['cockpit.team', { plugin: { id: 'cockpit.team', enabledByDefault: true, source: { kind: 'bundled' } }, revoked: false }]
  ])
  const projects = new Map<string, { enabledPlugins?: string[]; disabledPlugins?: string[] } | 'unknown'>([
    ['p1', { enabledPlugins: ['x.team'] }],
    ['p2', { enabledPlugins: ['x.team'] }]
  ])
  let disabledBundled: string[] = []
  // The live owners a room service would walk; `ended` collects what the sweep ended, with why.
  const live: RoomOwner[] = [
    { pluginId: 'x.team', projectId: 'p1' },
    { pluginId: 'x.team', projectId: 'p2' },
    { pluginId: 'cockpit.team', projectId: 'p1' }
  ]
  const ended: string[] = []
  let sweeps = 0
  const gate = new RoomsPluginGate({
    plugin: (id) => plugins.get(id),
    project: (id) => projects.get(id),
    disabledBundled: () => disabledBundled,
    endRoomsOfPluginsOff: (offWhy) => {
      sweeps++
      for (const o of live) {
        const why = offWhy(o)
        if (why !== undefined) ended.push(`${o.pluginId}@${o.projectId}: ${why}`)
      }
      live.splice(0, live.length, ...live.filter((o) => offWhy(o) === undefined))
    }
  })
  return {
    gate,
    plugins,
    projects,
    ended,
    sweeps: () => sweeps,
    offAppWide: (ids: string[]) => void (disabledBundled = ids)
  }
}

describe('RoomsPluginGate', () => {
  it('never sweeps before the plugins loaded, nor after a failed load (every plugin would look removed)', () => {
    const s = setup()
    s.plugins.clear()
    s.gate.sweep()
    expect(s.sweeps()).toBe(0)
    s.gate.loaded(true)
    s.gate.sweep()
    expect(s.sweeps()).toBe(0)
    expect(s.ended).toEqual([])
  })

  it('sweeps once when the load finished, and on every change after it', () => {
    const s = setup()
    s.gate.loaded(false)
    expect(s.sweeps()).toBe(1)
    s.gate.sweep()
    expect(s.sweeps()).toBe(2)
    expect(s.ended).toEqual([])
  })

  it('a switch-off in one project ends the rooms there only; off in all projects ends a bundled plugin everywhere', () => {
    const s = setup()
    s.gate.loaded(false)
    s.projects.set('p1', { enabledPlugins: [] })
    s.gate.sweep()
    expect(s.ended).toEqual(['x.team@p1: plugin disabled'])
    s.offAppWide(['cockpit.team'])
    s.gate.sweep()
    expect(s.ended).toEqual(['x.team@p1: plugin disabled', 'cockpit.team@p1: plugin disabled'])
  })

  it('an uninstall and a revocation end the rooms; installing an unrelated plugin ends nothing', () => {
    const s = setup()
    s.gate.loaded(false)
    s.plugins.set('y.other', { plugin: { id: 'y.other', source: { kind: 'git' } }, revoked: false })
    s.gate.sweep()
    expect(s.ended).toEqual([])
    s.plugins.set('cockpit.team', { ...s.plugins.get('cockpit.team')!, revoked: true })
    s.plugins.delete('x.team')
    s.gate.sweep()
    expect(s.ended.sort()).toEqual(['cockpit.team@p1: plugin revoked', 'x.team@p1: plugin removed', 'x.team@p2: plugin removed'])
  })

  it('keeps the rooms of a project whose record cannot be read; a forgotten one ends them as project removed (review m2)', () => {
    const s = setup()
    s.gate.loaded(false)
    s.projects.set('p1', 'unknown')
    s.gate.sweep()
    expect(s.ended).toEqual([])
    s.projects.delete('p2')
    s.gate.sweep()
    expect(s.ended).toEqual(['x.team@p2: project removed'])
  })

  it('answers the refusal by the same rule before and after the load', () => {
    const s = setup()
    expect(s.gate.offWhy({ pluginId: 'x.team', projectId: 'p1' })).toBeUndefined()
    s.projects.set('p1', { disabledPlugins: ['x.team'] })
    expect(s.gate.offWhy({ pluginId: 'x.team', projectId: 'p1' })).toBe('plugin disabled')
    expect(s.gate.offWhy({ pluginId: 'gone.plugin', projectId: 'p1' })).toBe('plugin removed')
  })
})

describe('main wires the gate (index.ts)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  // The start of a handler (its key is unique in index.ts): the sweep is among its first lines.
  const body = (key: string): string => {
    const at = source.indexOf(key)
    expect(at, key).toBeGreaterThan(-1)
    expect(source.indexOf(key, at + 1), key).toBe(-1)
    return source.slice(at, at + 400)
  }

  it('sweeps after the load (with its failure flag), on every installer change and after both Plugins page switches', () => {
    expect(source).toContain('void pluginsLoaded.then(() => roomsGate.loaded(pluginsLoadFailed))')
    expect(body('    onChange: () => {')).toContain('roomsGate.sweep()')
    expect(body('    bundledOffChanged: async (pluginId) => {')).toContain('roomsGate.sweep()')
    expect(body('    enabledChanged: (projectId) => {')).toContain('roomsGate.sweep()')
  })

  it('gives HostApi the same rule for its refusal', () => {
    expect(source).toContain('roomsOff: (owner) => roomsGate.offWhy(owner)')
    expect(source).toContain('project: (projectId) => registry.enablementRecord(projectId)')
  })
})
