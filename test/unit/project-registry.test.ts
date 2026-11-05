import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_DISCUSS_PROMPT } from '../../src/shared/discuss'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as nodeFs from 'node:fs'
import { projectFile, projectId } from '../../src/main/paths'
import { MAX_RECENT_PROJECTS, ProjectRegistry } from '../../src/main/projects/registry'
import type { FsOps } from '../../src/main/store/json-file'
import { defaultLayout, hidePanel, movePanel, reconcile } from '../../src/shared/layout'
import { BUILTIN_VIEWER, OPEN_FILE_PICK } from '../../src/shared/services'

let root: string
let dataDir: string
let work: string
let logs: string[]
let clock: number

beforeEach(() => {
  // realpath: on macOS the tmpdir is /var/... -> /private/var/..., and the registry stores the real path.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-registry-')))
  dataDir = join(root, 'data')
  work = join(root, 'work')
  mkdirSync(work)
  logs = []
  clock = 1000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function registry(): ProjectRegistry {
  return new ProjectRegistry({ dataDir, log: (m) => logs.push(m), now: () => ++clock })
}

function folder(name: string): string {
  const p = join(work, name)
  mkdirSync(p)
  return p
}

describe('openPath', () => {
  it('creates a record keyed by the hash of the real path', () => {
    const reg = registry()
    const dir = folder('alpha')
    const view = reg.openPath(dir)
    expect(view.id).toBe(projectId(dir))
    expect(view.path).toBe(dir)
    expect(view.name).toBe('alpha')
    expect(view.missing).toBe(false)
    expect(view.enabledPlugins).toEqual([])
    expect(view.tabs).toEqual([])
    reg.flushAll()
    expect(existsSync(projectFile(dataDir, view.id))).toBe(true)
  })

  it('gives the same id for a symlink, a trailing slash and a dotted path', () => {
    const reg = registry()
    const dir = folder('alpha')
    const link = join(work, 'link')
    symlinkSync(dir, link)
    const first = reg.openPath(dir)
    expect(reg.openPath(link).id).toBe(first.id)
    expect(reg.openPath(dir + '/').id).toBe(first.id)
    expect(reg.openPath(join(dir, 'sub', '..')).id).toBe(first.id)
    expect(reg.list()).toHaveLength(1)
  })

  it('loads an existing record from disk in a new registry', () => {
    const dir = folder('alpha')
    const a = registry()
    a.openPath(dir)
    a.update(projectId(dir), (r) => {
      r.enabledPlugins = ['hello.demo']
      r.pluginSettings = { 'hello.demo': { greeting: 'hi' } }
    })
    a.flushAll()

    const b = registry()
    const view = b.openPath(dir)
    expect(view.enabledPlugins).toEqual(['hello.demo'])
    expect(view.pluginSettings).toEqual({ 'hello.demo': { greeting: 'hi' } })
  })

  it('refuses a path that is not an existing directory and has no record', () => {
    const reg = registry()
    expect(() => reg.openPath(join(work, 'nope'))).toThrow(/not a directory/)
    const file = join(work, 'file.txt')
    writeFileSync(file, 'x')
    expect(() => reg.openPath(file)).toThrow(/not a directory/)
    expect(reg.list()).toEqual([])
  })

  it('updates recents newest first and caps the list', () => {
    const reg = registry()
    const a = reg.openPath(folder('a'))
    const b = reg.openPath(folder('b'))
    expect(reg.recent().map((p) => p.id)).toEqual([b.id, a.id])
    reg.openPath(join(work, 'a'))
    expect(reg.recent().map((p) => p.id)).toEqual([a.id, b.id])

    for (let i = 0; i < MAX_RECENT_PROJECTS + 3; i++) reg.openPath(folder(`p${i}`))
    expect(reg.app.data.recentProjects).toHaveLength(MAX_RECENT_PROJECTS)
  })
})

describe('views', () => {
  it('are copies: mutating one does not change the stored record', () => {
    const reg = registry()
    const view = reg.openPath(folder('a'))
    view.tabs.push({ id: 't', kind: 'shell', cwd: '/' })
    expect(reg.get(view.id)?.tabs).toHaveLength(0)
  })
})

describe('findByPath', () => {
  it('finds a record by any spelling of its folder, without creating one or moving recents', () => {
    const reg = registry()
    const dirA = folder('a')
    const a = reg.openPath(dirA)
    reg.openPath(folder('b'))
    const before = reg.recent().map((p) => p.id)
    expect(reg.findByPath(join(dirA, '.'))?.id).toBe(a.id)
    // What `ccc --project` may send: a trailing slash, or a symlink to the folder (macOS /var vs
    // /private/var is the everyday case).
    expect(reg.findByPath(`${dirA}/`)?.id).toBe(a.id)
    const link = join(dirname(dirA), 'link-to-a')
    symlinkSync(dirA, link)
    expect(reg.findByPath(link)?.id).toBe(a.id)
    expect(reg.recent().map((p) => p.id)).toEqual(before)
    const unknown = folder('unknown')
    expect(reg.findByPath(unknown)).toBeUndefined()
    expect(reg.list().map((p) => p.path)).not.toContain(unknown)
  })
})

describe('missing folders', () => {
  it('flags a record whose folder was removed, in get, list and openPath', () => {
    const dir = folder('gone')
    const reg = registry()
    const { id } = reg.openPath(dir)
    reg.flushAll()
    rmSync(dir, { recursive: true })

    const fresh = registry()
    expect(fresh.get(id)?.missing).toBe(true)
    expect(fresh.list().map((p) => p.missing)).toEqual([true])
    // Re-opening the vanished path returns the known record instead of throwing, so the UI can
    // offer relink or forget.
    expect(fresh.openPath(dir)).toMatchObject({ id, missing: true })
  })

  it('does not flag a folder that is there', () => {
    const reg = registry()
    const { id } = reg.openPath(folder('here'))
    expect(reg.get(id)?.missing).toBe(false)
  })
})

describe('relink', () => {
  it('keeps the id, settings and tabs and updates path and name', () => {
    const reg = registry()
    const old = folder('old')
    const { id } = reg.openPath(old)
    reg.update(id, (r) => {
      r.enabledPlugins = ['x.y']
      r.tabs = [{ id: 't1', kind: 'shell', cwd: old }]
    })
    const moved = folder('moved')
    const view = reg.relink(id, moved)
    expect(view).toMatchObject({ id, path: moved, name: 'moved', missing: false })
    expect(view.enabledPlugins).toEqual(['x.y'])
    expect(view.tabs).toHaveLength(1)
    reg.flushAll()
    expect(registry().get(id)?.path).toBe(moved)
  })

  it('makes openPath on the new folder find the relinked record, not create a second one', () => {
    const reg = registry()
    const { id } = reg.openPath(folder('old'))
    const moved = folder('moved')
    reg.relink(id, moved)
    expect(reg.openPath(moved).id).toBe(id)
    expect(reg.list()).toHaveLength(1)
    // Same after a restart: the scan finds it by path, not by hash.
    reg.flushAll()
    const again = registry()
    expect(again.openPath(moved).id).toBe(id)
    expect(again.list()).toHaveLength(1)
  })

  it('gives a new record a different id when the old folder path is opened again after a relink', () => {
    const reg = registry()
    const p1 = folder('p1')
    const a = reg.openPath(p1)
    const p2 = folder('p2')
    reg.relink(a.id, p2)
    rmSync(p1, { recursive: true })
    mkdirSync(p1)
    const b = reg.openPath(p1)
    expect(b.id).not.toBe(a.id)
    expect(b.path).toBe(p1)
    expect(reg.get(a.id)?.path).toBe(p2)
    expect(reg.list()).toHaveLength(2)
  })

  it('refuses an unknown id, a non-directory and a folder owned by another record', () => {
    const reg = registry()
    const a = reg.openPath(folder('a'))
    const b = reg.openPath(folder('b'))
    expect(() => reg.relink('0123456789abcdef', work)).toThrow(/unknown project/)
    expect(() => reg.relink(a.id, join(work, 'nope'))).toThrow(/not a directory/)
    expect(() => reg.relink(a.id, b.path)).toThrow(/already a project/)
    expect(reg.get(a.id)?.path).toBe(join(work, 'a'))
  })
})

describe('forget', () => {
  it('removes the record file and drops the id from open and recent lists', () => {
    const reg = registry()
    const { id } = reg.openPath(folder('a'))
    reg.markOpen(id)
    reg.flushAll()
    expect(existsSync(projectFile(dataDir, id))).toBe(true)

    reg.forget(id)
    expect(existsSync(projectFile(dataDir, id))).toBe(false)
    expect(reg.get(id)).toBeUndefined()
    expect(reg.list()).toEqual([])
    expect(reg.app.data.openProjects).toEqual([])
    expect(reg.app.data.recentProjects).toEqual([])
  })

  it('does not resurrect the file through a pending debounced write', () => {
    const reg = registry()
    const { id } = reg.openPath(folder('a'))
    // No flush: the write is still pending when we forget.
    reg.forget(id)
    reg.flushAll()
    expect(existsSync(projectFile(dataDir, id))).toBe(false)
  })

  it('ignores unknown and malformed ids', () => {
    const reg = registry()
    expect(() => reg.forget('0123456789abcdef')).not.toThrow()
    expect(() => reg.forget('../../etc/passwd')).not.toThrow()
  })

  it('lets the same folder be opened again as a fresh project', () => {
    const reg = registry()
    const dir = folder('a')
    const first = reg.openPath(dir)
    reg.update(first.id, (r) => {
      r.enabledPlugins = ['x.y']
    })
    reg.forget(first.id)
    const again = reg.openPath(dir)
    expect(again.id).toBe(first.id)
    expect(again.enabledPlugins).toEqual([])
  })
})

describe('app.json open list', () => {
  it('persists open ids across a restart and skips forgotten or unknown ones', () => {
    const reg = registry()
    const a = reg.openPath(folder('a'))
    const b = reg.openPath(folder('b'))
    reg.markOpen(a.id)
    reg.markOpen(a.id)
    reg.markOpen(b.id)
    reg.markOpen('0123456789abcdef') // unknown: ignored
    reg.flushAll()

    const again = registry()
    expect(again.openIds()).toEqual([a.id, b.id])
    again.markClosed(a.id)
    expect(again.openIds()).toEqual([b.id])
    again.forget(b.id)
    expect(again.openIds()).toEqual([])
  })

  it('treats a damaged openProjects value as an empty list', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ schemaVersion: 1, openProjects: 'oops' }))
    expect(registry().openIds()).toEqual([])
  })

  // JsonFile's shallow merge keeps a present null over the default []: every list method used
  // to throw on it, so no project could be opened and markOpen failed after its window existed.
  it.each([null, 'oops', { a: 1 }])('repairs damaged open and recent lists (%j) at load', (bad) => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'app.json'),
      JSON.stringify({ schemaVersion: 1, openProjects: bad, recentProjects: bad })
    )
    const reg = registry()
    expect(reg.recent()).toEqual([])
    const a = reg.openPath(folder('a'))
    const b = reg.openPath(folder('b'))
    reg.markOpen(a.id)
    reg.markOpen(b.id)
    expect(reg.openIds()).toEqual([a.id, b.id])
    expect(reg.recent().map((p) => p.id)).toEqual([b.id, a.id])
    reg.markClosed(a.id)
    reg.forget(b.id)
    expect(reg.openIds()).toEqual([])
    expect(reg.recent().map((p) => p.id)).toEqual([a.id])
    reg.flushAll()
    const app = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as Record<string, unknown>
    expect(app.openProjects).toEqual([])
    expect(app.recentProjects).toEqual([a.id])
  })

  it('drops non-string entries from the open and recent lists', () => {
    const reg = registry()
    const a = reg.openPath(folder('a'))
    reg.markOpen(a.id)
    reg.flushAll()
    writeFileSync(
      join(dataDir, 'app.json'),
      JSON.stringify({ schemaVersion: 1, openProjects: [7, a.id, null], recentProjects: [{}, a.id] })
    )
    const again = registry()
    expect(again.app.data.openProjects).toEqual([a.id])
    expect(again.app.data.recentProjects).toEqual([a.id])
  })

  it('writes app.json with a schemaVersion', () => {
    const reg = registry()
    reg.openPath(folder('a'))
    reg.flushAll()
    const app = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as Record<string, unknown>
    expect(app.schemaVersion).toBe(1)
    expect(app.keyOverrides).toEqual({})
  })
})

