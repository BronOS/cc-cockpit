// openDiff wired to a real OverlayManager (fake PTY backend): the dedupe entry of a diff must be
// released when its window closes, or the same diff could never be opened again in a window that
// gets that id. open-diff.test.ts covers openDiff alone with a stubbed `open`.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OverlayManager, type UrlViewFactory } from '../../src/main/overlays/overlay-manager'
import { openDiff, type DiffTab, type OpenDiffOptions } from '../../src/main/sessions/open-diff'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const W = 7
let dir: string
let backend: FakePtyBackend
let closed: Set<number>

const noViews: UrlViewFactory = {
  create: () => {
    throw new Error('no url overlays here')
  },
  focusWindow: () => {}
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-open-diff-')))
  backend = new FakePtyBackend()
  closed = new Set()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(): { overlays: OverlayManager; options: OpenDiffOptions } {
  const overlays = new OverlayManager({
    backend,
    views: noViews,
    isWindowOpen: (windowId) => !closed.has(windowId),
    env: () => ({ PATH: '/usr/bin', TERM: 'xterm-256color' }),
    emit: () => {},
    commandForChord: () => undefined,
    log: () => {}
  })
  const tab: DiffTab = { projectId: P, cwd: dir, files: ['a.ts'] }
  const options: OpenDiffOptions = {
    tab: (id) => (id === 't1' ? tab : undefined),
    lsFiles: async () => ({ code: 0 }),
    open: (windowId, spec, opener) => overlays.open(windowId, spec, opener),
    shown: new Set(),
    log: () => {}
  }
  return { overlays, options }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('openDiff with the overlay manager', () => {
  it('a window closing releases its open diffs, so the same id can open them again', async () => {
    const { overlays, options } = setup()
    await expect(openDiff(options, { windowId: W, projectId: P }, 't1', 'a.ts')).resolves.toBe(true)
    expect(backend.spawned).toHaveLength(1)
    // Deduped while open.
    await openDiff(options, { windowId: W, projectId: P }, 't1', 'a.ts')
    expect(backend.spawned).toHaveLength(1)

    overlays.closeWindow(W)
    await settle()
    expect(options.shown.size).toBe(0)
    // A later window with the same id (ids are per main process, but may come back after a
    // reload) opens the diff again.
    await openDiff(options, { windowId: W, projectId: P }, 't1', 'a.ts')
    expect(backend.spawned).toHaveLength(2)
  })

  it('an open that throws instead of rejecting does not leave the diff blocked', async () => {
    const { options } = setup()
    let fail = true
    const real = options.open
    options.open = (...args) => {
      if (fail) throw new Error('boom')
      return real(...args)
    }
    await expect(openDiff(options, { windowId: W, projectId: P }, 't1', 'a.ts')).rejects.toThrow('boom')
    expect(options.shown.size).toBe(0)
    fail = false
    await expect(openDiff(options, { windowId: W, projectId: P }, 't1', 'a.ts')).resolves.toBe(true)
    expect(backend.spawned).toHaveLength(1)
  })
})
