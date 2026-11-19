// The guest tag and the guest's size on TabManager (design-guests §7, §8; D-14, D-21): create({openedByGuest}) tags a Claude or
// shell tab, info() exposes it, restoreTab keeps it, an invalid value is dropped (never the tab), and guestResize
// is remembered for the guest's explicit take only.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { TAKE_DEBOUNCE_MS } from '../../src/main/tabs/terminal-sizes'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const D = 'desktop:1'
const G = 'web:9'

let root: string
let backend: FakePtyBackend

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-guest-tabs-')))
  backend = new FakePtyBackend()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function manager(): TabManager {
  return new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: () => {},
    log: () => undefined
  })
}

describe('openedByGuest on create', () => {
  it('tags a Claude and a shell tab, and info() and list() expose it', () => {
    const tabs = manager()
    const c = tabs.create(P, { kind: 'claude', openedByGuest: 'guest-1' })
    const s = tabs.create(P, { kind: 'shell', openedByGuest: 'guest-2' })
    expect(c.openedByGuest).toBe('guest-1')
    expect(s.openedByGuest).toBe('guest-2')
    expect(tabs.list(P).map((t) => t.openedByGuest)).toEqual(['guest-1', 'guest-2'])
  })

  it('a tab without the option carries no field', () => {
    const tabs = manager()
    const t = tabs.create(P, { kind: 'shell' })
    expect('openedByGuest' in t).toBe(false)
  })

  it('drops an empty, a too long or a non-string value and still creates the tab', () => {
    const tabs = manager()
    const bad: unknown[] = ['', 'x'.repeat(65), 7, {}, null, ['g']]
    for (const value of bad) {
      const t = tabs.create(P, { kind: 'shell', openedByGuest: value as string })
      expect(t.kind).toBe('shell')
      expect('openedByGuest' in t).toBe(false)
    }
    expect(tabs.list(P)).toHaveLength(bad.length)
    // The longest allowed id is kept.
    expect(tabs.create(P, { kind: 'shell', openedByGuest: 'x'.repeat(64) }).openedByGuest).toBe('x'.repeat(64))
  })
})

describe('openedByGuest on restoreTab', () => {
  it('keeps it for a Claude and a shell tab, and drops an invalid one', () => {
    const tabs = manager()
    const c = tabs.restoreTab(P, { kind: 'claude', resumeId: 's-1', openedByGuest: 'guest-1' })
    const s = tabs.restoreTab(P, { kind: 'shell', openedByGuest: 'guest-2' })
    const bad = tabs.restoreTab(P, { kind: 'shell', openedByGuest: '' })
    expect(c.openedByGuest).toBe('guest-1')
    expect(s.openedByGuest).toBe('guest-2')
    expect('openedByGuest' in bad).toBe(false)
  })
})

describe('guestResize', () => {
  it("is remembered but never takes the pty size by itself; the guest's typing take does", async () => {
    const tabs = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.guestResize(P, tab.id, 40, 10, G)
    tabs.guestResize(P, tab.id, 41, 10, G)
    expect(pty.resizes).toEqual([[120, 40]])
    expect(tabs.sizerOf(tab.id)).toBe(D)
    tabs.viewInput(P, tab.id, 'x', G)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS)
    expect(pty.resizes).toEqual([[120, 40], [41, 10]])
    expect(tabs.sizerOf(tab.id)).toBe(G)
  })

  it('a lone guest report sizes nothing, and a junk size or an unknown tab is ignored', () => {
    const tabs = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.guestResize(P, tab.id, 40, 10, G)
    tabs.guestResize(P, tab.id, 0, 10, G)
    tabs.guestResize(P, 'no-such-tab', 40, 10, G)
    tabs.guestResize('bbbbbbbbbbbbbbbb', tab.id, 40, 10, G)
    expect(pty.resizes).toEqual([])
    expect(tabs.sizerOf(tab.id)).toBeUndefined()
  })

  it('Fit to this screen from the guest takes the size at once', () => {
    const tabs = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.guestResize(P, tab.id, 40, 10, G)
    expect(tabs.fit(P, tab.id, G)).toBe(true)
    expect(pty.resizes).toEqual([[120, 40], [40, 10]])
  })
})
