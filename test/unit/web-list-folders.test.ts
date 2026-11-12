// Server mode's folder browser, main's side (main/web/list-folders.ts, design-web.md §9.8): the body
// check, the start folder and its fallback, folders only, hidden ones, the marks (never through a
// link), the caps, and an unreadable folder as text rather than a throw. The gateway's HTTP side
// (server mode only, a device, the Origin check) is in web-gateway.test.ts.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listFolders, MAX_SCANNED_ENTRIES, parseFoldersBody, type FolderFs, type ListFoldersDeps } from '../../src/main/web/list-folders'
import { MAX_OPEN_PATH } from '../../src/main/web/open-project'
import { MAX_FOLDER_ENTRIES, type WebFoldersReply } from '../../src/shared/web-protocol'

/** A listing that is not an error, or the test fails saying what came back. */
function listed(reply: WebFoldersReply): Extract<WebFoldersReply, { folders: unknown }> {
  if ('error' in reply) throw new Error(`expected a listing, got: ${reply.error}`)
  return reply
}

describe('parseFoldersBody', () => {
  it('takes an absolute path (normalized) and hidden; absent or empty path is the start folder', () => {
    expect(parseFoldersBody({})).toEqual({})
    expect(parseFoldersBody({ path: '' })).toEqual({})
    expect(parseFoldersBody({ path: '/srv//a/../b/', hidden: true })).toEqual({ path: '/srv/b', hidden: true })
    expect(parseFoldersBody({ path: '/', hidden: false })).toEqual({ path: '/' })
    // Nothing else of the body is used.
    expect(parseFoldersBody({ path: '/srv', windowId: 3, open: '/etc' })).toEqual({ path: '/srv' })
  })

  it('refuses a relative path, a NUL, an oversize or non-string path, a non-boolean hidden, and a non-object', () => {
    expect(parseFoldersBody({ path: 'srv' })).toEqual({ error: 'not an absolute path: srv' })
    expect(parseFoldersBody({ path: '~/src' })).toHaveProperty('error')
    for (const body of [{ path: '/a\0b' }, { path: `/${'a'.repeat(MAX_OPEN_PATH)}` }, { path: 3 }, { path: null }, { hidden: 'yes' }, { hidden: 1 }, [], null, 'x', 3]) {
      expect(parseFoldersBody(body), JSON.stringify(body)?.slice(0, 40)).toHaveProperty('error')
    }
  })

  it('does not take an inherited key for an own one', () => {
    expect(parseFoldersBody(Object.create({ path: 'relative' }) as unknown)).toEqual({})
  })
})