describe('bad files', () => {
  it('treats a corrupt record as not a project and keeps a copy', () => {
    const dir = folder('a')
    const id = projectId(dir)
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    writeFileSync(projectFile(dataDir, id), '{ not json')

    const reg = registry()
    expect(reg.get(id)).toBeUndefined()
    expect(reg.list()).toEqual([])
    expect(readdirSync(join(dataDir, 'projects')).some((n) => n.includes('.corrupt-'))).toBe(true)
    // Opening the folder again replaces the unusable record with a fresh one.
    expect(reg.openPath(dir).id).toBe(id)
  })

  it('loads data written before accounts left core: accounts.json and old choices are left alone', () => {
    const dir = folder('a')
    const id = projectId(dir)
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    const accountsJson = join(dataDir, 'accounts.json')
    const oldAccounts = JSON.stringify({ schemaVersion: 1, accounts: { 'hello-token:me': { kind: 'hello-token' } } })
    writeFileSync(accountsJson, oldAccounts)
    writeFileSync(
      projectFile(dataDir, id),
      JSON.stringify({
        schemaVersion: 1,
        id,
        path: dir,
        name: 'a',
        enabledPlugins: ['hello.demo'],
        accounts: { 'hello.demo/hello-token': 'hello-token:me' },
        pluginSettings: {},
        layout: defaultLayout(),
        tabs: [],
        lastOpenedAt: 1
      })
    )

    const reg = registry()
    expect(reg.get(id)?.enabledPlugins).toEqual(['hello.demo'])
    reg.update(id, (r) => {
      r.enabledPlugins = []
    })
    reg.flushAll()
    expect(logs).toEqual([])
    // The rewritten project file still holds the old key.
    expect(JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8')).accounts).toEqual({ 'hello.demo/hello-token': 'hello-token:me' })
    // Ignored, never deleted (the README says it can be removed by hand).
    expect(readFileSync(accountsJson, 'utf8')).toBe(oldAccounts)
    expect(readdirSync(join(dataDir, 'projects')).some((n) => n.includes('.corrupt-'))).toBe(false)
  })

  it('ignores stray files in projects/', () => {
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    writeFileSync(join(dataDir, 'projects', 'notes.txt'), 'x')
    writeFileSync(join(dataDir, 'projects', '0123456789abcdef.json.tmp'), '{}')
    expect(registry().list()).toEqual([])
  })
})

describe('layout', () => {
  const available = [{ panelKey: 'test/sessions', defaultZone: 'left' as const }]

  it('gives a new record the default layout', () => {
    const view = registry().openPath(folder('a'))
    expect(view.layout).toEqual(defaultLayout())
  })

  it('persists a changed layout through the debounced writer and reloads it', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    const layout = movePanel(reconcile(defaultLayout(), available), 'test/sessions', 'bottom')
    reg.setLayout(id, layout)
    reg.flushAll()

    const again = registry().get(id)!
    expect(again.layout).toEqual(layout)
    expect(again.layout.zones.bottom.panels.map((p) => p.panelKey)).toEqual(['test/sessions'])
  })

  it('re-validates a layout passed to setLayout', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    reg.setLayout(id, { zones: 7, hidden: 'x' } as never)
    expect(reg.get(id)!.layout).toEqual(defaultLayout())
  })

  it('loads a record written before Task 17 (layout: {}) as the default layout', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    reg.update(id, (r) => {
      r.layout = {} as never
    })
    reg.flushAll()

    expect(registry().get(id)!.layout).toEqual(defaultLayout())
  })

  it('loads the core Sessions panel of a record written before 0.10 as cockpit.sessions/sessions, in its place', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    const old = { ...defaultLayout(), zones: { ...defaultLayout().zones, right: { collapsed: false, size: 320, panels: [{ panelKey: 'core/sessions', open: true, size: 260 }] } } }
    reg.update(id, (r) => {
      r.layout = old
    })
    reg.flushAll()

    expect(registry().get(id)!.layout.zones.right.panels).toEqual([{ panelKey: 'cockpit.sessions/sessions', open: true, size: 260 }])
  })

  it('keeps hidden panels hidden across a reload', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    reg.setLayout(id, hidePanel(reconcile(defaultLayout(), available), 'test/sessions'))
    reg.flushAll()

    expect(registry().get(id)!.layout.hidden).toEqual(['test/sessions'])
  })
})

