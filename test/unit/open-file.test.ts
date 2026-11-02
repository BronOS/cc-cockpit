// The open-file hook (friction round 1, Task 12): which plugin a Sessions panel file click goes to
// (the shared rule), main's routing with its checks and the built-in viewer as the fallback, the
// pick on the Plugins page, and the host's `ctx.files.onOpen` with its ack.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { OPEN_LISTENER_WAIT_MS, runOpenListeners } from '../../src/host/ctx/files'
import { parsePluginSpecs } from '../../src/host/loader'
import { ServiceChoices } from '../../src/main/plugins/service-choices'
import type { DiffTab } from '../../src/main/sessions/open-diff'
import { projectRelativePath, routeOpenFile, type OpenFileRouteDeps } from '../../src/main/sessions/open-file'
import { BUILTIN_VIEWER, OPEN_FILE_PICK, openFileStatus, selectOpenFile, type OpenFilePlugin } from '../../src/shared/services'
import { hostSpec } from '../fakes/host-spec'

const P = 'aaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbb'
const review = (id: string, title = 'Review'): OpenFilePlugin => ({ id, openFile: { title } })

describe('selectOpenFile / openFileStatus (the shared rule)', () => {
  it('no handler: the built-in viewer', () => {
    const plugins = [{ id: 'a.plain' }]
    expect(selectOpenFile(plugins, {})).toBeNull()
    expect(openFileStatus(plugins, {})).toEqual({ candidates: [], selected: BUILTIN_VIEWER })
  })

  it('one handler gets the clicks unless the project picked the built-in viewer', () => {
    const plugins = [{ id: 'a.plain' }, review('a.rev')]
    expect(selectOpenFile(plugins, {})).toBe('a.rev')
    expect(openFileStatus(plugins, {})).toEqual({ candidates: [{ id: 'a.rev', title: 'Review' }], selected: 'a.rev' })
    const builtin = { [OPEN_FILE_PICK]: BUILTIN_VIEWER }
    expect(selectOpenFile(plugins, builtin)).toBeNull()
    expect(openFileStatus(plugins, builtin).selected).toBe(BUILTIN_VIEWER)
  })

  it('two handlers: the pick decides; none or a stale one is no pick (the built-in viewer opens)', () => {
    const plugins = [review('a.one', 'One'), review('a.two', 'Two')]
    expect(selectOpenFile(plugins, {})).toBeNull()
    expect(openFileStatus(plugins, {})).toEqual({
      candidates: [
        { id: 'a.one', title: 'One' },
        { id: 'a.two', title: 'Two' }
      ],
      selected: null
    })
    expect(selectOpenFile(plugins, { [OPEN_FILE_PICK]: 'a.two' })).toBe('a.two')
    expect(openFileStatus(plugins, { [OPEN_FILE_PICK]: 'a.two' }).selected).toBe('a.two')
    expect(selectOpenFile(plugins, { [OPEN_FILE_PICK]: 'a.gone' })).toBeNull()
    expect(openFileStatus(plugins, { [OPEN_FILE_PICK]: 'a.gone' }).selected).toBeNull()
  })

  it('the reserved key never meets a service pick, and a service pick never selects a handler', () => {
    const plugins = [review('a.one'), review('a.two'), { id: 'a.svc', services: { provides: { greet: 1 } } }]
    expect(selectOpenFile(plugins, { greet: 'a.one' })).toBeNull()
    // An inherited name answers nothing (the map is read with hasOwn).
    expect(selectOpenFile(plugins, Object.create({ [OPEN_FILE_PICK]: 'a.one' }) as Record<string, string>)).toBeNull()
  })
})

