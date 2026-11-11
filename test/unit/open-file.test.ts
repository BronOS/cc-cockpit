// The open-file hook (friction round 1, Task 12): which plugin a Sessions panel file click goes to
// (the shared rule), main's routing with its checks and the built-in viewer as the fallback, the
// pick on the Plugins page, and the host's `ctx.files.onOpen` with its ack.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { OPEN_LISTENER_WAIT_MS, runOpenListeners } from '../../src/host/ctx/files'
import { currentView } from '../../src/host/ctx/origin-view'
import { parsePluginSpecs } from '../../src/host/loader'
import { ServiceChoices } from '../../src/main/plugins/service-choices'
import type { DiffTab } from '../../src/main/sessions/open-diff'
import type { OverlaySpec } from '../../src/main/overlays/overlay-manager'
import { openProjectFileDiff, type OpenDiffOptions } from '../../src/main/sessions/open-diff'
import {
  projectRelativePath,
  resolveProjectFile,
  routeOpenFile,
  routeProjectFile,
  type OpenFileRouteDeps
} from '../../src/main/sessions/open-file'
import { BUILTIN_VIEWER, OPEN_FILE_PICK, openFileStatus, selectOpenFile, type OpenFilePlugin } from '../../src/shared/services'
import { SLOT_NONE } from '../../src/shared/slots'
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
    const delivered: Array<{ projectId: string; pluginId: string; req: { path: string; tabId?: string; view?: string } }> = []
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
      builtinFile: async () => {
        throw new Error('not for a click')
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

  it("a click made in a remote view hands that view to the plugin (its listeners act there)", async () => {
    const { deps, delivered } = setup()
    await expect(routeOpenFile(deps, caller, 't1', '/work/p/src/a.ts', 'web:2')).resolves.toBe(true)
    expect(delivered).toEqual([{ projectId: P, pluginId: 'a.rev', req: { path: 'src/a.ts', tabId: 't1', view: 'web:2' } }])
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

describe('resolveProjectFile / routeProjectFile (ctx.files.open)', () => {
  let root: string
  let proj: string
  const caller = { windowId: 7, projectId: P }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-open-file-')))
    proj = join(root, 'proj')
    mkdirSync(join(proj, 'src'), { recursive: true })
    writeFileSync(join(proj, 'src', 'a.ts'), 'a')
    writeFileSync(join(root, 'secret.txt'), 's')
    // One link out of the project, one that stays inside.
    symlinkSync(root, join(proj, 'out'))
    symlinkSync(join(proj, 'src'), join(proj, 'in'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a file inside, normalized, and one through a link that stays inside', async () => {
    await expect(resolveProjectFile(proj, 'src/a.ts')).resolves.toBe('src/a.ts')
    await expect(resolveProjectFile(proj, './src//a.ts')).resolves.toBe('src/a.ts')
    await expect(resolveProjectFile(proj, 'in/a.ts')).resolves.toBe('in/a.ts')
  })

  it('refuses absolute paths, ".." segments, a link out, a missing path and a directory', async () => {
    await expect(resolveProjectFile(proj, join(proj, 'src', 'a.ts'))).rejects.toThrow('relative to the project folder')
    await expect(resolveProjectFile(proj, 'C:/x')).rejects.toThrow('relative to the project folder')
    await expect(resolveProjectFile(proj, '../secret.txt')).rejects.toThrow('".." segments')
    await expect(resolveProjectFile(proj, 'src/../src/a.ts')).rejects.toThrow('".." segments')
    await expect(resolveProjectFile(proj, 'out/secret.txt')).rejects.toThrow('outside the project folder')
    await expect(resolveProjectFile(proj, 'src/nope.ts')).rejects.toThrow('no such file')
    await expect(resolveProjectFile(proj, 'src')).rejects.toThrow('not a regular file')
    await expect(resolveProjectFile(proj, './')).rejects.toThrow('names the project folder')
    await expect(resolveProjectFile(proj, '')).rejects.toThrow('non-empty string')
    await expect(resolveProjectFile(proj, 5)).rejects.toThrow('non-empty string')
    await expect(resolveProjectFile(proj, 'src/a\0.ts')).rejects.toThrow('NUL')
  })

  function setup(options: { handler?: string | null; deliver?: OpenFileRouteDeps['deliver']; tabs?: Record<string, DiffTab> } = {}) {
    const delivered: Array<{ projectId: string; pluginId: string; req: { path: string; tabId?: string; view?: string } }> = []
    const builtinFiles: Array<{ projectDir: string; path: string }> = []
    const deps: OpenFileRouteDeps = {
      tab: (id) => (options.tabs ?? { t1: { projectId: P, cwd: proj, files: [] }, t2: { projectId: OTHER, cwd: proj, files: [] } })[id],
      projectPath: () => proj,
      windowOf: () => 7,
      handler: async () => (options.handler === undefined ? 'a.tree' : options.handler),
      deliver:
        options.deliver ??
        (async (projectId, pluginId, req) => {
          delivered.push({ projectId, pluginId, req })
          return true
        }),
      builtin: async () => {
        throw new Error('not for ctx.files.open')
      },
      builtinFile: async (_caller, projectDir, path) => {
        builtinFiles.push({ projectDir, path })
        return true
      },
      delivering: new Set(),
      log: () => {}
    }
    return { deps, delivered, builtinFiles }
  }

  it('hands the checked path to the picked plugin, with no tabId key when none was given', async () => {
    const { deps, delivered, builtinFiles } = setup()
    await expect(routeProjectFile(deps, caller, './src/a.ts')).resolves.toBe('plugin')
    expect(delivered).toEqual([{ projectId: P, pluginId: 'a.tree', req: { path: 'src/a.ts' } }])
    expect('tabId' in delivered[0]!.req).toBe(false)
    expect(builtinFiles).toEqual([])
  })

  it('an open made in a remote view hands that view to the picked plugin', async () => {
    const { deps, delivered } = setup()
    await expect(routeProjectFile(deps, caller, 'src/a.ts', undefined, 'web:2')).resolves.toBe('plugin')
    expect(delivered).toEqual([{ projectId: P, pluginId: 'a.tree', req: { path: 'src/a.ts', view: 'web:2' } }])
  })

  it('passes a tab of this project on, and drops a foreign or unknown one without an error', async () => {
    const { deps, delivered } = setup()
    await routeProjectFile(deps, caller, 'src/a.ts', 't1')
    await routeProjectFile(deps, caller, 'src/a.ts', 't2')
    await routeProjectFile(deps, caller, 'src/a.ts', 'nope')
    expect(delivered.map((d) => d.req)).toEqual([{ path: 'src/a.ts', tabId: 't1' }, { path: 'src/a.ts' }, { path: 'src/a.ts' }])
  })

  it('opens the built-in viewer over the project folder for the @builtin pick, a declined or a failed delivery', async () => {
    const none = setup({ handler: null })
    await expect(routeProjectFile(none.deps, caller, 'src/a.ts', 't1')).resolves.toBe('builtin')
    expect(none.delivered).toEqual([])
    expect(none.builtinFiles).toEqual([{ projectDir: proj, path: 'src/a.ts' }])

    const declined = setup({ deliver: async () => false })
    await expect(routeProjectFile(declined.deps, caller, 'src/a.ts')).resolves.toBe('builtin')
    expect(declined.builtinFiles).toHaveLength(1)

    const thrown = setup({
      deliver: async () => {
        throw new Error('host gone')
      }
    })
    await expect(routeProjectFile(thrown.deps, caller, 'src/a.ts')).resolves.toBe('builtin')
    expect(thrown.builtinFiles).toHaveLength(1)
  })

  it('a refused path reaches no plugin and no viewer', async () => {
    const { deps, delivered, builtinFiles } = setup()
    await expect(routeProjectFile(deps, caller, 'out/secret.txt')).rejects.toThrow('outside the project folder')
    await expect(routeProjectFile(deps, caller, '/etc/hosts')).rejects.toThrow('relative')
    expect(delivered).toEqual([])
    expect(builtinFiles).toEqual([])
  })

  it('rejects when the caller is no longer the project window, before or after the pick', async () => {
    const other = setup()
    other.deps.windowOf = () => 8
    await expect(routeProjectFile(other.deps, caller, 'src/a.ts')).rejects.toThrow('window is gone')
    let windowId: number | undefined = 7
    const gone = setup()
    gone.deps.windowOf = () => windowId
    gone.deps.handler = async () => {
      windowId = undefined
      return 'a.tree'
    }
    await expect(routeProjectFile(gone.deps, caller, 'src/a.ts')).rejects.toThrow('window is gone')
    expect(other.delivered).toEqual([])
    expect(gone.delivered).toEqual([])
  })

  it('a second open of the same file while the first waits for its ack calls the plugin once', async () => {
    let ack: (ok: boolean) => void = () => {}
    let count = 0
    const { deps } = setup({
      deliver: () => {
        count++
        return new Promise<boolean>((resolve) => (ack = resolve))
      }
    })
    const first = routeProjectFile(deps, caller, 'src/a.ts')
    await vi.waitFor(() => expect(count).toBe(1))
    await expect(routeProjectFile(deps, caller, 'src/a.ts', 't1')).resolves.toBe('plugin')
    ack(true)
    await expect(first).resolves.toBe('plugin')
    expect(count).toBe(1)
  })

  it('openProjectFileDiff: the diff over the project folder, one overlay per window and file at a time', async () => {
    const opened: Array<{ windowId: number; spec: OverlaySpec }> = []
    const options: OpenDiffOptions = {
      // The real tabs are never consulted: the synthetic one stands in.
      tab: () => {
        throw new Error('no tab lookup')
      },
      lsFiles: async () => ({ code: 0 }),
      open: (windowId, spec) => {
        opened.push({ windowId, spec })
        return new Promise(() => {})
      },
      shown: new Set(),
      log: () => {}
    }
    await expect(openProjectFileDiff(options, caller, proj, 'src/a.ts')).resolves.toBe(true)
    await expect(openProjectFileDiff(options, caller, proj, 'src/a.ts')).resolves.toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ windowId: 7, spec: { kind: 'terminal', cwd: proj, title: 'a.ts' } })
    expect((opened[0]!.spec as { argv: string[] }).argv).toContain(join(proj, 'src', 'a.ts'))
    expect([...options.shown]).toEqual(['7\0\0src/a.ts'])
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

describe('ServiceChoices: slot picks (design-next §2)', () => {
  function setup() {
    const picks: Record<string, string> = {}
    const restarts: string[] = []
    const refreshed: string[] = []
    const agenda = [{ type: 'agenda', entry: 'slots/agenda.html' }]
    const choices = new ServiceChoices({
      plugins: async () => [{ id: 'a.cal', slots: agenda }, { id: 'b.cal', slots: agenda }, { id: 'a.plain' }],
      choices: () => ({ ...picks }),
      setChoice: (_p, key, pluginId) => {
        if (pluginId === null) delete picks[key]
        else picks[key] = pluginId
        return true
      },
      restart: async (projectId) => void restarts.push(projectId),
      slotsChanged: (projectId) => void refreshed.push(projectId)
    })
    return { choices, picks, restarts, refreshed }
  }

  it('stores a candidate or @none under @slot:<type>, with no host restart', async () => {
    const { choices, picks, restarts, refreshed } = setup()
    expect((await choices.status(P)).slots).toEqual([{ type: 'agenda', candidates: ['a.cal', 'b.cal'], selected: null }])
    await choices.setProvider(P, '@slot:agenda', 'b.cal')
    expect(picks).toEqual({ '@slot:agenda': 'b.cal' })
    expect((await choices.status(P)).slots[0]?.selected).toBe('b.cal')
    await choices.setProvider(P, '@slot:agenda', SLOT_NONE)
    expect((await choices.status(P)).slots[0]?.selected).toBe(SLOT_NONE)
    await choices.setProvider(P, '@slot:agenda', null)
    expect(picks).toEqual({})
    expect(restarts).toEqual([])
    // Each change re-sends the layout instead (main resolves the frames again).
    expect(refreshed).toEqual([P, P, P])
  })

  it('refuses a plugin not declaring the type, a bad type and a non-string', async () => {
    const { choices, picks } = setup()
    await expect(choices.setProvider(P, '@slot:agenda', 'a.plain')).rejects.toThrow('does not provide slot "agenda"')
    await expect(choices.setProvider(P, '@slot:weather', 'a.cal')).rejects.toThrow('does not provide slot "weather"')
    await expect(choices.setProvider(P, '@slot:Bad', 'a.cal')).rejects.toThrow('bad slot type')
    await expect(choices.setProvider(P, '@slot:', null)).rejects.toThrow('bad slot type')
    await expect(choices.setProvider(P, '@slot:agenda', 5)).rejects.toThrow('string or null')
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

  it("runs the listeners in the remote view main names (origin-view.ts); the request stays { path, tabId }", async () => {
    const { contexts, ctx } = setup()
    const seen: unknown[] = []
    ctx.files.onOpen(async (req) => {
      await Promise.resolve()
      seen.push([req, currentView()])
    })
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 'src/a.ts', view: 'web:2' })).resolves.toBe(true)
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 'src/a.ts' })).resolves.toBe(true)
    // A view main never mints is refused (main opens its own viewer), never read as the desktop's.
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 'src/a.ts', view: 'desktop:1' })).rejects.toThrow('not a view id')
    expect(seen).toEqual([
      [{ path: 'src/a.ts' }, 'web:2'],
      [{ path: 'src/a.ts' }, undefined]
    ])
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
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 'a', tabId: 5 })).rejects.toThrow('tabId a string')
  })

  it('an open with no tab reaches the listener without a tabId key', async () => {
    const { contexts, ctx } = setup()
    const seen: Array<Record<string, unknown>> = []
    ctx.files.onOpen((req) => void seen.push(req as unknown as Record<string, unknown>))
    await expect(contexts.openFile({ pluginId: 'a.rev', path: 'src/a.ts' })).resolves.toBe(true)
    expect(seen).toEqual([{ path: 'src/a.ts' }])
    expect('tabId' in seen[0]!).toBe(false)
  })

  it('ctx.files.open asks main with its own plugin id, needs no declaration, and checks the shapes', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let answer: unknown = { via: 'builtin' }
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params) => {
        calls.push({ method, params })
        return answer
      }
    })
    // No contributes.openFile: calling open is for every plugin.
    const ctx = contexts.create(hostSpec({ id: 'a.tree', dir: '/d', main: 'm.js' }))
    await expect(ctx.files.open('src/a.ts')).resolves.toEqual({ via: 'builtin' })
    answer = { via: 'plugin' }
    await expect(ctx.files.open('src/a.ts', { tabId: 't1' })).resolves.toEqual({ via: 'plugin' })
    expect(calls).toEqual([
      { method: 'files.open', params: { pluginId: 'a.tree', path: 'src/a.ts' } },
      { method: 'files.open', params: { pluginId: 'a.tree', path: 'src/a.ts', tabId: 't1' } }
    ])
    await expect(ctx.files.open('' as string)).rejects.toThrow('needs a path')
    await expect(ctx.files.open('a', { tabId: 5 as never })).rejects.toThrow('tabId must be a string')
    await expect(ctx.files.open('a', 'x' as never)).rejects.toThrow('options must be an object')
    answer = { via: 'elsewhere' }
    await expect(ctx.files.open('a')).rejects.toThrow('unexpected answer')
    expect(calls).toHaveLength(3)
    contexts.dispose('a.tree')
    await expect(ctx.files.open('a')).rejects.toThrow('deactivated')
  })

  it('ctx.files.reveal / openWithSystem / trash ask main with their own plugin id; trash waits and tells a no apart', async () => {
    const calls: Array<{ method: string; params: unknown; options?: unknown }> = []
    let answer: unknown = null
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params, options) => {
        calls.push({ method, params, ...(options ? { options } : {}) })
        return answer
      }
    })
    const ctx = contexts.create(hostSpec({ id: 'a.tree', dir: '/d', main: 'm.js' }))
    await expect(ctx.files.reveal('')).resolves.toBeUndefined()
    await expect(ctx.files.openWithSystem('a.md')).resolves.toBeUndefined()
    answer = { trashed: true }
    await expect(ctx.files.trash('src')).resolves.toBeUndefined()
    expect(calls).toEqual([
      { method: 'files.reveal', params: { pluginId: 'a.tree', path: '' } },
      { method: 'files.openWithSystem', params: { pluginId: 'a.tree', path: 'a.md' } },
      // The person answers when they do: no RPC timeout on the dialog.
      { method: 'files.trash', params: { pluginId: 'a.tree', path: 'src' }, options: { timeoutMs: Infinity } }
    ])
    answer = { trashed: false }
    const no = await ctx.files.trash('src').catch((e: Error) => e)
    expect(no).toBeInstanceOf(Error)
    expect((no as Error).name).toBe('AbortError')
    expect((no as Error).message).toContain('cancelled')
    answer = {}
    await expect(ctx.files.trash('src')).rejects.toThrow('unexpected answer')
    // The project folder is reveal's only: the others refuse '' before asking main.
    await expect(ctx.files.openWithSystem('')).rejects.toThrow('not the folder itself')
    await expect(ctx.files.trash('')).rejects.toThrow('not the folder itself')
    await expect(ctx.files.reveal(5 as never)).rejects.toThrow('needs a path')
    expect(calls).toHaveLength(5)
  })

  it('the spec parser keeps openFile only as a boolean', () => {
    const base = { id: 'a.b', dir: '/d', main: 'm.js', projectDir: '/p', dataDir: '/x', appDataDir: '/y', storageFile: '/x/s', commands: [], settings: { project: {}, app: {} } }
    expect(parsePluginSpecs({ plugins: [{ ...base, openFile: true }] })[0]?.openFile).toBe(true)
    expect(parsePluginSpecs({ plugins: [base] })[0]?.openFile).toBeUndefined()
    expect(() => parsePluginSpecs({ plugins: [{ ...base, openFile: 'yes' }] })).toThrow('openFile must be a boolean')
  })
})
