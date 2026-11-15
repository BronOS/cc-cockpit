// The per-plugin caps the person sets (design-rooms.md §6): the defaults and ceilings, a stored
// override clamped on every read (app.json is user-writable), an edit checked whole, the round trip through the real
// app.json, the socket handlers (the write host-only, refused again by the handler), and the real `ccc plugin limits`
// against the real SocketServer: read from a tab, write refused in a tab, written from a shell.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from '../../src/cli/args'
import { buildRequest, run, type Output } from '../../src/cli/client'
import {
  appJsonLimitsStorage,
  applyLimitsEdit,
  effectiveLimits,
  globalLimits,
  globalLimitsView,
  limitsView,
  parseLimitValue,
  PluginLimitsStore,
  storedOverrides,
  type PluginLimitsStorage
} from '../../src/main/plugins/plugin-limits'
import { ProjectRegistry } from '../../src/main/projects/registry'
import { pluginLimitsHandler, pluginLimitsSetHandler, registerPluginLimitsHandlers } from '../../src/main/socket/handlers'
import { SocketServer, type Caller } from '../../src/main/socket/socket-server'
import { DEFAULT_PLUGIN_LIMITS, formatPluginLimits, PLUGIN_LIMIT_SPECS } from '../../src/shared/plugin-limits'
import { PLUGIN_LIMITS_HOST_ONLY_TEXT } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
const TOKEN = 'c'.repeat(64)
const WINDOW = 'w'.repeat(64)

let root: string
let closers: (() => Promise<void> | void)[]

beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'cclim-'))
  closers = []
})

afterEach(async () => {
  for (const close of closers) await close()
  rmSync(root, { recursive: true, force: true })
})

/** An in-memory storage: what is stored, as JSON would carry it; `global` holds the global values. */
function memory(
  initial: Record<string, unknown> = {},
  initialGlobal?: unknown
): PluginLimitsStorage & { data: Record<string, unknown>; global: { value: unknown } } {
  const data: Record<string, unknown> = { ...initial }
  const global = { value: initialGlobal }
  return {
    data,
    global,
    get: (id) => (Object.hasOwn(data, id) ? data[id] : undefined),
    set: (id, overrides) => {
      if (overrides === undefined) delete data[id]
      else data[id] = JSON.parse(JSON.stringify(overrides))
    },
    getGlobal: () => global.value,
    setGlobal: (values) => {
      global.value = values === undefined ? undefined : JSON.parse(JSON.stringify(values))
    }
  }
}

const store = (storage = memory(), known = (id: string) => id === 'a.one' || id === 'b.two'): PluginLimitsStore =>
  new PluginLimitsStore({ storage, known })

describe('defaults and ceilings (design-rooms.md §6)', () => {
  it('are the design numbers, one minute each', () => {
    expect(DEFAULT_PLUGIN_LIMITS).toEqual({ opensPerMinute: 5, sendsPerMinute: 30, roomSendsPerMember: 20, roomSendsPerRoom: 60 })
    expect(Object.fromEntries(PLUGIN_LIMIT_SPECS.map((s) => [s.key, s.ceiling]))).toEqual({
      opensPerMinute: 60,
      sendsPerMinute: 300,
      roomSendsPerMember: 120,
      roomSendsPerRoom: 600
    })
  })

  it('apply with nothing stored, for an unknown plugin too', () => {
    expect(store().limits('a.one')).toEqual(DEFAULT_PLUGIN_LIMITS)
    expect(store().limits('nobody.here')).toEqual(DEFAULT_PLUGIN_LIMITS)
    expect(effectiveLimits(undefined)).toEqual(DEFAULT_PLUGIN_LIMITS)
  })
})

