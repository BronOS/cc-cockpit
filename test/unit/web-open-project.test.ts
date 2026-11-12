// Server mode's open from the browser picker (main/web/open-project.ts, design-web.md §9.8): the
// POST body's check and what main does with it. The gateway's HTTP side is in web-gateway.test.ts;
// the real WindowManager behind openPath / openRecent in window-manager.test.ts.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRefusal, ProjectRegistry } from '../../src/main/projects/registry'
import { forgetMissing, relinkMissing } from '../../src/main/restore'
import { MAX_OPEN_PATH, openProjectFromWeb, parseOpenProjectBody, type OpenProjectDeps } from '../../src/main/web/open-project'

describe('parseOpenProjectBody', () => {
  it('takes exactly one of open and reopen, each a plain non-empty string', async () => {
    expect(parseOpenProjectBody({ open: '/srv/app' })).toEqual({ open: '/srv/app' })
    expect(parseOpenProjectBody({ reopen: 'abc' })).toEqual({ reopen: 'abc' })
  })

  it('uses nothing else of the body', async () => {
    expect(parseOpenProjectBody({ reopen: 'abc', path: '/etc', windowId: 3 })).toEqual({ reopen: 'abc' })
  })

  it('refuses both keys, neither, and anything that is not an object', async () => {
    for (const body of [{ open: '/a', reopen: 'b' }, {}, { other: 1 }, null, [], 'x', 3, undefined]) {
      expect(parseOpenProjectBody(body), JSON.stringify(body)).toHaveProperty('error')
    }
  })

  it('refuses an empty, non-string, NUL-carrying or oversize value', async () => {
    for (const body of [{ open: '' }, { reopen: '' }, { open: 3 }, { reopen: null }, { open: ['/a'] }, { open: '/a\0b' }, { open: `/${'a'.repeat(MAX_OPEN_PATH)}` }]) {
      expect(parseOpenProjectBody(body), JSON.stringify(body).slice(0, 40)).toHaveProperty('error')
    }
  })

  it('takes relink with its new folder and forget, each with a project id', async () => {
    expect(parseOpenProjectBody({ relink: 'abc', path: '/srv/new' })).toEqual({ relink: 'abc', path: '/srv/new' })
    expect(parseOpenProjectBody({ forget: 'abc', path: '/ignored' })).toEqual({ forget: 'abc' })
    for (const body of [{ relink: 'abc' }, { relink: 'abc', path: '' }, { relink: 'abc', path: 3 }, { relink: '', path: '/a' }, { relink: 'a', path: '/a\0b' }, { forget: '' }, { forget: 1 }, { forget: 'a', reopen: 'b' }, { relink: 'a', path: '/x', open: '/y' }]) {
      expect(parseOpenProjectBody(body), JSON.stringify(body)).toHaveProperty('error')
    }
  })

  it('does not take an inherited key for an own one', async () => {
    const proto = { open: '/inherited' }
    expect(parseOpenProjectBody(Object.create(proto) as unknown)).toHaveProperty('error')
  })
})

/** The device is still signed in at the open (the gateway's re-check, open-project.ts `authorized`). */
const signedIn = (): boolean => true