describe('colour', () => {
  it('has none on a new record, and keeps a stored one across a reload', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    expect(reg.get(id)).not.toHaveProperty('color')
    reg.update(id, (r) => {
      r.color = '#12abef'
    })
    reg.flushAll()
    expect(JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8')).color).toBe('#12abef')
    expect(registry().get(id)!.color).toBe('#12abef')
  })

  it('reads a damaged stored value as none, and an upper-case hex as its lower case', () => {
    const reg = registry()
    const ids = ['a', 'b', 'c', 'd', 'e'].map((name) => reg.openPath(folder(name)).id)
    const stored: unknown[] = ['Blue', 5, { r: 1 }, '#ABCDEF', 'teal']
    ids.forEach((id, i) => {
      reg.update(id, (r) => {
        r.color = stored[i] as never
      })
    })
    reg.flushAll()

    const fresh = registry()
    expect(ids.map((id) => fresh.get(id)!.color)).toEqual([undefined, undefined, undefined, '#abcdef', 'teal'])
    expect(fresh.get(ids[0]!)).not.toHaveProperty('color')
  })

  it('repairs a damaged Discuss prompt, project and global, to absent but keeps an empty one', () => {
    const reg = registry()
    const ids = ['a', 'b', 'c', 'd'].map((name) => reg.openPath(folder(name)).id)
    const stored: unknown[] = [5, 'x'.repeat(MAX_DISCUSS_PROMPT + 1), '', 'Be brief']
    ids.forEach((id, i) => reg.update(id, (r) => void (r.discussPrompt = stored[i] as never)))
    reg.flushAll()
    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ schemaVersion: 1, discussPrompt: 7 }))

    const fresh = registry()
    expect(ids.map((id) => fresh.get(id)!.discussPrompt)).toEqual([undefined, undefined, '', 'Be brief'])
    expect(fresh.app.data).not.toHaveProperty('discussPrompt')
  })
})

