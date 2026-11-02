import { describe, expect, it } from 'vitest'
import { selectProvider, serviceProblemMessage, serviceStatus, type ServicePlugin } from '../../src/shared/services'

const prov = (id: string, provides: Record<string, number>): ServicePlugin => ({ id, services: { provides } })
const cons = (id: string, uses: Record<string, number>): ServicePlugin => ({ id, services: { uses } })

describe('selectProvider', () => {
  it('reports missing when nobody provides it', () => {
    const r = selectProvider('triage', [cons('c', { triage: 1 })], {})
    expect(r).toEqual({ ok: false, problem: { kind: 'missing', service: 'triage' } })
    if (!r.ok) expect(serviceProblemMessage(r.problem)).toBe('no enabled plugin in this project provides service "triage"')
  })

  it('selects the only provider without a choice', () => {
    expect(selectProvider('triage', [prov('a', { triage: 2 })], {})).toEqual({ ok: true, provider: 'a', version: 2 })
  })

  it('is ambiguous with two providers and no choice', () => {
    const r = selectProvider('triage', [prov('a', { triage: 1 }), prov('b', { triage: 1 })], {})
    expect(r).toEqual({ ok: false, problem: { kind: 'ambiguous', service: 'triage', candidates: ['a', 'b'] } })
    if (!r.ok) expect(serviceProblemMessage(r.problem)).toBe('plugins a and b both provide service "triage"; pick one in Settings > Plugins')
  })

  it('uses the pick among two providers', () => {
    const plugins = [prov('a', { triage: 1 }), prov('b', { triage: 1 })]
    expect(selectProvider('triage', plugins, { triage: 'b' })).toEqual({ ok: true, provider: 'b', version: 1 })
  })

  it('treats a pick that is not a provider in the set as no choice', () => {
    const plugins = [prov('a', { triage: 1 }), prov('b', { triage: 1 })]
    expect(selectProvider('triage', plugins, { triage: 'gone' }).ok).toBe(false)
    // One provider left: the stale pick is ignored, the remaining provider answers.
    expect(selectProvider('triage', [plugins[0]!], { triage: 'gone' })).toEqual({ ok: true, provider: 'a', version: 1 })
  })

  it('reports a version mismatch with the consumer', () => {
    const r = selectProvider('triage', [prov('a', { triage: 1 })], {}, { id: 'c', version: 2 })
    expect(r).toEqual({
      ok: false,
      problem: { kind: 'version-mismatch', service: 'triage', consumer: 'c', usesVersion: 2, provider: 'a', providesVersion: 1 }
    })
    if (!r.ok) expect(serviceProblemMessage(r.problem)).toBe('"triage": c uses version 2, a provides version 1')
    expect(selectProvider('triage', [prov('a', { triage: 1 })], {}, { id: 'c', version: 1 }).ok).toBe(true)
  })

  it('lists three candidates and maps ids to names', () => {
    const msg = serviceProblemMessage({ kind: 'ambiguous', service: 's', candidates: ['a', 'b', 'c'] }, (id) => id.toUpperCase())
    expect(msg).toBe('plugins A, B and C both provide service "s"; pick one in Settings > Plugins')
  })

  it('is not fooled by names that exist on Object.prototype', () => {
    expect(selectProvider('constructor', [prov('a', { triage: 1 })], {}).ok).toBe(false)
    expect(selectProvider('triage', [prov('a', { triage: 1 }), prov('b', { triage: 1 })], {}).ok).toBe(false)
  })
})

describe('serviceStatus', () => {
  it('is empty for plugins without services', () => {
    expect(serviceStatus([{ id: 'a' }], {})).toEqual({ plugins: [{ id: 'a', provides: [], uses: [], problems: [] }], services: [] })
  })

  it('none: a consumer with no provider gets a missing problem', () => {
    const s = serviceStatus([cons('c', { triage: 1 })], {})
    expect(s.plugins[0]!.problems).toEqual([{ kind: 'missing', service: 'triage' }])
    expect(s.services).toEqual([{ service: 'triage', candidates: [], selected: null }])
  })

  it('one provider: selected, no problems', () => {
    const s = serviceStatus([prov('p', { triage: 1 }), cons('c', { triage: 1 })], {})
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([])
    expect(s.plugins.find((p) => p.id === 'p')!.provides).toEqual([{ service: 'triage', version: 1 }])
    expect(s.services).toEqual([{ service: 'triage', candidates: ['p'], selected: 'p' }])
  })

  it('two unpicked: ambiguous', () => {
    const s = serviceStatus([prov('a', { triage: 1 }), prov('b', { triage: 1 }), cons('c', { triage: 1 })], {})
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([{ kind: 'ambiguous', service: 'triage', candidates: ['a', 'b'] }])
    expect(s.services[0]).toEqual({ service: 'triage', candidates: ['a', 'b'], selected: null })
  })

  it('two picked: selected, no problems', () => {
    const s = serviceStatus([prov('a', { triage: 1 }), prov('b', { triage: 1 }), cons('c', { triage: 1 })], { triage: 'a' })
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([])
    expect(s.services[0]!.selected).toBe('a')
  })

  it('stale pick counts as no choice', () => {
    const s = serviceStatus([prov('a', { triage: 1 }), prov('b', { triage: 1 }), cons('c', { triage: 1 })], { triage: 'removed' })
    expect(s.services[0]!.selected).toBeNull()
    expect(s.plugins.find((p) => p.id === 'c')!.problems[0]!.kind).toBe('ambiguous')
  })

  it('version mismatch is reported on the consumer, the provider stays selected', () => {
    const s = serviceStatus([prov('p', { triage: 1 }), cons('c', { triage: 2 })], {})
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([
      { kind: 'version-mismatch', service: 'triage', consumer: 'c', usesVersion: 2, provider: 'p', providesVersion: 1 }
    ])
    expect(s.services[0]!.selected).toBe('p')
  })

  it('sorts services by name', () => {
    const s = serviceStatus([prov('p', { zeta: 1, alpha: 1 })], {})
    expect(s.services.map((x) => x.service)).toEqual(['alpha', 'zeta'])
  })
})