describe('openProjectFromWeb', () => {
  let root: string
  let calls: string[]
  let deps: OpenProjectDeps
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-open-'))
    calls = []
    deps = {
      openPath: (path) => {
        calls.push(`open ${path}`)
        return { id: 'p-new' }
      },
      openRecent: (id) => {
        calls.push(`reopen ${id}`)
        if (id === 'gone') throw new ProjectRefusal('project folder is missing: /old/gone')
        if (id !== 'r1') throw new ProjectRefusal('not a recent project')
        return { id: 'r1' }
      }
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('opens an existing folder by its resolved path', async () => {
    const dir = join(root, 'app')
    mkdirSync(dir)
    expect(await openProjectFromWeb({ open: `${root}/x/../app/` }, deps, signedIn)).toEqual({ id: 'p-new' })
    expect(calls).toEqual([`open ${dir}`])
  })

  it('a link to a folder is a folder', async () => {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(await openProjectFromWeb({ open: join(root, 'link') }, deps, signedIn)).toEqual({ id: 'p-new' })
  })

  it('refuses a relative path, a file and a path that is not there, creating nothing', async () => {
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(await openProjectFromWeb({ open: 'app' }, deps, signedIn)).toEqual({ error: 'not an absolute path: app' })
    expect(await openProjectFromWeb({ open: '~/app' }, deps, signedIn)).toHaveProperty('error')
    expect(await openProjectFromWeb({ open: join(root, 'file.txt') }, deps, signedIn)).toEqual({ error: `not a folder: ${join(root, 'file.txt')}` })
    expect(await openProjectFromWeb({ open: join(root, 'nope') }, deps, signedIn)).toEqual({ error: `not a folder: ${join(root, 'nope')}` })
    expect(calls).toEqual([])
  })

  it('a failing open is a generic text (detail logged), a registry refusal its own text, never a throw', async () => {
    mkdirSync(join(root, 'app'))
    const failing: OpenProjectDeps = { ...deps, openPath: () => { throw new Error('cannot open a window') } }
    expect(await openProjectFromWeb({ open: join(root, 'app') }, failing, signedIn)).toEqual({ error: 'opening the project failed' })
    const logged: string[] = []
    const eacces: OpenProjectDeps = {
      ...deps,
      log: (l) => logged.push(l),
      openPath: () => {
        throw new Error("EACCES: open '/data/projects/x.json'")
      }
    }
    expect(await openProjectFromWeb({ open: join(root, 'app') }, eacces, signedIn)).toEqual({ error: 'opening the project failed' })
    expect(logged.join()).toContain('/data/projects/x.json')
    const refused: OpenProjectDeps = {
      ...deps,
      openPath: () => {
        throw new ProjectRefusal('not a directory: /x')
      }
    }
    expect(await openProjectFromWeb({ open: join(root, 'app') }, refused, signedIn)).toEqual({ error: 'not a directory: /x' })
    // Decided by the error's class, never its wording: a plain error with the same text is generic.
    const lookalike: OpenProjectDeps = {
      ...deps,
      openPath: () => {
        throw new Error('not a directory: /data/projects/x.json')
      }
    }
    expect(await openProjectFromWeb({ open: join(root, 'app') }, lookalike, signedIn)).toEqual({ error: 'opening the project failed' })
  })

  it('reopens by id through the recent list only; an unknown id and a missing folder say so', async () => {
    expect(await openProjectFromWeb({ reopen: 'r1' }, deps, signedIn)).toEqual({ id: 'r1' })
    expect(await openProjectFromWeb({ reopen: 'nope' }, deps, signedIn)).toEqual({ error: 'not a recent project' })
    expect(await openProjectFromWeb({ reopen: 'gone' }, deps, signedIn)).toEqual({ error: 'project folder is missing: /old/gone' })
    expect(calls).toEqual(['reopen r1', 'reopen nope', 'reopen gone'])
  })

  it('opens and reopens nothing for a device no longer signed in', async () => {
    mkdirSync(join(root, 'app'))
    expect(await openProjectFromWeb({ open: join(root, 'app') }, deps, () => false)).toEqual({ unauthorized: true })
    expect(await openProjectFromWeb({ reopen: 'r1' }, deps, () => false)).toEqual({ unauthorized: true })
    expect(calls).toEqual([])
  })

  // External review round 3: the device was checked before the folder's `stat`, never after it, so
  // one revoked while the stat was pending still had its folder opened.
  it('asks again after the folder check: a device revoked while it is pending opens nothing', async () => {
    let finish!: (isDir: boolean) => void
    let signed = true
    const asked: boolean[] = []
    const pending: OpenProjectDeps = {
      ...deps,
      isDirectory: () => new Promise<boolean>((resolve) => (finish = resolve))
    }
    const reply = openProjectFromWeb({ open: join(root, 'app') }, pending, () => {
      asked.push(signed)
      return signed
    })
    // The stat is pending: the device is revoked meanwhile.
    signed = false
    finish(true)
    expect(await reply).toEqual({ unauthorized: true })
    expect(asked).toEqual([false])
    expect(calls).toEqual([])
  })
})

// Relink and forget from a server's browser (design-web.md §9.8): main's own relinkMissing /
// forgetMissing behind the checked request, the new folder checked as an open's path, a refusal's
// text answered, and nothing changed for a device no longer signed in.
describe('openProjectFromWeb: relink and forget', () => {
  let root: string
  let dataDir: string
  let registry: ProjectRegistry
  let id: string
  let gone: string
  let opened: string[]
  let deps: OpenProjectDeps
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-relink-'))
    dataDir = join(root, 'data')
    mkdirSync(dataDir)
    registry = new ProjectRegistry({ dataDir, log: () => {} })
    gone = join(root, 'gone')
    mkdirSync(gone)
    id = registry.openPath(gone).id
    registry.update(id, (r) => {
      r.tabs = [{ id: 't', kind: 'shell', cwd: gone }]
    })
    opened = []
    // As main wires it (index.ts): the desktop's code, then open the relinked folder.
    deps = {
      openPath: (path) => {
        opened.push(path)
        return registry.openPath(path)
      },
      openRecent: () => {
        throw new ProjectRefusal('not a recent project')
      },
      relink: (projectId, path) => {
        const view = relinkMissing(registry, projectId, path)
        opened.push(view.path)
        return registry.openPath(view.path)
      },
      forget: (projectId) => forgetMissing(registry, projectId)
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('relinks a missing project to an existing folder (its tabs dropped) and opens it there', async () => {
    rmSync(gone, { recursive: true })
    const moved = join(root, 'moved')
    mkdirSync(moved)
    expect(await openProjectFromWeb({ relink: id, path: `${root}/x/../moved/` }, deps, signedIn)).toEqual({ id })
    expect(registry.get(id)).toMatchObject({ path: moved, missing: false, tabs: [] })
    expect(opened).toEqual([moved])
  })

  it('refuses a relink to a relative path, a file or nothing, and of a project that is fine or not recent, changing nothing', async () => {
    const moved = join(root, 'moved')
    mkdirSync(moved)
    writeFileSync(join(root, 'file.txt'), 'x')
    // Fine (not missing): the desktop's refusal, as text.
    expect(await openProjectFromWeb({ relink: id, path: moved }, deps, signedIn)).toEqual({ error: 'the project folder is not missing' })
    rmSync(gone, { recursive: true })
    expect(await openProjectFromWeb({ relink: id, path: 'moved' }, deps, signedIn)).toEqual({ error: 'not an absolute path: moved' })
    expect(await openProjectFromWeb({ relink: id, path: join(root, 'file.txt') }, deps, signedIn)).toEqual({ error: `not a folder: ${join(root, 'file.txt')}` })
    expect(await openProjectFromWeb({ relink: id, path: join(root, 'nope') }, deps, signedIn)).toEqual({ error: `not a folder: ${join(root, 'nope')}` })
    expect(await openProjectFromWeb({ relink: 'ffffffffffffffff', path: moved }, deps, signedIn)).toEqual({ error: 'not a recent project' })
    // Another project's folder: one record per folder.
    const other = registry.openPath(moved)
    expect(await openProjectFromWeb({ relink: id, path: moved }, deps, signedIn)).toEqual({ error: `that folder is already a project (${other.id})` })
    expect(registry.get(id)).toMatchObject({ path: gone, missing: true })
    expect(registry.get(id)?.tabs).toHaveLength(1)
    expect(opened).toEqual([])
  })

  it('forgets a missing recent project and its saved tabs; refuses one that is fine or unknown', async () => {
    expect(await openProjectFromWeb({ forget: id }, deps, signedIn)).toEqual({ error: 'the project folder is not missing' })
    expect(await openProjectFromWeb({ forget: 'ffffffffffffffff' }, deps, signedIn)).toEqual({ error: 'not a recent project' })
    expect(registry.get(id)).toBeDefined()
    rmSync(gone, { recursive: true })
    expect(await openProjectFromWeb({ forget: id }, deps, signedIn)).toEqual({ id })
    expect(registry.get(id)).toBeUndefined()
    expect(registry.recent()).toEqual([])
  })

  it('a device no longer signed in relinks and forgets nothing, also when revoked during the folder check', async () => {
    rmSync(gone, { recursive: true })
    const moved = join(root, 'moved')
    mkdirSync(moved)
    expect(await openProjectFromWeb({ forget: id }, deps, () => false)).toEqual({ unauthorized: true })
    expect(await openProjectFromWeb({ relink: id, path: moved }, deps, () => false)).toEqual({ unauthorized: true })
    let finish!: (isDir: boolean) => void
    let signed = true
    const reply = openProjectFromWeb({ relink: id, path: moved }, { ...deps, isDirectory: () => new Promise<boolean>((r) => (finish = r)) }, () => signed)
    signed = false
    finish(true)
    expect(await reply).toEqual({ unauthorized: true })
    expect(registry.get(id)).toMatchObject({ path: gone, missing: true })
  })

  it('a caller without relink or forget is refused, and an unexpected failure is generic with the detail logged', async () => {
    rmSync(gone, { recursive: true })
    const moved = join(root, 'moved')
    mkdirSync(moved)
    const bare: OpenProjectDeps = { openPath: deps.openPath, openRecent: deps.openRecent }
    expect(await openProjectFromWeb({ forget: id }, bare, signedIn)).toEqual({ error: 'forget is not available here' })
    expect(await openProjectFromWeb({ relink: id, path: moved }, bare, signedIn)).toEqual({ error: 'relink is not available here' })
    const logged: string[] = []
    const failing: OpenProjectDeps = {
      ...deps,
      log: (l) => logged.push(l),
      forget: () => {
        throw new Error("EACCES: unlink '/data/projects/x.json'")
      }
    }
    expect(await openProjectFromWeb({ forget: id }, failing, signedIn)).toEqual({ error: 'forgetting the project failed' })
    expect(logged.join()).toContain('/data/projects/x.json')
  })
})