describe('service providers', () => {
  it('has none on a new record; a pick is saved, read back after a reload, and cleared with null', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    expect(reg.serviceProviders(id)).toEqual({})
    expect(reg.get(id)).not.toHaveProperty('serviceProviders')
    expect(reg.setServiceProvider(id, 'triage', 'a.one')).toBe(true)
    // The same value again is no change (the caller restarts the host only on a change).
    expect(reg.setServiceProvider(id, 'triage', 'a.one')).toBe(false)
    expect(reg.setServiceProvider(id, 'mail', 'a.two')).toBe(true)
    reg.flushAll()
    expect(JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8')).serviceProviders).toEqual({ triage: 'a.one', mail: 'a.two' })
    const fresh = registry()
    expect(fresh.serviceProviders(id)).toEqual({ triage: 'a.one', mail: 'a.two' })
    expect(fresh.setServiceProvider(id, 'triage', null)).toBe(true)
    expect(fresh.setServiceProvider(id, 'triage', null)).toBe(false)
    expect(fresh.setServiceProvider(id, 'mail', null)).toBe(true)
    expect(fresh.get(id)).not.toHaveProperty('serviceProviders')
  })

  it('reads a damaged stored value as no picks, keeping only valid string pairs', () => {
    const reg = registry()
    const ids = ['a', 'b', 'c', 'd'].map((name) => reg.openPath(folder(name)).id)
    const stored: unknown[] = ['triage', ['a.one'], { triage: 5, 'Bad Name': 'a.one', mail: '' }, { triage: 'a.one', x: null }]
    ids.forEach((id, i) => reg.update(id, (r) => void (r.serviceProviders = stored[i] as never)))
    reg.flushAll()
    const fresh = registry()
    expect(ids.map((id) => fresh.serviceProviders(id))).toEqual([{}, {}, {}, { triage: 'a.one' }])
    expect(fresh.get(ids[2]!)).not.toHaveProperty('serviceProviders')
    // An unknown project has none and cannot be written.
    expect(fresh.serviceProviders('0123456789abcdef')).toEqual({})
    expect(() => fresh.setServiceProvider('0123456789abcdef', 'triage', 'a.one')).toThrow(/unknown project/)
  })

  it('keeps the reserved open-file pick across a reload; another non-service key still goes', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    expect(reg.setServiceProvider(id, OPEN_FILE_PICK, BUILTIN_VIEWER)).toBe(true)
    reg.update(id, (r) => void (r.serviceProviders = { ...r.serviceProviders, '@other': 'a.one' }))
    reg.flushAll()
    expect(registry().serviceProviders(id)).toEqual({ [OPEN_FILE_PICK]: BUILTIN_VIEWER })
  })

  it('keeps @slot:<type> picks across a reload; a slot key with a bad type goes', () => {
    const reg = registry()
    const id = reg.openPath(folder('a')).id
    expect(reg.setServiceProvider(id, '@slot:agenda', 'a.one')).toBe(true)
    expect(reg.setServiceProvider(id, '@slot:sessions-strip', '@none')).toBe(true)
    reg.update(id, (r) => void (r.serviceProviders = { ...r.serviceProviders, '@slot:Bad': 'a.one', '@slot:': 'a.one', '@slot:x': '' }))
    reg.flushAll()
    const fresh = registry()
    expect(fresh.serviceProviders(id)).toEqual({ '@slot:agenda': 'a.one', '@slot:sessions-strip': '@none' })
    expect(fresh.setServiceProvider(id, '@slot:agenda', null)).toBe(true)
    expect(fresh.serviceProviders(id)).toEqual({ '@slot:sessions-strip': '@none' })
  })
})

