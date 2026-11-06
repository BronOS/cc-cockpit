// ctx.files.reveal / openWithSystem / trash, main side (main/files/system-files.ts), with the trash
// dialog (files/trash-dialog.ts) and the runnable list (shared/runnable-files.ts): real temp
// folders and symlinks, a recording SystemShell in place of Electron's, and a queued confirm. The
// HostApi half (budgets, one dialog at a time, the caller from the host's scope) is at the end.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemFiles, resolveProjectEntry, type SystemShell } from '../../src/main/files/system-files'
import { electronConfirmTrash, QueuedTrashConfirm, trashDialogOptions } from '../../src/main/files/trash-dialog'
import {
  HostApi,
  MAX_REVEALS_PER_WINDOW,
  MAX_SYSTEM_OPENS_PER_WINDOW,
  MAX_TRASHES_PER_WINDOW,
  SYSTEM_OPEN_WINDOW_MS,
  TRASH_WINDOW_MS,
  type HostApiDeps,
  type HostScope
} from '../../src/main/plugins/host-api'
import { RUNNABLE_EXTENSIONS, runnableByName } from '../../src/shared/runnable-files'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const WIN_A = 1
const WIN_B = 2

let root: string
let projA: string
let projB: string
let outside: string
let calls: Array<[string, string]>
let shell: SystemShell
let confirm: QueuedTrashConfirm
let openFails: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-system-files-')))
  projA = join(root, 'a')
  projB = join(root, 'b')
  outside = join(root, 'outside')
  for (const d of [join(projA, 'src', 'deep'), projB, join(outside, 'dir')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(projA, 'notes.txt'), 'x')
  writeFileSync(join(projA, 'src', 'a.ts'), 'x')
  writeFileSync(join(projB, 'b.txt'), 'x')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  writeFileSync(join(outside, 'dir', 'f.txt'), 'x')
  symlinkSync(outside, join(projA, 'link-out'))
  symlinkSync(join(outside, 'secret.txt'), join(projA, 'secret-link.txt'))
  symlinkSync(join(projA, 'notes.txt'), join(projA, 'inner-link.txt'))
  symlinkSync(join(projA, 'nope'), join(projA, 'dangling'))
  // A link out of the project whose child links back in: the whole path resolves inside, the
  // folder holding the entry does not.
  symlinkSync(join(projA, 'notes.txt'), join(outside, 'back.txt'))
  calls = []
  openFails = ''
  shell = {
    showItemInFolder: (p) => {
      calls.push(['reveal', p])
    },
    openPath: async (p) => {
      calls.push(['open', p])
      return openFails
    },
    trashItem: async (p) => {
      calls.push(['trash', p])
    }
  }
  confirm = new QueuedTrashConfirm()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function files(platform: NodeJS.Platform = 'darwin'): SystemFiles {
  return new SystemFiles({
    projectPath: (id) => ({ [A]: projA, [B]: projB })[id],
    windowOf: (id) => ({ [A]: WIN_A, [B]: WIN_B })[id],
    shell,
    confirmTrash: confirm.confirm,
    platform
  })
}
const callerA = { windowId: WIN_A, projectId: A }

describe('resolveProjectEntry', () => {
  it('normalizes a path inside, and hands the system the entry itself (a link stays a link)', async () => {
    expect(await resolveProjectEntry(projA, './src//a.ts', false)).toEqual({
      rel: 'src/a.ts',
      target: join(projA, 'src', 'a.ts'),
      real: join(projA, 'src', 'a.ts'),
      root: projA
    })
    const link = await resolveProjectEntry(projA, 'inner-link.txt', false)
    expect(link.target).toBe(join(projA, 'inner-link.txt'))
    expect(link.real).toBe(join(projA, 'notes.txt'))
  })

  it('refuses the lexical escapes and the shapes', async () => {
    const bad: Array<[unknown, RegExp]> = [
      ['', /non-empty string/],
      [7, /non-empty string/],
      ['/etc/passwd', /relative to the project/],
      ['C:/x', /relative to the project/],
      ['../a/notes.txt', /"\.\." segments/],
      ['src/../../x', /"\.\." segments/],
      ['a\0b', /NUL/],
      ['x'.repeat(5000), /longer than/]
    ]
    for (const [path, why] of bad) await expect(resolveProjectEntry(projA, path, false), String(path)).rejects.toThrow(why)
  })

  it('refuses a symlink out of the project, a path through one, a dangling link and a missing path', async () => {
    await expect(resolveProjectEntry(projA, 'secret-link.txt', false)).rejects.toThrow('outside the project')
    await expect(resolveProjectEntry(projA, 'link-out', false)).rejects.toThrow('outside the project')
    await expect(resolveProjectEntry(projA, 'link-out/dir/f.txt', false)).rejects.toThrow('outside the project')
    // Resolves inside (to notes.txt) but sits in a folder outside: the system would act on outside/back.txt.
    await expect(resolveProjectEntry(projA, 'link-out/back.txt', false)).rejects.toThrow('outside the project')
    await expect(resolveProjectEntry(projA, 'dangling', false)).rejects.toThrow('no such file or folder: dangling')
    await expect(resolveProjectEntry(projA, 'gone.txt', false)).rejects.toThrow('no such file or folder')
  })

  it("names the project folder only when allowed ('.', '', a link to it)", async () => {
    symlinkSync(projA, join(projA, 'self'))
    expect((await resolveProjectEntry(projA, '.', true)).target).toBe(projA)
    await expect(resolveProjectEntry(projA, './', false)).rejects.toThrow('project folder')
    await expect(resolveProjectEntry(projA, 'self', false)).rejects.toThrow('is the project folder')
  })
})

describe('runnableByName', () => {
  it('matches every listed extension in any case, and app bundles anywhere in the path', () => {
    for (const ext of RUNNABLE_EXTENSIONS) {
      expect(runnableByName(`dir/x${ext}`), ext).not.toBeNull()
      expect(runnableByName(`dir/X${ext.toUpperCase()}`), ext).not.toBeNull()
    }
    for (const p of ['Foo.app', 'build/Foo.APP/Contents/Info.plist', 'x\\Y.app\\z.txt']) expect(runnableByName(p), p).toMatch(/app bundle/)
    for (const p of ['notes.txt', 'Makefile', '.bashrc', '.sh', 'a.json', 'happ', 'dir.app.txt', '.app/x.md', 'img.png']) {
      expect(runnableByName(p), p).toBeNull()
    }
    expect(runnableByName('tool.AppImage')).toBe('a .appimage file runs when opened')
  })
})

describe('SystemFiles', () => {
  it('reveal: the entry (a link as the link), or the project folder for ""', async () => {
    const sf = files()
    await sf.reveal(callerA, 'src/a.ts')
    await sf.reveal(callerA, 'src')
    await sf.reveal(callerA, 'inner-link.txt')
    await sf.reveal(callerA, '')
    expect(calls).toEqual([
      ['reveal', join(projA, 'src', 'a.ts')],
      ['reveal', join(projA, 'src')],
      ['reveal', join(projA, 'inner-link.txt')],
      ['reveal', projA]
    ])
    await expect(sf.reveal(callerA, 'link-out')).rejects.toThrow('outside the project')
    expect(calls).toHaveLength(4)
  })

  it('works only in the caller\'s project and while its window is the caller\'s', async () => {
    const sf = files()
    // Project A's caller cannot reach B's file by naming it: the path is resolved in A.
    await expect(sf.reveal(callerA, 'b.txt')).rejects.toThrow('no such file')
    await expect(sf.reveal({ windowId: WIN_B, projectId: A }, 'notes.txt')).rejects.toThrow('window is gone')
    await expect(sf.reveal({ windowId: WIN_A, projectId: 'cccccccccccccccc' }, 'notes.txt')).rejects.toThrow('window is gone')
    expect(calls).toEqual([])
  })

  it('openWithSystem: opens a document by its real path; passes the system\'s error on', async () => {
    const sf = files()
    await sf.openWithSystem(callerA, 'inner-link.txt')
    expect(calls).toEqual([['open', join(projA, 'notes.txt')]])
    openFails = 'No application knows how to open this'
    await expect(sf.openWithSystem(callerA, 'notes.txt')).rejects.toThrow('No application knows how to open this')
  })

  it('openWithSystem refuses folders, the exec bit (POSIX), runnable names any case, app bundles, and links to them', async () => {
    writeFileSync(join(projA, 'run'), '#!/bin/sh\n')
    chmodSync(join(projA, 'run'), 0o755)
    writeFileSync(join(projA, 'readme.md'), 'x')
    chmodSync(join(projA, 'readme.md'), 0o744)
    for (const name of ['Build.COMMAND', 'setup.Exe', 'tool.AppImage', 'x.desktop', 'a.jar', 'w.js', 'go.sh', 'R.PS1']) {
      writeFileSync(join(projA, name), 'x')
    }
    mkdirSync(join(projA, 'Foo.app', 'Contents'), { recursive: true })
    writeFileSync(join(projA, 'Foo.app', 'Contents', 'Info.plist'), 'x')
    symlinkSync(join(projA, 'go.sh'), join(projA, 'harmless.txt'))
    symlinkSync(join(projA, 'notes.txt'), join(projA, 'looks.sh'))
    const refused: Array<[string, RegExp]> = [
      ['src', /it is a folder \(use reveal/],
      ['run', /executable/],
      ['readme.md', /executable/],
      ['Build.COMMAND', /\.command file runs/],
      ['setup.Exe', /\.exe file runs/],
      ['tool.AppImage', /\.appimage file runs/],
      ['x.desktop', /\.desktop file runs/],
      ['a.jar', /\.jar file runs/],
      ['w.js', /\.js file runs/],
      ['go.sh', /\.sh file runs/],
      ['R.PS1', /\.ps1 file runs/],
      ['Foo.app', /app bundle/],
      ['Foo.app/Contents/Info.plist', /app bundle/],
      // A harmless name over a script, and a script name over a text file: both refused.
      ['harmless.txt', /\.sh file runs/],
      ['looks.sh', /\.sh file runs/]
    ]
    for (const platform of ['darwin', 'linux'] as const) {
      const sf = files(platform)
      for (const [path, why] of refused) await expect(sf.openWithSystem(callerA, path), `${platform} ${path}`).rejects.toThrow(why)
    }
    expect(calls).toEqual([])
    // Windows: no exec bit to read (Node derives one), the name list decides.
    await files('win32').openWithSystem(callerA, 'readme.md')
    await expect(files('win32').openWithSystem(callerA, 'setup.Exe')).rejects.toThrow(/\.exe file runs/)
    expect(calls).toEqual([['open', join(projA, 'readme.md')]])
  })

  it('trash: asks in the caller\'s window with the relative path, then moves the entry; a no moves nothing', async () => {
    const sf = files()
    confirm.answer(false, true, true)
    expect(await sf.trash(callerA, 'src/a.ts', 'cockpit.files')).toBe(false)
    expect(calls).toEqual([])
    expect(await sf.trash(callerA, './src/a.ts', 'cockpit.files')).toBe(true)
    expect(await sf.trash(callerA, 'inner-link.txt', 'cockpit.files')).toBe(true)
    expect(calls).toEqual([
      ['trash', join(projA, 'src', 'a.ts')],
      // The link itself, never notes.txt behind it.
      ['trash', join(projA, 'inner-link.txt')]
    ])
    expect(confirm.dialogs()).toEqual([
      { windowId: WIN_A, path: 'src/a.ts', kind: 'file', pluginId: 'cockpit.files' },
      { windowId: WIN_A, path: 'src/a.ts', kind: 'file', pluginId: 'cockpit.files' },
      { windowId: WIN_A, path: 'inner-link.txt', kind: 'file', pluginId: 'cockpit.files' }
    ])
    // No answer queued: the real dialog's default, Cancel.
    expect(await sf.trash(callerA, 'src', 'cockpit.files')).toBe(false)
    expect(confirm.dialogs().at(-1)).toMatchObject({ path: 'src', kind: 'folder' })
  })

  it('trash refuses the project folder, outside paths, and a path swapped while the dialog was up', async () => {
    const sf = files()
    await expect(sf.trash(callerA, '.', 'p')).rejects.toThrow('project folder')
    await expect(sf.trash(callerA, 'link-out', 'p')).rejects.toThrow('outside the project')
    await expect(sf.trash(callerA, 'secret-link.txt', 'p')).rejects.toThrow('outside the project')
    expect(confirm.dialogs()).toEqual([])
    // The person says yes while notes.txt is replaced by another file under the same name.
    const swapping = new SystemFiles({
      projectPath: () => projA,
      windowOf: () => WIN_A,
      shell,
      confirmTrash: async () => {
        renameSync(join(projA, 'notes.txt'), join(projA, 'old.txt'))
        writeFileSync(join(projA, 'notes.txt'), 'new')
        return true
      }
    })
    await expect(swapping.trash(callerA, 'notes.txt', 'p')).rejects.toThrow('changed while the confirmation was open')
    // ...or by a link out of the project.
    const linking = new SystemFiles({
      projectPath: () => projA,
      windowOf: () => WIN_A,
      shell,
      confirmTrash: async () => {
        rmSync(join(projA, 'src'), { recursive: true })
        symlinkSync(outside, join(projA, 'src'))
        return true
      }
    })
    await expect(linking.trash(callerA, 'src', 'p')).rejects.toThrow(/outside the project|changed/)
    expect(calls).toEqual([])
  })

  it('trash dialog text is display-safe: control and bidi characters in a name are dropped', async () => {
    const odd = 'evil\u202Etxt.exe\n2'
    writeFileSync(join(projA, odd), 'x')
    await files().trash(callerA, odd, 'cockpit.files')
    expect(confirm.dialogs()[0]!.path).toBe('eviltxt.exe2')
  })
})

describe('trash dialog', () => {
  const info = { path: 'src/a.ts', kind: 'file' as const, pluginId: 'cockpit.files' }

  it('makes Cancel the first, default and cancel button, and names the path and the plugin', () => {
    const o = trashDialogOptions(info, 'darwin')
    expect(o.buttons).toEqual(['Cancel', 'Move to Trash'])
    expect([o.defaultId, o.cancelId]).toEqual([0, 0])
    expect(o.message).toBe('Move the file src/a.ts to the Trash?')
    expect(o.detail).toContain('cockpit.files')
    expect(trashDialogOptions(info, 'win32').buttons).toEqual(['Cancel', 'Move to Recycle Bin'])
  })

  it('is true only for the move button; a gone window or a failed dialog is a no', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const ask = electronConfirmTrash({ windowOf: (id) => (id === 7 ? 'w7' : undefined), showMessageBox, platform: 'linux' })
    expect(await ask(7, info)).toBe(true)
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await ask(7, info)).toBe(false)
    expect(await ask(8, info)).toBe(false)
    showMessageBox.mockRejectedValueOnce(new Error('closed'))
    expect(await ask(7, info)).toBe(false)
  })
})