describe('a stored override, as read (the file is user-writable)', () => {
  it('is clamped to the ceiling; a value that is no whole number from 1 is ignored', () => {
    expect(effectiveLimits({ opensPerMinute: 1000, sendsPerMinute: 300, roomSendsPerMember: 1, roomSendsPerRoom: 61 })).toEqual({
      opensPerMinute: 60,
      sendsPerMinute: 300,
      roomSendsPerMember: 1,
      roomSendsPerRoom: 61
    })
    for (const bad of [0, -3, 1.5, '7', null, true, Number.NaN, Number.POSITIVE_INFINITY, [9], { v: 9 }]) {
      expect(effectiveLimits({ opensPerMinute: bad }).opensPerMinute, String(bad)).toBe(5)
    }
  })

  it('counts only own properties of the known keys; a damaged entry reads as none', () => {
    const parsed = JSON.parse('{"__proto__": {"opensPerMinute": 50}, "unknownKey": 9, "sendsPerMinute": 100}') as unknown
    expect(storedOverrides(parsed)).toEqual({ sendsPerMinute: 100 })
    for (const damaged of ['x', 5, [], null]) expect(effectiveLimits(damaged)).toEqual(DEFAULT_PLUGIN_LIMITS)
  })

  it('is read on every call: an edit applies to the next one', () => {
    const storage = memory()
    const s = store(storage)
    expect(s.limits('a.one').opensPerMinute).toBe(5)
    storage.data['a.one'] = { opensPerMinute: 12 }
    expect(s.limits('a.one').opensPerMinute).toBe(12)
  })

  it('never throws from limits(): a failing storage gives the defaults', () => {
    const s = new PluginLimitsStore({
      storage: {
        get: () => {
          throw new Error('disk')
        },
        set: () => {},
        getGlobal: () => undefined,
        setGlobal: () => {}
      },
      known: () => true
    })
    expect(s.limits('a.one')).toEqual(DEFAULT_PLUGIN_LIMITS)
  })

  it('shows in the view with its default, ceiling and whether it is set', () => {
    const view = limitsView('a.one', { sendsPerMinute: 999 })
    expect(view.id).toBe('a.one')
    expect(view.limits.map((l) => [l.key, l.value, l.overridden, l.source, l.inherited, l.default, l.ceiling])).toEqual([
      ['opensPerMinute', 5, false, 'default', 5, 5, 60],
      ['sendsPerMinute', 300, true, 'plugin', 30, 30, 300],
      ['roomSendsPerMember', 20, false, 'default', 20, 20, 120],
      ['roomSendsPerRoom', 60, false, 'default', 60, 60, 600]
    ])
  })
})

describe('an edit', () => {
  it('sets numbers and digit strings, resets keys, and keeps the rest', () => {
    expect(applyLimitsEdit({ roomSendsPerRoom: 100 }, [['opensPerMinute', 10], ['sendsPerMinute', '45']], undefined)).toEqual({
      opensPerMinute: 10,
      sendsPerMinute: 45,
      roomSendsPerRoom: 100
    })
    expect(applyLimitsEdit({ roomSendsPerRoom: 100, opensPerMinute: 9 }, undefined, ['roomSendsPerRoom'])).toEqual({ opensPerMinute: 9 })
    // The ceiling itself and 1 are allowed.
    expect(applyLimitsEdit({}, [['opensPerMinute', '60'], ['roomSendsPerMember', 1]], [])).toEqual({ opensPerMinute: 60, roomSendsPerMember: 1 })
  })

  it('refuses a value outside 1..ceiling or not a plain whole number, naming the range', () => {
    for (const bad of ['0', '61', '1e1', '+5', ' 5', '5 ', '5.0', '-1', '', '1234567', '٥', 0, 61, 1.5, -2, true, null, [5], Number.NaN]) {
      expect(() => parseLimitValue('opensPerMinute', bad), String(bad)).toThrow('opensPerMinute must be a whole number from 1 to 60')
    }
    expect(() => parseLimitValue('roomSendsPerRoom', '601')).toThrow('from 1 to 600')
  })

  it('refuses an unknown key naming the known ones, a key named twice, and an empty or malformed edit, storing nothing', () => {
    expect(() => applyLimitsEdit({}, [['maxTabs', 3]], [])).toThrow(
      'unknown limit: maxTabs (the limits are opensPerMinute, sendsPerMinute, roomSendsPerMember, roomSendsPerRoom)'
    )
    expect(() => applyLimitsEdit({}, [['__proto__', 3]], [])).toThrow('unknown limit: __proto__')
    expect(() => applyLimitsEdit({}, [['opensPerMinute', 3]], ['opensPerMinute'])).toThrow('opensPerMinute is named twice')
    expect(() => applyLimitsEdit({}, [['opensPerMinute', 3], ['opensPerMinute', 4]], [])).toThrow('named twice')
    expect(() => applyLimitsEdit({}, [], [])).toThrow('nothing to change')
    expect(() => applyLimitsEdit({}, undefined, undefined)).toThrow('nothing to change')
    expect(() => applyLimitsEdit({}, { opensPerMinute: 3 }, [])).toThrow('list of [key, value] pairs')
    expect(() => applyLimitsEdit({}, [['opensPerMinute']], [])).toThrow('[key, value] pair')
    expect(() => applyLimitsEdit({}, Array.from({ length: 17 }, () => ['opensPerMinute', 3]), [])).toThrow('at most 16 changes')
    const storage = memory({ 'a.one': { opensPerMinute: 7 } })
    expect(() => store(storage).set('a.one', [['sendsPerMinute', 40], ['opensPerMinute', '999']], [])).toThrow('from 1 to 60')
    expect(storage.data).toEqual({ 'a.one': { opensPerMinute: 7 } })
  })

  it('is refused for a plugin that is not installed, and so is a read', () => {
    const storage = memory()
    expect(() => store(storage).set('nobody.here', [['opensPerMinute', 9]], [])).toThrow('nobody.here is not installed')
    expect(() => store(storage).view('nobody.here')).toThrow('not installed')
    expect(() => store(storage).view(5)).toThrow('needs a plugin id')
    expect(storage.data).toEqual({})
  })

  it('answers the new view; dropping the last override removes the plugin entry', () => {
    const storage = memory()
    const s = store(storage)
    const view = s.set('a.one', [['opensPerMinute', '20']], [])
    expect(view.limits.find((l) => l.key === 'opensPerMinute')).toMatchObject({ value: 20, overridden: true })
    expect(storage.data).toEqual({ 'a.one': { opensPerMinute: 20 } })
    expect(s.limits('a.one')).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 20 })
    expect(s.limits('b.two')).toEqual(DEFAULT_PLUGIN_LIMITS)
    s.set('a.one', [], ['opensPerMinute'])
    expect(storage.data).toEqual({})
  })
})