describe('data dir containment', () => {
  it('writes only under the temp data dir', () => {
    const reg = registry()
    const a = reg.openPath(folder('a'))
    reg.markOpen(a.id)
    reg.relink(a.id, folder('b'))
    reg.flushAll()

    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p.slice(dataDir.length + 1))
      }
    }
    walk(dataDir)
    expect(files.sort()).toEqual(['app.json', join('projects', `${a.id}.json`)])
  })
})

describe('rememberPluginRepo', () => {
  const slow = (fs?: FsOps): ProjectRegistry =>
    new ProjectRegistry({ dataDir, debounceMs: 60_000, log: (m) => logs.push(m), now: () => ++clock, ...(fs ? { fs } : {}) })
  const onDisk = (): unknown => (JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginRepos?: unknown }).pluginRepos

  it('has it on disk when it returns, not a debounce later, keeping the other ids', () => {
    const reg = slow()
    reg.rememberPluginRepo('x.y', 'https://a/x.git')
    reg.rememberPluginRepo('p.q', 'https://a/p.git')
    expect(onDisk()).toEqual({ 'x.y': 'https://a/x.git', 'p.q': 'https://a/p.git' })
  })

  it('throws on a failed write, and memory goes on saying what the file says', () => {
    slow().rememberPluginRepo('x.y', 'https://a/x.git')
    const reg = slow({ ...nodeFs, renameSync: () => { throw new Error('ENOSPC') } } as unknown as FsOps)
    expect(() => reg.rememberPluginRepo('x.y', 'https://b/x.git')).toThrow(/could not be written/)
    expect(reg.app.data.pluginRepos).toEqual({ 'x.y': 'https://a/x.git' })
    expect(onDisk()).toEqual({ 'x.y': 'https://a/x.git' })
  })

  it('throws for an app.json that must not be overwritten, where a save only logs', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ schemaVersion: 99 }))
    expect(() => slow().rememberPluginRepo('x.y', 'https://a/x.git')).toThrow(/cannot be written/)
  })

  it('replaces a damaged list rather than writing into it', () => {
    const reg = slow()
    reg.app.update((a) => void ((a as { pluginRepos?: unknown }).pluginRepos = 'junk'))
    reg.rememberPluginRepo('x.y', 'https://a/x.git')
    expect(onDisk()).toEqual({ 'x.y': 'https://a/x.git' })
  })
})

