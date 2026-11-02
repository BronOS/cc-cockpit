import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GIT_DIFF_FLAGS } from '../../src/main/sessions/diff-argv'
import { execLsFiles, openDiff, type DiffTab, type OpenDiffOptions } from '../../src/main/sessions/open-diff'
import { MAX_TITLE_LENGTH, type OverlaySpec } from '../../src/main/overlays/overlay-manager'

const P = 'aaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbb'
const G = ['git', ...GIT_DIFF_FLAGS]

function setup(tabs: Record<string, DiffTab>, open?: OpenDiffOptions['open']) {
  const opened: Array<{ windowId: number; spec: OverlaySpec; opener: string }> = []
  const logs: string[] = []
  const options: OpenDiffOptions = {
    tab: (id) => tabs[id],
    lsFiles: async () => ({ code: 0 }),
    open:
      open ??
      ((windowId, spec, opener) => {
        opened.push({ windowId, spec, opener })
        return new Promise(() => {}) // settles at close, which never happens here
      }),
    shown: new Set(),
    log: (m) => logs.push(m)
  }
  return { options, opened, logs }
}

const tab = (over: Partial<DiffTab> = {}): DiffTab => ({
  projectId: P,
  cwd: '/work/p',
  files: ['src/a.ts', '-weird name'],
  ...over
})

const argvOf = (o: { spec: OverlaySpec }): string[] => (o.spec as { argv: string[] }).argv

describe('openDiff', () => {
  it('opens a terminal overlay in the asking window with the tab’s own cwd and a built argv', async () => {
    const { options, opened } = setup({ t1: tab() })
    await expect(openDiff(options, { windowId: 7, projectId: P }, 't1', 'src/a.ts')).resolves.toBe(true)
    expect(opened).toEqual([
      {
        windowId: 7,
        opener: 'sessions-panel',
        spec: { kind: 'terminal', argv: [...G, 'diff', '--', '/work/p/src/a.ts'], cwd: '/work/p', title: 'a.ts', size: 'large' }
      }
    ])
  })

  it('refuses a tab of another project, an unknown tab and a file main never recorded', async () => {
    const { options, opened } = setup({ t1: tab(), t2: tab({ projectId: OTHER }) })
    const caller = { windowId: 7, projectId: P }
    await expect(openDiff(options, caller, 't2', 'src/a.ts')).resolves.toBe(false)
    await expect(openDiff(options, caller, 'nope', 'src/a.ts')).resolves.toBe(false)
    await expect(openDiff(options, caller, 't1', '/etc/passwd')).resolves.toBe(false)
    await expect(openDiff(options, caller, 't1', './src/a.ts')).resolves.toBe(false)
    expect(opened).toEqual([])
  })

  it('keeps a recorded file with a leading dash behind `--`', async () => {
    const { options, opened } = setup({ t1: tab() })
    await openDiff(options, { windowId: 1, projectId: P }, 't1', '-weird name')
    expect(argvOf(opened[0]!)).toEqual([...G, 'diff', '--', '/work/p/-weird name'])
  })

  it('accepts a recorded file outside the cwd: hooks report what Claude touched, by design', async () => {
    const files = ['../sibling/b.ts', '/elsewhere/c.ts']
    const { options, opened } = setup({ t1: tab({ files }) })
    for (const f of files) await expect(openDiff(options, { windowId: 1, projectId: P }, 't1', f)).resolves.toBe(true)
    expect(opened.map((o) => argvOf(o).at(-1))).toEqual(['/work/sibling/b.ts', '/elsewhere/c.ts'])
  })

  it('takes the cwd from the tab record of the caller’s project, per project', async () => {
    const { options, opened } = setup({
      t1: tab(),
      t2: tab({ projectId: OTHER, cwd: '/work/other' })
    })
    await openDiff(options, { windowId: 1, projectId: P }, 't1', 'src/a.ts')
    await openDiff(options, { windowId: 2, projectId: OTHER }, 't2', 'src/a.ts')
    expect(opened.map((o) => [o.windowId, (o.spec as { cwd: string }).cwd, argvOf(o).at(-1)])).toEqual([
      [1, '/work/p', '/work/p/src/a.ts'],
      [2, '/work/other', '/work/other/src/a.ts']
    ])
  })

  it('clips a long file name to a title the overlay manager accepts', async () => {
    const long = 'x'.repeat(4000)
    const { options, opened } = setup({ t1: tab({ files: [long] }) })
    await expect(openDiff(options, { windowId: 1, projectId: P }, 't1', long)).resolves.toBe(true)
    const title = (opened[0]!.spec as { title: string }).title
    expect(title.length).toBe(MAX_TITLE_LENGTH)
    expect(title.endsWith('…')).toBe(true)
    expect(argvOf(opened[0]!).at(-1)).toBe(`/work/p/${long}`)
  })

  it('passes a recorded name holding NUL as one argv entry (the probe refuses it, so less)', async () => {
    const nul = 'a\0b.ts'
    const { options, opened } = setup({ t1: tab({ files: [nul] }) })
    options.lsFiles = (argv, cwd) => execLsFiles(argv, cwd)
    await expect(openDiff(options, { windowId: 1, projectId: P }, 't1', nul)).resolves.toBe(true)
    expect(argvOf(opened[0]!)).toEqual(['less', '-+F', '--', `/work/p/${nul}`])
  })

  it('does not stack a second overlay for a diff already open, and allows it again after close', async () => {
    const closers: Array<() => void> = []
    const { options } = setup({ t1: tab() }, () => new Promise<void>((r) => closers.push(r)))
    const caller = { windowId: 7, projectId: P }
    // A double click: both calls start before the first overlay is up.
    const both = await Promise.all([
      openDiff(options, caller, 't1', 'src/a.ts'),
      openDiff(options, caller, 't1', 'src/a.ts')
    ])
    expect(both).toEqual([true, true])
    expect(closers).toHaveLength(1)
    // Another window or another file is a different diff.
    await openDiff(options, { windowId: 8, projectId: P }, 't1', 'src/a.ts')
    await openDiff(options, caller, 't1', '-weird name')
    expect(closers).toHaveLength(3)
    // Once the first overlay closes, the same click opens it again.
    closers[0]!()
    await new Promise((r) => setTimeout(r, 0))
    await openDiff(options, caller, 't1', 'src/a.ts')
    expect(closers).toHaveLength(4)
  })

  it('does not wait for the overlay to close and only logs a refused open', async () => {
    const { options, logs } = setup({ t1: tab() }, () => Promise.reject(new Error('window gone')))
    await expect(openDiff(options, { windowId: 7, projectId: P }, 't1', 'src/a.ts')).resolves.toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(logs).toEqual(['sessions panel: opening a diff failed: window gone'])
    // A refused open is forgotten, so the next click tries again.
    expect(options.shown.size).toBe(0)
  })
})