describe('HostApi files.reveal / openWithSystem / trash', () => {
  let seen: Array<{ method: string; caller: unknown; path: unknown; pluginId?: string; signal?: AbortSignal }>
  let trashAnswer: () => Promise<boolean>
  let apis: HostApi[]

  beforeEach(() => {
    seen = []
    apis = []
    trashAnswer = async () => true
  })
  afterEach(() => {
    for (const api of apis) api.dispose()
  })

  function host(withSystemFiles = true): (method: string, params?: unknown) => Promise<unknown> {
    const deps: HostApiDeps = {
      listSessions: () => [],
      session: () => undefined,
      send: () => ({ id: 'x', delivered: false }),
      onSessionsChange: () => () => {},
      openTab: async () => ({ id: 't' }),
      setBadge: () => true,
      openOverlay: async () => ({ dismissed: true }) as never,
      secrets: unusedSecrets,
      oauth: unusedOAuth,
      log: () => {},
      ...(withSystemFiles
        ? {
            systemFiles: {
              reveal: async (caller, path) => {
                seen.push({ method: 'reveal', caller, path })
              },
              openWithSystem: async (caller, path) => {
                seen.push({ method: 'open', caller, path })
              },
              trash: async (caller, path, pluginId, signal) => {
                seen.push({ method: 'trash', caller, path, pluginId, signal })
                return trashAnswer()
              }
            }
          }
        : {})
    }
    const scope: HostScope = {
      projectId: A,
      windowId: WIN_A,
      projectDir: projA,
      plugins: [
        { id: 'a.one', dir: root, panels: [] },
        { id: 'a.two', dir: root, panels: [] }
      ]
    }
    const api = new HostApi(deps, scope, () => {})
    apis.push(api)
    const handlers = api.handlers
    return (method, params) => Promise.resolve().then(() => handlers[method]!(params))
  }

  it("passes the host's own project and window, never one from the request", async () => {
    const call = host()
    await call('files.reveal', { pluginId: 'a.one', path: 'x', projectId: B, windowId: WIN_B })
    await call('files.openWithSystem', { pluginId: 'a.one', path: 'y', projectId: B })
    await expect(call('files.trash', { pluginId: 'a.one', path: 'z', projectId: B })).resolves.toEqual({ trashed: true })
    expect(seen.map((s) => [s.method, s.caller, s.path])).toEqual([
      ['reveal', { windowId: WIN_A, projectId: A }, 'x'],
      ['open', { windowId: WIN_A, projectId: A }, 'y'],
      ['trash', { windowId: WIN_A, projectId: A }, 'z']
    ])
    expect(seen[2]!.pluginId).toBe('a.one')
    expect(seen[2]!.signal).toBeInstanceOf(AbortSignal)
    trashAnswer = async () => false
    await expect(call('files.trash', { pluginId: 'a.one', path: 'z' })).resolves.toEqual({ trashed: false })
  })

  it('refuses unknown plugins, bad shapes and a missing handler before main does anything', async () => {
    const call = host()
    await expect(call('files.reveal', { pluginId: 'b.one', path: 'x' })).rejects.toThrow('unknown plugin')
    await expect(call('files.trash', { pluginId: 'a.one', path: 5 })).rejects.toThrow('path must be a string')
    expect(seen).toEqual([])
    await expect(host(false)('files.reveal', { pluginId: 'a.one', path: 'x' })).rejects.toThrow('not available')
  })

  it(`allows ${MAX_REVEALS_PER_WINDOW} reveals and ${MAX_SYSTEM_OPENS_PER_WINDOW} opens per plugin per ${SYSTEM_OPEN_WINDOW_MS / 1000} s, each its own budget`, async () => {
    vi.useFakeTimers()
    const call = host()
    for (let i = 0; i < MAX_REVEALS_PER_WINDOW; i++) await call('files.reveal', { pluginId: 'a.one', path: 'x' })
    await expect(call('files.reveal', { pluginId: 'a.one', path: 'x' })).rejects.toThrow(`files.reveal: more than ${MAX_REVEALS_PER_WINDOW}`)
    for (let i = 0; i < MAX_SYSTEM_OPENS_PER_WINDOW; i++) await call('files.openWithSystem', { pluginId: 'a.one', path: 'x' })
    await expect(call('files.openWithSystem', { pluginId: 'a.one', path: 'x' })).rejects.toThrow('files.openWithSystem: more than')
    await expect(call('files.reveal', { pluginId: 'a.two', path: 'x' })).resolves.toBeNull()
    vi.advanceTimersByTime(SYSTEM_OPEN_WINDOW_MS)
    await expect(call('files.reveal', { pluginId: 'a.one', path: 'x' })).resolves.toBeNull()
  })

  it(`allows ${MAX_TRASHES_PER_WINDOW} trash requests per plugin per ${TRASH_WINDOW_MS / 1000} s, and one dialog at a time`, async () => {
    vi.useFakeTimers()
    const call = host()
    for (let i = 0; i < MAX_TRASHES_PER_WINDOW; i++) await call('files.trash', { pluginId: 'a.one', path: 'x' })
    await expect(call('files.trash', { pluginId: 'a.one', path: 'x' })).rejects.toThrow(`files.trash: more than ${MAX_TRASHES_PER_WINDOW}`)
    vi.advanceTimersByTime(TRASH_WINDOW_MS)
    let answer!: (yes: boolean) => void
    trashAnswer = () => new Promise<boolean>((resolve) => (answer = resolve))
    const first = call('files.trash', { pluginId: 'a.one', path: 'x' })
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    await expect(call('files.trash', { pluginId: 'a.two', path: 'y' })).rejects.toThrow('already open')
    answer(true)
    await expect(first).resolves.toEqual({ trashed: true })
    trashAnswer = async () => true
    await expect(call('files.trash', { pluginId: 'a.two', path: 'y' })).resolves.toEqual({ trashed: true })
  })

  it("prefixes main's failure with the method", async () => {
    const call = host()
    trashAnswer = async () => {
      throw new Error('src resolves outside the project folder')
    }
    await expect(call('files.trash', { pluginId: 'a.one', path: 'src' })).rejects.toThrow('files.trash: src resolves outside the project folder')
  })
})