describe('forgetPluginRepo', () => {
  const slow = (fs?: FsOps): ProjectRegistry =>
    new ProjectRegistry({ dataDir, debounceMs: 60_000, log: (m) => logs.push(m), now: () => ++clock, ...(fs ? { fs } : {}) })
  const onDisk = (): unknown => (JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { pluginRepos?: unknown }).pluginRepos

  it('has it gone from disk when it returns, keeping the other ids', () => {
    const reg = slow()
    reg.rememberPluginRepo('x.y', 'https://a/x.git')
    reg.rememberPluginRepo('p.q', 'https://a/p.git')
    reg.forgetPluginRepo('x.y')
    expect(onDisk()).toEqual({ 'p.q': 'https://a/p.git' })
  })

  it('throws on a failed write, and memory goes on saying what the file says', () => {
    slow().rememberPluginRepo('x.y', 'https://a/x.git')
    const reg = slow({ ...nodeFs, renameSync: () => { throw new Error('ENOSPC') } } as unknown as FsOps)
    expect(() => reg.forgetPluginRepo('x.y')).toThrow(/could not be written/)
    expect(reg.app.data.pluginRepos).toEqual({ 'x.y': 'https://a/x.git' })
    expect(onDisk()).toEqual({ 'x.y': 'https://a/x.git' })
  })

  it('with nothing to forget it needs no write, also on an app.json that must not be overwritten', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ schemaVersion: 99 }))
    expect(() => slow().forgetPluginRepo('x.y')).not.toThrow()
  })
})

