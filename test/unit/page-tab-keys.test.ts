// Keyboard routing for page tabs (design-editor.md §1 "Keyboard", plan Task 3). Desktop: main sees a
// page tab frame's keys first (before-input-event) and sends the app's chords to the shell
// (page-tab-keys.ts). Web shell: the shell lists the app's chords with the page tab intro, the panel
// SDK forwards those (panel-core.ts keyDown), and the pool hands a chord on only from the focused,
// shown frame (page-frames.ts). Precedence: the app table and the person's overrides win; a page's
// declared keys clash only in Settings › Keybindings (CommandRegistry.bindings pageKeys).
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRegistry } from '../../src/main/commands/command-registry'
import { MAX_TRACKED_PAGE_TAB_FRAMES, PageTabFrameTabs, isShellPluginFrame, pageTabChord, panelChord } from '../../src/main/tabs/page-tab-keys'
import {
  forwardedChords,
  onKeyTable,
  registerHandlers,
  resetKeybindings,
  runForwardedChord,
  setCommands,
  setForwardedRunner,
  captureKeys
} from '../../src/renderer/commands/keybindings'
import { chordOfKey, PanelClient, TAB_KEY_MESSAGE, TAB_MESSAGE, type KeyLike, type ThemeRoot } from '../../src/sdk/panel-core'
import { chordFromEvent } from '../../src/shared/keys'
import { pageTabFrameName, pageTabOfFrameName } from '../../src/shared/page-tabs'
import { entry, pool, settle, TAB_A, TAB_B } from '../fakes/fake-page-frames'