// The global value of each cap (Settings › General, `ccc plugin limits --global`): a plugin's cap is its override,
// else the global value, else the default; ceilings and clamping apply to both levels; counting stays per plugin.
describe('global values', () => {
  it('resolve override > global > default, key by key', () => {
    const global = { opensPerMinute: 12, sendsPerMinute: 50 }
    expect(effectiveLimits({ opensPerMinute: 7 }, global)).toEqual({ opensPerMinute: 7, sendsPerMinute: 50, roomSendsPerMember: 20, roomSendsPerRoom: 60 })
    expect(effectiveLimits(undefined, global)).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 12, sendsPerMinute: 50 })
    expect(globalLimits(global)).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 12, sendsPerMinute: 50 })
    const s = store(memory({ 'a.one': { opensPerMinute: 7 } }, global))
    expect(s.limits('a.one')).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 7, sendsPerMinute: 50 })
    expect(s.limits('b.two')).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 12, sendsPerMinute: 50 })
  })

  it('an override below the global value still wins (it is the plugin\'s own, not a floor)', () => {
    expect(effectiveLimits({ sendsPerMinute: 2 }, { sendsPerMinute: 200 }).sendsPerMinute).toBe(2)
  })

  it('are clamped and checked like an override when read: ceiling, junk ignored, own known keys only', () => {
    expect(globalLimits({ opensPerMinute: 1000, sendsPerMinute: 0, roomSendsPerMember: '9', roomSendsPerRoom: 600 })).toEqual({
      ...DEFAULT_PLUGIN_LIMITS,
      opensPerMinute: 60,
      roomSendsPerRoom: 600
    })
    const parsed = JSON.parse('{"__proto__": {"opensPerMinute": 50}, "constructor": 9, "sendsPerMinute": 100}') as unknown
    expect(globalLimits(parsed)).toEqual({ ...DEFAULT_PLUGIN_LIMITS, sendsPerMinute: 100 })
    for (const damaged of ['x', 5, [], null]) expect(globalLimits(damaged)).toEqual(DEFAULT_PLUGIN_LIMITS)
    // A junk override falls through to the global value, not to the default.
    expect(effectiveLimits({ opensPerMinute: -1 }, { opensPerMinute: 30 }).opensPerMinute).toBe(30)
    // A clamped global value is what a plugin without an override gets.
    expect(effectiveLimits({}, { roomSendsPerMember: 5000 }).roomSendsPerMember).toBe(120)
  })

  it('show in a plugin\'s view as global (with the value) or as the plugin\'s own (with the global value behind it)', () => {
    const view = limitsView('a.one', { opensPerMinute: 7 }, { opensPerMinute: 12, sendsPerMinute: 50 })
    expect(view.limits.map((l) => [l.key, l.value, l.source, l.overridden, l.inherited])).toEqual([
      ['opensPerMinute', 7, 'plugin', true, 12],
      ['sendsPerMinute', 50, 'global', false, 50],
      ['roomSendsPerMember', 20, 'default', false, 20],
      ['roomSendsPerRoom', 60, 'default', false, 60]
    ])
  })

  it('have their own view: set by the person or the default', () => {
    const view = globalLimitsView({ sendsPerMinute: 999 })
    expect(view.global).toBe(true)
    expect(view.limits.map((l) => [l.key, l.value, l.source, l.overridden, l.inherited, l.ceiling])).toEqual([
      ['opensPerMinute', 5, 'default', false, 5, 60],
      ['sendsPerMinute', 300, 'global', true, 30, 300],
      ['roomSendsPerMember', 20, 'default', false, 20, 120],
      ['roomSendsPerRoom', 60, 'default', false, 60, 600]
    ])
  })

  it('an edit is checked like a plugin\'s (range, unknown key, twice, empty) and stores nothing when refused', () => {
    const storage = memory({}, { opensPerMinute: 9 })
    const s = store(storage)
    expect(() => s.setGlobal([['opensPerMinute', '61']], [])).toThrow('opensPerMinute must be a whole number from 1 to 60')
    expect(() => s.setGlobal([['sendsPerMinute', 40], ['__proto__', 3]], [])).toThrow('unknown limit: __proto__')
    expect(() => s.setGlobal([['opensPerMinute', 3]], ['opensPerMinute'])).toThrow('named twice')
    expect(() => s.setGlobal([], [])).toThrow('nothing to change')
    expect(() => s.setGlobal({ opensPerMinute: 3 }, [])).toThrow('list of [key, value] pairs')
    expect(storage.global.value).toEqual({ opensPerMinute: 9 })
  })

  it('set and reset: a reset global value goes back to the default, a reset override to the global value', () => {
    const storage = memory()
    const s = store(storage)
    const g = s.setGlobal([['opensPerMinute', '20'], ['roomSendsPerRoom', 100]], [])
    expect(g.limits.find((l) => l.key === 'opensPerMinute')).toMatchObject({ value: 20, overridden: true, source: 'global' })
    expect(storage.global.value).toEqual({ opensPerMinute: 20, roomSendsPerRoom: 100 })
    // An override set after: the plugin's own; reset, the plugin goes back to the global value.
    expect(s.set('a.one', [['opensPerMinute', 3]], []).limits[0]).toMatchObject({ value: 3, source: 'plugin', inherited: 20 })
    expect(s.set('a.one', [], ['opensPerMinute']).limits[0]).toMatchObject({ value: 20, source: 'global', overridden: false })
    expect(storage.data).toEqual({})
    // The global value reset: the default again, for every plugin.
    expect(s.setGlobal([], ['opensPerMinute']).limits[0]).toMatchObject({ value: 5, source: 'default', overridden: false })
    expect(s.limits('a.one').opensPerMinute).toBe(5)
    // The last global value dropped: the entry goes.
    s.setGlobal(undefined, ['roomSendsPerRoom'])
    expect(storage.global.value).toBeUndefined()
    expect(s.globalView().limits.every((l) => l.source === 'default')).toBe(true)
  })

  it('apply live to every plugin without an override, at its next read; an override keeps its own', () => {
    const storage = memory({ 'a.one': { sendsPerMinute: 10 } })
    const s = store(storage)
    expect(s.limits('b.two').sendsPerMinute).toBe(30)
    s.setGlobal([['sendsPerMinute', 90]], [])
    expect(s.limits('b.two').sendsPerMinute).toBe(90)
    expect(s.limits('a.one').sendsPerMinute).toBe(10)
    // Any id, installed or not, reads the global value: limits() is what HostApi asks, never refused.
    expect(s.limits('nobody.here').sendsPerMinute).toBe(90)
  })

  it('stay when a plugin is uninstalled (they belong to no plugin)', () => {
    const storage = memory({ 'a.one': { opensPerMinute: 60 } }, { opensPerMinute: 10 })
    store(storage).forget('a.one')
    expect(storage.data).toEqual({})
    expect(storage.global.value).toEqual({ opensPerMinute: 10 })
  })

  it('round trip through the real app.json under pluginLimitsGlobal, beside pluginLimits', () => {
    const dataDir = join(root, 'data')
    const first = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: () => {} })
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(first.app), known: () => true })
    s.setGlobal([['sendsPerMinute', 120]], [])
    s.set('a.one', [['opensPerMinute', 9]], [])
    first.flushAll()
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginLimits?: unknown; pluginLimitsGlobal?: unknown }
    expect(onDisk.pluginLimitsGlobal).toEqual({ sendsPerMinute: 120 })
    expect(onDisk.pluginLimits).toEqual({ 'a.one': { opensPerMinute: 9 } })

    const second = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: () => {} })
    const again = new PluginLimitsStore({ storage: appJsonLimitsStorage(second.app), known: () => true })
    expect(again.limits('a.one')).toEqual({ ...DEFAULT_PLUGIN_LIMITS, opensPerMinute: 9, sendsPerMinute: 120 })
    again.setGlobal([], ['sendsPerMinute'])
    second.flushAll()
    const after = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginLimitsGlobal?: unknown }
    expect(after.pluginLimitsGlobal).toBeUndefined()
  })

  it('a damaged stored entry reads as none and is replaced whole by the next edit', () => {
    const registry = new ProjectRegistry({ dataDir: join(root, 'data'), debounceMs: 60_000, log: () => {} })
    registry.app.update((a) => {
      ;(a as { pluginLimitsGlobal?: unknown }).pluginLimitsGlobal = ['garbage']
    })
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(registry.app), known: () => true })
    expect(s.limits('a.one')).toEqual(DEFAULT_PLUGIN_LIMITS)
    s.setGlobal([['opensPerMinute', 6]], [])
    expect(registry.app.data.pluginLimitsGlobal).toEqual({ opensPerMinute: 6 })
  })

  it('a global edit is refused while app.json cannot be written', () => {
    const updates: unknown[] = []
    const app = { data: {}, readOnly: true, update: (m: unknown) => void updates.push(m) }
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(app), known: () => true })
    expect(() => s.setGlobal([['opensPerMinute', 6]], [])).toThrow(/app\.json cannot be written/)
    expect(updates).toEqual([])
  })
})

