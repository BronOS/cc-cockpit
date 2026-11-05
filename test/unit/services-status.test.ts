import { describe, expect, it } from 'vitest'
import { selectProvider, selectSlotProvider, serviceProblemMessage, serviceStatus, slotStatus, type ServicePlugin, type SlotPlugin } from '../../src/shared/services'
import { SLOT_NONE, slotPickKey, slotTypeOfPickKey } from '../../src/shared/slots'

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
    if (!r.ok) expect(serviceProblemMessage(r.problem)).toBe('plugins a and b both provide service "triage"; pick one in Settings > This Project')
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
    expect(msg).toBe('plugins A, B and C both provide service "s"; pick one in Settings > This Project')
  })

  it('is not fooled by names that exist on Object.prototype', () => {
    expect(selectProvider('constructor', [prov('a', { triage: 1 })], {}).ok).toBe(false)
    expect(selectProvider('triage', [prov('a', { triage: 1 }), prov('b', { triage: 1 })], {}).ok).toBe(false)
  })
})

describe('serviceStatus', () => {
  it('collected name: a provider at another major is a problem on the collector, a same-major one is not', () => {
    const collector: ServicePlugin = { id: 'inbox', services: { uses: { feed: 2 }, collects: ['feed'] } }
    const s = serviceStatus([collector, prov('old', { feed: 1 }), prov('new', { feed: 2 })], {})
    expect(s.plugins.find((p) => p.id === 'inbox')!.problems).toEqual([
      { kind: 'collected-major', service: 'feed', consumer: 'inbox', usesVersion: 2, provider: 'old', providesVersion: 1 }
    ])
    expect(s.plugins.find((p) => p.id === 'old')!.problems).toEqual([])
    expect(s.services[0]).toMatchObject({ collectedOnly: true })
    const none = serviceStatus([collector, prov('new', { feed: 2 })], {})
    expect(none.plugins.find((p) => p.id === 'inbox')!.problems).toEqual([])
  })

  it('collected-major message names the provider and the collector', () => {
    const msg = serviceProblemMessage(
      { kind: 'collected-major', service: 'inbox-feed', consumer: 'inbox', usesVersion: 2, provider: 'gmail', providesVersion: 1 },
      (id) => ({ inbox: 'Inbox', gmail: 'Gmail' })[id] ?? id
    )
    expect(msg).toBe('Gmail provides inbox-feed 1, Inbox reads 2: update Gmail')
  })

  it('is empty for plugins without services', () => {
    expect(serviceStatus([{ id: 'a' }], {})).toEqual({ plugins: [{ id: 'a', provides: [], uses: [], problems: [] }], services: [] })
  })

  it('none: a consumer with no provider gets a missing problem', () => {
    const s = serviceStatus([cons('c', { triage: 1 })], {})
    expect(s.plugins[0]!.problems).toEqual([{ kind: 'missing', service: 'triage' }])
    expect(s.services).toEqual([{ service: 'triage', candidates: [], selected: null, collectedOnly: false }])
  })

  it('one provider: selected, no problems', () => {
    const s = serviceStatus([prov('p', { triage: 1 }), cons('c', { triage: 1 })], {})
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([])
    expect(s.plugins.find((p) => p.id === 'p')!.provides).toEqual([{ service: 'triage', version: 1 }])
    expect(s.services).toEqual([{ service: 'triage', candidates: ['p'], selected: 'p', collectedOnly: false }])
  })

  it('two unpicked: ambiguous', () => {
    const s = serviceStatus([prov('a', { triage: 1 }), prov('b', { triage: 1 }), cons('c', { triage: 1 })], {})
    expect(s.plugins.find((p) => p.id === 'c')!.problems).toEqual([{ kind: 'ambiguous', service: 'triage', candidates: ['a', 'b'] }])
    expect(s.services[0]).toEqual({ service: 'triage', candidates: ['a', 'b'], selected: null, collectedOnly: false })
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

describe('serviceStatus with collectors (services.collects)', () => {
  const coll = (id: string, name: string): ServicePlugin => ({ id, services: { uses: { [name]: 1 }, collects: [name] } })

  it('reports no pick and no problem for a name only collectors use', () => {
    const st = serviceStatus([prov('chat', { 'inbox-feed': 1 }), prov('mail', { 'inbox-feed': 1 }), coll('inbox', 'inbox-feed')], {})
    expect(st.services).toEqual([{ service: 'inbox-feed', candidates: ['chat', 'mail'], selected: null, collectedOnly: true }])
    expect(st.plugins.find((p) => p.id === 'inbox')?.problems).toEqual([])
  })

  it('a collector with no provider has no problem either', () => {
    expect(serviceStatus([coll('inbox', 'inbox-feed')], {}).plugins[0]?.problems).toEqual([])
  })

  it('a plain use consumer beside a collector still needs the pick', () => {
    const st = serviceStatus([prov('chat', { 'inbox-feed': 1 }), prov('mail', { 'inbox-feed': 1 }), coll('inbox', 'inbox-feed'), cons('plain', { 'inbox-feed': 1 })], {})
    expect(st.services[0]?.collectedOnly).toBe(false)
    expect(st.plugins.find((p) => p.id === 'plain')?.problems.map((p) => p.kind)).toEqual(['ambiguous'])
  })

  it('a name nobody uses is not collectedOnly', () => {
    expect(serviceStatus([prov('chat', { 'inbox-feed': 1 })], {}).services[0]?.collectedOnly).toBe(false)
  })
})

describe('slot picks (selectSlotProvider / slotStatus)', () => {
  const slotsOf = (id: string, ...types: string[]): SlotPlugin => ({ id, slots: types.map((type) => ({ type })) })
  const plain: SlotPlugin = { id: 'x.plain' }

  it('the key helpers round-trip a valid type only', () => {
    expect(slotPickKey('agenda')).toBe('@slot:agenda')
    expect(slotTypeOfPickKey('@slot:agenda')).toBe('agenda')
    for (const key of ['agenda', '@slot:', '@slot:Agenda', '@open-file', '@slotagenda']) expect(slotTypeOfPickKey(key)).toBeUndefined()
  })

  it('no candidate: nothing draws and there is no row', () => {
    expect(selectSlotProvider('agenda', [plain, slotsOf('x.other', 'weather')], {})).toBeNull()
    expect(slotStatus([plain], {})).toEqual([])
  })

  it('one candidate draws without a pick; @none turns it off', () => {
    const plugins = [plain, slotsOf('a.cal', 'agenda')]
    expect(selectSlotProvider('agenda', plugins, {})).toBe('a.cal')
    expect(slotStatus(plugins, {})).toEqual([{ type: 'agenda', candidates: ['a.cal'], selected: 'a.cal' }])
    const off = { [slotPickKey('agenda')]: SLOT_NONE }
    expect(selectSlotProvider('agenda', plugins, off)).toBeNull()
    expect(slotStatus(plugins, off)).toEqual([{ type: 'agenda', candidates: ['a.cal'], selected: SLOT_NONE }])
  })

  it('two candidates draw none until one is picked; a stale pick counts as none', () => {
    const plugins = [slotsOf('a.cal', 'agenda'), slotsOf('b.cal', 'agenda', 'weather')]
    expect(selectSlotProvider('agenda', plugins, {})).toBeNull()
    expect(slotStatus(plugins, {})).toEqual([
      { type: 'agenda', candidates: ['a.cal', 'b.cal'], selected: null },
      { type: 'weather', candidates: ['b.cal'], selected: 'b.cal' }
    ])
    const picked = { '@slot:agenda': 'b.cal' }
    expect(selectSlotProvider('agenda', plugins, picked)).toBe('b.cal')
    expect(slotStatus(plugins, picked)[0]?.selected).toBe('b.cal')
    // Gone, or a plugin that does not declare the type.
    for (const stale of [{ '@slot:agenda': 'c.gone' }, { '@slot:agenda': 'x.plain' }]) {
      expect(selectSlotProvider('agenda', [...plugins, plain], stale)).toBeNull()
      expect(slotStatus([...plugins, plain], stale)[0]?.selected).toBeNull()
    }
    // The pick of one type does not choose for another, and a service pick of the bare name is not a slot pick.
    expect(selectSlotProvider('agenda', plugins, { '@slot:weather': 'a.cal', agenda: 'b.cal' })).toBeNull()
  })

  it('reads only own keys of the picks', () => {
    const plugins = [slotsOf('a.cal', 'agenda'), slotsOf('b.cal', 'agenda')]
    expect(selectSlotProvider('agenda', plugins, Object.create({ '@slot:agenda': 'a.cal' }) as Record<string, string>)).toBeNull()
  })

  it('slot picks are not services: serviceStatus ignores slot declarations and keys', () => {
    const plugins: (ServicePlugin & SlotPlugin)[] = [{ ...slotsOf('a.cal', 'agenda'), services: { provides: { mail: 1 } } }]
    expect(serviceStatus(plugins, { '@slot:agenda': 'a.cal' }).services.map((s) => s.service)).toEqual(['mail'])
  })
})