afterEach(() => resetKeybindings())

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('desktop: before-input-event on a page tab frame', () => {
  const TAB = '0b7c1e2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'
  const OTHER = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
  const top = { parent: null }
  const URL = 'cc-plugin://cockpit.editor/page/file.html'
  // A frame as Electron's WebFrameMain shows it: about:blank (in the shell's process) until it loads.
  const child = (id: number, name: string, url = 'about:blank', parent: unknown = top) => ({ frameTreeNodeId: id, name, url, parent })

  it('the shell names a frame after its tab; anything else is no page tab name', () => {
    expect(pageTabFrameName(TAB)).toBe(`cc-page-tab:${TAB}`)
    expect(pageTabOfFrameName(pageTabFrameName(TAB))).toBe(TAB)
    expect(pageTabOfFrameName('cc-page-tab')).toBeUndefined()
    expect(pageTabOfFrameName('cc-page-tab:not-an-id')).toBeUndefined()
    expect(pageTabOfFrameName(`x${pageTabFrameName(TAB)}`)).toBeUndefined()
  })

  it("main records a frame's tab when the shell sets its src, before any page runs in it, and only then", () => {
    const frames = new PageTabFrameTabs()
    const f = child(7, pageTabFrameName(TAB))
    frames.navigating(f, URL, top)
    // Before the load commits the frame is still about:blank: no plugin page, no page tab.
    expect(frames.tabOf(f)).toBeUndefined()
    const loaded = { ...f, url: URL }
    expect(frames.tabOf(loaded)).toBe(TAB)
    // The page renames its window to another tab's frame name, then navigates itself (or the shell
    // navigates it again): the record stays, never read again (the review's CRITICAL, round 2).
    const renamed = { ...loaded, name: pageTabFrameName(OTHER) }
    frames.navigating(renamed, URL, renamed)
    frames.navigating(renamed, URL, top)
    expect(frames.tabOf(renamed)).toBe(TAB)
    // Not the top frame's own navigation, not its own child, no plugin page, no page tab name.
    const a = child(8, pageTabFrameName(OTHER))
    frames.navigating(a, URL, { parent: top })
    frames.navigating(a, URL, null)
    expect(frames.tabOf({ ...a, url: URL })).toBeUndefined()
    const nested = child(9, pageTabFrameName(OTHER), 'about:blank', loaded)
    frames.navigating(nested, URL, top)
    expect(frames.tabOf({ ...nested, url: URL })).toBeUndefined()
    const web = child(10, pageTabFrameName(OTHER))
    frames.navigating(web, 'https://example.com/', top)
    expect(frames.tabOf({ ...web, url: 'https://example.com/' })).toBeUndefined()
    const panel = child(11, 'cc-panel')
    frames.navigating(panel, URL, top)
    expect(frames.tabOf({ ...panel, url: URL })).toBeUndefined()
    // The top frame itself and no frame are no page tab's.
    expect(frames.tabOf({ frameTreeNodeId: 1, name: '', url: URL, parent: null })).toBeUndefined()
    expect(frames.tabOf(null)).toBeUndefined()
    // A frame that left the plugin's pages is no page tab's either.
    expect(frames.tabOf({ ...loaded, url: 'about:blank' })).toBeUndefined()
    // The top page reloaded: its frames went.
    frames.clear()
    expect(frames.tabOf(loaded)).toBeUndefined()
  })

  // The final review's MAJOR: records were never pruned and the oldest went past the cap, so in a window
  // open all day the file kept beside Claude since the morning (the oldest frame, still in use) was the
  // one forgotten, and its chords stopped reaching the shell.
  it("a frame gone from the window's frame tree is forgotten at the next record; one in use all day never is", () => {
    const live = new Set<number>([1])
    const frames = new PageTabFrameTabs(() => live)
    const kept = child(5, pageTabFrameName(TAB))
    live.add(5)
    frames.navigating(kept, URL, top)
    // A day of files opened and closed, trimmed and remounted beside it: far more than the cap.
    for (let i = 0; i < MAX_TRACKED_PAGE_TAB_FRAMES * 4; i++) {
      const id = 1000 + i
      live.add(id)
      frames.navigating(child(id, pageTabFrameName(OTHER)), URL, top)
      live.delete(id)
    }
    expect(frames.tabOf({ ...kept, url: URL })).toBe(TAB)
    // Only the live frames are on record (the last one left the tree after its record).
    frames.navigating(child(9, pageTabFrameName(OTHER)), URL, top)
    expect(frames.size).toBe(2)
    expect(frames.tabOf(child(1000, pageTabFrameName(OTHER), URL))).toBeUndefined()
  })

  it('a tree main cannot read prunes nothing; the cap then evicts the frame least recently used for a key', () => {
    let readable = false
    const frames = new PageTabFrameTabs(() => {
      if (!readable) throw new Error('the window is going away')
      return [100]
    })
    for (let i = 0; i < MAX_TRACKED_PAGE_TAB_FRAMES; i++) frames.navigating(child(100 + i, pageTabFrameName(TAB)), URL, top)
    expect(frames.size).toBe(MAX_TRACKED_PAGE_TAB_FRAMES)
    // The oldest record is the frame typed in: a key refreshes it, so the next record evicts frame 101.
    expect(frames.tabOf(child(100, pageTabFrameName(TAB), URL))).toBe(TAB)
    frames.navigating(child(100 + MAX_TRACKED_PAGE_TAB_FRAMES, pageTabFrameName(TAB)), URL, top)
    expect(frames.size).toBe(MAX_TRACKED_PAGE_TAB_FRAMES)
    expect(frames.tabOf(child(100, pageTabFrameName(TAB), URL))).toBe(TAB)
    expect(frames.tabOf(child(101, pageTabFrameName(TAB), URL))).toBeUndefined()
    expect(frames.tabOf(child(102, pageTabFrameName(TAB), URL))).toBe(TAB)
    // With no reader at all (the default) the same bound holds.
    const bare = new PageTabFrameTabs()
    for (let i = 0; i <= MAX_TRACKED_PAGE_TAB_FRAMES; i++) bare.navigating(child(100 + i, pageTabFrameName(TAB)), URL, top)
    expect(bare.size).toBe(MAX_TRACKED_PAGE_TAB_FRAMES)
    expect(bare.tabOf(child(100, pageTabFrameName(TAB), URL))).toBeUndefined()
    // Once the tree reads again, every frame not in it goes at the next record.
    readable = true
    frames.navigating(child(5000, pageTabFrameName(TAB)), URL, top)
    expect(frames.size).toBe(2)
    expect(frames.tabOf(child(100, pageTabFrameName(TAB), URL))).toBe(TAB)
  })

  it('the app table wins: its chords go to the shell, the rest (declared keys, typing, Escape) to the page', () => {
    const table: Record<string, string> = { 'ctrl+w': 'tab.close', 'ctrl+tab': 'tab.switchNext', escape: 'overlay.pop', 'ctrl+shift+w': 'overlay.closeTop' }
    const triggered: Array<[number, string, string, unknown]> = []
    const at = { tab: TAB, code: 'KeyW' }
    const deps = {
      commandFor: (_w: number, c: string) => table[c],
      trigger: (w: number, id: string, chord: string, origin: unknown) => {
        triggered.push([w, id, chord, origin])
        return true
      }
    }
    expect(pageTabChord(deps, 3, 'ctrl+w', at)).toBe(true)
    expect(pageTabChord(deps, 3, 'ctrl+tab', at)).toBe(true)
    // The editor's own Ctrl+S, not in the table: the page's.
    expect(pageTabChord(deps, 3, 'ctrl+s', at)).toBe(false)
    expect(pageTabChord(deps, 3, 'escape', at)).toBe(false)
    expect(pageTabChord(deps, 3, 'ctrl+shift+w', at)).toBe(false)
    expect(pageTabChord(deps, 3, null, at)).toBe(false)
    // An auto-repeat of an app chord is swallowed and not run again; one that is no app chord is the page's.
    const before = triggered.length
    expect(pageTabChord(deps, 3, 'ctrl+w', at, true)).toBe(true)
    expect(pageTabChord(deps, 3, 'ctrl+s', at, true)).toBe(false)
    expect(triggered).toHaveLength(before)
    // The chord goes with the command, and where main saw it: the frame's tab (the shell runs it only
    // while that frame holds the keys) and the physical code (held after a pane chord).
    expect(triggered).toEqual([
      [3, 'tab.close', 'ctrl+w', at],
      [3, 'tab.switchNext', 'ctrl+tab', at]
    ])
  })

  it('a window that is gone takes nothing', () => {
    expect(pageTabChord({ commandFor: () => 'tab.close', trigger: () => false }, 3, 'ctrl+w', { tab: TAB, code: 'KeyW' })).toBe(false)
  })
})