describe('app.json round trip', () => {
  it('stores pluginLimits[id] in the real file, reads it back after a restart, and --default removes it', () => {
    const dataDir = join(root, 'data')
    const first = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: () => {} })
    const known = (): boolean => true
    new PluginLimitsStore({ storage: appJsonLimitsStorage(first.app), known }).set('a.one', [['sendsPerMinute', 120], ['roomSendsPerRoom', '600']], [])
    first.flushAll()
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginLimits?: unknown }
    expect(onDisk.pluginLimits).toEqual({ 'a.one': { sendsPerMinute: 120, roomSendsPerRoom: 600 } })

    const second = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: () => {} })
    const again = new PluginLimitsStore({ storage: appJsonLimitsStorage(second.app), known })
    expect(again.limits('a.one')).toEqual({ ...DEFAULT_PLUGIN_LIMITS, sendsPerMinute: 120, roomSendsPerRoom: 600 })
    again.set('a.one', [], ['sendsPerMinute', 'roomSendsPerRoom'])
    second.flushAll()
    expect((JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginLimits?: unknown }).pluginLimits).toBeUndefined()
  })

  it('replaces a damaged top level rather than writing into it', () => {
    const dataDir = join(root, 'data')
    const registry = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: () => {} })
    registry.app.update((a) => {
      ;(a as { pluginLimits?: unknown }).pluginLimits = 'garbage'
    })
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(registry.app), known: () => true })
    expect(s.limits('a.one')).toEqual(DEFAULT_PLUGIN_LIMITS)
    s.set('a.one', [['opensPerMinute', 6]], [])
    expect(registry.app.data.pluginLimits).toEqual({ 'a.one': { opensPerMinute: 6 } })
  })
})