describe('listFolders', () => {
  let root: string
  let home: string
  let start: string | undefined
  let projects: Set<string>
  let logged: string[]
  const deps = (over: Partial<ListFoldersDeps> = {}): ListFoldersDeps => ({
    home: () => home,
    startFolder: () => start,
    projectPaths: () => projects,
    log: (l) => logged.push(l),
    ...over
  })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-folders-')))
    home = join(root, 'home')
    mkdirSync(home)
    start = undefined
    projects = new Set()
    logged = []
  })
  afterEach(() => {
    // A chmod 000 folder must be readable again for rm.
    try {
      chmodSync(join(root, 'locked'), 0o755)
    } catch {
      // not made by this test
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('lists only folders, sorted as a person reads them, with the parent and home', async () => {
    for (const d of ['beta', 'Alpha', 'v10', 'v2']) mkdirSync(join(home, d))
    writeFileSync(join(home, 'notes.txt'), 'x')
    const reply = listed(await listFolders({ path: home }, deps()))
    expect(reply.folders.map((f) => f.name)).toEqual(['Alpha', 'beta', 'v2', 'v10'])
    expect(reply).toMatchObject({ path: home, parent: root, home, hiddenCount: 0, truncated: false, here: { git: false, project: false } })
    expect(JSON.stringify(reply)).not.toContain('notes.txt')
  })

  it('starts in the start folder, else home; a start folder that is gone falls back to home with a note', async () => {
    const srv = join(root, 'srv')
    mkdirSync(join(srv, 'app'), { recursive: true })
    mkdirSync(join(home, 'src'))
    expect(listed(await listFolders({}, deps()))).toMatchObject({ path: home, folders: [{ name: 'src' }] })
    expect(listed(await listFolders({}, deps())).note).toBeUndefined()
    start = srv
    expect(listed(await listFolders({}, deps()))).toMatchObject({ path: srv, folders: [{ name: 'app' }] })
    start = join(root, 'gone')
    const fallback = listed(await listFolders({}, deps()))
    expect(fallback.path).toBe(home)
    expect(fallback.note).toBe(`The start folder ${join(root, 'gone')} is not a folder on this server now; showing the home folder.`)
    // A file is no start folder either.
    writeFileSync(join(root, 'file'), 'x')
    start = join(root, 'file')
    expect(listed(await listFolders({}, deps())).path).toBe(home)
    // A path the request names wins over the start folder.
    expect(listed(await listFolders({ path: srv }, deps())).path).toBe(srv)
  })

  it('leaves dot folders out unless asked, counting them', async () => {
    for (const d of ['.config', '.cache', 'src']) mkdirSync(join(home, d))
    const plain = listed(await listFolders({ path: home }, deps()))
    expect(plain.folders.map((f) => f.name)).toEqual(['src'])
    expect(plain.hiddenCount).toBe(2)
    const all = listed(await listFolders({ path: home, hidden: true }, deps()))
    expect(all.folders.map((f) => f.name)).toEqual(['.cache', '.config', 'src'])
    expect(all.hiddenCount).toBe(0)
  })

  it('marks git repos (a .git folder or file) and projects (by real path), and the folder shown itself', async () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true })
    mkdirSync(join(home, 'worktree'))
    writeFileSync(join(home, 'worktree', '.git'), 'gitdir: /elsewhere')
    mkdirSync(join(home, 'proj'))
    mkdirSync(join(home, 'plain'))
    projects = new Set([join(home, 'proj'), home])
    const reply = listed(await listFolders({ path: home }, deps()))
    expect(reply.folders).toEqual([{ name: 'plain' }, { name: 'proj', project: true }, { name: 'repo', git: true }, { name: 'worktree', git: true }])
    expect(reply.here).toEqual({ git: false, project: true })
    expect(listed(await listFolders({ path: join(home, 'repo') }, deps())).here).toEqual({ git: true, project: false })
  })

  it('lists a link to a folder as a link with no marks; a link to a file or to nothing is left out', async () => {
    const target = join(root, 'target')
    mkdirSync(join(target, '.git'), { recursive: true })
    projects = new Set([target])
    symlinkSync(target, join(home, 'linked'))
    writeFileSync(join(root, 'file'), 'x')
    symlinkSync(join(root, 'file'), join(home, 'to-file'))
    symlinkSync(join(root, 'nowhere'), join(home, 'dangling'))
    const reply = listed(await listFolders({ path: home }, deps()))
    expect(reply.folders).toEqual([{ name: 'linked', link: true }])
    // Entered through the link, the folder is listed with its own marks (the realpath of the folder shown).
    expect(listed(await listFolders({ path: join(home, 'linked') }, deps())).here).toEqual({ git: true, project: true })
  })

  it('caps the answer at MAX_FOLDER_ENTRIES folders, saying so', async () => {
    for (let i = 0; i < MAX_FOLDER_ENTRIES + 5; i++) mkdirSync(join(home, `d${i}`))
    const reply = listed(await listFolders({ path: home }, deps()))
    expect(reply.folders).toHaveLength(MAX_FOLDER_ENTRIES)
    expect(reply.truncated).toBe(true)
  })

  it('stops reading after MAX_SCANNED_ENTRIES entries, folders or not (an fs that never ends)', async () => {
    let read = 0
    const endless: FolderFs = {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            read++
            yield { name: `f${read}`, isDirectory: () => false, isSymbolicLink: () => false }
          }
        }
      }),
      lstat: async () => {
        throw Object.assign(new Error('no'), { code: 'ENOENT' })
      },
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (p) => p
    }
    const reply = listed(await listFolders({ path: '/big' }, deps({ fs: endless })))
    expect(reply.folders).toEqual([])
    expect(reply.truncated).toBe(true)
    expect(read).toBe(MAX_SCANNED_ENTRIES + 1)
  })

  it('answers a folder it cannot read with the reason, the path and its parent, never a throw', async () => {
    const gone = await listFolders({ path: join(root, 'gone') }, deps())
    expect(gone).toEqual({ path: join(root, 'gone'), parent: root, home, error: 'this folder does not exist (any more)' })
    writeFileSync(join(root, 'file'), 'x')
    expect(await listFolders({ path: join(root, 'file') }, deps())).toMatchObject({ error: 'not a folder' })
    // An unexpected code: generic text with the code, the detail in the log.
    const failing: FolderFs = {
      opendir: async () => {
        throw Object.assign(new Error('EIO: i/o error, opendir /mnt/x'), { code: 'EIO' })
      },
      lstat: async () => undefined,
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (p) => p
    }
    expect(await listFolders({ path: '/mnt/x' }, deps({ fs: failing }))).toMatchObject({ error: 'cannot read this folder (EIO)', parent: '/mnt' })
    expect(logged.join()).toContain('i/o error')
    // The root has no parent.
    const top = listed(await listFolders({ path: '/' }, deps()))
    expect(top.parent).toBeNull()
  })

  // Root reads everything: the permission case only means something for another user.
  it.skipIf(process.getuid?.() === 0)('answers permission denied for a folder the server user cannot read', async () => {
    const locked = join(root, 'locked')
    mkdirSync(join(locked, 'inside'), { recursive: true })
    chmodSync(locked, 0o000)
    expect(await listFolders({ path: locked }, deps())).toEqual({
      path: locked,
      parent: root,
      home,
      error: 'permission denied: the server user cannot read this folder'
    })
    // Listed from its parent all the same (the parent is readable); its unreadable `.git` is no mark.
    const entry = listed(await listFolders({ path: root }, deps())).folders.find((f) => f.name === 'locked')
    expect(entry).toEqual({ name: 'locked' })
  })
})