describe('desktop: before-input-event on a plugin panel frame (Sessions, Usage, Files)', () => {
  const top = { parent: null }
  const frame = (url: string, parent: unknown = top) => ({ frameTreeNodeId: 1, name: '', url, parent })

  it('only a plugin page the shell embeds directly is a panel frame', () => {
    expect(isShellPluginFrame(frame('cc-plugin://cockpit.sessions/panel.html'))).toBe(true)
    expect(isShellPluginFrame(frame('cc-plugin://x/p.html', { parent: top }))).toBe(false)
    expect(isShellPluginFrame(frame('https://example.com/'))).toBe(false)
    expect(isShellPluginFrame(frame('cc-plugin://x/p.html', null))).toBe(false)
    expect(isShellPluginFrame(null)).toBe(false)
  })

  it('app chords go to the shell with the keyboard handed over; typing, Escape and repeats are handled as for a webview', () => {
    const table: Record<string, string> = { 'ctrl+t': 'tab.newClaude', escape: 'overlay.pop' }
    const run: Array<[number, string, string, string]> = []
    const deps = {
      commandFor: (_w: number, c: string) => table[c],
      triggerInShell: (w: number, id: string, chord: string, code: string) => {
        run.push([w, id, chord, code])
        return true
      }
    }
    expect(panelChord(deps, 3, 'ctrl+t', 'KeyT')).toBe(true)
    expect(panelChord(deps, 3, 'ctrl+a', 'KeyA')).toBe(false)
    expect(panelChord(deps, 3, 'escape', 'Escape')).toBe(false)
    expect(panelChord(deps, 3, 't', 'KeyT')).toBe(false)
    expect(panelChord(deps, 3, null, 'KeyT')).toBe(false)
    expect(panelChord(deps, 3, 'ctrl+t', 'KeyT', true)).toBe(true)
    expect(run).toEqual([[3, 'tab.newClaude', 'ctrl+t', 'KeyT']])
  })

  it('a window that is gone takes nothing', () => {
    expect(panelChord({ commandFor: () => 'tab.close', triggerInShell: () => false }, 3, 'ctrl+w', 'KeyW')).toBe(false)
  })
})

describe('Settings › Keybindings: a page tab key the app table holds is shown as a clash', () => {
  it('names the page tab kinds on the row of the command that holds the chord, after overrides', () => {
    const reg = new CommandRegistry(
      'linux',
      () => ({ 'zone.toggleLeft': 'Ctrl+K' }),
      () => ({ app: [], project: [] }),
      () => [{ label: 'Editor file tabs', keys: ['Cmd+P', 'Ctrl+K', 'Ctrl+S', 'not a chord'] }]
    )
    const rows = reg.bindings('p')
    // Cmd+P is Ctrl+P on Linux; no app command holds it by default.
    expect(rows.filter((r) => r.pageKeys).map((r) => [r.id, r.key, r.pageKeys])).toEqual([['zone.toggleLeft', 'ctrl+k', ['Editor file tabs']]])
    // An override moving the command off the chord ends the clash.
    expect(reg.bindings('p', {}).some((r) => r.pageKeys)).toBe(false)
  })

  it('the table itself never changes for page tab keys', () => {
    const reg = new CommandRegistry('linux', () => ({}), undefined, () => [{ label: 'X tabs', keys: ['Cmd+W'] }])
    expect(reg.view('p').commands.find((c) => c.id === 'tab.close')?.key).toBe('ctrl+w')
  })
})

