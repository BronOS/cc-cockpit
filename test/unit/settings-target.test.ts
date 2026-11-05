import { describe, expect, it } from 'vitest'
import { targetOf } from '../../src/renderer/settings/settings-target'

const ev = (detail: unknown): Event => ({ detail }) as unknown as Event

describe('targetOf (the panel gear request, design-next §5.3)', () => {
  it('accepts a project or app scope with a plugin id', () => {
    expect(targetOf(ev({ scope: 'project', pluginId: 'a.b' }))).toEqual({ scope: 'project', pluginId: 'a.b' })
    expect(targetOf(ev({ scope: 'app', pluginId: 'a.b', extra: 1 }))).toEqual({ scope: 'app', pluginId: 'a.b' })
  })
  it('refuses anything else', () => {
    for (const d of [null, undefined, 'x', 3, {}, { scope: 'window', pluginId: 'a' }, { scope: 'app', pluginId: '' }, { scope: 'app', pluginId: 5 }]) {
      expect(targetOf(ev(d))).toBeNull()
    }
  })
})
