// The user's new-tab menu entries (src/main/tabs/tab-commands.ts): reading damaged settings,
// checking a list to save, the menu's two groups, and the lookup by id that is the only way a
// command tab gets its command line.
import { describe, expect, it } from 'vitest'
import {
  checkTabCommands,
  newTabMenu,
  openTabCommand,
  tabCommandsOf,
  TabCommandsService
} from '../../src/main/tabs/tab-commands'
import {
  checkTabCommandLabel,
  checkTabCommandLine,
  checkTabCommandOpen,
  TAB_COMMAND_LABEL_MAX,
  TAB_COMMAND_MAX,
  TAB_COMMANDS_MAX
} from '../../src/shared/tab-commands'
import type { TabCommandEntry } from '../../src/shared/types'

const P = 'aaaaaaaaaaaaaaaa'
const entry = (id: string, label = `L${id}`, command = `echo ${id}`): TabCommandEntry => ({ id, label, command })

describe('label and command checks', () => {
  it('takes 1-60 characters of one-line label, trimmed', () => {
    expect(checkTabCommandLabel('  Git  ')).toEqual({ ok: true, value: 'Git' })
    expect(checkTabCommandLabel('x'.repeat(TAB_COMMAND_LABEL_MAX)).ok).toBe(true)
    for (const bad of ['', '   ', 'x'.repeat(TAB_COMMAND_LABEL_MAX + 1), 'two\nlines', 'esc\u001b[31m', 'nul\0', 5, null]) {
      expect(checkTabCommandLabel(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('takes 1-4096 characters of command line without NUL; newlines and shell syntax are fine', () => {
    expect(checkTabCommandLine(' docker compose logs -f | grep api ')).toEqual({
      ok: true,
      value: 'docker compose logs -f | grep api'
    })
    expect(checkTabCommandLine('make\nmake test').ok).toBe(true)
    expect(checkTabCommandLine('x'.repeat(TAB_COMMAND_MAX)).ok).toBe(true)
    for (const bad of ['', ' \n ', 'x'.repeat(TAB_COMMAND_MAX + 1), 'echo a\0b', {}, undefined]) {
      expect(checkTabCommandLine(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('tabCommandsOf (reading a user-writable file)', () => {
  it('keeps valid entries in order', () => {
    expect(tabCommandsOf([entry('a', 'Git', 'lazygit'), entry('b')])).toEqual([entry('a', 'Git', 'lazygit'), entry('b')])
  })

  it('reads anything but a list as no entries', () => {
    for (const damaged of [undefined, null, 'lazygit', 5, { a: entry('a') }]) {
      expect(tabCommandsOf(damaged)).toEqual([])
    }
  })

  it('drops bad entries, not the list', () => {
    const stored: unknown[] = [
      'junk',
      null,
      [entry('arr')],
      { label: 'No id', command: 'x' },
      { id: '', label: 'Empty id', command: 'x' },
      { id: 'has space', label: 'Bad id', command: 'x' },
      { id: 'n', label: 'Nul', command: 'echo \0' },
      { id: 'l', label: 'x'.repeat(61), command: 'x' },
      { id: 'c', label: 'No command' },
      entry('ok'),
      { ...entry('ok'), label: 'Repeated id' },
      { id: 'trim', label: '  Trim  ', command: '  htop  ', extra: true }
    ]
    expect(tabCommandsOf(stored)).toEqual([entry('ok'), { id: 'trim', label: 'Trim', command: 'htop' }])
  })

  it("keeps `open: 'overlay'`; absent, 'tab' or a damaged value reads as a tab (no `open` field)", () => {
    const stored: unknown[] = [
      { ...entry('o'), open: 'overlay' },
      { ...entry('t'), open: 'tab' },
      entry('old'),
      { ...entry('typo'), open: 'Overlay' },
      { ...entry('num'), open: 1 },
      { ...entry('obj'), open: { overlay: true } }
    ]
    expect(tabCommandsOf(stored)).toEqual([
      { ...entry('o'), open: 'overlay' },
      entry('t'),
      entry('old'),
      entry('typo'),
      entry('num'),
      entry('obj')
    ])
  })

  it('keeps at most 50, counting valid entries only', () => {
    const stored = ['junk', ...Array.from({ length: TAB_COMMANDS_MAX + 5 }, (_, i) => entry(`e${i}`))]
    const read = tabCommandsOf(stored)
    expect(read).toHaveLength(TAB_COMMANDS_MAX)
    expect(read[0]!.id).toBe('e0')
    expect(read.at(-1)!.id).toBe(`e${TAB_COMMANDS_MAX - 1}`)
  })
})

describe('checkTabCommands (a list to save)', () => {
  let n = 0
  const mint = (): string => `new${++n}`

  it('keeps known ids, mints ids for new entries and for unknown or repeated ones', () => {
    n = 0
    const current = [entry('a'), entry('b')]
    const next = checkTabCommands(
      [
        { id: 'b', label: 'B', command: 'make' },
        { label: 'New', command: 'htop' },
        { id: 'planted', label: 'Planted', command: 'x' },
        { id: 'b', label: 'Copy of b', command: 'y' },
        { id: 'a', label: ' A ', command: ' lazygit ' }
      ],
      current,
      mint
    )
    expect(next).toEqual([
      { id: 'b', label: 'B', command: 'make' },
      { id: 'new1', label: 'New', command: 'htop' },
      { id: 'new2', label: 'Planted', command: 'x' },
      { id: 'new3', label: 'Copy of b', command: 'y' },
      { id: 'a', label: 'A', command: 'lazygit' }
    ])
  })

  it('refuses the whole list for one bad entry, naming it', () => {
    expect(() => checkTabCommands('x', [])).toThrow('give a list')
    expect(() => checkTabCommands([entry('a'), { label: '', command: 'x' }], [])).toThrow(/command 2: the label/)
    expect(() => checkTabCommands([{ label: 'Bad', command: 'a\0b' }], [])).toThrow(/command 1 \(Bad\): .*NUL/)
    expect(() => checkTabCommands([{ label: 'Long', command: 'x'.repeat(4097) }], [])).toThrow(/1-4096/)
    expect(() => checkTabCommands([null], [])).toThrow(/command 1/)
  })

  it("saves `open: 'overlay'` only; 'tab' and anything else are stored as a plain (tab) entry", () => {
    n = 0
    const next = checkTabCommands(
      [
        { label: 'Git', command: 'lazygit', open: 'overlay' },
        { label: 'Dev', command: 'npm run dev', open: 'tab' },
        { label: 'Top', command: 'htop', open: 'window' },
        { label: 'Logs', command: 'tail -f log' }
      ],
      [],
      mint
    )
    expect(next).toEqual([
      { id: 'new1', label: 'Git', command: 'lazygit', open: 'overlay' },
      { id: 'new2', label: 'Dev', command: 'npm run dev' },
      { id: 'new3', label: 'Top', command: 'htop' },
      { id: 'new4', label: 'Logs', command: 'tail -f log' }
    ])
  })

  it('refuses more than 50 entries', () => {
    const many = Array.from({ length: TAB_COMMANDS_MAX + 1 }, (_, i) => ({ label: `L${i}`, command: 'x' }))
    expect(() => checkTabCommands(many, [])).toThrow('at most 50')
    expect(checkTabCommands(many.slice(0, TAB_COMMANDS_MAX), [])).toHaveLength(TAB_COMMANDS_MAX)
  })
})

describe('newTabMenu', () => {
  it('lists app-wide entries, then the project ones, with labels and ids only', () => {
    expect(newTabMenu([entry('a', 'Git', 'lazygit')], [entry('p', 'Dev', 'npm run dev'), entry('q', 'Top', 'htop')])).toEqual({
      app: [{ id: 'a', label: 'Git' }],
      project: [
        { id: 'p', label: 'Dev' },
        { id: 'q', label: 'Top' }
      ]
    })
    expect(newTabMenu([], [])).toEqual({ app: [], project: [] })
  })

  it('marks overlay entries for the menu hint, still without the command line', () => {
    expect(newTabMenu([{ ...entry('a', 'Git', 'lazygit'), open: 'overlay' }], [entry('p', 'Dev')])).toEqual({
      app: [{ id: 'a', label: 'Git', open: 'overlay' }],
      project: [{ id: 'p', label: 'Dev' }]
    })
  })
})

describe('checkTabCommandOpen', () => {
  it("is 'overlay' for exactly that and 'tab' for anything else", () => {
    expect(checkTabCommandOpen('overlay')).toBe('overlay')
    for (const other of ['tab', undefined, null, 'Overlay', ' overlay', 1, true, {}, ['overlay']]) {
      expect(checkTabCommandOpen(other), JSON.stringify(other)).toBe('tab')
    }
  })
})

describe('openTabCommand (tab or overlay: main decides from the resolved entry)', () => {
  function rig() {
    const calls: Array<[string, { label: string; command: string }]> = []
    const to = {
      tab: (e: { label: string; command: string }) => {
        calls.push(['tab', e])
        return { tabId: 't1' }
      },
      overlay: (e: { label: string; command: string }) => {
        calls.push(['overlay', e])
      }
    }
    return { calls, to }
  }

  it('opens a tab entry as a tab and returns what the tab opener returned', () => {
    const { calls, to } = rig()
    expect(openTabCommand({ label: 'Dev', command: 'npm run dev', open: 'tab' }, to)).toEqual({ tabId: 't1' })
    expect(calls).toEqual([['tab', { label: 'Dev', command: 'npm run dev' }]])
  })

  it('opens an overlay entry as an overlay and returns null (no tab)', () => {
    const { calls, to } = rig()
    expect(openTabCommand({ label: 'Git', command: 'lazygit', open: 'overlay' }, to)).toBeNull()
    expect(calls).toEqual([['overlay', { label: 'Git', command: 'lazygit' }]])
  })

  it('a failing opener throws to the caller (the click shows the error)', () => {
    const failing = {
      tab: () => {
        throw new Error('spawn failed')
      },
      overlay: () => {
        throw new Error('cwd is not a directory')
      }
    }
    expect(() => openTabCommand({ label: 'a', command: 'a', open: 'tab' }, failing)).toThrow('spawn failed')
    expect(() => openTabCommand({ label: 'b', command: 'b', open: 'overlay' }, failing)).toThrow('not a directory')
  })
})

describe('TabCommandsService', () => {
  function rig() {
    const store: { app: unknown; projects: Record<string, unknown> } = { app: undefined, projects: { [P]: undefined } }
    let n = 0
    const service = new TabCommandsService({
      app: {
        get: () => store.app,
        set: (next) => {
          store.app = next
        }
      },
      project: {
        get: (id) => {
          if (!(id in store.projects)) throw new Error('the project record is gone')
          return store.projects[id]
        },
        set: (id, next) => {
          store.projects[id] = next
        }
      },
      mintId: () => `id${++n}`
    })
    return { service, store }
  }

  it('saves each level in its own store and composes the menu from both', () => {
    const { service, store } = rig()
    expect(service.set(P, 'app', [{ label: 'Git', command: 'lazygit' }])).toEqual([{ id: 'id1', label: 'Git', command: 'lazygit' }])
    service.set(P, 'project', [{ label: 'Dev', command: 'npm run dev' }])
    expect(store.app).toEqual([{ id: 'id1', label: 'Git', command: 'lazygit' }])
    expect(store.projects[P]).toEqual([{ id: 'id2', label: 'Dev', command: 'npm run dev' }])
    expect(service.menu(P)).toEqual({ app: [{ id: 'id1', label: 'Git' }], project: [{ id: 'id2', label: 'Dev' }] })
  })

  it('stores nothing when a list or a level is refused', () => {
    const { service, store } = rig()
    service.set(P, 'app', [{ label: 'Git', command: 'lazygit' }])
    expect(() => service.set(P, 'app', [{ label: 'Git', command: '' }])).toThrow()
    expect(() => service.set(P, 'user', [])).toThrow("'app' or 'project'")
    expect(store.app).toEqual([{ id: 'id1', label: 'Git', command: 'lazygit' }])
  })

  it('resolves an entry by level and id from its own store', () => {
    const { service, store } = rig()
    store.app = [entry('a', 'Git', 'lazygit')]
    store.projects[P] = [entry('p', 'Logs', 'docker compose logs -f | grep api')]
    expect(service.resolve(P, 'app', 'a')).toEqual({ label: 'Git', command: 'lazygit', open: 'tab' })
    expect(service.resolve(P, 'project', 'p')).toEqual({ label: 'Logs', command: 'docker compose logs -f | grep api', open: 'tab' })
  })

  it('resolves where an entry opens from its own store, whatever the menu showed', () => {
    const { service, store } = rig()
    store.app = [{ ...entry('a', 'Git', 'lazygit'), open: 'overlay' }, { ...entry('d', 'Dev', 'npm run dev'), open: 'bogus' }]
    expect(service.resolve(P, 'app', 'a')).toEqual({ label: 'Git', command: 'lazygit', open: 'overlay' })
    expect(service.resolve(P, 'app', 'd')).toEqual({ label: 'Dev', command: 'npm run dev', open: 'tab' })
    // Saving the editor's list keeps the overlay entry an overlay (and its id), and switches back.
    service.set(P, 'app', [{ id: 'a', label: 'Git', command: 'lazygit', open: 'tab' }])
    expect(store.app).toEqual([{ id: 'a', label: 'Git', command: 'lazygit' }])
    expect(service.resolve(P, 'app', 'a').open).toBe('tab')
    service.set(P, 'app', [{ id: 'a', label: 'Git', command: 'lazygit', open: 'overlay' }])
    expect(service.menu(P).app).toEqual([{ id: 'a', label: 'Git', open: 'overlay' }])
  })

  it('refuses an unknown id, the wrong level, a non-string id and a damaged entry', () => {
    const { service, store } = rig()
    store.app = [entry('a'), { id: 'bad', label: 'Bad', command: 'a\0b' }]
    expect(() => service.resolve(P, 'project', 'a')).toThrow('no such command')
    expect(() => service.resolve(P, 'app', 'zzz')).toThrow('no such command')
    expect(() => service.resolve(P, 'app', 'bad')).toThrow('no such command')
    expect(() => service.resolve(P, 'app', { command: 'rm -rf ~' })).toThrow('entry id')
    expect(() => service.resolve(P, 'raw', 'a')).toThrow("'app' or 'project'")
  })

  it('an entry deleted after the menu was drawn is refused, not run', () => {
    const { service } = rig()
    const [saved] = service.set(P, 'project', [{ label: 'Deploy', command: './deploy.sh' }])
    service.set(P, 'project', [])
    expect(() => service.resolve(P, 'project', saved!.id)).toThrow('no such command')
  })

  it('refuses the project level of a project whose record is gone', () => {
    const { service } = rig()
    expect(() => service.menu('ffffffffffffffff')).toThrow('record is gone')
  })
})