describe('projectRelativePath', () => {
  const noLinks = (p: string): string => p

  it('makes a recorded path relative to the project folder, from the tab cwd', () => {
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/src/a.ts', noLinks)).toBe('src/a.ts')
    expect(projectRelativePath('/work/p', '/work/p/sub', 'b.ts', noLinks)).toBe('sub/b.ts')
    expect(projectRelativePath('/work/p', '/work/p', '-weird name', noLinks)).toBe('-weird name')
  })

  it('refuses a path outside the project, the folder itself, and a sibling sharing the prefix', () => {
    expect(projectRelativePath('/work/p', '/work/p', '/etc/passwd', noLinks)).toBeNull()
    expect(projectRelativePath('/work/p', '/work/p', '../q/a.ts', noLinks)).toBeNull()
    expect(projectRelativePath('/work/p', '/work/p', '/work/p', noLinks)).toBeNull()
    expect(projectRelativePath('/work/p', '/work/p', '/work/p2/a.ts', noLinks)).toBeNull()
  })

  it('tries the real path when a symlinked prefix makes it look outside (macOS /var)', () => {
    const real = (p: string): string => p.replace(/^\/var\//, '/private/var/')
    expect(projectRelativePath('/private/var/p', '/private/var/p', '/var/p/a.ts', real)).toBe('a.ts')
    // A missing file resolves through its folder.
    const missing = (p: string): string => {
      if (p.endsWith('gone.ts')) throw new Error('ENOENT')
      return real(p)
    }
    expect(projectRelativePath('/private/var/p', '/private/var/p', '/var/p/gone.ts', missing)).toBe('gone.ts')
    expect(projectRelativePath('/private/var/p', '/private/var/p', '/var/q/a.ts', real)).toBeNull()
  })

  it('refuses a lexically internal path whose real path leaves the project (a symlink out)', () => {
    // /work/p/link -> /etc; /work/p/inner -> /work/p/src stays inside.
    const links = (p: string): string => {
      if (p.includes('gone')) throw new Error('ENOENT')
      return p.replace(/^\/work\/p\/link(?=\/|$)/, '/etc').replace(/^\/work\/p\/inner(?=\/|$)/, '/work/p/src')
    }
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/link/secret.txt', links)).toBeNull()
    expect(projectRelativePath('/work/p', '/work/p/link', 'secret.txt', links)).toBeNull()
    // A deleted file behind the link is checked through its nearest existing ancestor: still outside.
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/link/gone.txt', links)).toBeNull()
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/link/gone/deeper/a.txt', links)).toBeNull()
    // Inside links and deleted files or folders in the project still work, as the path the user saw.
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/inner/a.ts', links)).toBe('inner/a.ts')
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/src/gone.ts', links)).toBe('src/gone.ts')
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/gone/dir/a.ts', links)).toBe('gone/dir/a.ts')
  })

  it('nothing resolves: null, even for a lexically internal path', () => {
    const none = (): string => {
      throw new Error('EACCES')
    }
    expect(projectRelativePath('/work/p', '/work/p', '/work/p/a.ts', none)).toBeNull()
  })
})

describe('routeOpenFile', () => {
  const tab = (over: Partial<DiffTab> = {}): DiffTab => ({ projectId: P, cwd: '/work/p', files: ['/work/p/src/a.ts', '/etc/hosts'], ...over })
  const caller = { windowId: 7, projectId: P }

  function setup(options: { handler?: string | null; deliver?: OpenFileRouteDeps['deliver']; tabs?: Record<string, DiffTab> } = {}) {
    const delivered: Array<{ projectId: string; pluginId: string; req: { path: string; tabId: string } }> = []
    const builtin: Array<{ tabId: string; file: string }> = []
    const logs: string[] = []
    const deps: OpenFileRouteDeps = {
      tab: (id) => (options.tabs ?? { t1: tab(), t2: tab({ projectId: OTHER }) })[id],
      projectPath: () => '/work/p',
      windowOf: () => 7,
      handler: async () => (options.handler === undefined ? 'a.rev' : options.handler),
      deliver:
        options.deliver ??
        (async (projectId, pluginId, req) => {
          delivered.push({ projectId, pluginId, req })
          return true
        }),
      builtin: async (_caller, tabId, file) => {
        builtin.push({ tabId, file })
        return true
      },
      delivering: new Set(),
      realpath: (p) => p,
      log: (m) => logs.push(m)
    }
    return { deps, delivered, builtin, logs }
  }

  it('no handler: the built-in viewer, nothing sent', async () => {
    const { deps, delivered, builtin } = setup({ handler: null })
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    expect(delivered).toEqual([])
    expect(builtin).toEqual([{ tabId: 't1', file: '/work/p/src/a.ts' }])
  })

  it('one handler gets the project-relative path and the checked tab id', async () => {
    const { deps, delivered, builtin } = setup()
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    expect(delivered).toEqual([{ projectId: P, pluginId: 'a.rev', req: { path: 'src/a.ts', tabId: 't1' } }])
    expect(builtin).toEqual([])
  })

  it('falls back to the built-in viewer when the host does not take it or the delivery throws', async () => {
    const declined = setup({ deliver: async () => false })
    await expect(routeOpenFile(declined.deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    expect(declined.builtin).toHaveLength(1)

    const thrown = setup({
      deliver: async () => {
        throw new Error('host gone')
      }
    })
    await expect(routeOpenFile(thrown.deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    expect(thrown.builtin).toHaveLength(1)
    expect(thrown.logs.join()).toContain('host gone')
  })

  it('a choice that cannot be read is the built-in viewer, not a lost click', async () => {
    const { deps, builtin, delivered } = setup()
    deps.handler = async () => {
      throw new Error('index not loaded')
    }
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    expect(delivered).toEqual([])
    expect(builtin).toHaveLength(1)
  })

  it('a tab of another window, an unknown tab or a file main never recorded reaches no plugin and no viewer', async () => {
    const { deps, delivered, builtin } = setup()
    await expect(routeOpenFile(deps, caller, 't2', '/work/p/src/a.ts')).resolves.toBe(false)
    await expect(routeOpenFile(deps, caller, 'nope', '/work/p/src/a.ts')).resolves.toBe(false)
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/secret.ts')).resolves.toBe(false)
    expect(delivered).toEqual([])
    expect(builtin).toEqual([])
  })

  it('a recorded file outside the project is never sent to the plugin: the built-in viewer shows it', async () => {
    const { deps, delivered, builtin } = setup()
    await expect(routeOpenFile(deps, caller, 't1', '/etc/hosts')).resolves.toBe(true)
    expect(delivered).toEqual([])
    expect(builtin).toEqual([{ tabId: 't1', file: '/etc/hosts' }])
  })

  it('a tab that closes (or a window that goes) while the plugin is chosen reaches no plugin', async () => {
    const tabs: Record<string, DiffTab> = { t1: tab() }
    const closing = setup({ tabs })
    closing.deps.handler = async () => {
      delete tabs.t1
      return 'a.rev'
    }
    await expect(routeOpenFile(closing.deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(false)
    expect(closing.delivered).toEqual([])
    expect(closing.builtin).toEqual([])

    let windowId: number | undefined = 7
    const gone = setup()
    gone.deps.windowOf = () => windowId
    gone.deps.handler = async () => {
      windowId = undefined
      return 'a.rev'
    }
    await expect(routeOpenFile(gone.deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(false)
    expect(gone.delivered).toEqual([])
    // A caller that is not the project's window is refused from the start.
    const other = setup()
    other.deps.windowOf = () => 8
    await expect(routeOpenFile(other.deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(false)
    expect(other.delivered).toEqual([])
  })

  it('a second click while the first waits for its ack calls the plugin once', async () => {
    let ack: (ok: boolean) => void = () => {}
    let count = 0
    const { deps } = setup({
      deliver: () => {
        count++
        return new Promise<boolean>((resolve) => (ack = resolve))
      }
    })
    const first = routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')
    await Promise.resolve()
    await Promise.resolve()
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')).resolves.toBe(true)
    ack(true)
    await expect(first).resolves.toBe(true)
    expect(count).toBe(1)
    // Settled: the next click asks again.
    const again = routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts')
    await Promise.resolve()
    await Promise.resolve()
    ack(true)
    await again
    expect(count).toBe(2)
  })
})

describe('ServiceChoices: the open-file pick', () => {
  function setup() {
    const picks: Record<string, string> = {}
    const restarts: string[] = []
    const choices = new ServiceChoices({
      plugins: async () => [review('a.one', 'One'), review('a.two', 'Two'), { id: 'a.plain' }],
      choices: () => ({ ...picks }),
      setChoice: (_p, key, pluginId) => {
        if (pluginId === null) delete picks[key]
        else picks[key] = pluginId
        return true
      },
      restart: async (projectId) => void restarts.push(projectId)
    })
    return { choices, picks, restarts }
  }

  it('stores a candidate or the built-in viewer under the reserved key, with no host restart', async () => {
    const { choices, picks, restarts } = setup()
    expect((await choices.status(P)).openFile).toEqual({
      candidates: [
        { id: 'a.one', title: 'One' },
        { id: 'a.two', title: 'Two' }
      ],
      selected: null
    })
    await choices.setProvider(P, OPEN_FILE_PICK, 'a.two')
    expect(picks).toEqual({ [OPEN_FILE_PICK]: 'a.two' })
    expect((await choices.status(P)).openFile.selected).toBe('a.two')
    await choices.setProvider(P, OPEN_FILE_PICK, BUILTIN_VIEWER)
    expect((await choices.status(P)).openFile.selected).toBe(BUILTIN_VIEWER)
    await choices.setProvider(P, OPEN_FILE_PICK, null)
    expect(picks).toEqual({})
    expect(restarts).toEqual([])
  })

  it('refuses a plugin that does not declare openFile, one not in the project, and a non-string', async () => {
    const { choices, picks } = setup()
    await expect(choices.setProvider(P, OPEN_FILE_PICK, 'a.plain')).rejects.toThrow('does not open files')
    await expect(choices.setProvider(P, OPEN_FILE_PICK, 'x.other')).rejects.toThrow('does not open files')
    await expect(choices.setProvider(P, OPEN_FILE_PICK, 5)).rejects.toThrow('string or null')
    expect(picks).toEqual({})
  })
})

describe('ctx.files.onOpen (host)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(openFile = true) {
    const logs: string[] = []
    const contexts = new HostContexts({ log: (id, level, text) => void logs.push(`${id} ${level} ${text}`) })
    const ctx = contexts.create(hostSpec({ id: 'a.rev', dir: '/d', main: 'm.js', ...(openFile ? { openFile: true } : {}) }))
    const open = (pluginId = 'a.rev'): Promise<boolean> => contexts.openFile({ pluginId, path: 'src/a.ts', tabId: 't1' })
    return { contexts, ctx, logs, open }
  }

  it('calls the listener with { path, tabId } and acks true', async () => {
    const { ctx, open } = setup()
    const seen: unknown[] = []
    ctx.files.onOpen((req) => void seen.push(req))
    await expect(open()).resolves.toBe(true)
    expect(seen).toEqual([{ path: 'src/a.ts', tabId: 't1' }])
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('acks false with no listener, after the disposer, for another plugin, and after deactivate', async () => {
    const { contexts, ctx, open } = setup()
    await expect(open()).resolves.toBe(false)
    const off = ctx.files.onOpen(() => {})
    await expect(open('a.other')).resolves.toBe(false)
    off()
    await expect(open()).resolves.toBe(false)
    ctx.files.onOpen(() => {})
    contexts.dispose('a.rev')
    await expect(open()).resolves.toBe(false)
    expect(() => ctx.files.onOpen(() => {})).toThrow('deactivated')
  })

  it('acks false when every listener throws or rejects (logged), true when one of several works', async () => {
    const { ctx, open, logs } = setup()
    const offA = ctx.files.onOpen(() => {
      throw new Error('sync boom')
    })
    const offB = ctx.files.onOpen(async () => {
      throw new Error('async boom')
    })
    await expect(open()).resolves.toBe(false)
    expect(logs.join('\n')).toContain('sync boom')
    expect(logs.join('\n')).toContain('async boom')
    ctx.files.onOpen(() => {})
    await expect(open()).resolves.toBe(true)
    offA()
    offB()
  })

  it('a listener still pending after the wait counts as handled (it may await an overlay)', async () => {
    vi.useFakeTimers()
    const listener = vi.fn(() => new Promise(() => {}))
    const result = runOpenListeners([listener], { path: 'a', tabId: 't' }, () => {})
    await vi.advanceTimersByTimeAsync(OPEN_LISTENER_WAIT_MS)
    await expect(result).resolves.toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('refuses a listener without contributes.openFile, and a non-function', () => {
    expect(() => setup(false).ctx.files.onOpen(() => {})).toThrow('contributes')
    expect(() => setup().ctx.files.onOpen('x' as never)).toThrow('needs a function')
  })

  it('refuses malformed files.open params', async () => {
    const { contexts } = setup()
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 5, tabId: 't1' })).rejects.toThrow('must be strings')
  })

  it('the spec parser keeps openFile only as a boolean', () => {
    const base = { id: 'a.b', dir: '/d', main: 'm.js', projectDir: '/p', dataDir: '/x', appDataDir: '/y', storageFile: '/x/s', commands: [], settings: { project: {}, app: {} } }
    expect(parsePluginSpecs({ plugins: [{ ...base, openFile: true }] })[0]?.openFile).toBe(true)
    expect(parsePluginSpecs({ plugins: [base] })[0]?.openFile).toBeUndefined()
    expect(() => parsePluginSpecs({ plugins: [{ ...base, openFile: 'yes' }] })).toThrow('openFile must be a boolean')
  })
})
