// A guest's tab across a restart (design-guests §7, D-21) and the restore's new-ids hook (spec-review 1): tabRecordsOf
// saves openedByGuest, the plan reads it back (Claude and shell tabs only, a damaged value dropped), failedRecord keeps it
// for a tab that did not start, and onRestored(projectId, idMap) runs once per run, after restoreGroups, throw-safe.
import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import type { TabRecord } from '../../src/shared/types'
import { buildRestorePlan, TabRestorer, tabRecordsOf } from '../../src/main/restore'

const info = (extra: Partial<TabInfo> & Pick<TabInfo, 'id' | 'kind'>): TabInfo => ({ gen: 1, cwd: '/p', ...extra })
const rec = (extra: Partial<TabRecord> & Pick<TabRecord, 'id' | 'kind'>): TabRecord => ({ cwd: '/p', ...extra })
const planOf = (tabs: unknown[]) => buildRestorePlan({ path: '/p', tabs: tabs as TabRecord[] })

describe('openedByGuest in the saved records and the plan', () => {
  it('tabRecordsOf saves it, and only when set', () => {
    const records = tabRecordsOf([info({ id: 'a', kind: 'claude', openedByGuest: 'g1' }), info({ id: 'b', kind: 'shell' })])
    expect(records[0]).toMatchObject({ id: 'a', openedByGuest: 'g1' })
    expect('openedByGuest' in records[1]!).toBe(false)
  })

  it('the plan reads it back for a Claude and a shell tab', () => {
    const plan = planOf([rec({ id: 'a', kind: 'claude', openedByGuest: 'g1' }), rec({ id: 'b', kind: 'shell', openedByGuest: 'g2' })])
    expect(plan.map((t) => t.openedByGuest)).toEqual(['g1', 'g2'])
  })

  it('drops a damaged value (empty, over 64 chars, not a string) and keeps the tab', () => {
    const plan = planOf([
      { ...rec({ id: 'a', kind: 'shell' }), openedByGuest: '' },
      { ...rec({ id: 'b', kind: 'shell' }), openedByGuest: 'x'.repeat(65) },
      { ...rec({ id: 'c', kind: 'claude' }), openedByGuest: 5 },
      { ...rec({ id: 'd', kind: 'shell' }), openedByGuest: 'x'.repeat(64) }
    ])
    expect(plan).toHaveLength(4)
    expect(plan.map((t) => t.openedByGuest)).toEqual([undefined, undefined, undefined, 'x'.repeat(64)])
  })

  it('a command tab never carries it', () => {
    const plan = planOf([{ id: 'c', kind: 'command', cwd: '/p', label: 'X', command: 'ls', openedByGuest: 'g1' }])
    expect(plan.every((t) => t.openedByGuest === undefined)).toBe(true)
  })

  it('a tab that failed to start keeps it in the saved record', async () => {
    const saved: TabRecord[][] = []
    const restorer = new TabRestorer({ listTabs: () => [], saveTabs: (_p, r) => saved.push(r), projectPath: () => '/p', log: () => {} })
    restorer.queue('p1', [{ kind: 'shell', openedByGuest: 'g1' }, { kind: 'claude', cwd: '/p', openedByGuest: 'g2' }])
    await restorer.restore('p1', Promise.resolve(), () => {
      throw new Error('out of ptys')
    })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.map((r) => [r.kind, r.openedByGuest])).toEqual([
      ['shell', 'g1'],
      ['claude', 'g2']
    ])
  })
})

describe('onRestored', () => {
  function setup(onRestored: (projectId: string, idMap: ReadonlyMap<string, string>) => void) {
    const order: string[] = []
    const logs: string[] = []
    const maps: Array<{ groups: Array<[string, string]>; restored: Array<[string, string]> }> = []
    let groupsMap: Array<[string, string]> = []
    const restorer = new TabRestorer({
      listTabs: () => [],
      saveTabs: () => order.push('save'),
      projectPath: () => '/p',
      restoreGroups: (_p, _saved, idMap) => {
        order.push('groups')
        groupsMap = [...idMap]
      },
      onRestored: (p, idMap) => {
        order.push('restored')
        maps.push({ groups: groupsMap, restored: [...idMap] })
        onRestored(p, idMap)
      },
      log: (m) => logs.push(m)
    })
    return { restorer, order, logs, maps }
  }

  const run = (restorer: TabRestorer, fail = false) => {
    restorer.queue('p1', [
      { savedId: 's1', kind: 'shell' },
      { savedId: 's2', kind: 'shell' },
      { savedId: 's3', kind: 'claude' }
    ])
    let n = 0
    return restorer.restore('p1', Promise.resolve(), (t) => {
      if (fail && t.savedId === 's2') throw new Error('no pty')
      return { id: `new-${++n}` }
    })
  }

  it('is called once with the same idMap as restoreGroups, after it and before the save', async () => {
    const calls: string[] = []
    const { restorer, order, maps } = setup((p) => calls.push(p))
    await run(restorer)
    expect(calls).toEqual(['p1'])
    expect(maps).toEqual([
      {
        groups: [['s1', 'new-1'], ['s2', 'new-2'], ['s3', 'new-3']],
        restored: [['s1', 'new-1'], ['s2', 'new-2'], ['s3', 'new-3']]
      }
    ])
    expect(order).toEqual(['groups', 'restored', 'save'])
  })

  it('a tab that failed to start is not in the map', async () => {
    const { restorer, maps } = setup(() => {})
    await run(restorer, true)
    expect(maps[0]!.restored).toEqual([['s1', 'new-1'], ['s3', 'new-2']])
  })

  it('a second restore of the same project does not call it again', async () => {
    const { restorer, maps } = setup(() => {})
    await run(restorer)
    await restorer.restore('p1', Promise.resolve(), () => ({ id: 'x' }))
    expect(maps).toHaveLength(1)
  })

  it('a throw is logged and the restore still completes: the tabs are saved', async () => {
    const { restorer, order, logs } = setup(() => {
      throw new Error('boom')
    })
    await run(restorer)
    expect(order).toEqual(['groups', 'restored', 'save'])
    expect(logs.join('\n')).toMatch(/listener of the new tab ids failed: boom/)
  })

  it('is not called when the window closed while the login env was captured', async () => {
    const { restorer, maps } = setup(() => {})
    restorer.queue('p1', [{ savedId: 's1', kind: 'shell' }])
    let release!: () => void
    const ready = new Promise<void>((r) => (release = r))
    const done = restorer.restore('p1', ready, () => ({ id: 'n1' }))
    restorer.clear('p1')
    release()
    await done
    expect(maps).toEqual([])
  })

  it('absent: nobody listens and the restore is unchanged', async () => {
    const saves: number[] = []
    const restorer = new TabRestorer({ listTabs: () => [], saveTabs: () => saves.push(1), projectPath: () => '/p', log: () => {} })
    await run(restorer)
    expect(saves).toEqual([1])
  })
})