describe('uninstall and an unwritable app.json', () => {
  it('forget drops the overrides of an id that is not installed (and does nothing when there are none)', () => {
    const storage = memory({ 'gone.plugin': { opensPerMinute: 60 }, 'a.one': { sendsPerMinute: 100 } })
    const s = store(storage, (id): id is 'a.one' => id === 'x')
    s.forget('gone.plugin')
    s.forget('never.had')
    expect(storage.data).toEqual({ 'a.one': { sendsPerMinute: 100 } })
    // Not installed, so no caps apply: the id gets the defaults, as a later plugin with this id would.
    expect(s.limits('gone.plugin')).toEqual(DEFAULT_PLUGIN_LIMITS)
  })

  it('forget on the real app.json removes the entry and the emptied map', () => {
    const registry = new ProjectRegistry({ dataDir: join(root, 'data'), debounceMs: 60_000, log: () => {} })
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(registry.app), known: () => true })
    s.set('a.one', [['opensPerMinute', 6]], [])
    expect(registry.app.data.pluginLimits).toEqual({ 'a.one': { opensPerMinute: 6 } })
    s.forget('a.one')
    expect(registry.app.data.pluginLimits).toBeUndefined()
  })

  it('refuses an edit while app.json cannot be written, instead of reporting it as set', () => {
    const updates: unknown[] = []
    const app = { data: {}, readOnly: true, update: (m: unknown) => void updates.push(m) }
    const s = new PluginLimitsStore({ storage: appJsonLimitsStorage(app), known: () => true })
    expect(() => s.set('a.one', [['opensPerMinute', 6]], [])).toThrow(/app\.json cannot be written/)
    expect(updates).toEqual([])
  })
})