describe('execLsFiles', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })
  const node = process.execPath

  it('reports the exit code as git’s answer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-ls-'))
    await expect(execLsFiles([node, '-e', ''], dir)).resolves.toEqual({ code: 0 })
    await expect(execLsFiles([node, '-e', 'process.exit(1)'], dir)).resolves.toEqual({ code: 1 })
    await expect(execLsFiles([node, '-e', 'process.exit(128)'], dir)).resolves.toEqual({ code: 128 })
  })

  it('runs with the env it is given, not main’s own', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-ls-'))
    const check = 'process.exit(process.env.CCC_PROBE === "login" ? 0 : 3)'
    await expect(execLsFiles([node, '-e', check], dir, { CCC_PROBE: 'login' })).resolves.toEqual({ code: 0 })
    await expect(execLsFiles([node, '-e', check], dir, {})).resolves.toEqual({ code: 3 })
  })

  it('without an env runs with main’s own, so a bare `git` is still found on its PATH', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-ls-'))
    // A default of {} (no PATH) would make every probe spawnFailed and every diff fall back to less.
    const check = 'process.exit(process.env.CCC_PROBE === "main" ? 0 : 3)'
    process.env.CCC_PROBE = 'main'
    try {
      await expect(execLsFiles([node, '-e', check], dir)).resolves.toEqual({ code: 0 })
    } finally {
      delete process.env.CCC_PROBE
    }
    // And a real `git` by bare name (the suite needs git anyway: the installer tests clone with it).
    await expect(execLsFiles(['git', '--version'], dir)).resolves.toEqual({ code: 0 })
  })

  it('calls a missing binary, a missing cwd, a NUL argument and a timeout spawnFailed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-ls-'))
    const failed = { code: null, spawnFailed: true }
    await expect(execLsFiles([join(dir, 'no-such-git')], dir)).resolves.toEqual(failed)
    await expect(execLsFiles([node, '-e', ''], join(dir, 'gone'))).resolves.toEqual(failed)
    await expect(execLsFiles([node, '-e', '', 'a\0b'], dir)).resolves.toEqual(failed)
    await expect(execLsFiles([], dir)).resolves.toEqual(failed)
    await expect(execLsFiles([node, '-e', 'setTimeout(() => {}, 10000)'], dir, process.env, 100)).resolves.toEqual(
      failed
    )
  })
})