describe('web shell: the SDK forwards the chords the shell listed', () => {
  const root = (): ThemeRoot => ({ setProperty: () => {}, removeProperty: () => undefined, colorScheme: '' })
  function client() {
    const sent: unknown[] = []
    const c = new PanelClient(root(), () => {}, undefined, undefined, (m) => sent.push(m))
    return { c, sent }
  }

  it('writes chords the way the shell does', () => {
    const samples: KeyLike[] = [
      key('w', 'KeyW', { ctrlKey: true, altKey: true }),
      key('∑', 'KeyW', { metaKey: true, altKey: true }),
      key('Tab', 'Tab', { ctrlKey: true, shiftKey: true }),
      key('<', 'Comma', { metaKey: true, shiftKey: true }),
      key('!', 'Digit1', { ctrlKey: true, shiftKey: true }),
      key('е', 'KeyT', { ctrlKey: true }),
      key('ArrowUp', 'ArrowUp', { altKey: true }),
      key('Control', 'ControlLeft', { ctrlKey: true })
    ]
    for (const e of samples) expect(chordOfKey(e)).toBe(chordFromEvent(e))
  })

  it('stops and forwards a listed chord, leaves the rest to the page, and sends no repeat', () => {
    const { c, sent } = client()
    // Not a page tab yet, or no list (the desktop): nothing is taken.
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+w', 'ctrl+alt+tab', 42] }, [])
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(true)
    expect(c.keyDown(key('s', 'KeyS', { ctrlKey: true }))).toBe(false)
    expect(c.keyDown(key('Tab', 'Tab', { ctrlKey: true, altKey: true, repeat: true }))).toBe(true)
    // With the key's physical code: the shell holds it after a pane chord (HeldChordKeys).
    expect(sent).toEqual([{ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w', code: 'KeyW' }])
    // A new table replaces the list.
    c.receive({ type: TAB_MESSAGE, tab: { type: 'other' }, keys: ['ctrl+s'] }, [])
    expect(c.api.tab?.type).toBe('file')
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(c.keyDown(key('s', 'KeyS', { ctrlKey: true }))).toBe(true)
  })
})

describe('web shell: the pool and the key table', () => {
  it("the intro carries the shell's chord list; a new table is posted to every served page", async () => {
    let keys: string[] | undefined = ['ctrl+alt+w']
    const t = pool({ keys: () => keys })
    t.frames.sync([entry(TAB_A)])
    t.frames.show([TAB_A], TAB_A)
    await settle()
    t.el(TAB_A).fire()
    t.connects.at(-1)!.deliver(t.port())
    expect(t.el(TAB_A).sent).toContainEqual({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+w'] })
    keys = ['ctrl+alt+t']
    t.frames.keysChanged()
    expect(t.el(TAB_A).sent.at(-1)).toEqual({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+t'] })
    // The desktop lists none: the intro has no keys.
    const d = pool()
    d.frames.sync([entry(TAB_A)])
    d.frames.show([TAB_A], TAB_A)
    await settle()
    d.el(TAB_A).fire()
    d.connects.at(-1)!.deliver(d.port())
    expect(d.el(TAB_A).sent).toContainEqual({ type: TAB_MESSAGE, tab: { type: 'file' } })
  })

  it('a forwarded chord counts only from the shown frame with the keyboard, only a listed one, and names that frame\'s tab', async () => {
    const chords: string[] = []
    const t = pool({ keys: () => ['ctrl+alt+w'], chord: (c, tabId, code) => chords.push(`${c} ${tabId}${code === undefined ? '' : ` ${code}`}`), userActive: () => true })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A], TAB_A)
    await settle()
    t.frames.show([TAB_B], TAB_B)
    await settle()
    const a = t.el(TAB_A)
    const b = t.el(TAB_B)
    a.focusedNow = true
    a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([])
    b.focusedNow = true
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+t' })
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([`ctrl+alt+w ${TAB_B}`])
    // The page's code goes on (it only decides which repeats the shell swallows); junk does not.
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w', code: 'KeyW' })
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w', code: 42 })
    expect(chords.slice(1)).toEqual([`ctrl+alt+w ${TAB_B} KeyW`, `ctrl+alt+w ${TAB_B}`])
  })

  it('two visible frames: a chord from the one without the keyboard is dropped, from the one with it names its tab', async () => {
    const chords: string[] = []
    const t = pool({ keys: () => ['ctrl+alt+w'], chord: (c, tabId) => chords.push(`${c} ${tabId}`), userActive: () => true })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A, TAB_B], TAB_A)
    await settle()
    // B has the keyboard (the person clicked into it), A is still the view's focused pane.
    t.el(TAB_B).focusedNow = true
    t.el(TAB_A).fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([])
    t.el(TAB_B).fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([`ctrl+alt+w ${TAB_B}`])
  })

  it('a forwarded chord counts only while the browser says the person just gave real input (a script alone cannot run app commands)', async () => {
    const chords: string[] = []
    let active = false
    const t = pool({ keys: () => ['ctrl+alt+w'], chord: (c) => chords.push(c), userActive: () => active })
    t.frames.sync([entry(TAB_A)])
    t.frames.show([TAB_A], TAB_A)
    await settle()
    const a = t.el(TAB_A)
    a.focusedNow = true
    // The page's script posts the chord with no key pressed: nothing runs, however often.
    for (let i = 0; i < 5; i++) a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([])
    active = true
    a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual(['ctrl+alt+w'])
    // No way to tell (an option left out): none taken.
    const none: string[] = []
    const u = pool({ keys: () => ['ctrl+alt+w'], chord: (c) => none.push(c) })
    u.frames.sync([entry(TAB_A)])
    u.frames.show([TAB_A], TAB_A)
    await settle()
    u.el(TAB_A).focusedNow = true
    u.el(TAB_A).fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(none).toEqual([])
  })

  it('the shell lists every app chord with Cmd, Ctrl or Alt, not the overlay keys, and runs one through its runner', () => {
    setCommands({
      commands: [
        { id: 'tab.close', title: 'Close', key: 'ctrl+w', source: 'core' },
        { id: 'overlay.pop', title: 'Pop', key: 'escape', source: 'core' },
        { id: 'overlay.closeTop', title: 'Close top', key: 'ctrl+shift+w', source: 'core' },
        { id: 'x.f5', title: 'F5', key: 'f5', source: 'core' },
        { id: 'zone.toggleLeft', title: 'Left', key: 'alt+b', source: 'core' }
      ],
      conflicts: []
    })
    expect(forwardedChords().sort()).toEqual(['alt+b', 'ctrl+w'])
    const ran: Array<[string, string | undefined]> = []
    // No runner, or no handler for the command: nothing runs.
    expect(runForwardedChord('ctrl+w', 'page-1')).toBe(false)
    const chords: string[] = []
    const off = setForwardedRunner((id, ctx, chord, code) => {
      ran.push([id, ctx?.tabId])
      chords.push(code === undefined ? chord : `${chord} ${code}`)
    })
    expect(runForwardedChord('ctrl+w', 'page-1')).toBe(false)
    registerHandlers({ 'tab.close': () => {} })
    expect(runForwardedChord('ctrl+w', 'page-1')).toBe(true)
    expect(runForwardedChord('ctrl+w', 'page-1', 'KeyW')).toBe(true)
    expect(runForwardedChord('ctrl+q', 'page-1')).toBe(false)
    // The keybinding editor recording: no chord runs anything.
    const release = captureKeys()
    expect(runForwardedChord('ctrl+w', 'page-1')).toBe(false)
    release()
    off()
    expect(runForwardedChord('ctrl+w', 'page-1')).toBe(false)
    // The command runs for the frame's own tab (design-split-pages.md §4), never "the active tab".
    expect(ran).toEqual([
      ['tab.close', 'page-1'],
      ['tab.close', 'page-1']
    ])
    expect(chords).toEqual(['ctrl+w', 'ctrl+w KeyW'])
  })

  it('a new key table is told to its listeners', () => {
    let told = 0
    const off = onKeyTable(() => told++)
    setCommands({ commands: [], conflicts: [] })
    off()
    setCommands({ commands: [], conflicts: [] })
    expect(told).toBe(1)
  })
})