describe('the socket handlers', () => {
  const callers: Caller[] = [
    { kind: 'session', tabId: 't1', projectId: 'p1' },
    { kind: 'window', projectId: 'p1' },
    { kind: 'project', path: '/x', projectId: 'p1' }
  ]

  it('the write refuses every caller but the anonymous one, before the store is touched', () => {
    const storage = memory()
    const handler = pluginLimitsSetHandler(store(storage))
    for (const caller of callers) {
      expect(() => handler({ id: 'a.one', set: [['opensPerMinute', '60']] }, caller), caller.kind).toThrow(PLUGIN_LIMITS_HOST_ONLY_TEXT)
    }
    expect(storage.data).toEqual({})
    expect(handler({ id: 'a.one', set: [['opensPerMinute', '60']] }, { kind: 'anonymous' })).toMatchObject({ id: 'a.one' })
    expect(storage.data).toEqual({ 'a.one': { opensPerMinute: 60 } })
  })

  it('the read answers any caller', () => {
    const handler = pluginLimitsHandler(store())
    for (const caller of [...callers, { kind: 'anonymous' } as const]) {
      expect(handler({ id: 'a.one' }, caller), caller.kind).toMatchObject({ id: 'a.one', limits: expect.any(Array) })
      expect(handler({ global: true }, caller), caller.kind).toMatchObject({ global: true, limits: expect.any(Array) })
    }
  })

  it('the global write refuses every caller but the anonymous one, before the store is touched', () => {
    const storage = memory()
    const handler = pluginLimitsSetHandler(store(storage))
    for (const caller of callers) {
      expect(() => handler({ global: true, set: [['opensPerMinute', '60']] }, caller), caller.kind).toThrow(PLUGIN_LIMITS_HOST_ONLY_TEXT)
      expect(() => handler({ global: true, reset: ['opensPerMinute'] }, caller), caller.kind).toThrow(PLUGIN_LIMITS_HOST_ONLY_TEXT)
    }
    expect(storage.global.value).toBeUndefined()
    expect(handler({ global: true, set: [['opensPerMinute', '60']] }, { kind: 'anonymous' })).toMatchObject({ global: true })
    expect(storage.global.value).toEqual({ opensPerMinute: 60 })
    expect(storage.data).toEqual({})
  })

  it('refuses a request naming both an id and global, or a global that is not true', () => {
    const storage = memory()
    const read = pluginLimitsHandler(store(storage))
    const write = pluginLimitsSetHandler(store(storage))
    const anon = { kind: 'anonymous' } as const
    expect(() => read({ id: 'a.one', global: true }, anon)).toThrow('not both')
    expect(() => write({ id: 'a.one', global: true, set: [['opensPerMinute', '9']] }, anon)).toThrow('not both')
    for (const global of ['true', 1, false, null]) {
      expect(() => write({ global, set: [['opensPerMinute', '9']] }, anon), String(global)).toThrow('global is true or absent')
    }
    expect(storage.global.value).toBeUndefined()
    expect(storage.data).toEqual({})
  })
})