describe('disablePluginEverywhere', () => {
  // A debounce no test waits out: only a write made on the spot can be on disk.
  const slow = (fs?: FsOps): ProjectRegistry =>
    new ProjectRegistry({ dataDir, debounceMs: 60_000, log: (m) => logs.push(m), now: () => ++clock, ...(fs ? { fs } : {}) })
  const onDiskList = (id: string): unknown => JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8')).enabledPlugins

  function twoProjects(): { a: string; b: string } {
    mkdirSync(join(work, 'a'))
    mkdirSync(join(work, 'b'))
    const reg = slow()
    const a = reg.openPath(join(work, 'a')).id
    const b = reg.openPath(join(work, 'b')).id
    reg.update(a, (r) => void (r.enabledPlugins = ['x.y', 'keep.me']))
    reg.update(b, (r) => void (r.enabledPlugins = ['x.y']))
    reg.flushAll()
    return { a, b }
  }

  it('has it off on disk when it returns, not a debounce later', () => {
    const { a, b } = twoProjects()
    slow().disablePluginEverywhere('x.y')
    expect(onDiskList(a)).toEqual(['keep.me'])
    expect(onDiskList(b)).toEqual([])
  })

  it('writes a change still waiting for the debounce, though memory no longer lists the plugin', () => {
    const { a } = twoProjects()
    const reg = slow()
    reg.update(a, (r) => void (r.enabledPlugins = ['keep.me']))
    expect(onDiskList(a)).toEqual(['x.y', 'keep.me'])
    reg.disablePluginEverywhere('x.y')
    expect(onDiskList(a)).toEqual(['keep.me'])
  })

  it('throws on a failed write, and memory goes on saying what the file says', () => {
    const { a, b } = twoProjects()
    const reg = slow({ ...nodeFs, renameSync: () => { throw new Error('ENOSPC') } } as unknown as FsOps)
    expect(() => reg.disablePluginEverywhere('x.y')).toThrow(/cannot turn x\.y off/)
    expect(onDiskList(a)).toEqual(['x.y', 'keep.me'])
    expect(onDiskList(b)).toEqual(['x.y'])
    // A retry must still see the enablement, or it would not be flagged as a repo change.
    expect(reg.list().some((p) => p.enabledPlugins.includes('x.y'))).toBe(true)
  })

  it('refuses when a record that may list the plugin cannot be read or written now', () => {
    const { a } = twoProjects()
    writeFileSync(projectFile(dataDir, a), JSON.stringify({ schemaVersion: 99, enabledPlugins: ['x.y'] }))
    expect(() => slow().disablePluginEverywhere('x.y')).toThrow(/cannot be written/)
  })

  it('refuses for a read-only record whose folder was opened again, which then has a path in memory', () => {
    const { a } = twoProjects()
    writeFileSync(projectFile(dataDir, a), JSON.stringify({ schemaVersion: 99, enabledPlugins: ['x.y'] }))
    const reg = slow()
    reg.openPath(join(work, 'a'))
    expect(reg.pluginMayBeEnabled('other.plugin')).toBe(true)
    expect(() => reg.disablePluginEverywhere('x.y')).toThrow(/cannot be written/)
  })

  // chmod does not stop root (CI containers).
  it.skipIf(process.getuid?.() === 0)('refuses, and may be enabled, when projects/ cannot be listed', () => {
    twoProjects()
    const dir = dirname(projectFile(dataDir, projectId(join(work, 'a'))))
    nodeFs.chmodSync(dir, 0o000)
    try {
      expect(slow().pluginMayBeEnabled('other.plugin')).toBe(true)
      expect(() => slow().disablePluginEverywhere('x.y')).toThrow(/cannot be listed/)
    } finally {
      nodeFs.chmodSync(dir, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)('counts a listed record it cannot reach, in a folder with no search permission', () => {
    twoProjects()
    const dir = dirname(projectFile(dataDir, projectId(join(work, 'a'))))
    nodeFs.chmodSync(dir, 0o400)
    try {
      expect(slow().pluginMayBeEnabled('other.plugin')).toBe(true)
      expect(() => slow().disablePluginEverywhere('x.y')).toThrow(/cannot be written/)
    } finally {
      nodeFs.chmodSync(dir, 0o700)
    }
  })
})

describe('pluginMayBeEnabled', () => {
  it('says yes for a listed plugin and no for another or with no projects', () => {
    const reg = registry()
    expect(reg.pluginMayBeEnabled('x.y')).toBe(false)
    const { id } = reg.openPath(folder('a'))
    reg.update(id, (r) => void (r.enabledPlugins = ['x.y']))
    expect(reg.pluginMayBeEnabled('x.y')).toBe(true)
    expect(reg.pluginMayBeEnabled('other.plugin')).toBe(false)
  })

  it.each<[string, string | undefined]>([
    ['written by a newer app', JSON.stringify({ schemaVersion: 99, enabledPlugins: [] })],
    ['unreadable', undefined]
  ])('says yes while a record is %s: it may come back listing it', (_name, text) => {
    const first = registry()
    const { id } = first.openPath(folder('a'))
    first.flushAll()
    const file = projectFile(dataDir, id)
    if (text !== undefined) writeFileSync(file, text)
    const eacces = {
      ...nodeFs,
      readFileSync: (path: string, encoding: 'utf8') => {
        if (path === file) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return nodeFs.readFileSync(path, encoding)
      }
    } as unknown as FsOps
    const reg = new ProjectRegistry({ dataDir, log: (m) => logs.push(m), now: () => ++clock, ...(text === undefined ? { fs: eacces } : {}) })
    expect(reg.pluginMayBeEnabled('other.plugin')).toBe(true)
  })

  it('does not count a corrupt record: it is quarantined and nothing reads its list again', () => {
    const first = registry()
    const { id } = first.openPath(folder('a'))
    first.flushAll()
    writeFileSync(projectFile(dataDir, id), '{')
    expect(registry().pluginMayBeEnabled('other.plugin')).toBe(false)
  })
})
