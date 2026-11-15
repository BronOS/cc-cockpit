// The per-plugin caps the person sets (rooms Task 11, design-rooms.md §6): the defaults and ceilings, a stored
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

/** An in-memory storage: what is stored, as JSON would carry it. */
function memory(initial: Record<string, unknown> = {}): PluginLimitsStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    get: (id) => (Object.hasOwn(data, id) ? data[id] : undefined),
    set: (id, overrides) => {
      if (overrides === undefined) delete data[id]
      else data[id] = JSON.parse(JSON.stringify(overrides))
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
        set: () => {}
      },
      known: () => true
    })
    expect(s.limits('a.one')).toEqual(DEFAULT_PLUGIN_LIMITS)
  })

  it('shows in the view with its default, ceiling and whether it is set', () => {
    const view = limitsView('a.one', { sendsPerMinute: 999 })
    expect(view.id).toBe('a.one')
    expect(view.limits.map((l) => [l.key, l.value, l.overridden, l.default, l.ceiling])).toEqual([
      ['opensPerMinute', 5, false, 5, 60],
      ['sendsPerMinute', 300, true, 30, 300],
      ['roomSendsPerMember', 20, false, 20, 120],
      ['roomSendsPerRoom', 60, false, 60, 600]
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
    }
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
    for (const argv of [
      ['plugin', 'limits'],
      ['plugin', 'limits', 'Not An Id'],
      ['plugin', 'limits', 'a.one', 'opensPerMinute'],
      ['plugin', 'limits', 'a.one', '=5'],
      ['plugin', 'limits', 'a.one', '--default'],
      ['plugin', 'limits', 'a.one', '--default', 'opensPerMinute=5'],
      ['plugin', 'limits', 'a.one', '--project', '/x'],
      ['plugin', 'limits', 'a.one', ...Array.from({ length: 17 }, () => 'opensPerMinute=5')]
    ]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage')
    }
  })

  it('sends plugin.limits for a read and plugin.limits.set for a change, never a project; the token goes along when there is one', () => {
    const read = buildRequest({ kind: 'plugin-limits', id: 'a.one', set: [], reset: [] }, { APP_TAB_TOKEN: TOKEN }, '/cwd')
    expect(read).toMatchObject({ cmd: 'plugin.limits', args: { id: 'a.one' }, token: TOKEN })
    const write = buildRequest({ kind: 'plugin-limits', id: 'a.one', set: [['opensPerMinute', '9']], reset: ['sendsPerMinute'] }, {}, '/cwd')
    expect(write).toEqual({ v: 1, id: 1, cmd: 'plugin.limits.set', args: { id: 'a.one', set: [['opensPerMinute', '9']], reset: ['sendsPerMinute'] } })
  })

  it('prints one line per cap, and survives a reply of the wrong shape', () => {
    const text = formatPluginLimits(limitsView('a.one', { opensPerMinute: 10 }), (t) => (typeof t === 'string' ? t : ''))
    expect(text.split('\n')[0]).toBe('# a.one')
    expect(text).toContain('opensPerMinute     = 10 (set)  default 5, at most 60: tabs opened a minute')
    expect(text).toContain('sendsPerMinute     = 30  default 30, at most 300')
    expect(text.endsWith('\n')).toBe(true)
    expect(formatPluginLimits(null, () => '')).toBe('# \n')
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
    expect(readInTab.stdout).toContain('opensPerMinute     = 5  default 5, at most 60')
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
    expect(written.stdout).toContain('opensPerMinute     = 60 (set)')
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

  it('says the app is not running, exit 1, instead of passing silently', async () => {
    const c = capture()
    expect(await run(['plugin', 'limits', 'a.one', 'opensPerMinute=9'], { CC_COCKPIT_SOCK: join(root, 'none.sock') }, Readable.from([]), c.out, root)).toBe(1)
    expect(c.stderr()).toBe('ccc: cc-cockpit is not running\n')
  })
})