describe('ccc plugin limits', () => {
  function capture(): { out: Output; stdout: () => string; stderr: () => string } {
    let o = ''
    let e = ''
    return { out: { stdout: (t) => void (o += t), stderr: (t) => void (e += t) }, stdout: () => o, stderr: () => e }
  }

  it('parses the read, the set and --default, and refuses the rest as usage', () => {
    expect(parseArgs(['plugin', 'limits', 'a.one'])).toEqual({ kind: 'plugin-limits', id: 'a.one', set: [], reset: [] })
    expect(parseArgs(['plugin', 'limits', 'a.one', 'opensPerMinute=10', 'sendsPerMinute=x=y'])).toEqual({
      kind: 'plugin-limits',
      id: 'a.one',
      set: [
        ['opensPerMinute', '10'],
        ['sendsPerMinute', 'x=y']
      ],
      reset: []
    })
    expect(parseArgs(['plugin', 'limits', 'a.one', '--default', 'opensPerMinute', 'sendsPerMinute'])).toEqual({
      kind: 'plugin-limits',
      id: 'a.one',
      set: [],
      reset: ['opensPerMinute', 'sendsPerMinute']
    })
    expect(parseArgs(['plugin', 'limits', '--help'])).toEqual({ kind: 'help', command: 'plugin' })
    // --global: no id, the same edits.
    expect(parseArgs(['plugin', 'limits', '--global'])).toEqual({ kind: 'plugin-limits', id: null, set: [], reset: [] })
    expect(parseArgs(['plugin', 'limits', '--global', 'sendsPerMinute=60'])).toEqual({ kind: 'plugin-limits', id: null, set: [['sendsPerMinute', '60']], reset: [] })
    expect(parseArgs(['plugin', 'limits', 'opensPerMinute=9', '--global'])).toEqual({ kind: 'plugin-limits', id: null, set: [['opensPerMinute', '9']], reset: [] })
    expect(parseArgs(['plugin', 'limits', '--global', '--default', 'opensPerMinute'])).toEqual({
      kind: 'plugin-limits',
      id: null,
      set: [],
      reset: ['opensPerMinute']
    })
    for (const argv of [
      ['plugin', 'limits'],
      ['plugin', 'limits', 'Not An Id'],
      ['plugin', 'limits', 'a.one', 'opensPerMinute'],
      ['plugin', 'limits', 'a.one', '=5'],
      ['plugin', 'limits', 'a.one', '--default'],
      ['plugin', 'limits', 'a.one', '--default', 'opensPerMinute=5'],
      ['plugin', 'limits', 'a.one', '--project', '/x'],
      ['plugin', 'limits', 'a.one', ...Array.from({ length: 17 }, () => 'opensPerMinute=5')],
      // --global takes no plugin id (it would read as a key=value missing its `=`).
      ['plugin', 'limits', '--global', 'a.one'],
      ['plugin', 'limits', '--global', 'a.one', 'opensPerMinute=5'],
      ['plugin', 'limits', '--global', '--default'],
      ['plugin', 'limits', '--global', ...Array.from({ length: 17 }, () => 'opensPerMinute=5')]
    ]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage')
    }
  })

  it('sends plugin.limits for a read and plugin.limits.set for a change, never a project; the token goes along when there is one', () => {
    const read = buildRequest({ kind: 'plugin-limits', id: 'a.one', set: [], reset: [] }, { APP_TAB_TOKEN: TOKEN }, '/cwd')
    expect(read).toMatchObject({ cmd: 'plugin.limits', args: { id: 'a.one' }, token: TOKEN })
    const write = buildRequest({ kind: 'plugin-limits', id: 'a.one', set: [['opensPerMinute', '9']], reset: ['sendsPerMinute'] }, {}, '/cwd')
    expect(write).toEqual({ v: 1, id: 1, cmd: 'plugin.limits.set', args: { id: 'a.one', set: [['opensPerMinute', '9']], reset: ['sendsPerMinute'] } })
    // --global: `global: true` in place of the id, on the same two request names.
    expect(buildRequest({ kind: 'plugin-limits', id: null, set: [], reset: [] }, { APP_TAB_TOKEN: TOKEN }, '/cwd')).toMatchObject({
      cmd: 'plugin.limits',
      args: { global: true },
      token: TOKEN
    })
    expect(buildRequest({ kind: 'plugin-limits', id: null, set: [['sendsPerMinute', '60']], reset: [] }, {}, '/cwd')).toEqual({
      v: 1,
      id: 1,
      cmd: 'plugin.limits.set',
      args: { global: true, set: [['sendsPerMinute', '60']] }
    })
  })

  it('prints one line per cap, and survives a reply of the wrong shape', () => {
    const text = formatPluginLimits(limitsView('a.one', { opensPerMinute: 10 }), (t) => (typeof t === 'string' ? t : ''))
    expect(text.split('\n')[0]).toBe('# a.one')
    expect(text).toContain('opensPerMinute     = 10 (plugin)  default 5, at most 60: tabs opened a minute')
    expect(text).toContain('sendsPerMinute     = 30 (default)  default 30, at most 300')
    expect(text.endsWith('\n')).toBe(true)
    expect(formatPluginLimits(null, () => '')).toBe('# \n')
    // Each value marked by where it comes from; the global view has its own heading.
    const marked = formatPluginLimits(limitsView('a.one', { opensPerMinute: 10 }, { sendsPerMinute: 60 }), (t) => (typeof t === 'string' ? t : ''))
    expect(marked).toContain('opensPerMinute     = 10 (plugin)')
    expect(marked).toContain('sendsPerMinute     = 60 (global)')
    expect(marked).toContain('roomSendsPerMember = 20 (default)')
    const global = formatPluginLimits(globalLimitsView({ sendsPerMinute: 60 }), (t) => (typeof t === 'string' ? t : ''))
    expect(global.split('\n')[0]).toBe('# global (every plugin without its own value)')
    expect(global).toContain('sendsPerMinute     = 60 (global)  default 30, at most 300')
    expect(global).toContain('opensPerMinute     = 5 (default)')
    // An older app's reply (no source): `(set)` on an override, as before; an unknown source is not printed.
    expect(formatPluginLimits({ id: 'x', limits: [{ key: 'k', value: 3, overridden: true }] }, (t) => String(t ?? ''))).toContain('k = 3 (set)')
    expect(formatPluginLimits({ id: 'x', limits: [{ key: 'k', value: 3, source: 'evil\u001b' }] }, (t) => String(t ?? ''))).toContain('k = 3  default')
    expect(formatPluginLimits({ id: 'x', limits: [{ key: 'k', value: 'no' }, 7] }, (t) => String(t ?? ''))).toBe('# x\nk = ?  default ?, at most ?: \n')
  })

  async function app(storage: ReturnType<typeof memory>): Promise<string> {
    const sock = join(root, 's.sock')
    const server = new SocketServer({
      path: sock,
      resolveToken: (token) => (token === TOKEN ? { kind: 'session', tabId: 'tab-1', projectId: 'p1' } : token === WINDOW ? { kind: 'window', projectId: 'p1' } : undefined),
      resolveProject: (path) => ({ path, projectId: 'p1' }),
      log: () => {},
      probeTimeoutMs: 200
    })
    registerPluginLimitsHandlers(server, store(storage))
    expect(await server.start()).toBe(true)
    closers.push(() => server.stop())
    return sock
  }

  it('against the real SocketServer: a tab reads, a tab cannot write (nothing stored), a shell outside writes', async () => {
    const storage = memory()
    const sock = await app(storage)
    const go = async (argv: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> => {
      const c = capture()
      const code = await run(argv, { CC_COCKPIT_SOCK: sock, ...env }, Readable.from([]), c.out, root)
      return { code, stdout: c.stdout(), stderr: c.stderr() }
    }
    const readInTab = await go(['plugin', 'limits', 'a.one'], { APP_TAB_TOKEN: TOKEN })
    expect(readInTab.code).toBe(0)
    expect(readInTab.stdout).toContain('opensPerMinute     = 5 (default)  default 5, at most 60')
    expect((await go(['plugin', 'limits', 'a.one'], { APP_TAB_TOKEN: WINDOW })).code).toBe(0)

    for (const token of [TOKEN, WINDOW]) {
      const refused = await go(['plugin', 'limits', 'a.one', 'opensPerMinute=60'], { APP_TAB_TOKEN: token })
      expect(refused.code).toBe(1)
      expect(refused.stderr).toBe(`ccc: ${PLUGIN_LIMITS_HOST_ONLY_TEXT}\n`)
      const reset = await go(['plugin', 'limits', 'a.one', '--default', 'opensPerMinute'], { APP_TAB_TOKEN: token })
      expect(reset.code).toBe(1)
    }
    expect(storage.data).toEqual({})

    const written = await go(['plugin', 'limits', 'a.one', 'opensPerMinute=60', 'roomSendsPerMember=40'], {})
    expect(written.code).toBe(0)
    expect(written.stdout).toContain('opensPerMinute     = 60 (plugin)')
    expect(storage.data).toEqual({ 'a.one': { opensPerMinute: 60, roomSendsPerMember: 40 } })

    const bad = await go(['plugin', 'limits', 'a.one', 'sendsPerMinute=301'], {})
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('sendsPerMinute must be a whole number from 1 to 300')
    const unknown = await go(['plugin', 'limits', 'nobody.here'], {})
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('nobody.here is not installed')

    expect((await go(['plugin', 'limits', 'a.one', '--default', 'opensPerMinute'], {})).code).toBe(0)
    expect(storage.data).toEqual({ 'a.one': { roomSendsPerMember: 40 } })
  })

  it('--global against the real SocketServer: a tab reads, a tab cannot write, a shell outside writes and resets', async () => {
    const storage = memory({ 'a.one': { sendsPerMinute: 10 } })
    const sock = await app(storage)
    const go = async (argv: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> => {
      const c = capture()
      const code = await run(argv, { CC_COCKPIT_SOCK: sock, ...env }, Readable.from([]), c.out, root)
      return { code, stdout: c.stdout(), stderr: c.stderr() }
    }
    const readInTab = await go(['plugin', 'limits', '--global'], { APP_TAB_TOKEN: TOKEN })
    expect(readInTab.code).toBe(0)
    expect(readInTab.stdout).toContain('# global (every plugin without its own value)')
    expect(readInTab.stdout).toContain('sendsPerMinute     = 30 (default)')

    for (const token of [TOKEN, WINDOW]) {
      const refused = await go(['plugin', 'limits', '--global', 'sendsPerMinute=300'], { APP_TAB_TOKEN: token })
      expect(refused.code).toBe(1)
      expect(refused.stderr).toBe(`ccc: ${PLUGIN_LIMITS_HOST_ONLY_TEXT}\n`)
      expect((await go(['plugin', 'limits', '--global', '--default', 'sendsPerMinute'], { APP_TAB_TOKEN: token })).code).toBe(1)
    }
    expect(storage.global.value).toBeUndefined()

    const written = await go(['plugin', 'limits', '--global', 'sendsPerMinute=90', 'opensPerMinute=8'], {})
    expect(written.code).toBe(0)
    expect(written.stdout).toContain('sendsPerMinute     = 90 (global)')
    expect(storage.global.value).toEqual({ sendsPerMinute: 90, opensPerMinute: 8 })
    // The plugin's view: its own override, the global value, the default.
    const plugin = await go(['plugin', 'limits', 'a.one'], {})
    expect(plugin.stdout).toContain('opensPerMinute     = 8 (global)')
    expect(plugin.stdout).toContain('sendsPerMinute     = 10 (plugin)')
    expect(plugin.stdout).toContain('roomSendsPerRoom   = 60 (default)')
    const bad = await go(['plugin', 'limits', '--global', 'roomSendsPerRoom=601'], {})
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('roomSendsPerRoom must be a whole number from 1 to 600')

    expect((await go(['plugin', 'limits', '--global', '--default', 'sendsPerMinute', 'opensPerMinute'], {})).code).toBe(0)
    expect(storage.global.value).toBeUndefined()
    expect(storage.data).toEqual({ 'a.one': { sendsPerMinute: 10 } })
  })

  it('says the app is not running, exit 1, instead of passing silently', async () => {
    const c = capture()
    expect(await run(['plugin', 'limits', 'a.one', 'opensPerMinute=9'], { CC_COCKPIT_SOCK: join(root, 'none.sock') }, Readable.from([]), c.out, root)).toBe(1)
    expect(c.stderr()).toBe('ccc: cc-cockpit is not running\n')
  })
})
